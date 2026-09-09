// D-104 — real E2E config, WebdriverIO + @wdio/tauri-service (embedded
// provider — the only macOS-supported path; the classic external
// tauri-driver tool does not support macOS at all, confirmed against
// Tauri's current docs, not memory). Plain .mjs, not TS, to keep this
// harness's own toolchain minimal — it's a standalone test project, not
// app code, and doesn't need this repo's TS setup.
//
// appBinaryPath assumes `e2e/run.sh` has already built the e2e-testing
// binary into ../target/e2e (a separate target dir from the shared
// ../target/debug a running dev server also writes to — see run.sh's own
// comment for why). Do not run this config directly without that build
// step; use `../e2e/run.sh`.
export const config = {
  runner: 'local',
  specs: ['./test/specs/**/*.spec.mjs'],
  maxInstances: 1,
  services: [
    [
      'tauri',
      {
        appBinaryPath: '../target/e2e/debug/apelles',
        driverProvider: 'embedded',
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  logLevel: 'info',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
