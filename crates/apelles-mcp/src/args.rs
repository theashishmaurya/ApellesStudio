//! Building the `args` object a tool posts to the control server (D-312).
//!
//! WHAT THIS IS
//!  [`WireArgs`] — an ordered JSON object built key by key, with "omit when the
//!  caller did not supply it" as a first-class operation.
//!
//! WHY IT IS ITS OWN THING
//!  The omit-when-absent rule is the single most repeated line in the whole tool
//!  surface and the easiest one to get subtly wrong. `None` must mean *the key is not
//!  in the request at all*, never `key: null`: every default in this system lives in
//!  the frontend handler, and a handler that reads `args.speed ?? clip.speed` sees a
//!  null and a missing key differently. Writing that rule once, here, is what keeps
//!  161 tools from each having their own almost-right version of it.
//!
//! WHAT IT DOES NOT DO
//!  No defaults, no renaming, no validation, no type coercion. A tool spells out its
//!  own wire keys — several of them differ from the Python parameter name
//!  (`source_start` goes out as `sourceStart`) — and that mapping stays visible at
//!  the call site rather than being inferred by a rule here.

use serde::Serialize;
use serde_json::{Map, Value};

/// The `args` object of one `POST /op` request.
///
/// Key order is not meaningful and is not preserved (this workspace builds `serde_json`
/// without `preserve_order`, so the map sorts): the control server parses this object,
/// it does not read it. The rendered *output* of a tool is the place where order matters
/// to a reader, and [`crate::render`] gets it from struct field order instead.
#[derive(Debug, Default, Clone)]
pub struct WireArgs(Map<String, Value>);

impl WireArgs {
    pub fn new() -> Self {
        Self(Map::new())
    }

    /// A key that is always sent, whatever its value.
    pub fn set(mut self, key: &str, value: impl Serialize) -> Self {
        self.insert(key, value);
        self
    }

    /// A key sent only when the caller supplied one. An absent argument leaves the key
    /// out entirely — see this module's own doc for why that is not the same as null.
    pub fn put<T: Serialize>(mut self, key: &str, value: Option<T>) -> Self {
        if let Some(value) = value {
            self.insert(key, value);
        }
        self
    }

    /// A flag sent only when it is `true`. A handful of ops treat the key's mere
    /// presence as the signal (`reset`), so sending `false` is not the same as omitting.
    pub fn put_if(mut self, key: &str, flag: bool) -> Self {
        if flag {
            self.insert(key, true);
        }
        self
    }

    fn insert(&mut self, key: &str, value: impl Serialize) {
        let value = serde_json::to_value(value).unwrap_or(Value::Null);
        self.0.insert(key.to_string(), value);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }
}

impl From<WireArgs> for Value {
    fn from(args: WireArgs) -> Self {
        args.into_value()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_absent_argument_leaves_the_key_out_rather_than_sending_null() {
        // The whole reason this module exists. `key: null` reaches a frontend handler
        // as a real value and defeats its `?? default` — an omitted key does not.
        let args = WireArgs::new()
            .put("speed", None::<f64>)
            .put("track", Some(2))
            .into_value();
        assert_eq!(args, json!({ "track": 2 }));
    }

    #[test]
    fn a_supplied_null_is_still_sent_when_the_tool_asks_for_it() {
        // `editor_import_subtitles` sends an explicit null to CLEAR a per-word colour —
        // "no accent on the spoken words" is a real style that an omitted key cannot
        // express. `set` must therefore be able to send null on purpose.
        let args = WireArgs::new().set("activeColor", Value::Null).into_value();
        assert_eq!(args, json!({ "activeColor": null }));
    }

    #[test]
    fn a_false_flag_is_omitted_where_presence_is_the_signal() {
        assert!(WireArgs::new().put_if("reset", false).is_empty());
        assert_eq!(
            WireArgs::new().put_if("reset", true).into_value(),
            json!({ "reset": true })
        );
    }
}
