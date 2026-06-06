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
    AppHandle, Emitter, Manager, Runtime, WebviewWindow,
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
    ns_window.orderFrontRegardless();
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_overlay_level<R: Runtime>(_window: &WebviewWindow<R>) {}

#[cfg(target_os = "macos")]
fn configure_macos_app_activation_policy(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_app_activation_policy(_app: &mut tauri::App) {}

/// Streams cursor positions relative to the webview content area.
///
/// The pet window is mostly transparent and uses `set_ignore_cursor_events` to let
/// clicks fall through to apps behind it. The decision of when to re-enable
/// interactivity is pixel-perfect and lives in the webview, but once the window is
/// ignoring cursor events the webview stops receiving `mousemove` entirely (and it
/// never receives them at all while another app is focused). Tauri has no
/// `forward`-style option for this (unlike Electron's `setIgnoreMouseEvents(true,
/// { forward: true })`), so we feed cursor positions from the native side. On
/// macOS we use NSWindow-relative mouse coordinates to avoid mixed-monitor global
/// coordinate conversion bugs; other platforms fall back to Tauri's global cursor
/// position APIs.
fn spawn_cursor_monitor(app: &tauri::App) {
    let handle = app.handle().clone();
    thread::spawn(move || {
        // Native window/cursor APIs reach into main-thread-only handles, so every sample
        // must run on the main thread via `run_on_main_thread`.
        let last_emitted: Arc<std::sync::Mutex<Option<((i64, i64), Instant)>>> =
            Arc::new(std::sync::Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));

        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(CURSOR_POLL_INTERVAL);

            let handle = handle.clone();
            let last_emitted = last_emitted.clone();
            let stop = stop.clone();
            let posted = handle.clone().run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window("main") else {
                    // Window is gone; signal the polling loop to exit.
                    stop.store(true, Ordering::Relaxed);
                    return;
                };

                let Some(client_point) = cursor_client_position(&handle, &window) else {
                    return;
                };

                // Dedupe at integer-pixel granularity while keeping a slow heartbeat.
                // Events emitted before the frontend listener exists are not buffered.
                let rounded = (client_point.x.round() as i64, client_point.y.round() as i64);
                {
                    let mut guard = last_emitted.lock().unwrap();
                    if let Some((last_position, last_time)) = *guard {
                        if last_position == rounded
                            && last_time.elapsed() < CURSOR_HEARTBEAT_INTERVAL
                        {
                            return;
                        }
                    }
                    *guard = Some((rounded, Instant::now()));
                }

                let _ = window.emit("cursor-moved", client_point.clone());
            });

            // If the event loop is gone, stop polling.
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

            let logout = MenuItemBuilder::with_id("logout", "\u{9000}\u{51fa}\u{767b}\u{5f55}").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "\u{9000}\u{51fa}").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&logout, &quit]).build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GoodPuppy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "logout" => {
                            let _ = app.emit("auth-logout-requested", ());
                        }
                        "quit" => app.exit(0),
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
