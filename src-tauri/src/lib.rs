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
    AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[cfg(target_os = "macos")]
use objc2::{define_class, ClassType};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPanel, NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowStyleMask};

// A borderless (decorationless) NSPanel returns NO from -canBecomeKeyWindow by
// default, so makeKeyAndOrderFront cannot make it key and its HTML text inputs
// never receive keystrokes. Subclass NSPanel and force -canBecomeKeyWindow to
// YES. The subclass adds no ivars, so swapping an existing NSWindow instance to
// it via object_setClass keeps the instance layout identical (same trick used
// for the NSPanel class swap). Being a subclass of NSPanel, isKindOfClass:
// [NSPanel class] still returns YES, preserving the fullscreen-Space behavior.
#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(NSPanel))]
    #[name = "GoodPuppyPanel"]
    struct GoodPuppyPanel;

    impl GoodPuppyPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            true
        }
    }
);

// NSPopUpMenuWindowLevel (101) — the same level Electron uses for always-on-top panel windows.
// Appearing above fullscreen apps is determined by FullScreenAuxiliary collection behavior, not
// by a high window level; using 1500 (CGAssistiveTechHighWindowLevel) caused the window manager
// to treat the window as an accessibility overlay, breaking Space membership on some macOS versions.
#[cfg(target_os = "macos")]
const NS_POPUP_MENU_WINDOW_LEVEL: objc2_app_kit::NSWindowLevel = 101;

/// Pet overlay windows that the cursor monitor / drag-end signal serve: the
/// coordinator + self window (`main`) and every dynamically spawned remote pet
/// window (`pet-<userId>`). The lounge / login windows are excluded.
fn is_pet_window_label(label: &str) -> bool {
    label == "main" || label.starts_with("pet-")
}

/// How often the native cursor monitor samples the cursor position.
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);
/// Re-emit unchanged cursor positions so late frontend listeners still receive state.
const CURSOR_HEARTBEAT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, PartialEq, Eq)]
struct LoungeStartupBehavior {
    strip_decorations: bool,
    show: bool,
    focus: bool,
    show_dock_icon: bool,
}

fn lounge_startup_behavior() -> LoungeStartupBehavior {
    LoungeStartupBehavior {
        strip_decorations: cfg!(target_os = "windows"),
        show: true,
        focus: true,
        show_dock_icon: true,
    }
}

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

/// Run an AppKit closure, catching any Objective-C exception it raises.
///
/// Window-teardown races (leave-room destroys overlay windows while the cursor
/// monitor / layout still touch them) can make an AppKit call raise an
/// NSException. A foreign exception unwinding through Rust aborts the whole
/// process (`fatal runtime error: Rust cannot catch foreign exceptions`). Catch
/// it at the FFI boundary so the race degrades to a logged no-op instead.
#[cfg(target_os = "macos")]
fn guard_appkit<R>(op: &str, f: impl FnOnce() -> R) -> Option<R> {
    use std::panic::AssertUnwindSafe;
    match objc2::exception::catch(AssertUnwindSafe(f)) {
        Ok(value) => Some(value),
        Err(exception) => {
            log::warn!("AppKit exception caught during {op}: {exception:?}");
            None
        }
    }
}

/// Return a dynamically-spawned overlay panel to a benign state just before it
/// is destroyed, so AppKit's teardown doesn't raise an Objective-C exception
/// (see `close_pet_window`). Order-out resigns key/IMK and ends any native drag
/// tracking; clearing the collection behavior drops it from all Spaces.
#[cfg(target_os = "macos")]
fn neutralize_overlay_before_close<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    ns_window.setCollectionBehavior(NSWindowCollectionBehavior::empty());
    ns_window.orderOut(None);
}

#[cfg(target_os = "macos")]
fn macos_window_cursor_position<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Option<CursorPayload> {
    let ns_window_ptr = window.ns_window().ok()?;
    guard_appkit("cursor_position", || {
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        let mouse = ns_window.mouseLocationOutsideOfEventStream();
        let content_rect = ns_window.contentLayoutRect();
        appkit_window_mouse_location_to_client_point(mouse.x, mouse.y, content_rect.size.height)
    })
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
        let panel_class = GoodPuppyPanel::class();
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

                // On a down→up transition, tell every pet window a (possibly native)
                // drag ended; each one self-judges whether it was the one dragging.
                if let Some(down) = left_mouse_button_down() {
                    let was_down = last_button_down.swap(down, Ordering::Relaxed);
                    if was_down && !down {
                        for (label, window) in handle.webview_windows() {
                            if is_pet_window_label(&label) {
                                // 定向到该窗口自己：避免广播给全部窗口造成 N×N 次派发。
                                let _ = window.emit_to(label.as_str(), "pet-drag-ended", ());
                            }
                        }
                    }
                }

                let mut guard = last_emitted.lock().unwrap();
                let now = Instant::now();

                for (label, window) in handle.webview_windows() {
                    if !is_pet_window_label(&label) {
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
                        // 必须定向到该窗口：`emit` 会广播给所有 webview，而每个窗口的
                        // cursor-moved 坐标是相对各自内容区算的。广播会让每个 pet 窗口
                        // 收到 N 份「别的窗口的坐标」，导致穿透状态乱抖（拖不动 / 卡 / 不稳定）。
                        let _ = window.emit_to(label.as_str(), "cursor-moved", client_point);
                        guard.insert(label, (rounded, now));
                    }
                }
            });

            if posted.is_err() {
                break;
            }
        }
    });
}

/// Resize and reposition a window atomically (single IPC round-trip → single
/// runloop tick → one paint). Setting size and position via two separate JS
/// calls lets the compositor paint an intermediate frame with mismatched
/// geometry, which shows as the window flashing/jumping when the bubble stack
/// or compose stick grows the pet window upward. Size first, then position last
/// pins the final top-left on both macOS and Windows.
/// Apply position + size to an overlay window. MUST be called on the main thread.
///
/// macOS: a single -[NSWindow setFrame:display:] call. Doing set_size +
/// set_position separately flashes when the stack grows the window upward:
/// -setContentSize: keeps the TOP-LEFT fixed (window grows DOWNWARD, moving the
/// bottom-anchored pet down), then -setFrameOrigin: moves it back — the
/// compositor catches that two-step. setFrame: applies the final geometry in one
/// shot with the Cocoa bottom-left origin anchored, so the pet never moves.
///
/// The Cocoa Y flip uses the height of the zero-origin screen (`screens[0]`, the
/// one holding the menu bar), which is the global Cocoa coordinate origin. Tauri
/// logical coordinates share a single global system anchored at the primary
/// screen's top-left, so this conversion is correct for windows on any monitor.
fn position_overlay_window<R: Runtime>(
    window: &WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSScreen;
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let Ok(ns_window_ptr) = window.ns_window() else {
            return;
        };
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let primary_height = NSScreen::screens(mtm)
            .firstObject()
            .map(|screen| screen.frame().size.height)
            .unwrap_or(0.0);
        // Tauri logical coords: origin at primary's TOP-left, Y down.
        // Cocoa: origin at primary's BOTTOM-left, Y up.
        let cocoa_y = primary_height - (y + height);
        let frame = NSRect::new(NSPoint::new(x, cocoa_y), NSSize::new(width, height));
        guard_appkit("set_frame", || ns_window.setFrame_display(frame, true));
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::{LogicalPosition, LogicalSize};
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}

#[tauri::command]
fn set_window_bounds(
    window: WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let win = window.clone();
    window
        .run_on_main_thread(move || position_overlay_window(&win, x, y, width, height))
        .map_err(|e| e.to_string())
}

/// Dynamically create a transparent, always-on-top pet overlay window for a
/// remote room member. The window loads `pet.html`; the frontend reads its own
/// label (`pet-<userId>`) to boot in "remote presenter" mode. The coordinator
/// (the `main` window) drives its animation/bubbles via `emit_to`.
#[tauri::command]
async fn spawn_pet_window(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/pet.html".into()))
        .title("GoodPuppy")
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    // Configure overlay level + final geometry on the main thread BEFORE showing,
    // so the window never flashes at the wrong position or below other windows.
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            configure_macos_overlay_level(&win);
            position_overlay_window(&win, x, y, width, height);
            let _ = win.show();
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy a previously spawned pet overlay window (member went offline / left).
///
/// The teardown MUST run on the main thread. Tauri commands may run on a worker
/// thread; destroying an NSWindow/NSPanel off the main thread tears down its
/// input-method context off-thread (`error messaging the mach port for
/// IMKCFRunLoopWakeUpReliable`) and raises an Objective-C exception that unwinds
/// through Rust — `fatal runtime error: Rust cannot catch foreign exceptions`.
/// `spawn_pet_window` / `set_window_bounds` already marshal to the main thread
/// for the same reason; this kept calling `destroy()` inline and crashed on leave.
#[tauri::command]
async fn close_pet_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                // These overlay windows were promoted to a custom NSPanel
                // (`GoodPuppyPanel`) with all-Spaces / FullScreenAuxiliary
                // collection behavior. The old single-window design never
                // destroyed such a window; the multi-window split does, and
                // AppKit's teardown of a promoted, all-Spaces, possibly-key
                // panel (removing it from every Space, resigning key/IMK,
                // ending an in-flight native drag) raises an Objective-C
                // exception that unwinds through Rust on a later runloop tick
                // → `Rust cannot catch foreign exceptions` abort.
                //
                // Put the panel back into a benign state BEFORE destroying it:
                // order it out (resigns key / ends drag tracking) and clear the
                // collection behavior (drops it from all Spaces) so the deferred
                // native teardown has nothing dangerous left to do.
                #[cfg(target_os = "macos")]
                guard_appkit("destroy_window", || {
                    neutralize_overlay_before_close(&win);
                    let _ = win.destroy();
                });
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = win.destroy();
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Make the pet panel the key window so its HTML text inputs (the compose
/// stick's textarea) can receive keyboard events. The panel is a nonactivating
/// NSPanel, so this grabs key status WITHOUT activating the app (Spotlight
/// style). Returns whether the panel actually became key — used both to fix
/// input focus and as a diagnostic. Must run AFTER any native menu has fully
/// dismissed, otherwise the menu teardown resigns key again.
#[tauri::command]
fn focus_pet_panel(window: WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(ns_window_ptr) = window.ns_window() else {
            return false;
        };
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        ns_window.makeKeyAndOrderFront(None);
        ns_window.isKeyWindow()
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_focus().is_ok()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_window_bounds,
            focus_pet_panel,
            spawn_pet_window,
            close_pet_window
        ])
        .setup(|app| {
            configure_macos_app_activation_policy(app);
            if let Some(window) = app.get_webview_window("main") {
                configure_macos_overlay_level(&window);
            }
            spawn_cursor_monitor(app);

            let lounge_startup = lounge_startup_behavior();

            if lounge_startup.show_dock_icon {
                set_dock_visible(true);
            }

            // On Windows: strip decorations while the window is still hidden. The frontend
            // still resizes for the custom title bar, but Rust owns first display so startup
            // cannot remain hidden if frontend initialization is delayed or fails.
            if let Some(lounge) = app.get_webview_window("lounge") {
                if lounge_startup.strip_decorations {
                    let _ = lounge.set_decorations(false);
                }
                if lounge_startup.show {
                    let _ = lounge.show();
                }
                if lounge_startup.focus {
                    let _ = lounge.set_focus();
                }
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

    #[test]
    fn pet_window_labels_include_main_and_remote_pets_only() {
        assert!(is_pet_window_label("main"));
        assert!(is_pet_window_label("pet-abc-123"));
        assert!(!is_pet_window_label("lounge"));
        assert!(!is_pet_window_label("login"));
        assert!(!is_pet_window_label("petunia")); // must be the "pet-" prefix
    }

    #[test]
    fn startup_lounge_is_visible_and_focused() {
        let behavior = lounge_startup_behavior();

        assert!(behavior.show);
        assert!(behavior.focus);
        assert!(behavior.show_dock_icon);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn startup_lounge_strips_system_decorations_on_windows() {
        let behavior = lounge_startup_behavior();

        assert!(behavior.strip_decorations);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn startup_lounge_keeps_system_decorations_off_windows() {
        let behavior = lounge_startup_behavior();

        assert!(!behavior.strip_decorations);
    }

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
