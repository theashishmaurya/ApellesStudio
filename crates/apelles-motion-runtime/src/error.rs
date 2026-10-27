//! Why installing or locating the runtime failed, in categories a person (and
//! an agent) can act on.

use std::path::Path;

/// One install / locate failure. [`RuntimeError::kind`] is the stable,
/// machine-readable category the status reports as `errorKind`.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    /// The server could not be reached at all — almost always no internet.
    #[error("cannot reach {host} — check the internet connection and press Retry ({detail})")]
    Offline { host: String, detail: String },
    /// The connection dropped part-way; a retry resumes where it stopped.
    #[error("the download of {url} was interrupted: {detail}")]
    Interrupted { url: String, detail: String },
    /// The server answered with an error status.
    #[error("{url} answered HTTP {status}")]
    Http { url: String, status: u16 },
    /// A downloaded file is not the pinned file.
    #[error(
        "{file} is not the expected download ({detail}); it was deleted and will be fetched again"
    )]
    Checksum { file: String, detail: String },
    /// Not enough free space for the download and the unpacked runtime.
    #[error(
        "not enough disk space: the Motion runtime needs {need_mb} MB free on the disk holding {dir}, and {free_mb} MB are free"
    )]
    DiskSpace {
        need_mb: u64,
        free_mb: u64,
        dir: String,
    },
    /// An archive could not be unpacked, or did not contain what it should.
    #[error("could not unpack {file}: {detail}")]
    Archive { file: String, detail: String },
    /// A filesystem operation failed.
    #[error("could not {what} {path}: {detail}")]
    Io {
        what: String,
        path: String,
        detail: String,
    },
    /// An install or removal is already running.
    #[error("{0}")]
    Busy(String),
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl RuntimeError {
    /// The stable category name (`errorKind` on the wire).
    pub fn kind(&self) -> &'static str {
        match self {
            RuntimeError::Offline { .. } => "offline",
            RuntimeError::Interrupted { .. } => "interrupted",
            RuntimeError::Http { .. } => "http",
            RuntimeError::Checksum { .. } => "checksum",
            RuntimeError::DiskSpace { .. } => "diskSpace",
            RuntimeError::Archive { .. } => "archive",
            RuntimeError::Io { .. } => "io",
            RuntimeError::Busy(_) => "busy",
            RuntimeError::Other(_) => "other",
        }
    }

    /// A filesystem failure on `path`.
    pub fn io(what: &str, path: &Path, e: std::io::Error) -> Self {
        RuntimeError::Io {
            what: what.to_string(),
            path: path.display().to_string(),
            detail: e.to_string(),
        }
    }

    /// Classify a failed request: no connection at all is `Offline`; a request
    /// that connected and then failed is `Interrupted`.
    pub fn from_request(url: &str, e: &reqwest::Error) -> Self {
        if e.is_connect() || (e.is_timeout() && !e.is_body()) {
            let host = reqwest::Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| url.to_string());
            return RuntimeError::Offline {
                host,
                detail: e.to_string(),
            };
        }
        RuntimeError::Interrupted {
            url: url.to_string(),
            detail: e.to_string(),
        }
    }

    /// Whether trying the same download again, at once, may succeed (the
    /// installer retries these a few times before giving up).
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            RuntimeError::Interrupted { .. } | RuntimeError::Checksum { .. }
        )
    }
}
