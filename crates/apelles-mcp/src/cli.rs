//! The `apelles-mcp` binary's command line: which transport, on which port (D-313).
//!
//! WHAT THIS IS
//!  [`Cli`] — argv parsed into "serve the tool surface over stdio" or "serve it over
//!  streamable HTTP on this loopback port", plus the `--help` text.
//!
//! WHAT IT DOES NOT DO
//!  No serving, no sockets, no tool logic — it turns strings into a [`Cli`] and
//!  nothing else, which is what lets `main` stay a wiring function and lets the whole
//!  grammar be unit-tested without binding anything.
//!
//! THE DEFAULT IS STDIO, DELIBERATELY
//!  An MCP client that spawns this binary by path passes no arguments, and that is
//!  exactly how every client was registered before D-313. So bare `apelles-mcp` must
//!  keep meaning what it meant in D-312 — HTTP is opt-in via `--http`, never the
//!  default. The app's own supervisor is the thing that passes `--http`.
//!
//! WHY NOT `clap`
//!  Two flags and one value. A dependency, its derive macro and its build time buy
//!  nothing here (CLAUDE.md: a 20-line pure function has no business pulling in a
//!  dependency), and the tests below cover every branch of the grammar.

use crate::serve;

/// What the process was asked to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli {
    /// Serve over stdio — the default, and what a client that spawns this binary by
    /// path gets.
    Stdio,
    /// Serve streamable HTTP on `127.0.0.1:<port>`.
    Http { port: u16 },
    /// Print [`HELP`] and exit 0.
    Help,
}

pub const HELP: &str = "\
apelles-mcp — Apelles' MCP server (the AI-facing tool surface for the running app)

USAGE:
    apelles-mcp [--stdio | --http [--port <PORT>]]

TRANSPORTS:
    --stdio        Serve over stdin/stdout. The DEFAULT, for a client that spawns
                   this binary itself by path.
    --http         Serve streamable HTTP on 127.0.0.1:<PORT>/mcp, so a client only
                   needs a URL. This is how the Apelles desktop app runs it.
    --port <PORT>  Port for --http. Default: $CHROMA_MCP_PORT, else 19790.

OPTIONS:
    -h, --help     Print this help.

ENVIRONMENT:
    CHROMA_MCP_PORT      Default --http port (19790).
    CHROMA_CONTROL_PORT  The running app's control server (19788). Both transports
                         expose the identical tool set and both reach the app here.

The Apelles desktop app must be running either way — every tool is applied by the
app's own frontend through its control server.
";

/// Why an argv could not be parsed. Its `Display` is what the binary prints to stderr
/// before exiting non-zero, so each message names the offending argument and the fix.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CliError {
    #[error("unknown argument '{0}'. Run `apelles-mcp --help`.")]
    Unknown(String),

    #[error("--port needs a value, e.g. `--port {}`.", serve::DEFAULT_HTTP_PORT)]
    PortMissingValue,

    #[error("--port '{0}' is not a port number (1-65535).")]
    PortNotANumber(String),

    #[error("--port only applies to --http; stdio has no port.")]
    PortWithoutHttp,

    #[error("--stdio and --http are mutually exclusive — pick one.")]
    BothTransports,
}

impl Cli {
    /// Parse the arguments *after* the program name.
    ///
    /// The `--http` port is resolved here rather than at serve time so `--port` and
    /// `CHROMA_MCP_PORT` have exactly one precedence rule, in one place: an explicit
    /// `--port` wins, else the env var, else [`serve::DEFAULT_HTTP_PORT`].
    pub fn parse<I, S>(args: I) -> Result<Self, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut http = false;
        let mut stdio = false;
        let mut port: Option<u16> = None;

        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_ref() {
                "-h" | "--help" => return Ok(Self::Help),
                "--http" => http = true,
                "--stdio" => stdio = true,
                "--port" => {
                    let raw = args.next().ok_or(CliError::PortMissingValue)?;
                    let raw = raw.as_ref();
                    port = Some(
                        raw.parse()
                            .map_err(|_| CliError::PortNotANumber(raw.to_string()))?,
                    );
                }
                other => return Err(CliError::Unknown(other.to_string())),
            }
        }

        match (http, stdio) {
            (true, true) => Err(CliError::BothTransports),
            (true, false) => Ok(Self::Http {
                port: port.unwrap_or_else(serve::port_from_env),
            }),
            (false, _) if port.is_some() => Err(CliError::PortWithoutHttp),
            (false, _) => Ok(Self::Stdio),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_is_stdio_so_a_d_312_client_registration_keeps_working() {
        // The whole backward-compatibility contract of D-313, in one assertion: a
        // client that was registered with `-- /path/to/apelles-mcp` passes no
        // arguments and must still get the stdio server it has always got.
        assert_eq!(Cli::parse(Vec::<String>::new()), Ok(Cli::Stdio));
        assert_eq!(Cli::parse(["--stdio"]), Ok(Cli::Stdio));
    }

    #[test]
    fn an_explicit_port_beats_the_environment() {
        assert_eq!(
            Cli::parse(["--http", "--port", "20000"]),
            Ok(Cli::Http { port: 20_000 })
        );
    }

    #[test]
    fn http_without_a_port_falls_back_to_the_default() {
        // Not the env var here — `port_from_env` has its own test for that, and
        // mutating the environment from a test that runs beside others is the bug
        // this split avoids.
        let Ok(Cli::Http { port }) = Cli::parse(["--http"]) else {
            panic!("--http should parse as the HTTP transport");
        };
        assert!(port > 0);
    }

    #[test]
    fn the_bad_argv_cases_each_name_their_own_problem() {
        assert_eq!(Cli::parse(["--port"]), Err(CliError::PortMissingValue));
        assert_eq!(
            Cli::parse(["--http", "--port", "sixteen"]),
            Err(CliError::PortNotANumber("sixteen".into()))
        );
        // A port with no --http is a silent no-op if accepted: the user asked for
        // something on a port and got stdio. Refusing it is the honest answer.
        assert_eq!(
            Cli::parse(["--port", "19790"]),
            Err(CliError::PortWithoutHttp)
        );
        assert_eq!(
            Cli::parse(["--http", "--stdio"]),
            Err(CliError::BothTransports)
        );
        assert_eq!(
            Cli::parse(["--serve"]),
            Err(CliError::Unknown("--serve".into()))
        );
    }

    #[test]
    fn help_wins_wherever_it_appears() {
        assert_eq!(Cli::parse(["--help"]), Ok(Cli::Help));
        assert_eq!(Cli::parse(["-h"]), Ok(Cli::Help));
        // Including alongside a transport flag: someone who asked for help wants the
        // help, not a server on a socket they then have to go and kill.
        assert_eq!(Cli::parse(["--http", "--help"]), Ok(Cli::Help));
    }
}
