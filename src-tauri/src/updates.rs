//! 更新包与验签留在 Rust；只允许会客厅发起，检查、下载和安装串行。
use serde::Serialize;
use std::time::Duration;
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState(tokio::sync::Mutex<PendingUpdate>);
#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    prepared: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    configured: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "lounge" {
        return Err("更新操作只能由会客厅执行".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn update_check(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    authorize(&window)?;
    let app = window.app_handle();
    let key = option_env!("GOODPUPPY_UPDATER_PUBLIC_KEY")
        .unwrap_or("")
        .trim();
    let mut info = UpdateInfo {
        configured: !key.is_empty(),
        current_version: app.package_info().version.to_string(),
        version: None,
        notes: None,
    };
    if key.is_empty() {
        return Ok(info);
    }
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行")?;
    if pending.prepared {
        return Err("正在安装更新".into());
    }
    let cleanup_app = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            crate::quit::prepare_for_update(&cleanup_app);
        })
        .endpoints(vec![tauri::Url::parse(&format!(
            "https://raw.githubusercontent.com/make-big-bucks/GoodPuppy/updates/{}.json",
            if app.package_info().version.pre.is_empty() {
                "stable"
            } else {
                "preview"
            }
        ))
        .map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .pubkey(key)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut update = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = update.as_mut() {
        // The check is short; a complete application download needs more time.
        update.timeout = Some(Duration::from_secs(900));
        info.version = Some(update.version.clone());
        info.notes = update.body.clone();
    }
    pending.update = update;
    pending.bytes = None;
    Ok(info)
}
#[tauri::command]
pub async fn update_download(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    progress: Channel<Progress>,
) -> Result<(), String> {
    authorize(&window)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行")?;
    let update = pending.update.as_ref().ok_or("请先检查更新")?;
    let mut downloaded = 0;
    let bytes = update
        .download(
            |size, total| {
                downloaded += size as u64;
                let _ = progress.send(Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    pending.bytes = Some(bytes);
    Ok(())
}
#[tauri::command]
pub async fn update_install(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    authorize(&window)?;
    let mut pending = state.0.try_lock().map_err(|_| "更新操作正在进行")?;
    let bytes = pending.bytes.take().ok_or("请先下载更新")?;
    let update = pending.update.take().ok_or("请先检查更新")?;
    pending.prepared = true;
    let app = window.app_handle().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        update.install(bytes).map_err(|e| e.to_string())?;
        // Windows 成功安装时由插件拉起安装器并退出；macOS 在替换后清理再重启。
        crate::quit::prepare_for_update(&app);
        app.restart();
    })
    .await
    .map_err(|e| e.to_string());
    pending.prepared = false;
    result?
}
