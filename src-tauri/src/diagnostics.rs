//! 有界生命周期日志；只接受固定字段，不接收错误正文、口令或聊天内容。
use std::io::{Read, Seek, SeekFrom};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

const TARGET: &str = "goodpuppy.lifecycle";
const REPORT_LIMIT: u64 = 1024 * 1024;

pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .targets([Target::new(TargetKind::LogDir {
            file_name: Some("lifecycle".into()),
        })
        .filter(|metadata| metadata.target() == TARGET)])
        .max_file_size(256 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(3))
        .build()
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Operation {
    NativeWindow,
    RoomEnter,
    RoomExit,
    RoomResume,
    SessionChanged,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Phase {
    Start,
    Ok,
    Failed,
    Canceled,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
    Spawn,
    Close,
    Show,
    Hide,
    Leave,
    Quit,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Environment {
    Production,
    Development,
    Test,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Event {
    operation: Operation,
    phase: Phase,
    action: Option<Action>,
    environment: Option<Environment>,
    target_window: Option<String>,
    instance_id: Option<String>,
    request_id: Option<String>,
    room_id: Option<String>,
    session_version: Option<u64>,
    duration_ms: Option<u64>,
}
fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 96
        && token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn is_archive(name: &str) -> bool {
    let Some(date) = name.strip_prefix("lifecycle_").and_then(|v| {
        v.strip_suffix(".log.bak")
            .or_else(|| v.strip_suffix(".log"))
    }) else {
        return false;
    };
    date.len() == 19
        && date.bytes().enumerate().all(|(i, c)| {
            if [4, 7, 13, 16].contains(&i) {
                c == b'-'
            } else if i == 10 {
                c == b'_'
            } else {
                c.is_ascii_digit()
            }
        })
}
// 插件同秒轮转可能产生 .bak；连同这些备份一起限制归档数量。
fn trim_archives<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    trim_archive_directory(&dir).map_err(|e| e.to_string())
}
fn trim_archive_directory(dir: &std::path::Path) -> std::io::Result<()> {
    let mut files = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| {
            is_archive(&entry.file_name().to_string_lossy())
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
    let excess = files.len().saturating_sub(3);
    for entry in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(entry.path());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn record_diagnostic(window: WebviewWindow, event: Event) -> Result<(), String> {
    for token in [
        &event.target_window,
        &event.instance_id,
        &event.request_id,
        &event.room_id,
    ]
    .into_iter()
    .flatten()
    {
        if !valid_token(token) {
            return Err("invalid diagnostic identifier".into());
        }
    }
    log::info!(target: TARGET, "{}", serde_json::json!({ "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "window": window.label(), "event": event }));
    let _ = trim_archives(window.app_handle());
    Ok(())
}
pub(crate) fn native<R: Runtime>(app: &AppHandle<R>, operation: &str, result: &str) {
    log::info!(target: TARGET, "{}", serde_json::json!({ "pid": std::process::id(), "operation": operation, "result": result }));
    let _ = trim_archives(app);
}

#[tauri::command]
pub(crate) fn get_diagnostic_report(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<String, String> {
    if window.label() != "lounge" {
        return Err("diagnostic export requires lounge".into());
    }
    log::logger().flush();
    let directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let mut files = std::fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name == "lifecycle.log" || is_archive(&name))
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
    let mut report = String::new();
    for entry in files
        .into_iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let remaining = REPORT_LIMIT.saturating_sub(report.len() as u64);
        if remaining == 0 {
            break;
        }
        let mut file = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        let keep = length.min(remaining);
        file.seek(SeekFrom::Start(length - keep))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(keep)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        report.push_str(&String::from_utf8_lossy(&bytes));
    }
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_retention_counts_backups_without_removing_other_files() {
        let dir = std::env::temp_dir().join(format!(
            "goodpuppy-log-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        for second in 0..5 {
            std::fs::write(
                dir.join(format!("lifecycle_2026-10-01_12-34-{second:02}.log.bak")),
                "record",
            )
            .unwrap();
        }
        std::fs::write(dir.join("lifecycle.log"), "active").unwrap();
        std::fs::write(dir.join("lifecycle_private.log"), "unrelated").unwrap();
        trim_archive_directory(&dir).unwrap();
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|e| is_archive(&e.file_name().to_string_lossy()))
                .count(),
            3
        );
        assert!(dir.join("lifecycle.log").exists());
        assert!(dir.join("lifecycle_private.log").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn archive_matching_includes_rotation_backups_only() {
        assert!(is_archive("lifecycle_2026-10-01_12-34-56.log.bak"));
        assert!(is_archive("lifecycle_2026-10-01_12-34-56.log"));
        assert!(!is_archive("lifecycle.log"));
        assert!(!is_archive("lifecycle_private.log"));
    }
    #[test]
    fn logs_reject_unknown_content_fields_and_unsafe_identifiers() {
        assert!(serde_json::from_str::<Event>(
            r#"{"operation":"room-enter","phase":"start","message":"secret"}"#
        )
        .is_err());
        assert!(valid_token("room-123"));
        assert!(!valid_token("message text"));
        assert!(!valid_token(&"a".repeat(97)));
    }
}
