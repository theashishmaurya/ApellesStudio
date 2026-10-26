//! The licence policy (D-400): which Creative Commons licences a tool call may
//! pull into a video, and the named reason for every one it refuses.
//!
//! **Why a policy at all.** A published video is a monetisable, redistributable
//! work. Openverse indexes audio under every CC licence, and two families cannot
//! go in one: NonCommercial (`nc`) forbids exactly the use a YouTube channel can
//! turn into, and NoDerivatives (`nd`) forbids cutting, mixing or fading the
//! sound, which is what an editor does to it. Those are refused outright, with
//! the reason said, never dropped silently. ShareAlike (`by-sa`) is allowed only
//! when asked for by name: it obliges the licence of the combined work, a choice
//! for the owner, not a default.
//!
//! **What it does NOT do:** fetch anything, or decide what is *attributable*
//! (that is [`crate::credits`]).

use std::fmt;

/// What a request gets when it names no licences: public-domain dedication and
/// plain attribution, the two that ask nothing of the video but a credit line.
pub const DEFAULT_LICENCES: [&str; 2] = ["cc0", "by"];

/// Every slug a request may name. `pdm` is the public-domain mark.
pub const ALLOWED_LICENCES: [&str; 4] = ["cc0", "pdm", "by", "by-sa"];

/// Why a licence cannot be used, in words a caller can show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LicenceRefusal {
    #[error(
        "licence `{0}` is NonCommercial: it forbids commercial use, and a published video (a monetised channel, a sponsor, an ad) is one. Refused."
    )]
    NonCommercial(String),
    #[error(
        "licence `{0}` is NoDerivatives: it forbids adapting the sound, and cutting, fading or mixing it into a video is an adaptation. Refused."
    )]
    NoDerivatives(String),
    #[error("licence `{slug}` is not one this tool imports (allowed: cc0, pdm, by, by-sa)")]
    Unknown { slug: String },
}

/// The set of licences a search may return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicencePolicy {
    allowed: Vec<String>,
}

impl LicencePolicy {
    /// The policy for a request: `None` or an empty list is
    /// [`DEFAULT_LICENCES`]; otherwise every named slug must be importable.
    ///
    /// NC and ND are refused here, before any network call, so a request that
    /// names one fails with the reason rather than returning fewer results.
    pub fn from_request(requested: Option<&[String]>) -> Result<Self, LicenceRefusal> {
        let slugs: Vec<String> = match requested {
            Some(list) if !list.is_empty() => {
                list.iter().map(|s| s.trim().to_lowercase()).collect()
            }
            _ => DEFAULT_LICENCES.iter().map(|s| (*s).to_owned()).collect(),
        };
        let mut allowed: Vec<String> = Vec::with_capacity(slugs.len());
        for slug in slugs {
            check_slug(&slug)?;
            if !allowed.contains(&slug) {
                allowed.push(slug);
            }
        }
        Ok(Self { allowed })
    }

    /// Whether a result's own licence slug may be used.
    pub fn admits(&self, slug: &str) -> bool {
        let slug = slug.trim().to_lowercase();
        self.allowed.contains(&slug)
    }

    /// The slugs, for the `license=` query parameter.
    pub fn allowed(&self) -> &[String] {
        &self.allowed
    }
}

impl fmt::Display for LicencePolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.allowed.join(", "))
    }
}

/// `Ok` for a slug this tool imports; otherwise the named refusal.
pub fn check_slug(slug: &str) -> Result<(), LicenceRefusal> {
    let slug = slug.trim().to_lowercase();
    let has = |part: &str| slug.split('-').any(|p| p == part);
    if has("nc") {
        return Err(LicenceRefusal::NonCommercial(slug));
    }
    if has("nd") {
        return Err(LicenceRefusal::NoDerivatives(slug));
    }
    if ALLOWED_LICENCES.contains(&slug.as_str()) {
        Ok(())
    } else {
        Err(LicenceRefusal::Unknown { slug })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(slugs: &[&str]) -> Vec<String> {
        slugs.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn no_request_means_cc0_and_by() {
        let p = LicencePolicy::from_request(None).expect("default policy");
        assert_eq!(p.allowed(), ["cc0", "by"]);
        assert_eq!(LicencePolicy::from_request(Some(&[])).expect("empty"), p);
        assert!(p.admits("CC0") && p.admits("by"));
        assert!(!p.admits("by-sa"));
    }

    #[test]
    fn non_commercial_and_no_derivatives_are_refused_by_name() {
        for slug in ["by-nc", "by-nc-sa", "by-nc-nd"] {
            let err = LicencePolicy::from_request(Some(&req(&["by", slug]))).expect_err(slug);
            assert!(
                matches!(err, LicenceRefusal::NonCommercial(_)),
                "{slug}: {err}"
            );
            assert!(err.to_string().contains("NonCommercial"));
        }
        let err = LicencePolicy::from_request(Some(&req(&["by-nd"]))).expect_err("nd");
        assert!(matches!(err, LicenceRefusal::NoDerivatives(_)));
        assert!(err.to_string().contains("NoDerivatives"));
    }

    #[test]
    fn share_alike_is_opt_in_and_unknown_slugs_are_refused() {
        let p = LicencePolicy::from_request(Some(&req(&["cc0", "by", "by-sa", "by"]))).expect("sa");
        assert_eq!(p.allowed(), ["cc0", "by", "by-sa"]);
        assert!(matches!(
            LicencePolicy::from_request(Some(&req(&["gpl"]))),
            Err(LicenceRefusal::Unknown { .. })
        ));
    }
}
