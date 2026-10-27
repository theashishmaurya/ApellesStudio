//! Word-level text facts the rest of the crate reads: is this word the end of
//! a sentence, of a clause, what is its bare lower-case token.
//!
//! **What it does NOT do.** No meaning. Every function here looks at the
//! characters of one transcript word as the recogniser wrote it (Parakeet
//! punctuates, D-381), and the closed lists below are spelled out so a reader
//! can see exactly what counts.

/// Characters that may trail a sentence-final mark without changing it:
/// closing quotes and brackets (`He said "stop."`).
const TRAILING_CLOSERS: &[char] = &['"', '\'', '\u{201d}', '\u{2019}', ')', ']'];

/// Abbreviations whose full stop is not a sentence end. A closed list on
/// purpose: Parakeet rarely writes them, and guessing at any other dotted
/// token would split sentences on a whim.
const ABBREVIATIONS: &[&str] = &[
    "dr", "e.g", "etc", "i.e", "jr", "mr", "mrs", "ms", "prof", "sr", "st", "u.k", "u.s", "vs",
];

/// How a word ends, as far as sentence and clause boundaries care.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordEnd {
    /// `.` (not an abbreviation's) or `…`.
    Period,
    Question,
    Exclamation,
    /// `,` `;` `:` or a dash — a clause boundary, never a sentence end.
    Clause,
    /// Anything else.
    Open,
}

impl WordEnd {
    /// A sentence-final mark.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Period | Self::Question | Self::Exclamation)
    }
}

/// Classify how one transcript word ends.
pub fn word_end(word: &str) -> WordEnd {
    let trimmed = word.trim().trim_end_matches(TRAILING_CLOSERS);
    let Some(last) = trimmed.chars().last() else {
        return WordEnd::Open;
    };
    match last {
        '?' => WordEnd::Question,
        '!' => WordEnd::Exclamation,
        '\u{2026}' => WordEnd::Period,
        '.' => {
            let stem = trimmed.trim_end_matches('.').to_lowercase();
            if trimmed.ends_with("...") {
                WordEnd::Period
            } else if ABBREVIATIONS.contains(&stem.as_str()) {
                WordEnd::Open
            } else {
                WordEnd::Period
            }
        }
        ',' | ';' | ':' | '\u{2014}' | '\u{2013}' => WordEnd::Clause,
        '-' if trimmed.ends_with("--") => WordEnd::Clause,
        _ => WordEnd::Open,
    }
}

/// The bare lower-case token of a word: leading and trailing punctuation
/// stripped, an internal apostrophe kept (`"It's,"` → `it's`, curly
/// apostrophes folded to `'`).
pub fn token(word: &str) -> String {
    let folded: String = word
        .trim()
        .chars()
        .map(|c| if c == '\u{2019}' { '\'' } else { c })
        .collect();
    folded
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

/// Does the word carry a number: a digit, a percent or currency sign.
pub fn has_number(word: &str) -> bool {
    word.chars()
        .any(|c| c.is_ascii_digit() || matches!(c, '%' | '$' | '\u{20ac}' | '\u{a3}'))
}

/// Spoken number words that make a line a "number" hook as surely as digits
/// do (Parakeet writes most numbers as digits; these are the ones it spells).
const NUMBER_WORDS: &[&str] = &[
    "billion", "half", "hundred", "million", "percent", "thousand", "twice", "trillion",
];

/// A number in the sentence, digits or a spoken magnitude word.
pub fn is_number_word(tok: &str) -> bool {
    NUMBER_WORDS.contains(&tok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentence_ends_are_read_through_closing_quotes() {
        assert_eq!(word_end("done."), WordEnd::Period);
        assert_eq!(word_end("right?"), WordEnd::Question);
        assert_eq!(word_end("wow!"), WordEnd::Exclamation);
        assert_eq!(word_end("stop.\""), WordEnd::Period);
        assert_eq!(word_end("so\u{2026}"), WordEnd::Period);
        assert_eq!(word_end("well..."), WordEnd::Period);
    }

    #[test]
    fn abbreviations_and_clauses_are_not_sentence_ends() {
        assert_eq!(word_end("Dr."), WordEnd::Open);
        assert_eq!(word_end("e.g."), WordEnd::Open);
        assert_eq!(word_end("U.S."), WordEnd::Open);
        assert_eq!(word_end("first,"), WordEnd::Clause);
        assert_eq!(word_end("note:"), WordEnd::Clause);
        assert_eq!(word_end("word"), WordEnd::Open);
        assert_eq!(word_end(""), WordEnd::Open);
        assert!(!WordEnd::Clause.is_terminal());
    }

    #[test]
    fn tokens_keep_an_inner_apostrophe_only() {
        assert_eq!(token(" It\u{2019}s,"), "it's");
        assert_eq!(token("\"Hello!\""), "hello");
        assert_eq!(token("80%"), "80");
        assert!(has_number("80%"));
        assert!(has_number("$5"));
        assert!(!has_number("five"));
        assert!(is_number_word("million"));
    }
}
