//! 原生操作必须返回实际执行结果；销毁还要等待 Destroyed 事件。
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub(crate) async fn on_main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let result = crate::platform::guard_appkit("window_command", work)
            .unwrap_or_else(|| Err("AppKit window operation failed".into()));
        #[cfg(not(target_os = "macos"))]
        let result = work();
        let _ = tx.try_send(result);
    })
    .map_err(|error| error.to_string())?;
    rx.recv()
        .await
        .ok_or_else(|| "window operation did not complete".to_string())?
}

pub(crate) async fn destroy_window<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = tx.send(());
        }
    });
    let app = window.app_handle().clone();
    on_main_thread(&app, move || {
        window.destroy().map_err(|error| error.to_string())
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("window destruction did not complete: {error}"))
}
