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
use objc2_app_kit::NSWindow;

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
            spawn_cursor_monitor(app);

            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&quit]).build()?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("GoodPuppy")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    if event.id() == "quit" {
                        app.exit(0);
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
}
