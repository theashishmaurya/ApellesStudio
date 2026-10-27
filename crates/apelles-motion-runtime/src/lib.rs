//! # apelles-motion-runtime — Motion's render runtime (D-417)
//!
//! **What it is:** everything about the programs a Motion render runs, apart
//! from running them: the pinned downloads ([`pins`]), fetching one resumably
//! and proving it is the pinned file ([`fetch`]), unpacking it ([`unpack`]),
//! the install on disk with its cheap integrity check and atomic upgrade
//! ([`store`]), the one resolver that answers "which Node, which browser, which
//! engine files" for every render path ([`locate`]), and the process-wide
//! manager the app and the MCP tools talk to ([`manager`]).
//!
//! **Why it exists:** the Motion tab's editor runs in the webview, but its
//! export, preview stills and component certification run Remotion, which
//! needs Node.js and Chrome Headless Shell. Those are ~340 MB on disk and the
//! owner watches the app's size, so they download on demand the first time the
//! Motion tab opens (owner decision recorded with D-391; built as D-417). The
//! engine's own JavaScript (a prebuilt Remotion bundle and the renderer
//! package) ships inside the app instead, so it always matches the app.
//!
//! **Layer:** L1 (I/O: network and filesystem), below `apelles-motion`, which
//! builds the render commands from a located [`locate::MotionRuntime`].
//!
//! **What it does NOT do:** render, bundle, or know anything about manifests.
//! It never installs at launch on its own — the Motion tab or an agent asks.

pub mod error;
pub mod fetch;
pub mod locate;
pub mod manager;
pub mod pins;
pub mod store;
pub mod unpack;

pub use error::RuntimeError;
pub use locate::{Layout, MotionRuntime, RuntimeSource};
pub use manager::{NOT_READY_CODE, RuntimeStatus, State};
