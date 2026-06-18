use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[cfg(target_os = "macos")]
use objc2::{define_class, ClassType};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPanel, NSWindow, NSWindowAnimationBehavior, NSWindowStyleMask};

// A borderless (decorationless) window returns NO from -canBecomeKeyWindow by
// default, so makeKeyAndOrderFront cannot make it key and its HTML text inputs
// never receive keystrokes. Subclass NSPanel and force -canBecomeKeyWindow to
// YES; promoting to a non-activating panel lets the window take key focus for the
// compose textarea WITHOUT activating the whole app. The subclass adds no ivars,
// so swapping an existing NSWindow instance to it via object_setClass keeps the
// instance layout identical. Only the never-destroyed `main` window is promoted
// (see configure_self_panel) — spawned pet windows stay plain so they can be
// destroyed safely.
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
// A high but non-accessibility level: using 1500 (CGAssistiveTechHighWindowLevel) made the window
// manager treat the window as an accessibility overlay, breaking Space membership on some macOS
// versions. Floats above ordinary windows; it does not (and is not meant to) overlay fullscreen apps.
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

/// Apply the floating desktop-pet overlay traits to a plain window:
/// - float above ordinary windows (a high but non-accessibility level),
/// - stay visible when another app is focused (`hidesOnDeactivate` off),
/// - never get hidden by Hide Others (`canHide` off),
/// - no Space-switch animation.
///
/// Deliberately NOT a panel and NOT joining all Spaces / fullscreen: GoodPuppy is
/// a desktop pet that does not overlay fullscreen apps. This keeps the window a
/// vanilla Tauri NSWindow, so dynamically spawned pet windows can be destroyed via
/// the standard path without the NSPanel-teardown crash (see `close_pet_window`).
#[cfg(target_os = "macos")]
fn configure_floating_overlay<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
    ns_window.setLevel(NS_POPUP_MENU_WINDOW_LEVEL);
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanHide(false);
    ns_window.setAnimationBehavior(NSWindowAnimationBehavior::None);
}

#[cfg(not(target_os = "macos"))]
fn configure_floating_overlay<R: Runtime>(_window: &WebviewWindow<R>) {}

/// Configure the self / coordinator window (`main`), which also hosts the compose
/// textarea. A borderless NSWindow returns NO from -canBecomeKeyWindow, so its
/// text input never receives keystrokes; promote it to a non-activating NSPanel
/// (`GoodPuppyPanel` overrides -canBecomeKeyWindow → YES) so typing works without
/// activating the whole app (Spotlight style).
///
/// Only `main` is promoted, and `main` lives for the entire session (it is hidden,
/// never destroyed). Dynamically spawned pet windows stay plain (see
/// `configure_floating_overlay`) precisely so they can be destroyed safely — the
/// abort on leave-room came from tearing down a promoted panel.
#[cfg(target_os = "macos")]
fn configure_self_panel<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };

    // objc2::ffi::object_setClass swaps the isa pointer. NSPanel has no extra ivars
    // versus NSWindow, so the instance layouts are identical (objc2 asserts size
    // equality in debug builds). Same technique Electron's ElectronNSPanel uses.
    unsafe {
        let panel_class = GoodPuppyPanel::class();
        objc2::ffi::object_setClass(
            ns_window as *const NSWindow as *mut objc2::runtime::AnyObject,
            panel_class,
        );
    }

    let ns_panel: &NSPanel = unsafe { &*ns_window_ptr.cast() };
    ns_panel.setFloatingPanel(true);
    ns_panel.setBecomesKeyOnlyIfNeeded(true);
    ns_window.setStyleMask(ns_window.styleMask() | NSWindowStyleMask::NonactivatingPanel);

    configure_floating_overlay(window);
}

#[cfg(not(target_os = "macos"))]
fn configure_self_panel<R: Runtime>(_window: &WebviewWindow<R>) {}

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

/// Per-window interactive hit shape, published by the webview in window-content
/// CSS-logical pixels (same space the cursor monitor measures the cursor in).
///
/// The native cursor monitor owns mouse passthrough and decides it from this
/// shape every poll tick — no per-move IPC round-trip. That removes the ~30–50ms
/// "become interactive" latency that made the first click after entering the pet
/// fail to grab it. The webview re-publishes the shape only when it changes
/// (animation frame, scale, bubbles/compose, drag), not on every cursor move.
#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetHitShape {
    /// Pet silhouette alpha mask over `mask_rect`, row-major, 1 = opaque pixel.
    mask: Vec<u8>,
    mask_cols: u32,
    mask_rows: u32,
    /// Mask rect [x, y, w, h] in content-logical px.
    mask_rect: [f64; 4],
    /// Always-interactive rects (visible bubbles / compose stick), content px.
    rects: Vec<[f64; 4]>,
    /// While dragging, the whole window stays interactive regardless of shape.
    force_interactive: bool,
}

/// label → latest published hit shape. Shared between the `set_pet_hit_shape`
/// command (writer) and the cursor monitor (reader).
type HitShapes = Arc<std::sync::Mutex<HashMap<String, PetHitShape>>>;

fn point_in_rect(x: f64, y: f64, r: [f64; 4]) -> bool {
    x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]
}

/// Whether a content-space point (CSS-logical px) is over interactive content:
/// the pet silhouette (mask) or any interactive rect, or unconditionally while
/// a drag forces the window interactive. Pure → unit-tested.
fn shape_is_interactive(shape: &PetHitShape, x: f64, y: f64) -> bool {
    if shape.force_interactive {
        return true;
    }
    if shape.rects.iter().any(|r| point_in_rect(x, y, *r)) {
        return true;
    }
    let [rx, ry, rw, rh] = shape.mask_rect;
    if shape.mask_cols == 0 || shape.mask_rows == 0 || rw <= 0.0 || rh <= 0.0 {
        return false;
    }
    if x < rx || y < ry || x > rx + rw || y > ry + rh {
        return false;
    }
    let col = (((x - rx) / rw) * shape.mask_cols as f64) as i64;
    let row = (((y - ry) / rh) * shape.mask_rows as f64) as i64;
    let col = col.clamp(0, shape.mask_cols as i64 - 1) as usize;
    let row = row.clamp(0, shape.mask_rows as i64 - 1) as usize;
    let idx = row * shape.mask_cols as usize + col;
    shape.mask.get(idx).copied().unwrap_or(0) != 0
}

/// Store the latest hit shape a pet window published. Cheap; called only when the
/// window's interactive shape actually changes.
#[tauri::command]
fn set_pet_hit_shape(window: WebviewWindow, shapes: tauri::State<'_, HitShapes>, shape: PetHitShape) {
    if let Ok(mut map) = shapes.lock() {
        map.insert(window.label().to_string(), shape);
    }
}

/// Polls the cursor and natively toggles each pet window's mouse passthrough from
/// the shape it published (pixel-perfect, no per-move IPC). Also emits a drag-end
/// signal on mouse release so drag-lift animations can settle.
fn spawn_cursor_monitor(app: &tauri::App, hit_shapes: HitShapes) {
    let handle = app.handle().clone();
    thread::spawn(move || {
        // Per-window dedup: label → last applied `ignore_cursor_events` value.
        let last_ignore: Arc<std::sync::Mutex<HashMap<String, bool>>> =
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
            let last_ignore = last_ignore.clone();
            let last_button_down = last_button_down.clone();
            let hit_shapes = hit_shapes.clone();
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

                let mut guard = last_ignore.lock().unwrap();
                let shapes = hit_shapes.lock().unwrap();

                for (label, window) in handle.webview_windows() {
                    if !is_pet_window_label(&label) {
                        continue;
                    }

                    let Some(client_point) = cursor_client_position(&handle, &window) else {
                        continue;
                    };

                    // Native owns passthrough: interactive over the pet/bubbles,
                    // ignore (click-through) elsewhere. No shape yet → ignore.
                    let interactive = shapes
                        .get(&label)
                        .map(|s| shape_is_interactive(s, client_point.x, client_point.y))
                        .unwrap_or(false);
                    let ignore = !interactive;

                    if guard.get(&label) != Some(&ignore) {
                        guard.insert(label, ignore);
                        let _ = window.set_ignore_cursor_events(ignore);
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
        // macOS: 普通窗口默认不接受 first mouse —— 失焦后第一次左键只用于激活窗口、
        // 不会派发到 webview，导致需要点两次才能拖动。静态 main/lounge 已在
        // tauri.conf.json 设了 acceptFirstMouse；动态 pet 窗口在此对齐。
        .accept_first_mouse(true)
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
    // Plain floating window (no panel promotion) so it can be destroyed safely.
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            configure_floating_overlay(&win);
            position_overlay_window(&win, x, y, width, height);
            let _ = win.show();
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Destroy a previously spawned pet overlay window (member went offline / left).
///
/// The teardown runs on the main thread (Tauri commands may run on a worker
/// thread; window teardown must be on the main thread). These windows are plain
/// floating NSWindows — NOT promoted panels — so destroying them is the standard
/// Tauri path. (The earlier leave-room abort came from tearing down promoted,
/// all-Spaces NSPanels; spawned pets are no longer promoted — see
/// `configure_floating_overlay`.) The destroy is still wrapped so any residual
/// AppKit teardown exception is logged rather than aborting the process.
#[tauri::command]
async fn close_pet_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                guard_appkit("destroy_window", || {
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
    let hit_shapes: HitShapes = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let monitor_hit_shapes = hit_shapes.clone();
    tauri::Builder::default()
        .manage(hit_shapes)
        .invoke_handler(tauri::generate_handler![
            set_window_bounds,
            focus_pet_panel,
            spawn_pet_window,
            close_pet_window,
            set_pet_hit_shape
        ])
        .setup(move |app| {
            configure_macos_app_activation_policy(app);
            if let Some(window) = app.get_webview_window("main") {
                configure_self_panel(&window);
            }
            spawn_cursor_monitor(app, monitor_hit_shapes);

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

    fn shape_with_mask(mask: Vec<u8>, cols: u32, rows: u32, rect: [f64; 4]) -> PetHitShape {
        PetHitShape {
            mask,
            mask_cols: cols,
            mask_rows: rows,
            mask_rect: rect,
            rects: Vec::new(),
            force_interactive: false,
        }
    }

    #[test]
    fn force_interactive_overrides_everything() {
        let mut shape = PetHitShape::default();
        shape.force_interactive = true;
        // No mask, no rects, but a drag forces the whole window interactive.
        assert!(shape_is_interactive(&shape, 9999.0, 9999.0));
    }

    #[test]
    fn interactive_rects_hit_inside_only() {
        let mut shape = PetHitShape::default();
        shape.rects = vec![[10.0, 20.0, 100.0, 40.0]];
        assert!(shape_is_interactive(&shape, 10.0, 20.0)); // top-left corner
        assert!(shape_is_interactive(&shape, 60.0, 40.0)); // inside
        assert!(shape_is_interactive(&shape, 110.0, 60.0)); // bottom-right corner
        assert!(!shape_is_interactive(&shape, 9.0, 40.0)); // left of rect
        assert!(!shape_is_interactive(&shape, 60.0, 61.0)); // below rect
    }

    #[test]
    fn mask_opaque_cells_are_interactive_transparent_are_not() {
        // 2x2 mask over a 20x20 rect at origin (10,10): only the bottom-right cell opaque.
        let shape = shape_with_mask(vec![0, 0, 0, 1], 2, 2, [10.0, 10.0, 20.0, 20.0]);
        assert!(!shape_is_interactive(&shape, 12.0, 12.0)); // top-left cell, transparent
        assert!(shape_is_interactive(&shape, 25.0, 25.0)); // bottom-right cell, opaque
        assert!(!shape_is_interactive(&shape, 5.0, 5.0)); // outside the mask rect
    }

    #[test]
    fn empty_mask_is_not_interactive() {
        let shape = shape_with_mask(Vec::new(), 0, 0, [0.0, 0.0, 0.0, 0.0]);
        assert!(!shape_is_interactive(&shape, 0.0, 0.0));
    }
}
