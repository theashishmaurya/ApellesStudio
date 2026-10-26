//! The Openverse HTTP client (D-400): search, one-item detail, and the file
//! download. The only network code in the Edit path, and it runs only when a
//! tool call asks for it.
//!
//! Anonymous use of the API works and is rate limited; the client identifies
//! itself with a real `User-Agent`, waits out a short `429 Retry-After` once,
//! and reports a longer one instead of hammering the service.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use crate::licence::LicencePolicy;
use crate::model::{AudioHit, HitFilter, Kind, SearchPage, parse_hit, parse_search};

const API_BASE: &str = "https://api.openverse.org/v1";
/// Anonymous clients may ask for at most this many results per page.
pub const MAX_PAGE_SIZE: u32 = 20;
pub const DEFAULT_PAGE_SIZE: u32 = 10;
/// A `429 Retry-After` up to this long is waited out once; longer is reported.
const MAX_RETRY_WAIT: Duration = Duration::from_secs(10);
/// Time allowed to open the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Time allowed with no bytes arriving. Idle, not total: Openverse's search has
/// been measured taking 34 s before its first byte (B-275), and a large music
/// bed may take minutes to download while data is still flowing.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// A download longer than this is refused: this tool imports sound, not video.
pub const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const USER_AGENT: &str = concat!(
    "Apelles/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/theashishmaurya/chroma; openverse audio import)"
);

/// What to search for.
#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub kind: Kind,
    pub min_secs: Option<f64>,
    pub max_secs: Option<f64>,
    pub policy: LicencePolicy,
    pub page: u32,
    pub page_size: u32,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(IDLE_TIMEOUT)
            .build()
            .map_err(|e| format!("could not build the HTTP client: {e}"))?;
        Ok(Self {
            http,
            base: API_BASE.to_owned(),
        })
    }

    pub async fn search(&self, req: &SearchRequest) -> Result<SearchPage, String> {
        if req.query.trim().is_empty() {
            return Err("query must not be empty".into());
        }
        let mut params: Vec<(&str, String)> = vec![
            ("q", req.query.trim().to_owned()),
            ("license", req.policy.allowed().join(",")),
            (
                "page_size",
                req.page_size.clamp(1, MAX_PAGE_SIZE).to_string(),
            ),
            ("page", req.page.max(1).to_string()),
            ("mature", "false".to_owned()),
        ];
        if let Some(category) = req.kind.server_category() {
            params.push(("category", category.to_owned()));
        }
        let body = self
            .get_text(&format!("{}/audio/", self.base), &params)
            .await?;
        let filter = HitFilter {
            kind: req.kind,
            min_secs: req.min_secs,
            max_secs: req.max_secs,
            policy: req.policy.clone(),
        };
        parse_search(&body, &filter)
    }

    /// One result by id. The id is checked before it goes into a URL.
    pub async fn detail(&self, id: &str) -> Result<AudioHit, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err(format!(
                "{id:?} is not an Openverse audio id (a UUID, from editor_search_audio)"
            ));
        }
        let body = self
            .get_text(&format!("{}/audio/{id}/", self.base), &[])
            .await?;
        let v: Value = serde_json::from_str(&body)
            .map_err(|e| format!("Openverse sent a body that is not JSON: {e}"))?;
        parse_hit(&v).ok_or_else(|| {
            format!("Openverse's record for {id} is missing its audio url or licence")
        })
    }

    /// Download `url` into `dest` (via a `.part` file renamed on success).
    /// Returns the byte count and the response's `Content-Type`.
    pub async fn download(&self, url: &str, dest: &Path) -> Result<(u64, Option<String>), String> {
        let mut resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| send_error("download failed", &e))?;
        if !resp.status().is_success() {
            return Err(format!("download failed: HTTP {}", resp.status()));
        }
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_DOWNLOAD_BYTES)
        {
            return Err(format!(
                "the file is larger than {} MB; not importing it",
                MAX_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let part = dest.with_extension("part");
        let mut file =
            std::fs::File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;
        let mut written: u64 = 0;
        let result = loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    written += chunk.len() as u64;
                    if written > MAX_DOWNLOAD_BYTES {
                        break Err(format!(
                            "the file is larger than {} MB; not importing it",
                            MAX_DOWNLOAD_BYTES / 1024 / 1024
                        ));
                    }
                    if let Err(e) = file.write_all(&chunk) {
                        break Err(format!("write {}: {e}", part.display()));
                    }
                }
                Ok(None) => break Ok(()),
                Err(e) => break Err(format!("download interrupted: {e}")),
            }
        };
        drop(file);
        if let Err(e) = result {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        if written == 0 {
            let _ = std::fs::remove_file(&part);
            return Err("the download was empty".into());
        }
        std::fs::rename(&part, dest)
            .map_err(|e| format!("move into place {}: {e}", dest.display()))?;
        Ok((written, content_type))
    }

    /// GET with one polite retry on `429`.
    async fn get_text(&self, url: &str, params: &[(&str, String)]) -> Result<String, String> {
        for attempt in 0..2 {
            let resp = self
                .http
                .get(url)
                .query(params)
                .send()
                .await
                .map_err(|e| send_error("could not reach Openverse", &e))?;
            let status = resp.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let wait = retry_after(
                    resp.headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok()),
                );
                match wait {
                    Some(w) if w <= MAX_RETRY_WAIT && attempt == 0 => {
                        tokio::time::sleep(w).await;
                        continue;
                    }
                    Some(w) => {
                        return Err(format!(
                            "Openverse is rate-limiting anonymous requests; try again in about {} s",
                            w.as_secs().max(1)
                        ));
                    }
                    None => {
                        return Err(
                            "Openverse is rate-limiting anonymous requests; try again in a minute"
                                .into(),
                        );
                    }
                }
            }
            if !status.is_success() {
                return Err(format!("Openverse answered HTTP {status}"));
            }
            return resp
                .text()
                .await
                .map_err(|e| format!("could not read Openverse's answer: {e}"));
        }
        Err("Openverse is rate-limiting anonymous requests; try again in a minute".into())
    }
}

/// `Retry-After` as seconds (the HTTP-date form is not used by Openverse and is
/// treated as unknown).
/// A request that never got an answer, worded by why: a timeout is the server
/// being slow (retry later), not the network being down (B-275).
fn send_error(what: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        if e.is_connect() {
            format!(
                "{what}: no connection within {} s",
                CONNECT_TIMEOUT.as_secs()
            )
        } else {
            format!(
                "{what}: Openverse sent nothing for {} s (it is slow at the moment; try again)",
                IDLE_TIMEOUT.as_secs()
            )
        }
    } else {
        format!("{what}: {e}")
    }
}

pub fn retry_after(header: Option<&str>) -> Option<Duration> {
    header?.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// The container to name an imported file with: Openverse's `filetype`, else
/// the URL path's own extension, else the `Content-Type`, else `mp3` (what the
/// catalogues serve as a preview).
pub fn file_extension(
    filetype: Option<&str>,
    url: &str,
    content_type: Option<&str>,
) -> &'static str {
    const KNOWN: [&str; 7] = ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac"];
    let known = |s: &str| {
        KNOWN
            .iter()
            .copied()
            .find(|k| k.eq_ignore_ascii_case(s.trim_start_matches('.')))
    };
    if let Some(e) = filetype.and_then(known) {
        return e;
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    if let Some(e) = path.rsplit_once('.').and_then(|(_, e)| known(e)) {
        return e;
    }
    match content_type
        .map(|c| c.split(';').next().unwrap_or(c).trim().to_lowercase())
        .as_deref()
    {
        Some("audio/wav" | "audio/x-wav" | "audio/wave") => "wav",
        Some("audio/ogg" | "application/ogg") => "ogg",
        Some("audio/flac" | "audio/x-flac") => "flac",
        Some("audio/mp4" | "audio/x-m4a") => "m4a",
        Some("audio/aac") => "aac",
        _ => "mp3",
    }
}

/// `heavy-rain-33d74b38`: a readable, collision-free file stem from a title and
/// an Openverse id.
pub fn file_stem(title: &str, id: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(40).collect();
    let short: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if slug.is_empty() {
        format!("audio-{short}")
    } else {
        format!("{slug}-{short}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_reads_seconds_and_nothing_else() {
        assert_eq!(retry_after(Some("7")), Some(Duration::from_secs(7)));
        assert_eq!(retry_after(Some(" 30 ")), Some(Duration::from_secs(30)));
        assert_eq!(retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(retry_after(None), None);
    }

    #[test]
    fn the_extension_comes_from_the_best_evidence() {
        assert_eq!(file_extension(Some("wav"), "https://x/y", None), "wav");
        assert_eq!(
            file_extension(None, "https://cdn/x/401275_hq.mp3?sig=1", None),
            "mp3"
        );
        assert_eq!(file_extension(None, "https://x/y.OGG", None), "ogg");
        assert_eq!(
            file_extension(
                None,
                "https://jamendo/?trackid=1&format=mp32",
                Some("audio/ogg; charset=x")
            ),
            "ogg"
        );
        assert_eq!(file_extension(None, "https://x/?id=1", None), "mp3");
        assert_eq!(file_extension(Some("exe"), "https://x/y.pdf", None), "mp3");
    }

    #[test]
    fn the_file_stem_is_readable_and_unique_per_id() {
        assert_eq!(
            file_stem("Rain, Moderate, C.wav", "6b072076-066b-45b6"),
            "rain-moderate-c-wav-6b072076"
        );
        assert_eq!(file_stem("!!!", "ab-cd"), "audio-abcd");
        assert!(file_stem(&"x".repeat(200), "1234abcd").len() <= 40 + 1 + 8);
    }

    #[tokio::test]
    async fn a_detail_id_that_is_not_a_uuid_is_refused_before_any_request() {
        let client = Client::new().expect("client");
        let err = client
            .detail("../../etc/passwd")
            .await
            .expect_err("path traversal");
        assert!(err.contains("not an Openverse audio id"), "{err}");
    }

    #[tokio::test]
    async fn an_empty_query_is_refused_before_any_request() {
        let client = Client::new().expect("client");
        let req = SearchRequest {
            query: "  ".into(),
            kind: Kind::Any,
            min_secs: None,
            max_secs: None,
            policy: LicencePolicy::from_request(None).expect("policy"),
            page: 1,
            page_size: 10,
        };
        assert!(client.search(&req).await.is_err());
    }
}
