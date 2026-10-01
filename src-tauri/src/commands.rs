//! 暴露给前端 webview 的 `#[tauri::command]` 集合：覆盖层窗口的几何更新、命中形状
//! 上报、远程宠物 / 气泡窗口的动态创建与销毁、以及自气泡面板取键焦点。
//! 这些命令是前端业务逻辑驱动原生窗口能力的薄入口，具体平台细节委托给 `platform`。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::bubbles::{
    ensure_parent_follow_listener, refresh_bubble_offset, register_bubble, unregister_bubble,
    unregister_parent, Bubbles,
};
use crate::hit_test::{HitShapes, PetHitShape};
use crate::platform::{
    add_child_window, configure_floating_overlay, configure_self_panel, position_overlay_window,
};
use crate::window_tasks::{destroy_window, on_main_thread};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindow;

/// Store the latest hit shape a pet window published. Cheap; called only when the
/// window's interactive shape actually changes.
#[tauri::command]
pub(crate) fn set_pet_hit_shape(
    window: WebviewWindow,
    shapes: tauri::State<'_, HitShapes>,
    shape: PetHitShape,
) {
    if let Ok(mut map) = shapes.lock() {
        map.shapes.insert(window.label().to_string(), shape);
    }
}

#[tauri::command]
pub(crate) async fn set_window_bounds(
    window: WebviewWindow,
    bubbles: tauri::State<'_, Bubbles>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // A bubble being repositioned (e.g. flipped above↔below the pet) changes its
    // offset from the parent; refresh it so the Windows `Moved` follow stays exact.
    // macOS auto-follow re-derives the offset from the child's own frame, so this
    // bookkeeping is Windows-only but harmless to keep updated everywhere.
    refresh_bubble_offset(&window, &bubbles, x, y);
    let win = window.clone();
    let app = window.app_handle().clone();
    on_main_thread(&app, move || {
        position_overlay_window(&win, x, y, width, height)
    })
    .await
}

/// Dynamically create a transparent, always-on-top pet overlay window for a
/// remote room member. The window loads `pet.html`; the frontend reads its own
/// label (`pet-<userId>`) to boot in "remote presenter" mode. The coordinator
/// (the `main` window) drives its animation/bubbles via `emit_to`.
#[tauri::command]
pub(crate) async fn spawn_pet_window(
    app: AppHandle,
    caller: WebviewWindow,
    shapes: tauri::State<'_, HitShapes>,
    bubbles: tauri::State<'_, Bubbles>,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "pet-")?;
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/pet.html".into()))
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

    watch_resources(&window, shapes.inner().clone(), bubbles.inner().clone());
    let win = window.clone();
    on_main_thread(&app, move || {
        configure_floating_overlay(&win);
        position_overlay_window(&win, x, y, width, height)?;
        win.show().map_err(|error| error.to_string())
    })
    .await
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
pub(crate) async fn close_pet_window(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "pet-")?;
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window).await?;
    }
    Ok(())
}

/// Dynamically create a transparent bubble overlay window glued to a pet window.
/// Loads `bubble.html`; the frontend reads its label (`bubble-self` /
/// `bubble-<userId>`) to render that pet's message stack (and, for self, the
/// compose stick). Becomes a native child of `parent_label` so the OS keeps it
/// following the pet. Only the self bubble is promoted to a key-capable panel
/// (`is_self`) because it hosts the compose textarea; remote bubbles stay plain
/// so they can be destroyed safely when the member leaves.
#[tauri::command]
pub(crate) async fn spawn_bubble_window(
    app: AppHandle,
    caller: WebviewWindow,
    shapes: tauri::State<'_, HitShapes>,
    bubbles: tauri::State<'_, Bubbles>,
    label: String,
    parent_label: String,
    is_self: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    validate_bubble_pair(&label, &parent_label, is_self)?;
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let Some(parent) = app.get_webview_window(&parent_label) else {
        return Err(format!("parent window {parent_label} not found"));
    };

    let builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/bubble.html".into()));
    #[cfg(target_os = "windows")]
    let builder = builder.owner(&parent).map_err(|error| error.to_string())?;
    let window = builder
        .title("GoodPuppy")
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

    // Record parent/offset so Windows can follow on `Moved` (macOS auto-follows).
    let parent_origin = parent
        .outer_position()
        .ok()
        .and_then(|p| {
            parent
                .scale_factor()
                .ok()
                .map(|s| (p.x as f64 / s, p.y as f64 / s))
        })
        .unwrap_or((x, y));
    register_bubble(&bubbles, &label, &parent_label, x, y, parent_origin);

    watch_resources(&window, shapes.inner().clone(), bubbles.inner().clone());
    let win = window.clone();
    let parent_for_main = parent.clone();
    on_main_thread(&app, move || {
        configure_floating_overlay(&win);
        if is_self {
            configure_self_panel(&win);
        }
        position_overlay_window(&win, x, y, width, height)?;
        add_child_window(&parent_for_main, &win)?;
        win.show().map_err(|error| error.to_string())
    })
    .await?;

    ensure_parent_follow_listener(&app, &parent_label, &bubbles);
    Ok(())
}

/// Destroy a previously spawned bubble window and forget its follow bookkeeping.
/// Remote bubbles are plain floating windows (not promoted panels), so this is
/// the standard Tauri teardown path; the self bubble is a panel and is hidden,
/// never destroyed, so it never reaches here.
#[tauri::command]
pub(crate) async fn close_bubble_window(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "bubble-")?;
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window).await?;
    }
    Ok(())
}

/// Dynamically create a transparent, always-on-top toast window for the
/// room-online notification. Loads `toast.html`; the frontend reads its label
/// (`toast-<seq>`) and the geometry / payload is supplied by the lounge via
/// `emit_to`. A plain floating overlay (not a panel) so it can be destroyed
/// safely when it auto-dismisses or the user closes/clicks it. Unlike pet /
/// bubble overlays it is NOT registered with the cursor monitor, so the webview
/// receives clicks natively (the card's buttons are normal DOM clicks).
#[tauri::command]
pub(crate) async fn spawn_toast_window(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "lounge")?;
    require_remote_label(&label, "toast-")?;
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/toast.html".into()))
            .title("GoodPuppy")
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

    let win = window.clone();
    on_main_thread(&app, move || {
        configure_floating_overlay(&win);
        position_overlay_window(&win, x, y, width, height)?;
        win.show().map_err(|error| error.to_string())
    })
    .await
}

/// Destroy a toast window (auto-dismiss / manual close / clicked through).
/// Plain floating NSWindow — standard Tauri teardown, guarded on macOS against
/// the window-teardown race the spawned pet/bubble windows also guard.
#[tauri::command]
pub(crate) async fn close_toast_window(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
) -> Result<(), String> {
    require_role(caller.label(), "lounge")?;
    require_remote_label(&label, "toast-")?;
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window).await?;
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
pub(crate) fn focus_pet_panel(window: WebviewWindow) -> bool {
    if window.label() != "bubble-self" {
        return false;
    }
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

fn require_role(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("window role is not allowed to perform this operation".into())
    }
}
fn require_remote_label(label: &str, prefix: &str) -> Result<(), String> {
    let suffix = label.strip_prefix(prefix).unwrap_or("");
    if suffix.is_empty()
        || suffix == "self"
        || !suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid dynamic window label".into());
    }
    Ok(())
}
fn validate_bubble_pair(label: &str, parent: &str, is_self: bool) -> Result<(), String> {
    if is_self && label == "bubble-self" && parent == "main" {
        return Ok(());
    }
    if is_self {
        return Err("invalid self panel identity".into());
    }
    require_remote_label(label, "bubble-")?;
    require_remote_label(parent, "pet-")?;
    if label.strip_prefix("bubble-") != parent.strip_prefix("pet-") {
        return Err("bubble and parent identities differ".into());
    }
    Ok(())
}
fn watch_resources(window: &WebviewWindow, shapes: HitShapes, bubbles: Bubbles) {
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            shapes.lock().unwrap().remove_window(&label);
            unregister_bubble(&bubbles, &label);
            unregister_parent(&bubbles, &label);
        }
    });
}

#[tauri::command]
pub(crate) async fn set_self_visible(
    app: AppHandle,
    caller: WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    let main = app
        .get_webview_window("main")
        .ok_or("main window unavailable")?;
    let bubble = app.get_webview_window("bubble-self");
    on_main_thread(&app, move || {
        if visible {
            main.show().map_err(|error| error.to_string())?;
            if let Some(bubble) = bubble {
                add_child_window(&main, &bubble)?;
                bubble.show().map_err(|error| error.to_string())?;
            }
        } else {
            if let Some(bubble) = bubble {
                bubble.hide().map_err(|error| error.to_string())?;
            }
            main.hide().map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panel_identity_and_dynamic_roles_are_enforced() {
        assert!(validate_bubble_pair("bubble-self", "main", true).is_ok());
        assert!(validate_bubble_pair("bubble-self", "main", false).is_err());
        assert!(validate_bubble_pair("bubble-a", "pet-b", false).is_err());
        assert!(validate_bubble_pair("bubble-a", "pet-a", false).is_ok());
        assert!(require_remote_label("main", "pet-").is_err());
        assert!(require_remote_label("bubble-self", "bubble-").is_err());
        assert!(require_remote_label("pet-", "pet-").is_err());
        assert!(require_role("pet-a", "main").is_err());
    }
}
