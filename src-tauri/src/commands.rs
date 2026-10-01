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
use crate::window_tasks::{destroy_window, on_main_thread, WindowInstances};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindow;

/// Store the latest hit shape a pet window published. Cheap; called only when the
/// window's interactive shape actually changes.
#[tauri::command]
pub(crate) fn set_pet_hit_shape(
    window: WebviewWindow,
    shapes: tauri::State<'_, HitShapes>,
    shape: PetHitShape,
    instance_id: Option<String>,
) {
    if window.label() != "main"
        && (instance_id.is_none()
            || !matches_instance(window.app_handle(), window.label(), instance_id.as_deref()))
    {
        return;
    }
    if let Ok(mut map) = shapes.lock() {
        map.shapes.insert(window.label().to_string(), shape);
    }
}

fn validate_geometry(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if [x, y, width, height, x + width, y + height]
        .iter()
        .all(|value| value.is_finite())
        && width > 0.0
        && height > 0.0
    {
        Ok(())
    } else {
        Err("window geometry must be finite with positive dimensions".into())
    }
}

#[tauri::command]
pub(crate) async fn set_window_bounds(
    window: WebviewWindow,
    bubbles: tauri::State<'_, Bubbles>,
    instance_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_geometry(x, y, width, height)?;
    if window.label() != "main"
        && (instance_id.is_none()
            || !matches_instance(window.app_handle(), window.label(), instance_id.as_deref()))
    {
        return Err("stale window geometry request".into());
    }
    // A bubble being repositioned (e.g. flipped above↔below the pet) changes its
    // offset from the parent; refresh it so the Windows `Moved` follow stays exact.
    // macOS auto-follow re-derives the offset from the child's own frame, so this
    // bookkeeping is Windows-only but harmless to keep updated everywhere.
    let bubbles = bubbles.inner().clone();
    let win = window.clone();
    let app = window.app_handle().clone();
    let app_check = app.clone();
    on_main_thread(&app, move || {
        if win.label() != "main"
            && !matches_instance(&app_check, win.label(), instance_id.as_deref())
        {
            return Err("stale window geometry request".into());
        }
        position_overlay_window(&win, x, y, width, height)?;
        // 位置真正应用后才提交跟随偏移；失败不能污染下一次父窗口移动。
        refresh_bubble_offset(&win, &bubbles, x, y);
        Ok(())
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
    instance_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "pet-")?;
    validate_geometry(x, y, width, height)?;
    let instance_id = instance_id.unwrap_or_else(new_instance_id);
    if app.get_webview_window(&label).is_some() {
        if matches_instance(&app, &label, Some(&instance_id)) {
            return Ok(());
        }
        return Err("window label is occupied by another instance".into());
    }

    let window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/pet.html".into()))
            .initialization_script(format!(
                "window.__GOODPUPPY_INSTANCE__ = {};",
                serde_json::to_string(&instance_id).map_err(|error| error.to_string())?
            ))
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

    watch_resources(
        &window,
        shapes.inner().clone(),
        bubbles.inner().clone(),
        instance_id.clone(),
    );
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
    instance_id: Option<String>,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "pet-")?;
    if instance_id.is_none() {
        return Err("window instance identity is required".into());
    }
    if !matches_instance(&app, &label, instance_id.as_deref()) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window, instance_id.clone()).await?;
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
    instance_id: Option<String>,
    parent_label: String,
    is_self: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    validate_bubble_pair(&label, &parent_label, is_self)?;
    validate_geometry(x, y, width, height)?;
    let instance_id = instance_id.unwrap_or_else(new_instance_id);
    if app.get_webview_window(&label).is_some() {
        if matches_instance(&app, &label, Some(&instance_id)) {
            return Ok(());
        }
        return Err("window label is occupied by another instance".into());
    }

    let parent = app
        .get_webview_window(&parent_label)
        .ok_or_else(|| format!("parent window {parent_label} not found"))?;
    let builder =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/bubble.html".into()));
    #[cfg(target_os = "windows")]
    let builder = builder.owner(&parent).map_err(|error| error.to_string())?;
    let window = builder
        .initialization_script(format!(
            "window.__GOODPUPPY_INSTANCE__ = {};",
            serde_json::to_string(&instance_id).map_err(|error| error.to_string())?
        ))
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

    watch_resources(
        &window,
        shapes.inner().clone(),
        bubbles.inner().clone(),
        instance_id.clone(),
    );
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
    instance_id: Option<String>,
) -> Result<(), String> {
    require_role(caller.label(), "main")?;
    require_remote_label(&label, "bubble-")?;
    if instance_id.is_none() {
        return Err("window instance identity is required".into());
    }
    if !matches_instance(&app, &label, instance_id.as_deref()) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window, instance_id.clone()).await?;
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
    instance_id: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    require_role(caller.label(), "lounge")?;
    require_remote_label(&label, "toast-")?;
    validate_geometry(x, y, width, height)?;
    let instance_id = instance_id.unwrap_or_else(new_instance_id);
    if app.get_webview_window(&label).is_some() {
        if matches_instance(&app, &label, Some(&instance_id)) {
            return Ok(());
        }
        return Err("window label is occupied by another instance".into());
    }

    let window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("windows/toast.html".into()))
            .initialization_script(format!(
                "window.__GOODPUPPY_INSTANCE__ = {};",
                serde_json::to_string(&instance_id).map_err(|error| error.to_string())?
            ))
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

    watch_resources(
        &window,
        app.state::<HitShapes>().inner().clone(),
        app.state::<Bubbles>().inner().clone(),
        instance_id,
    );
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
    instance_id: Option<String>,
) -> Result<(), String> {
    require_role(caller.label(), "lounge")?;
    require_remote_label(&label, "toast-")?;
    if !matches_instance(&app, &label, instance_id.as_deref()) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&label) {
        destroy_window(window, instance_id).await?;
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
pub(crate) async fn focus_pet_panel(
    window: WebviewWindow,
    instance_id: Option<String>,
) -> Result<bool, String> {
    if window.label() != "bubble-self"
        || !matches_instance(window.app_handle(), window.label(), instance_id.as_deref())
    {
        return Ok(false);
    }
    let app = window.app_handle().clone();
    on_main_thread(&app, move || {
        if !window.is_visible().map_err(|error| error.to_string())? {
            return Ok(false);
        }
        #[cfg(target_os = "macos")]
        {
            let ptr = window.ns_window().map_err(|error| error.to_string())?;
            let native: &NSWindow = unsafe { &*ptr.cast() };
            native.makeKeyAndOrderFront(None);
            Ok(native.isKeyWindow())
        }
        #[cfg(not(target_os = "macos"))]
        {
            window.set_focus().map_err(|error| error.to_string())?;
            Ok(true)
        }
    })
    .await
}

fn require_role(actual: &str, expected: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err("window role is not allowed to perform this operation".into())
    }
}

#[derive(serde::Serialize)]
pub(crate) struct LogicalWorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
fn logical_work_area(x: f64, y: f64, width: f64, height: f64, scale: f64) -> LogicalWorkArea {
    LogicalWorkArea {
        x: x / scale,
        y: y / scale,
        width: width / scale,
        height: height / scale,
    }
}
/// 根据实际目标窗口选屏；不能把不同 DPI 的逻辑矩形混成同一全局坐标系来猜屏幕。
#[tauri::command]
pub(crate) async fn get_pet_monitor_work_area(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
    instance_id: Option<String>,
) -> Result<LogicalWorkArea, String> {
    require_role(caller.label(), "main")?;
    if label != "main" {
        require_remote_label(&label, "pet-")?;
    }
    let handle = app.clone();
    on_main_thread(&app, move || {
        if let Some(expected) = instance_id {
            if handle
                .state::<WindowInstances>()
                .lock()
                .unwrap()
                .get(&label)
                != Some(&expected)
            {
                return Err("stale target window instance".into());
            }
        }
        let window = handle
            .get_webview_window(&label)
            .ok_or("target pet window is unavailable")?;
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("target monitor is unavailable")?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        if !scale.is_finite() || scale <= 0.0 {
            return Err("invalid target scale factor".into());
        }
        let area = monitor.work_area();
        Ok(logical_work_area(
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
            scale,
        ))
    })
    .await
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
fn watch_resources(
    window: &WebviewWindow,
    shapes: HitShapes,
    bubbles: Bubbles,
    instance_id: String,
) {
    let instances = window
        .app_handle()
        .state::<WindowInstances>()
        .inner()
        .clone();
    instances
        .lock()
        .unwrap()
        .insert(window.label().to_string(), instance_id.clone());
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let mut registry = instances.lock().unwrap();
            if registry.get(&label) != Some(&instance_id) {
                return;
            }
            registry.remove(&label);
            drop(registry);
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
    fn window_geometry_rejects_invalid_dimensions_before_native_mutation() {
        assert!(validate_geometry(-1920.0, -200.0, 150.0, 120.0).is_ok());
        for dimensions in [(0.0, 120.0), (-1.0, 120.0), (150.0, 0.0), (150.0, f64::NAN)] {
            assert!(validate_geometry(0.0, 0.0, dimensions.0, dimensions.1).is_err());
        }
        assert!(validate_geometry(f64::INFINITY, 0.0, 150.0, 120.0).is_err());
        assert!(validate_geometry(f64::MAX, 0.0, f64::MAX, 120.0).is_err());
    }
    #[test]
    fn target_work_area_uses_the_target_window_scale_and_preserves_negative_origins() {
        let secondary = logical_work_area(1920.0, 40.0, 2560.0, 1400.0, 2.0);
        assert_eq!(
            (secondary.x, secondary.y, secondary.width, secondary.height),
            (960.0, 20.0, 1280.0, 700.0)
        );
        let left = logical_work_area(-1920.0, 0.0, 1920.0, 1040.0, 1.0);
        assert_eq!((left.x, left.width), (-1920.0, 1920.0));
    }
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

fn new_instance_id() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}
fn matches_instance(app: &AppHandle, label: &str, expected: Option<&str>) -> bool {
    expected.map_or(true, |expected| {
        app.state::<WindowInstances>()
            .lock()
            .unwrap()
            .get(label)
            .is_some_and(|actual| actual == expected)
    })
}

#[tauri::command]
pub(crate) fn get_managed_window_instance(
    app: AppHandle,
    caller: WebviewWindow,
    label: String,
) -> Result<Option<String>, String> {
    require_role(caller.label(), "main")?;
    Ok(app
        .state::<WindowInstances>()
        .lock()
        .unwrap()
        .get(&label)
        .cloned())
}
