//! 原生光标监视：采样光标在每个覆盖层窗口内容坐标系下的位置，依据该窗口发布的
//! 命中形状（见 `hit_test`）逐 tick 切换鼠标穿透；并在左键释放时发出 drag-end 信号。
//! 见 `src/shared/cursorEventsController.ts` 与相关 ADR。

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::hit_test::{shape_is_interactive, HitShapes};
use crate::window_labels::{is_overlay_window_label, is_pet_window_label};

#[cfg(target_os = "macos")]
use crate::platform::guard_appkit;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindow;

/// How often the native cursor monitor samples the cursor position.
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);

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
fn macos_window_cursor_position<R: Runtime>(window: &WebviewWindow<R>) -> Option<CursorPayload> {
    let ns_window_ptr = window.ns_window().ok()?;
    guard_appkit("cursor_position", || {
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        let mouse = ns_window.mouseLocationOutsideOfEventStream();
        let content_rect = ns_window.contentLayoutRect();
        appkit_window_mouse_location_to_client_point(mouse.x, mouse.y, content_rect.size.height)
    })
}

#[cfg(not(target_os = "macos"))]
fn macos_window_cursor_position<R: Runtime>(_window: &WebviewWindow<R>) -> Option<CursorPayload> {
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

/// Polls the cursor and natively toggles each pet window's mouse passthrough from
/// the shape it published (pixel-perfect, no per-move IPC). Also emits a drag-end
/// signal on mouse release so drag-lift animations can settle.
pub(crate) fn spawn_cursor_monitor(app: &tauri::App, hit_shapes: HitShapes) {
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
                    if !is_overlay_window_label(&label) {
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

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn converts_appkit_window_mouse_location_to_dom_client_coordinates() {
        let point = appkit_window_mouse_location_to_client_point(25.5, 40.0, 340.0);

        assert_eq!(point.x, 25.5);
        assert_eq!(point.y, 300.0);
    }
}
