use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, Runtime, WebviewWindow,
};

#[cfg(target_os = "macos")]
use objc2::ClassType;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPanel, NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowStyleMask};

// NSPopUpMenuWindowLevel (101) — the same level Electron uses for always-on-top panel windows.
// Appearing above fullscreen apps is determined by FullScreenAuxiliary collection behavior, not
// by a high window level; using 1500 (CGAssistiveTechHighWindowLevel) caused the window manager
// to treat the window as an accessibility overlay, breaking Space membership on some macOS versions.
#[cfg(target_os = "macos")]
const NS_POPUP_MENU_WINDOW_LEVEL: objc2_app_kit::NSWindowLevel = 101;

/// How often the native cursor monitor samples the cursor position.
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);
/// Re-emit unchanged cursor positions so late frontend listeners still receive state.
const CURSOR_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize)]
struct CursorPayload {
    /// Cursor X relative to the window content top-left, in CSS (logical) pixels.
    x: f64,
    /// Cursor Y relative to the window content top-left, in CSS (logical) pixels.
    y: f64,
}

#[cfg(target_os = "macos")]
fn appkit_window_mouse_location_to_client_point(
    mouse_x: f64,
    mouse_y: f64,
    content_height: f64,
) -> CursorPayload {
    CursorPayload {
        x: mouse_x,
        y: content_height - mouse_y,
    }
}

#[cfg(target_os = "macos")]
fn macos_window_cursor_position<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Option<CursorPayload> {
    let ns_window_ptr = window.ns_window().ok()?;
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    let mouse = ns_window.mouseLocationOutsideOfEventStream();
    let content_rect = ns_window.contentLayoutRect();

    Some(appkit_window_mouse_location_to_client_point(
        mouse.x,
        mouse.y,
        content_rect.size.height,
    ))
}

#[cfg(not(target_os = "macos"))]
fn macos_window_cursor_position<R: Runtime>(
    _window: &WebviewWindow<R>,
) -> Option<CursorPayload> {
    None
}

fn fallback_global_cursor_position<R: Runtime>(
    handle: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Option<CursorPayload> {
    let (Ok(cursor), Ok(pos), Ok(scale)) = (
        handle.cursor_position(),
        window.inner_position(),
        window.scale_factor(),
    ) else {
        return None;
    };

    Some(CursorPayload {
        x: (cursor.x - pos.x as f64) / scale,
        y: (cursor.y - pos.y as f64) / scale,
    })
}

fn cursor_client_position<R: Runtime>(
    handle: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Option<CursorPayload> {
    macos_window_cursor_position(window).or_else(|| fallback_global_cursor_position(handle, window))
}

/// Whether the primary (left) mouse button is currently held down, globally.
///
/// Native window drags (`startDragging`) on Windows run inside an OS modal move
/// loop that swallows `pointerup`, so the webview never learns when the user
/// lets go. Polling the real button state lets us emit a reliable drag-end
/// signal on every platform. Returns `None` where the platform can't be queried.
#[cfg(target_os = "windows")]
fn left_mouse_button_down() -> Option<bool> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // VK_LBUTTON = 0x01; the high-order bit is set while the button is down.
    let state = unsafe { GetAsyncKeyState(0x01) };
    Some((state as u16 & 0x8000) != 0)
}

#[cfg(target_os = "macos")]
fn left_mouse_button_down() -> Option<bool> {
    // Bit 0 of the pressed-button mask is the left button.
    let buttons = objc2_app_kit::NSEvent::pressedMouseButtons();
    Some((buttons & 1) != 0)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn left_mouse_button_down() -> Option<bool> {
    None
}

/// Returns the collection behavior needed for a persistent overlay window that appears above
/// macOS fullscreen apps on every Space.
///
/// Tao (Tauri's windowing layer) sets Managed and FullScreenPrimary by default, which conflict
/// with FullScreenAuxiliary and Stationary. We clear the full set of conflicting flags before
/// setting the overlay flags so the window correctly joins all Spaces.
#[cfg(target_os = "macos")]
fn macos_overlay_collection_behavior(
    existing: NSWindowCollectionBehavior,
) -> NSWindowCollectionBehavior {
    let clear = NSWindowCollectionBehavior::MoveToActiveSpace
        | NSWindowCollectionBehavior::Managed
        | NSWindowCollectionBehavior::Transient
        | NSWindowCollectionBehavior::ParticipatesInCycle
        | NSWindowCollectionBehavior::FullScreenPrimary
        | NSWindowCollectionBehavior::FullScreenNone
        | NSWindowCollectionBehavior::FullScreenAllowsTiling
        | NSWindowCollectionBehavior::Primary
        | NSWindowCollectionBehavior::Auxiliary
        | NSWindowCollectionBehavior::CanJoinAllApplications;

    let set = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::IgnoresCycle;

    (existing & !clear) | set
}

#[cfg(target_os = "macos")]
fn configure_macos_overlay_level<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };

    // Promote the Tauri NSWindow instance to the NSPanel class at runtime.
    //
    // Why this is needed: macOS AppKit's Space/fullscreen management internally calls
    // -[window isKindOfClass:[NSPanel class]]. An NSWindow with the same style mask and
    // collection behavior flags still fails that check and does not join fullscreen Spaces.
    // Setting NSWindowStyleMaskNonactivatingPanel alone (our previous attempt) is not enough.
    //
    // How: objc2::ffi::object_setClass swaps the isa pointer. NSPanel has no extra ivars
    // versus NSWindow, so the instance layouts are identical — objc2's AnyObject::set_class
    // asserts size equality in debug builds, giving us a compile-time safety net.
    //
    // This is the same technique Electron's ElectronNSPanel uses (they override styleMask to
    // add NSWindowStyleMaskNonactivatingPanel on an NSWindow subclass), except we go one step
    // further and make isKindOfClass:[NSPanel class] return YES.
    unsafe {
        let panel_class = <NSPanel as ClassType>::class();
        objc2::ffi::object_setClass(
            ns_window as *const NSWindow as *mut objc2::runtime::AnyObject,
            panel_class,
        );
    }

    // Now safe to call NSPanel-specific methods.
    let ns_panel: &NSPanel = unsafe { &*ns_window_ptr.cast() };
    ns_panel.setFloatingPanel(true);
    ns_panel.setBecomesKeyOnlyIfNeeded(true);

    ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    ns_window.setLevel(NS_POPUP_MENU_WINDOW_LEVEL);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanHide(false);
    ns_window.setAnimationBehavior(NSWindowAnimationBehavior::None);
    ns_window.setCollectionBehavior(macos_overlay_collection_behavior(
        ns_window.collectionBehavior(),
    ));
}


#[cfg(not(target_os = "macos"))]
fn configure_macos_overlay_level<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Switches the macOS Dock icon on or off at runtime.
///
/// Policy 0 = NSApplicationActivationPolicyRegular (Dock icon shown).
/// Policy 1 = NSApplicationActivationPolicyAccessory (Dock icon hidden).
#[cfg(target_os = "macos")]
fn set_dock_visible(visible: bool) {
    let policy: isize = if visible { 0 } else { 1 };
    unsafe {
        let app: *mut objc2::runtime::AnyObject =
            objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let _: () = objc2::msg_send![app, setActivationPolicy: policy];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_visible: bool) {}

#[cfg(target_os = "macos")]
fn configure_macos_app_activation_policy(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_app_activation_policy(_app: &mut tauri::App) {}

/// Streams cursor positions relative to the pet webview's content area so the
/// transparent overlay can perform pixel-perfect hit testing while ignoring mouse events.
fn spawn_cursor_monitor(app: &tauri::App) {
    let handle = app.handle().clone();
    thread::spawn(move || {
        // Per-window dedup: label → (last rounded position, last emit time).
        let last_emitted: Arc<std::sync::Mutex<HashMap<String, ((i64, i64), Instant)>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        // Tracks the left mouse button so we can emit a drag-end signal on release.
        let last_button_down = Arc::new(AtomicBool::new(false));

        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(CURSOR_POLL_INTERVAL);

            let handle = handle.clone();
            let last_emitted = last_emitted.clone();
            let last_button_down = last_button_down.clone();
            let stop = stop.clone();
            let posted = handle.clone().run_on_main_thread(move || {
                if handle.get_webview_window("main").is_none() {
                    stop.store(true, Ordering::Relaxed);
                    return;
                }

                // On a down→up transition, tell the pet a (possibly native) drag ended.
                if let Some(down) = left_mouse_button_down() {
                    let was_down = last_button_down.swap(down, Ordering::Relaxed);
                    if was_down && !down {
                        if let Some(main) = handle.get_webview_window("main") {
                            let _ = main.emit("pet-drag-ended", ());
                        }
                    }
                }

                let mut guard = last_emitted.lock().unwrap();
                let now = Instant::now();

                for (label, window) in handle.webview_windows() {
                    if label != "main" {
                        continue;
                    }

                    let Some(client_point) = cursor_client_position(&handle, &window) else {
                        continue;
                    };

                    let rounded = (client_point.x.round() as i64, client_point.y.round() as i64);
                    let should_emit = match guard.get(&label) {
                        Some((last_pos, last_time)) => {
                            *last_pos != rounded || last_time.elapsed() >= CURSOR_HEARTBEAT_INTERVAL
                        }
                        None => true,
                    };

                    if should_emit {
                        guard.insert(label, (rounded, now));
                        let _ = window.emit("cursor-moved", client_point);
                    }
                }
            });

            if posted.is_err() {
                break;
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            configure_macos_app_activation_policy(app);
            if let Some(window) = app.get_webview_window("main") {
                configure_macos_overlay_level(&window);
            }
            spawn_cursor_monitor(app);

            // On Windows: strip decorations while the window is still hidden, then let JS
            // resize to compensate for the custom title bar and call show() itself.
            // On other platforms: show immediately (macOS titleBarStyle handles the chrome).
            if let Some(lounge) = app.get_webview_window("lounge") {
                #[cfg(target_os = "windows")]
                let _ = lounge.set_decorations(false);
                #[cfg(not(target_os = "windows"))]
                let _ = lounge.show();
            }

            // 登录成功：通知 Pet 窗口初始化（不自动显示，进房间时由前端控制）
            let handle = app.handle().clone();
            app.listen("auth-ready", move |_| {
                let h = handle.clone();
                let inner = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = inner.get_webview_window("main") {
                        let _ = w.emit("pet-init", ());
                    }
                });
            });

            // 退出登录：隐藏 Pet 窗口，显示会客厅
            let handle2 = app.handle().clone();
            app.listen("auth-cleared", move |_| {
                let h = handle2.clone();
                let inner = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = inner.get_webview_window("main") {
                        let _ = w.hide();
                    }
                    if let Some(w) = inner.get_webview_window("lounge") {
                        let _ = w.show();
                        let _ = w.set_focus();
                        set_dock_visible(true);
                    }
                });
            });

            // 前端进入房间时会隐藏 Lounge 窗口并发出此事件
            let handle3 = app.handle().clone();
            app.listen("lounge-hidden", move |_| {
                let h = handle3.clone();
                let _ = h.run_on_main_thread(move || {
                    set_dock_visible(false);
                });
            });

            // 用户点击 Lounge 窗口的关闭按钮时，隐藏而不是销毁，并收起 Dock 图标
            if let Some(lounge) = app.get_webview_window("lounge") {
                let lounge_clone = lounge.clone();
                lounge.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = lounge_clone.hide();
                        set_dock_visible(false);
                    }
                });
            }

            // Lounge 窗口默认可见，启动时展示 Dock 图标
            set_dock_visible(true);

            let manage = MenuItemBuilder::with_id("open-lounge", "\u{4f1a}\u{5ba2}\u{5385}").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "\u{9000}\u{51fa}").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&manage, &quit]).build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GoodPuppy")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "open-lounge" => {
                            if let Some(w) = app.get_webview_window("lounge") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.emit("lounge-refresh", ());
                                set_dock_visible(true);
                            }
                        }
                        "quit" => {
                            // 握手式退出：通知 JS 清理 presence，JS 完成后回 ack，Rust 立即退出。
                            // 3s 超时兜底：网络异常或 JS 未响应时仍能正常关闭。
                            let app_handle = app.clone();
                            thread::spawn(move || {
                                let (tx, rx) = std::sync::mpsc::channel::<()>();
                                let tx2 = tx.clone();
                                app_handle.once("app-quit-ready", move |_| {
                                    let _ = tx2.send(());
                                });
                                if let Some(pet) = app_handle.get_webview_window("main") {
                                    let _ = pet.emit("app-before-quit", ());
                                }
                                let _ = rx.recv_timeout(Duration::from_millis(3000));
                                app_handle.exit(0);
                            });
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn converts_appkit_window_mouse_location_to_dom_client_coordinates() {
        let point = appkit_window_mouse_location_to_client_point(25.5, 40.0, 340.0);

        assert_eq!(point.x, 25.5);
        assert_eq!(point.y, 300.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_overlay_collection_behavior_clears_conflicting_flags() {
        let existing = NSWindowCollectionBehavior::Managed
            | NSWindowCollectionBehavior::MoveToActiveSpace
            | NSWindowCollectionBehavior::ParticipatesInCycle
            | NSWindowCollectionBehavior::FullScreenPrimary;

        let result = macos_overlay_collection_behavior(existing);

        assert!(!result.contains(NSWindowCollectionBehavior::Managed));
        assert!(!result.contains(NSWindowCollectionBehavior::MoveToActiveSpace));
        assert!(!result.contains(NSWindowCollectionBehavior::ParticipatesInCycle));
        assert!(!result.contains(NSWindowCollectionBehavior::FullScreenPrimary));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_overlay_collection_behavior_sets_all_required_overlay_flags() {
        let existing = NSWindowCollectionBehavior::empty();

        let result = macos_overlay_collection_behavior(existing);

        assert!(result.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(result.contains(NSWindowCollectionBehavior::Stationary));
        assert!(result.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(result.contains(NSWindowCollectionBehavior::IgnoresCycle));
        assert!(!result.contains(NSWindowCollectionBehavior::FullScreenDisallowsTiling));
    }
}
