//! # chroma-types — L0 foundation crate (D-039)
//!
//! **What it is:** the shared value types every other Chroma crate speaks in —
//! `Resolution`, `Rational` (a frame rate / aspect as an exact ratio), `Frame`,
//! `ColorSpace`, `TimeRange`, typed IDs, and the crate-wide error enum.
//!
//! **What it does NOT do:** no GPU (`wgpu`), no media I/O (`ffmpeg`), no
//! rendering, no filesystem. Pure data + `serde`. This crate is the root of the
//! one-directional dependency graph (D-039): everything depends on it, it
//! depends on nothing heavy.
//!
//! **Status:** D-039 migration step 1 skeleton — one placeholder of each shape.
//! Real extraction (from `app/src-tauri/src/chroma/*` and greenfield) is a
//! later, per-type, tracked step.

use serde::{Deserialize, Serialize};

/// Pixel dimensions of a frame or output target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Resolution {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

/// An exact ratio — a frame rate (`Rational { num: 24000, den: 1001 }`) or a
/// pixel/display aspect. Kept exact (never collapsed to `f64`) so timebases
/// round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const fn new(num: i64, den: i64) -> Self {
        Self { num, den }
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }
}

/// The crate-wide error type. Every fallible Chroma API returns
/// `Result<_, ChromaError>` (or a crate-local error that converts into this).
#[derive(Debug, thiserror::Error)]
pub enum ChromaError {
    #[error("invalid value: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

/// Convenience alias.
pub type Result<T, E = ChromaError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_builds() {
        let r = Resolution::new(3840, 2160);
        assert_eq!(r.width * r.height, 8_294_400);
        assert!((Rational::new(24000, 1001).as_f64() - 23.976).abs() < 0.001);
    }
}
