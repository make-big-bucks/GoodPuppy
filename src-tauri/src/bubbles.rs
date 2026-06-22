//! 气泡子窗口的「跟随父宠物窗口」记账与定位。
//!
//! 每个 pet 窗口可挂一个气泡窗口（`bubble-self` / `bubble-<userId>`），气泡需随
//! 父窗口移动而移动。两个平台都需要软件跟随：Windows `set_parent` 仅建立 owner
//! 关系、不会移动子窗口；macOS `addChildWindow:` 虽保持附着与 z-order，但在原生
//! 拖拽的 `performWindowDragWithEvent:` 模态循环里不重定位子窗口。因此监听父窗口
//! 的 `Moved` 事件，按存储的偏移量补上这段实时定位。见 `src/windows/pet/` 相关逻辑。

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::window_labels::is_bubble_window_label;

/// Tracks dynamically spawned bubble windows so they can follow their parent pet
/// window. We reposition each child from the parent's `Moved` events using the
/// stored offset. This is needed on BOTH platforms: Windows `set_parent` is
/// owner-only and never moves the child, and on macOS `addChildWindow:` keeps the
/// child attached + z-ordered but AppKit does NOT reposition it during a native
/// drag's `performWindowDragWithEvent:` modal loop (verified: parent fires `Moved`
/// live with the child attached, yet the child stays put until drag-end). So the
/// `Moved` listener supplies the live drag positioning AppKit skips.
#[derive(Default)]
pub(crate) struct BubbleRegistry {
    /// bubble label → parent pet label.
    parent_of: HashMap<String, String>,
    /// parent pet label → its bubble labels.
    children_of: HashMap<String, Vec<String>>,
    /// bubble label → (offset_x, offset_y) from parent top-left, logical px.
    offset_of: HashMap<String, (f64, f64)>,
    /// parent pet labels that already have a `Moved` follow listener attached.
    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    listening_parents: std::collections::HashSet<String>,
}

pub(crate) type Bubbles = Arc<std::sync::Mutex<BubbleRegistry>>;

/// Register a freshly spawned bubble: remember its parent and initial offset so
/// the parent-`Moved` follow can glue it in place. `parent_origin` is the parent
/// window's top-left in logical px at spawn time.
pub(crate) fn register_bubble(
    bubbles: &Bubbles,
    label: &str,
    parent_label: &str,
    x: f64,
    y: f64,
    parent_origin: (f64, f64),
) {
    let mut reg = bubbles.lock().unwrap();
    reg.parent_of
        .insert(label.to_string(), parent_label.to_string());
    reg.children_of
        .entry(parent_label.to_string())
        .or_default()
        .push(label.to_string());
    reg.offset_of.insert(
        label.to_string(),
        (x - parent_origin.0, y - parent_origin.1),
    );
}

/// Forget a bubble's follow bookkeeping when it is destroyed.
pub(crate) fn unregister_bubble(bubbles: &Bubbles, label: &str) {
    let mut reg = bubbles.lock().unwrap();
    if let Some(parent) = reg.parent_of.remove(label) {
        if let Some(children) = reg.children_of.get_mut(&parent) {
            children.retain(|l| l != label);
        }
    }
    reg.offset_of.remove(label);
}

/// Attach a `Moved` listener to the parent pet window that repositions every
/// registered bubble child by its stored offset. Active on Windows (`set_parent`
/// never moves the child) AND macOS (`addChildWindow` doesn't reposition the child
/// during the native drag's modal loop). The offset is refreshed whenever the
/// coordinator repositions a bubble (see `set_window_bounds`), so above/below flips
/// stay correct on the next parent move.
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) fn ensure_parent_follow_listener<R: Runtime>(
    app: &AppHandle<R>,
    parent_label: &str,
    bubbles: &Bubbles,
) {
    {
        let mut reg = bubbles.lock().unwrap();
        if reg.listening_parents.contains(parent_label) {
            return;
        }
        reg.listening_parents.insert(parent_label.to_string());
    }
    let Some(parent) = app.get_webview_window(parent_label) else {
        return;
    };
    let app = app.clone();
    let bubbles = bubbles.clone();
    let parent_label = parent_label.to_string();
    parent.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            let scale = app
                .get_webview_window(&parent_label)
                .and_then(|w| w.scale_factor().ok())
                .unwrap_or(1.0);
            let parent_x = pos.x as f64 / scale;
            let parent_y = pos.y as f64 / scale;
            let children: Vec<(String, (f64, f64))> = {
                let reg = bubbles.lock().unwrap();
                reg.children_of
                    .get(&parent_label)
                    .map(|labels| {
                        labels
                            .iter()
                            .filter_map(|l| reg.offset_of.get(l).map(|off| (l.clone(), *off)))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            for (label, (ox, oy)) in children {
                if let Some(child) = app.get_webview_window(&label) {
                    use tauri::LogicalPosition;
                    let _ = child.set_position(LogicalPosition::new(parent_x + ox, parent_y + oy));
                }
            }
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(crate) fn ensure_parent_follow_listener<R: Runtime>(
    _app: &AppHandle<R>,
    _parent_label: &str,
    _bubbles: &Bubbles,
) {
}

/// Recompute a bubble window's stored offset from its parent after an explicit
/// reposition, so the parent-`Moved` follow keeps the bubble glued in its new spot.
pub(crate) fn refresh_bubble_offset<R: Runtime>(
    window: &WebviewWindow<R>,
    bubbles: &Bubbles,
    x: f64,
    y: f64,
) {
    let label = window.label().to_string();
    if !is_bubble_window_label(&label) {
        return;
    }
    let parent_label = {
        let reg = bubbles.lock().unwrap();
        reg.parent_of.get(&label).cloned()
    };
    let Some(parent_label) = parent_label else {
        return;
    };
    let Some(parent) = window.app_handle().get_webview_window(&parent_label) else {
        return;
    };
    let Some((px, py)) = parent
        .outer_position()
        .ok()
        .and_then(|p| parent.scale_factor().ok().map(|s| (p.x as f64 / s, p.y as f64 / s)))
    else {
        return;
    };
    let mut reg = bubbles.lock().unwrap();
    reg.offset_of.insert(label, (x - px, y - py));
}
