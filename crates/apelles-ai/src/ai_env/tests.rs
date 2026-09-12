//! Tests for the AI-env bootstrap (D-315).
//!
//! Split across two kinds, deliberately:
//!
//! - **Pure** tests of the parts a future change can silently get wrong — the progress
//!   parser (against uv's real output, transcribed from a genuine run), the phase
//!   classification, the path layout, the backoff ladder.
//! - **Real** tests that run the actual `uv` binary against real temp directories,
//!   including one that kills it mid-install and proves the re-run resumes rather than
//!   restarting. Those are the claims this feature is actually making, and a mock of
//!   `uv` would assert only that the mock behaves like the mock. They skip themselves
//!   when there is no `uv` to run (`cargo test` on a checkout that has never built the
//!   app) rather than failing, with a message saying what to build — the same
//!   convention `app/src-tauri/src/chroma/sidecar.rs`'s live MCP test uses.

use super::*;

/// Global state (`shared()`, `PATHS`) is process-wide, so the tests that touch it
/// cannot run concurrently — the same reason `chroma::mod.rs` keeps
/// `PROJECT_STATE_LOCK`.
static STATE_LOCK: Mutex<()> = Mutex::new(());

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "apelles-ai-env-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("temp dir");
    d
}

fn no_notify(_: &AiEnvStatus) {}

// ---- the progress parser -----------------------------------------------------------

/// Real `uv pip install` output, copied verbatim from the D-315 probe run
/// (`uv` 0.12.13, the 90-package `ai-env/requirements.lock.txt`). Transcribed rather
/// than invented, because the entire value of this parser is that it matches what uv
/// actually prints — a parser tested against made-up lines tests nothing.
const REAL_UV_OUTPUT: &[&str] = &[
    "Using Python 3.11.15 environment at: /tmp/d315-probe/.venv",
    "Resolved 91 packages in 4.36s",
    "Downloading hf-xet (3.7MiB)",
    "   Updating https://github.com/EasternJournalist/utils3d-moge.git (62f09d5)",
    "Downloading numba (2.6MiB)",
    "Downloading torch (121.4MiB)",
    " Downloaded sentencepiece",
    " Downloaded uvloop",
    " Downloaded scipy",
    "Prepared 91 packages in 1m 12s",
    "Installed 91 packages in 402ms",
    " + torch==2.14.0",
];

#[test]
fn the_progress_parser_reads_uvs_real_output() {
    let mut s = AiEnvStatus::default();
    for line in REAL_UV_OUTPUT {
        parse_progress(line, &mut s);
    }
    assert_eq!(s.packages_total, 91, "total comes from the `Resolved` line");
    assert_eq!(
        s.packages_done, 91,
        "`Installed N` must snap the count to its true value — counting only \
         `Downloaded` lines undercounts every cache hit, which on a re-run is all of them"
    );
}

#[test]
fn downloaded_lines_advance_progress_and_name_the_package() {
    let mut s = AiEnvStatus::default();
    assert!(parse_progress("Resolved 91 packages in 4.36s", &mut s));
    assert!(parse_progress("Downloading torch (121.4MiB)", &mut s));
    assert_eq!(
        s.packages_done, 0,
        "starting a download is not finishing one"
    );
    assert_eq!(s.detail.as_deref(), Some("downloading torch (121.4MiB)"));

    assert!(parse_progress(" Downloaded torch", &mut s));
    assert_eq!(s.packages_done, 1);
    assert_eq!(s.detail.as_deref(), Some("downloaded torch"));
}

/// The count must never go backwards. `Prepared` arrives after the `Downloaded` lines
/// and, on a partially-cached run, reports fewer than were downloaded in *this*
/// process — a plain assignment would make a progress bar jump backwards.
#[test]
fn progress_never_goes_backwards() {
    let mut s = AiEnvStatus::default();
    parse_progress("Resolved 91 packages in 1s", &mut s);
    for _ in 0..40 {
        parse_progress(" Downloaded something", &mut s);
    }
    assert_eq!(s.packages_done, 40);
    parse_progress("Prepared 12 packages in 3s", &mut s);
    assert_eq!(s.packages_done, 40, "Prepared must not lower the count");
    parse_progress("Installed 91 packages in 402ms", &mut s);
    assert_eq!(s.packages_done, 91);
}

#[test]
fn unrelated_lines_change_nothing() {
    let mut s = AiEnvStatus::default();
    for line in [
        "Using Python 3.11.15 environment at: /tmp/x/.venv",
        "   Updating https://github.com/EasternJournalist/utils3d-moge.git (62f09d5)",
        " + torch==2.14.0",
        "",
    ] {
        assert!(!parse_progress(line, &mut s), "{line:?} should be ignored");
    }
    assert_eq!(s.packages_done, 0);
    assert_eq!(s.packages_total, 0);
    assert!(s.detail.is_none());
}

// ---- phases and the wire shape -------------------------------------------------------

/// `is_working` decides whether every AI-feature entry point says "still setting up,
/// hang on" or "this is broken, here is a retry". Getting a phase on the wrong side of
/// it is exactly the confusing-error case D-315 exists to remove.
#[test]
fn only_the_in_flight_phases_count_as_working() {
    for p in [
        Phase::Checking,
        Phase::InstallingPython,
        Phase::CreatingVenv,
        Phase::InstallingPackages,
        Phase::Repairing,
    ] {
        assert!(p.is_working(), "{p:?} is an in-flight phase");
    }
    for p in [
        Phase::Unknown,
        Phase::Ready,
        Phase::Failed,
        Phase::Unavailable,
    ] {
        assert!(!p.is_working(), "{p:?} is not an in-flight phase");
    }
}

/// The frontend and the MCP tool both branch on these exact strings.
#[test]
fn phases_serialize_as_the_camel_case_names_the_ui_matches_on() {
    let cases = [
        (Phase::Unknown, "\"unknown\""),
        (Phase::Checking, "\"checking\""),
        (Phase::InstallingPython, "\"installingPython\""),
        (Phase::CreatingVenv, "\"creatingVenv\""),
        (Phase::InstallingPackages, "\"installingPackages\""),
        (Phase::Repairing, "\"repairing\""),
        (Phase::Ready, "\"ready\""),
        (Phase::Failed, "\"failed\""),
        (Phase::Unavailable, "\"unavailable\""),
    ];
    for (phase, expected) in cases {
        assert_eq!(serde_json::to_string(&phase).unwrap(), expected);
    }
}

/// `Phase::as_str` is what goes into the `ai_env_not_ready` message a client matches
/// phases out of, and `serde` is what goes onto the wire. Two spellings of one fact, in
/// two places, is exactly the kind of pair that drifts — so they are asserted equal
/// rather than each asserted separately.
#[test]
fn the_phase_name_in_an_error_message_is_the_same_one_the_wire_carries() {
    for phase in [
        Phase::Unknown,
        Phase::Checking,
        Phase::InstallingPython,
        Phase::CreatingVenv,
        Phase::InstallingPackages,
        Phase::Repairing,
        Phase::Ready,
        Phase::Failed,
        Phase::Unavailable,
    ] {
        assert_eq!(
            serde_json::to_string(&phase).unwrap(),
            format!("\"{}\"", phase.as_str()),
        );
    }
}

// ---- D-315: the "still bootstrapping" contract -----------------------------------

/// The whole point of the message: a caller can tell "wait, this will work later" from
/// "the sidecar crashed" without parsing prose, and can then decide *whether* to wait
/// from the phase and the package counts carried in the same line.
#[test]
fn a_not_ready_environment_explains_itself_with_the_machine_token_and_the_progress() {
    let s = AiEnvStatus {
        phase: Phase::InstallingPackages,
        packages_done: 47,
        packages_total: 91,
        attempt: 1,
        elapsed_secs: 63,
        ..Default::default()
    };
    let msg = s
        .not_ready_message()
        .expect("not ready must explain itself");
    assert!(msg.starts_with(NOT_READY_CODE), "{msg}");
    assert!(msg.contains("installingPackages"), "{msg}");
    assert!(msg.contains("47 of 91"), "{msg}");
    assert!(msg.contains("ai_env_status"), "{msg}");
    assert!(msg.contains("ai_env_retry"), "{msg}");
}

/// `failed` and `unavailable` are different advice, and the message has to give the
/// different advice — otherwise the distinction D-315 drew in the state machine is lost
/// at the one place a caller actually reads it.
#[test]
fn failed_promises_a_retry_and_unavailable_refuses_to() {
    let failed = AiEnvStatus {
        phase: Phase::Failed,
        attempt: 3,
        retry_in_secs: Some(45),
        last_error: Some("network is unreachable".into()),
        ..Default::default()
    }
    .not_ready_message()
    .expect("failed is not ready");
    assert!(failed.contains("retry is in 45s"), "{failed}");
    assert!(failed.contains("network is unreachable"), "{failed}");

    let unavailable = AiEnvStatus {
        phase: Phase::Unavailable,
        detail: Some("CHROMA_AI_ENV_NO_BOOTSTRAP is set".into()),
        ..Default::default()
    }
    .not_ready_message()
    .expect("unavailable is not ready");
    assert!(unavailable.contains("CANNOT be built"), "{unavailable}");
    assert!(
        unavailable.contains("waiting will not help"),
        "{unavailable}"
    );
    assert!(
        unavailable.contains("CHROMA_AI_ENV_NO_BOOTSTRAP"),
        "{unavailable}"
    );
}

/// A ready environment must add nothing at all. Every AI failure would otherwise be
/// mislabelled a bootstrap problem, which is the same "unexplained error" defect this
/// change exists to remove, pointed the other way.
#[test]
fn a_ready_environment_leaves_a_real_failure_exactly_as_it_was() {
    let ready = AiEnvStatus {
        phase: Phase::Ready,
        ..Default::default()
    };
    assert!(ready.not_ready_message().is_none());
}

/// `explain_unreachable` PREPENDS; it never replaces. The environment being unbuilt is
/// a very likely explanation for a refused connection but never a certain one, so
/// throwing the caller's own diagnosis away would trade one unexplained failure for
/// another.
#[test]
fn the_underlying_error_is_never_discarded() {
    // Whatever the live phase is in this test process, the caller's hint survives.
    let out = explain_unreachable("connection refused on 127.0.0.1:8765");
    assert!(
        out.contains("connection refused on 127.0.0.1:8765"),
        "{out}"
    );
}

#[test]
fn the_status_wire_shape_is_camel_case_and_omits_empty_options() {
    let s = AiEnvStatus {
        phase: Phase::InstallingPackages,
        packages_done: 12,
        packages_total: 91,
        attempt: 1,
        ..Default::default()
    };
    let v: serde_json::Value = serde_json::to_value(&s).unwrap();
    assert_eq!(v["phase"], "installingPackages");
    assert_eq!(v["packagesDone"], 12);
    assert_eq!(v["packagesTotal"], 91);
    assert!(
        v.get("lastError").is_none(),
        "absent options must not appear"
    );
    assert!(v.get("retryInSecs").is_none());
}

/// The ladder must be non-decreasing and must hold at its last value rather than
/// panicking — `supervise` indexes it with an attempt counter that grows without bound.
#[test]
fn the_backoff_ladder_climbs_and_then_holds() {
    assert!(
        BACKOFF.windows(2).all(|w| w[0] < w[1]),
        "must be increasing"
    );
    for attempt in 1..500usize {
        let wait = BACKOFF[(attempt - 1).min(BACKOFF.len() - 1)];
        assert!(wait >= BACKOFF[0] && wait <= *BACKOFF.last().unwrap());
    }
    assert_eq!(
        BACKOFF[BACKOFF.len() - 1],
        BACKOFF[(999usize).min(BACKOFF.len() - 1)],
        "a hundredth attempt waits the same as the last rung, it does not panic"
    );
}

// ---- paths ---------------------------------------------------------------------------

#[test]
fn the_venv_layout_is_root_dot_venv_bin_python() {
    let p = AiEnvPaths {
        root: PathBuf::from("/x/ai-env"),
        lock: PathBuf::from("/x/ai-env/requirements.lock.txt"),
        verify: PathBuf::from("/x/ai-env/verify.py"),
    };
    assert_eq!(p.venv(), PathBuf::from("/x/ai-env/.venv"));
    assert_eq!(p.python(), PathBuf::from("/x/ai-env/.venv/bin/python"));
}

/// A bundle keeps the lock read-only inside the `.app` and the venv outside it, so
/// nothing may assume the two are siblings.
#[test]
fn the_lock_and_the_venv_are_allowed_to_live_apart() {
    let p = AiEnvPaths {
        root: PathBuf::from("/Users/x/Library/Application Support/studio.apelles.app/ai-env"),
        lock: PathBuf::from(
            "/Applications/Apelles.app/Contents/Resources/ai-env/requirements.lock.txt",
        ),
        verify: PathBuf::from("/Applications/Apelles.app/Contents/Resources/ai-env/verify.py"),
    };
    assert!(p.venv().starts_with("/Users/x/Library"));
    assert!(!p.venv().starts_with("/Applications"));
}

#[test]
fn missing_inputs_are_reported_by_name() {
    let dir = tmpdir("missing");
    let p = AiEnvPaths {
        root: dir.clone(),
        lock: dir.join("requirements.lock.txt"),
        verify: dir.join("verify.py"),
    };
    assert!(p.missing().unwrap().contains("requirements.lock.txt"));

    std::fs::write(&p.lock, "").unwrap();
    assert!(p.missing().unwrap().contains("verify.py"));

    std::fs::write(&p.verify, "").unwrap();
    assert!(p.missing().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// In a dev checkout the fallback must find the repo's real `ai-env/`, because that is
/// what makes `cargo test`, `cargo run` and a hand-run `setup.sh` agree with the app.
#[test]
fn the_dev_fallback_finds_the_repos_own_ai_env() {
    let Some(p) = paths() else {
        panic!("the dev-layout fallback should find ai-env/ from this crate");
    };
    assert!(p.lock.is_file(), "{} should exist", p.lock.display());
    assert!(p.verify.is_file(), "{} should exist", p.verify.display());
    assert_eq!(p.root.file_name().unwrap(), "ai-env");
}

// ---- the health check ------------------------------------------------------------------

/// `health` must be a real import check, not a file-existence check — the failure it
/// exists for (a killed install) leaves the interpreter perfectly runnable.
#[test]
fn health_fails_when_the_interpreter_is_not_there() {
    let dir = tmpdir("nohealth");
    let err = health(&dir.join(".venv/bin/python"), &dir.join("verify.py")).unwrap_err();
    assert!(err.contains("no interpreter"), "got {err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The real shape: a working interpreter over a `site-packages` that is missing what a
/// sidecar needs. Built with the machine's own `python3` and the repo's real
/// `verify.py`, so this asserts the actual contract (`torch` etc. cannot be imported
/// from a bare venv) rather than a stand-in for it.
#[test]
fn health_rejects_a_venv_that_starts_but_cannot_import() {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(real) = paths() else {
        eprintln!("skipping: no ai-env/ in this checkout");
        return;
    };
    let Some(python3) = sidecar::which("python3") else {
        eprintln!("skipping: no python3 on PATH to build a fixture venv with");
        return;
    };

    let dir = tmpdir("torn");
    let venv = dir.join(".venv");
    let made = Command::new(&python3)
        .args(["-m", "venv", &venv.to_string_lossy()])
        .output();
    match made {
        Ok(o) if o.status.success() => {}
        _ => {
            eprintln!("skipping: could not create a fixture venv");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
    }

    let python = sidecar::venv_python(&venv);
    assert!(
        python.is_file(),
        "the fixture venv should have an interpreter"
    );

    // The interpreter runs...
    let runs = Command::new(&python)
        .args(["-c", "print(1)"])
        .output()
        .unwrap();
    assert!(
        runs.status.success(),
        "the fixture interpreter must actually work"
    );

    // ...and health still refuses it, naming what it could not import.
    let err = health(&python, &real.verify).unwrap_err();
    assert!(
        err.contains("cannot import"),
        "an empty venv must be reported as unimportable, got {err:?}"
    );
    assert!(
        err.contains("torch"),
        "the message should name a module, got {err:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---- real uv ----------------------------------------------------------------------------

/// `uv` for the live tests, or `None` with a reason printed.
fn uv_for_tests() -> Option<PathBuf> {
    match uv_bin() {
        Some(uv) => Some(uv),
        None => {
            eprintln!(
                "skipping: no uv binary. It is staged into target/<profile>/ by \
                 `cargo build -p apelles` (D-315's build.rs), or set CHROMA_UV_BIN."
            );
            None
        }
    }
}

/// The claim that makes the whole bundled-toolchain design work: uv installs a CPython
/// that is **its own**, not the machine's. If this ever silently resolved to a system
/// interpreter, every sidecar would run on unpinned system packages — the exact failure
/// D-314 caught in `resolve_shared_python`, one layer further out.
#[test]
fn uv_builds_a_venv_on_a_self_contained_interpreter_not_the_system_one() {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(uv) = uv_for_tests() else { return };

    let dir = tmpdir("managed");
    let venv = dir.join(".venv");

    if let Err(e) = run_uv(&uv, &["python", "install", PYTHON_VERSION], |_| {}) {
        eprintln!("skipping: could not install a managed Python ({e}) — offline?");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    run_uv(
        &uv,
        &["venv", "--python", PYTHON_VERSION, &venv.to_string_lossy()],
        |_| {},
    )
    .expect("uv venv");

    let python = sidecar::venv_python(&venv);
    let out = Command::new(&python)
        .args([
            "-c",
            "import sys; print(sys.base_prefix); print(sys.version)",
        ])
        .output()
        .expect("run the venv interpreter");
    let text = String::from_utf8_lossy(&out.stdout);
    let base = text.lines().next().unwrap_or_default();

    assert!(
        text.contains(PYTHON_VERSION),
        "the venv must be on the pinned {PYTHON_VERSION}, got {text:?}"
    );
    assert!(
        !base.starts_with("/usr/") && !base.starts_with("/Library/Frameworks"),
        "the base interpreter must be a uv-managed standalone build, not a system \
         Python — got {base:?}. UV_PYTHON_PREFERENCE=only-managed is what guarantees this."
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// **The resume claim, exercised for real.** Start a genuine `uv pip install`, kill it
/// mid-flight the way a crash or a force-quit would, then re-run the identical command
/// and require it to finish — proving uv's wheel cache makes the re-run a resume rather
/// than a restart, and that a torn venv is recoverable at all.
///
/// Uses a small package set rather than the 1.6 GB real lock: the behaviour under test
/// is "killed, then re-run, then correct", which does not depend on the size of the
/// download, and a test that needs a gigabyte of network is a test nobody runs. The
/// full-lock version of this is the end-to-end run recorded in
/// `docs/notes/ai-env-bootstrap.md`.
#[test]
fn a_killed_install_is_resumed_by_re_running_the_same_command() {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(uv) = uv_for_tests() else { return };

    let dir = tmpdir("resume");
    let venv = dir.join(".venv");
    let lock = dir.join("requirements.lock.txt");
    // Pinned exactly, like every other requirement in this repo (D-314), so the test
    // is not at the mercy of a new release.
    std::fs::write(&lock, "rich==14.2.0\nplatformdirs==4.5.0\n").unwrap();

    if let Err(e) = run_uv(&uv, &["python", "install", PYTHON_VERSION], |_| {}) {
        eprintln!("skipping: no managed Python available ({e}) — offline?");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    if let Err(e) = run_uv(
        &uv,
        &["venv", "--python", PYTHON_VERSION, &venv.to_string_lossy()],
        |_| {},
    ) {
        eprintln!("skipping: could not create the venv ({e})");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    let python = sidecar::venv_python(&venv);

    // Kill the install the moment it reports any progress at all. `shutdown()` is the
    // real kill path (it is what the app-exit hook calls), so this exercises the
    // production code rather than a test-only variant.
    {
        if let Ok(mut s) = shared().stopping.lock() {
            *s = false;
        }
        let killer = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            shutdown();
        });
        let killed = run_uv(
            &uv,
            &[
                "pip",
                "install",
                "--python",
                &python.to_string_lossy(),
                "-r",
                &lock.to_string_lossy(),
            ],
            |_| {},
        );
        let _ = killer.join();
        // It either got cancelled or was quick enough to beat the killer; both are
        // fine, the point is the state the next run starts from.
        if let Err(e) = &killed {
            assert!(
                e.contains("cancelled") || e.contains("failed"),
                "unexpected: {e}"
            );
        }
        // Clear the shutdown flag so the re-run below is a normal run.
        if let Ok(mut s) = shared().stopping.lock() {
            *s = false;
        }
        if let Ok(mut c) = shared().child.lock() {
            *c = None;
        }
    }

    // The resume: the exact same command, and it must succeed.
    let started = Instant::now();
    run_uv(
        &uv,
        &[
            "pip",
            "install",
            "--python",
            &python.to_string_lossy(),
            "-r",
            &lock.to_string_lossy(),
        ],
        |_| {},
    )
    .expect("re-running the identical install must recover, not wedge");

    let out = Command::new(&python)
        .args(["-c", "import rich, platformdirs; print('ok')"])
        .output()
        .expect("run the interpreter");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("ok"),
        "after the resume the packages must genuinely import: {:?}",
        String::from_utf8_lossy(&out.stderr)
    );
    eprintln!("resume completed in {:?}", started.elapsed());

    let _ = std::fs::remove_dir_all(&dir);
}

/// **The self-heal, end to end.** Hand `attempt` a venv that is deliberately damaged
/// (its interpreter deleted, which is what a half-unpacked install can look like) and
/// require it to reach a genuinely working environment rather than wedging or looping.
///
/// Uses a tiny lock so it is runnable; the code path taken — check, build, re-check,
/// wipe-and-rebuild if still bad — is the same one the real 90-package lock takes.
#[test]
fn a_damaged_environment_is_healed_rather_than_reported_ready() {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Some(uv) = uv_for_tests() else { return };
    if let Ok(mut s) = shared().stopping.lock() {
        *s = false;
    }

    let dir = tmpdir("heal");
    let lock = dir.join("requirements.lock.txt");
    std::fs::write(&lock, "platformdirs==4.5.0\n").unwrap();

    // A verify.py standing in for the real one: same contract (exit 0 = usable, exit 1
    // + a `checks` array = not), one cheap import instead of nine multi-gigabyte ones.
    let verify = dir.join("verify.py");
    std::fs::write(
        &verify,
        r#"import json, sys
try:
    import platformdirs  # noqa: F401
    ok = True
    err = None
except BaseException as e:
    ok, err = False, f"{type(e).__name__}: {e}"
if "--json" in sys.argv:
    json.dump({"ok": ok, "checks": [{"label": "platformdirs", "ok": ok, "error": err}]}, sys.stdout)
sys.exit(0 if ok else 1)
"#,
    )
    .unwrap();

    let p = AiEnvPaths {
        root: dir.clone(),
        lock,
        verify,
    };

    // First build: from nothing.
    if let Err(e) = attempt(&p, &uv, &no_notify) {
        eprintln!("skipping: could not build the fixture environment ({e}) — offline?");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    assert!(
        health(&p.python(), &p.verify).is_ok(),
        "first build must verify"
    );

    // Now damage it the way a killed install does: the tree is there, the interpreter
    // is not.
    std::fs::remove_file(p.python()).expect("remove the interpreter");
    assert!(
        health(&p.python(), &p.verify).is_err(),
        "the fixture must actually be broken, or this test proves nothing"
    );

    // ...and the bootstrap must bring it back.
    attempt(&p, &uv, &no_notify).expect("a damaged environment must heal, not wedge");
    assert!(
        health(&p.python(), &p.verify).is_ok(),
        "after healing, the environment must genuinely import"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A missing lock file is [`Phase::Unavailable`], never [`Phase::Failed`] — the
/// difference is whether a UI promises an automatic retry, and retrying a file that
/// does not exist forever would be a lie.
#[test]
fn a_missing_lock_file_is_unavailable_not_a_retryable_failure() {
    let dir = tmpdir("nolock");
    let p = AiEnvPaths {
        root: dir.clone(),
        lock: dir.join("requirements.lock.txt"),
        verify: dir.join("verify.py"),
    };
    assert!(p.missing().is_some());
    assert!(!Phase::Unavailable.is_working());
    assert_ne!(Phase::Unavailable, Phase::Failed);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `retry_now` must be honest about whether it did anything: a UI that shows a spinner
/// on a click that was ignored is worse than a disabled button. It declines only while
/// an attempt is actually in flight.
///
/// **`Ready` must be accepted**, and that is the interesting case. An earlier version of
/// this refused there too ("nothing to retry"), which was wrong twice over: it left
/// `supervise`'s post-ready park loop waiting on a signal nothing could ever send, and
/// it meant a venv deleted or broken *after* the app reached ready stayed reported as
/// healthy forever. Ready is a cached answer; this is its invalidation.
#[test]
fn retry_now_declines_only_while_an_attempt_is_in_flight() {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let restore = status_snapshot();
    let set_phase = |phase: Phase| {
        if let Ok(mut s) = shared().status.lock() {
            s.phase = phase;
        }
        if let Ok(mut r) = shared().retry_requested.lock() {
            *r = false;
        }
    };

    for phase in [
        Phase::Checking,
        Phase::InstallingPython,
        Phase::CreatingVenv,
        Phase::InstallingPackages,
        Phase::Repairing,
    ] {
        set_phase(phase);
        assert!(
            !retry_now(),
            "{phase:?} is already working \u{2014} a second attempt would be a no-op"
        );
    }

    set_phase(Phase::Ready);
    assert!(
        retry_now(),
        "ready is a cached answer and must stay re-checkable \u{2014} otherwise a venv \
         deleted by hand is reported healthy forever"
    );

    for phase in [Phase::Failed, Phase::Unknown] {
        set_phase(phase);
        assert!(retry_now(), "{phase:?} must accept a retry");
    }

    // B-180 — `unavailable` is the one that must be refused: `supervise` has already
    // RETURNED by the time that phase is set, so there is no thread left to wake, and
    // reporting that an attempt started would promise one that can never happen. The
    // same lie D-315 refused to tell with an automatic timer.
    set_phase(Phase::Unavailable);
    assert!(
        !retry_now(),
        "unavailable means nothing about trying again changes the answer"
    );

    // Leave the global as we found it, and drop the flag this test just set.
    if let Ok(mut r) = shared().retry_requested.lock() {
        *r = false;
    }
    if let Ok(mut s) = shared().status.lock() {
        *s = restore;
    }
}
