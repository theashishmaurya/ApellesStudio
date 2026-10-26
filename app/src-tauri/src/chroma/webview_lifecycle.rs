//! The webview's web content process dying, handled on purpose (B-274, D-402).
//!
//! **What it is.** On macOS the WKWebView renders in a separate web content
//! process, which the OS terminates under memory pressure. WebKit reports it
//! (`webViewWebContentProcessDidTerminate:`), and Tauri exposes that as
//! `Builder::on_web_content_process_terminate` (tauri 2.11, wry 0.55). Without
//! a hook of ours, `tauri-runtime-wry` installs its own, which only logs at
//! `debug` and reloads: the page came back with nobody told.
//!
//! **What it does.** [`on_web_content_process_terminate`] logs the event at
//! `warn` (it reaches `app.log`), records it, and reloads the webview itself.
//! The reloaded page asks [`chroma_webview_take_termination`] once at startup
//! and tells the user; the Edit timeline's own write-ahead journal
//! (`chroma::edit_journal`) has meanwhile replayed every edit the dead page had
//! not saved.
//!
//! **What it does NOT do.** Run anything in the dead page: by the time WebKit
//! calls this, that process is gone, so there is nothing left to flush. That is
//! why the journal writes on every edit instead of at this moment. It cannot
//! prevent a termination either; memory use is the other half of B-274.

use std::sync::Mutex;

use serde::Serialize;

/// One termination, as the next page is told about it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewTermination {
    /// The webview's label (`main` for the app window).
    pub label: String,
    /// RFC 3339, when WebKit reported it.
    pub at: String,
    /// How many terminations this app process has seen, this one included.
    pub count: u64,
}

// Only the macOS/iOS hook records; elsewhere WebKit has no such process.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
struct Terminations {
    count: u64,
    /// The newest termination no page has been told about yet.
    unreported: Option<WebviewTermination>,
}

static TERMINATIONS: Mutex<Terminations> = Mutex::new(Terminations {
    count: 0,
    unreported: None,
});

/// Record a termination of the webview labelled `label` and return it.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
fn record(label: &str) -> WebviewTermination {
    let mut t = TERMINATIONS.lock().unwrap_or_else(|e| e.into_inner());
    t.count += 1;
    let report = WebviewTermination {
        label: label.to_string(),
        at: chrono::Utc::now().to_rfc3339(),
        count: t.count,
    };
    t.unreported = Some(report.clone());
    report
}

/// Hand out the unreported termination, at most once.
fn take() -> Option<WebviewTermination> {
    TERMINATIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .unreported
        .take()
}

/// The `Builder::on_web_content_process_terminate` hook: log, record, reload.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn on_web_content_process_terminate<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let report = record(webview.label());
    log::warn!(
        "webview `{}`: the OS terminated its web content process (termination {} this session, usually memory pressure); reloading it",
        report.label,
        report.count
    );
    if let Err(e) = webview.reload() {
        log::error!(
            "webview `{}`: reload after its web content process died failed: {e}",
            report.label
        );
    }
}

/// The termination the previous page died of, if no page has been told yet.
/// Taken, not peeked: the first page to ask after the reload reports it, and a
/// later ordinary reload does not report it again.
#[tauri::command]
pub fn chroma_webview_take_termination() -> Option<WebviewTermination> {
    take()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, because the record is process-wide.
    #[test]
    fn a_termination_is_reported_once_and_counted() {
        let _ = take();
        let first = record("main");
        let second = record("main");
        assert_eq!(second.count, first.count + 1);
        assert_eq!(take(), Some(second), "the newest one is reported");
        assert_eq!(take(), None, "and only once");
    }
}
