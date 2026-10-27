//! What a reloaded page needs to put the window back the way it was (B-277,
//! D-410).
//!
//! **What it is.** The Rust process outlives the webview's page: a web content
//! process terminated by macOS (B-274) or a dev full reload replaces the page
//! and keeps this process. Two facts the new page needs survive here: which
//! project was open (`state::current_project()`, which the backend already
//! owned for saving and the launcher's delete guard) and which tab was showing
//! (recorded here by the page whenever it changes).
//!
//! **What it does.** [`chroma_page_session_set_tab`] records the active tab;
//! [`chroma_page_session_get`] answers both facts in one call, and the page's
//! start-up (`app/src/utils/pageSessionRestore.ts`) reopens the project on that
//! tab, which also replays the Edit journal (D-402).
//!
//! **What it does NOT do.** Persist anything: both facts live in this process's
//! memory only, so a cold launch starts empty and opens the launcher on the
//! default tab, as it always has (B-007: the active tab is session-only). It
//! does not reopen the project itself either; the page does, through the same
//! `chroma_project_open` every open uses. An in-memory "Untitled" session has
//! no project here and is not restored.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::state;

/// The app's three tabs, as `@apelles/shell`'s `ShellTabId` names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppTab {
    Edit,
    Motion,
    Colorist,
}

/// The project a reloaded page should reopen.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenProject {
    pub name: String,
    pub path: String,
}

/// What [`chroma_page_session_get`] answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSession {
    /// The project the previous page had open, `None` on a cold launch, after
    /// "‹ Projects", or for an Untitled session.
    pub project: Option<OpenProject>,
    /// The tab the previous page last showed, `None` until a page reports one.
    pub active_tab: Option<AppTab>,
}

static ACTIVE_TAB: Mutex<Option<AppTab>> = Mutex::new(None);

fn set_tab(tab: AppTab) {
    *ACTIVE_TAB.lock().unwrap_or_else(|e| e.into_inner()) = Some(tab);
}

fn active_tab() -> Option<AppTab> {
    *ACTIVE_TAB.lock().unwrap_or_else(|e| e.into_inner())
}

fn current() -> PageSession {
    PageSession {
        project: state::current_project().map(|p| OpenProject {
            name: p.name,
            path: p.path.to_string_lossy().into_owned(),
        }),
        active_tab: active_tab(),
    }
}

/// Record the tab the page is showing. Called by the page on every switch.
#[tauri::command]
pub fn chroma_page_session_set_tab(tab: AppTab) {
    set_tab(tab);
}

/// The open project and active tab a reloaded page should restore.
#[tauri::command]
pub fn chroma_page_session_get() -> PageSession {
    current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// One test, because both facts are process-wide.
    #[test]
    fn the_session_follows_the_open_project_and_the_last_tab() {
        let _guard = crate::chroma::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let before = state::current_project();

        state::set_project(None);
        assert_eq!(current().project, None, "nothing open: nothing to reopen");

        state::set_project(Some(state::ProjectRef {
            path: PathBuf::from("/tmp/Fix check.chroma"),
            name: "Fix check".into(),
        }));
        set_tab(AppTab::Motion);
        let s = current();
        assert_eq!(
            s.project,
            Some(OpenProject {
                name: "Fix check".into(),
                path: "/tmp/Fix check.chroma".into()
            })
        );
        assert_eq!(s.active_tab, Some(AppTab::Motion));

        set_tab(AppTab::Colorist);
        assert_eq!(
            current().active_tab,
            Some(AppTab::Colorist),
            "the latest tab wins"
        );

        state::set_project(None);
        assert_eq!(current().project, None, "a closed project is not reopened");

        state::set_project(before);
    }

    #[test]
    fn tabs_use_the_shells_names_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&AppTab::Colorist).ok().as_deref(),
            Some("\"colorist\"")
        );
        assert_eq!(
            serde_json::from_str::<AppTab>("\"edit\"").ok(),
            Some(AppTab::Edit)
        );
        assert!(serde_json::from_str::<AppTab>("\"settings\"").is_err());
        let s = PageSession {
            project: None,
            active_tab: Some(AppTab::Edit),
        };
        assert_eq!(
            serde_json::to_value(&s).ok(),
            Some(serde_json::json!({ "project": null, "activeTab": "edit" }))
        );
    }
}
