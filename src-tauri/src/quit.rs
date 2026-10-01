//! 托盘和系统退出共用一次握手；超时后放行，避免重复请求启动多份清理。
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

#[derive(Default)]
pub(crate) struct QuitState(AtomicU8);

impl QuitState {
    pub(crate) fn allowed(&self) -> bool {
        self.0.load(Ordering::SeqCst) == 2
    }
    fn begin(&self) -> bool {
        self.0
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    fn complete(&self) {
        self.0.store(2, Ordering::SeqCst);
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    request_id: String,
}

fn matches_ack(payload: &str, expected: &str) -> bool {
    serde_json::from_str::<QuitRequest>(payload).is_ok_and(|ack| ack.request_id == expected)
}

pub(crate) fn request<R: Runtime>(app: &AppHandle<R>, exit_code: i32) {
    if !app.state::<QuitState>().begin() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let request = QuitRequest {
            request_id: format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
        };
        let expected = request.request_id.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let listener = app.listen("app-quit-ready", move |event| {
            if matches_ack(event.payload(), &expected) {
                let _ = tx.send(());
            }
        });
        let mut acknowledged = false;
        if let Some(pet) = app.get_webview_window("main") {
            if pet.emit("app-before-quit", request).is_ok() {
                acknowledged = rx.recv_timeout(Duration::from_secs(3)).is_ok();
            }
        }
        app.unlisten(listener);
        app.state::<QuitState>().complete();
        #[cfg(debug_assertions)]
        if std::env::var("GOODPUPPY_NATIVE_SMOKE").as_deref() == Ok("1")
            && app.config().identifier == "com.goodpuppy.desktop.native-smoke"
        {
            if acknowledged {
                eprintln!("[native-smoke] QUIT-PASS: correlated cleanup acknowledgement");
            } else {
                eprintln!("[native-smoke] FAIL: quit cleanup acknowledgement missing");
            }
        }
        let _ = acknowledged;
        app.exit(exit_code);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_or_malformed_acknowledgements_do_not_finish_cleanup() {
        assert!(matches_ack(r#"{"requestId":"current"}"#, "current"));
        assert!(!matches_ack(r#"{"requestId":"old"}"#, "current"));
        assert!(!matches_ack("null", "current"));
        assert!(!matches_ack("not-json", "current"));
    }
    #[test]
    fn only_one_cleanup_runs_and_completed_exit_is_allowed() {
        let state = QuitState::default();
        assert!(!state.allowed());
        assert!(state.begin());
        assert!(!state.begin());
        assert!(!state.allowed());
        state.complete();
        assert!(state.allowed());
        assert!(!state.begin());
    }
}
