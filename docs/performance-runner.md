# Scenario performance runner

The runner measures explicit scenarios, not unit-test/build duration. It does not
fetch a baseline, build an application, install on the host, or change the current
checkout. Playwright is a root development dependency, not a desktop runtime
dependency. Run `npm install` at the repository root before using the UI driver.

## Commands

```powershell
npm run perf -- report --app "C:\artifacts\win-unpacked\MicroClaw.exe" --scenario app.restart,chat.new-session --samples 3
npm run perf -- compare --app "C:\artifacts\win-unpacked\MicroClaw.exe" --baseline "build/performance/<baseline-run>/results.json" --scenario app.restart,chat.new-session --samples 3
npm run perf -- --help
```

All relative paths resolve against the repository root, even when the command is
started from another directory. Results go to `build/performance/<run-id>/` by
default; `--output` changes the parent directory. Existing runs are never reused.
Report mode has no baseline or regression verdict. Compare mode preserves the
candidate report when a baseline is missing, malformed or incompatible. It shows
deltas and failure-rate differences, without a gating verdict or invented thresholds.

Default scope is all three scenarios, with three samples each. Without a suitable
packaged application or VM adapter, affected samples are explicitly `unavailable`.
`npm run perf -- report` is safe to use to check this reporting path: it does not
launch an application or contact a model provider without an `--app` argument.
The first version supports packaged Electron applications, not Vite/dev mode.

Exit codes: `0` means all selected scenarios were measured, `1` means incomplete
coverage or failed attempts, `2` means invalid arguments/runner errors, and `130`
means interruption. Comparison compatibility is separate from measurement coverage;
inspect `baseline.status` rather than interpreting exit code zero as a regression gate.

## Evidence and boundaries

Each run saves `results.json`, `report.md`, per-attempt JSON, observed renderer
milestones, sanitized Electron lifecycle summaries and model-request counts/timings.
The source revision, relevant source-file hashes, dirty state, executable/application
archive hashes and environment are recorded outside the measured interval. An
existing binary is **not** attributed to the current source just because both are
available. Binary/source association remains unknown; retain your build provenance.
OpenClaw runtime archive identity is hashed when available; unavailable versions or
hardware information must not be inferred from the source checkout.

- `app.restart`: an initial unmeasured launch establishes readiness and disk caches.
  The measured interval starts with the normal-exit request and ends when the
  relaunched chat surface is observed ready. Both the owned desktop and Gateway
  must exit before relaunch. Reused Gateways, forced-shutdown fallbacks and missing
  startup summaries cannot produce a successful full-restart sample.
- `chat.new-session`: the real new-conversation button and composer are operated.
  The renderer records the click and submit keydown with its own monotonic clock.
  Session/run matching, response completion, nonempty answer DOM visibility and
  paint opportunities are required. Reasoning/tool panels, lifecycle-end alone,
  empty finals, duplicate terminal events and unrelated sessions cannot complete
  the sample. The send promise is not a completion signal.
- `install.clean`: the VM adapter supplies confirmation-through-first-service-
  readiness-and-final-validation timing, excluding VM restore/boot and human
  approval waits. It must restore its clean fixture before every sample.

Runner-side restart timing and renderer-side chat timing use separate clocks;
their absolute timestamps are not subtracted. UI detection and observer scheduling
add overhead: DOM visibility after paint opportunities is not physical screen
presentation timing. Main-process startup stages are nested/cumulative and must
not be summed blindly. GPU details, provider token counts and internal model-runtime
stages are not currently measured.

All failed attempts remain visible with elapsed time and classification. After a
failed sample, remaining samples in that scenario are skipped rather than silently
retrying or altering the fixture. Statistics include only successful metric samples;
missing values are `null`, never zero. Reports show median/min/max/count, not a
purported stable p95 from a few samples.

## Model profiles

`fixed-response` uses a real UI, desktop and Gateway against a loopback-only model
service implementing OpenAI chat completions. It emits `MICROCLAW_` and `PERF_OK`
with a fixed 20 ms delay per chunk. This measures product overhead, not inference
or remote-provider latency. The synthetic profile starts without personal history,
extra plugins or bundled skills; the application may converge its own resources.

For `real-model`, explicitly authorize the model, sample count and **whole-run**
request budget, including normal application warmup and title-generation requests:

```powershell
npm run perf -- report --app "C:\artifacts\win-unpacked\MicroClaw.exe" --scenario chat.new-session --profile real-model --model "<model-id>" --endpoint "https://<provider>/v1" --api-key-env PERF_MODEL_API_KEY --samples 3 --max-model-requests 12
```

Set `PERF_MODEL_API_KEY` separately using your normal secret-management method.
Never put an API key in arguments or fixture JSON. The local proxy forwards only
chat-completion requests to the explicit HTTPS endpoint (loopback HTTP is allowed
for local inference), refuses redirects and enforces the request budget across all
scenarios. It does not record request bodies, response text or the key. It uses
the normal provider adapter chain; it does not mock Gateway `chat.send`.
No arbitrary provider protocols or Vite/browser mocks are supported in this version.
Disk caches are retained across samples after the initial unmeasured launch; this
is not an OS cold-boot or model-cold-start measurement. Profiles must not be mixed.

## Isolation and ordinary-use overhead

Normal startup has no runner, model server, performance IPC, observer or timer.
The renderer probe is dynamically imported only when the main process has validated
the explicit disposable-fixture marker and token. With performance mode disabled,
the fixture configuration returns before filesystem access or environment changes.
There remains a small one-time module/flag-check cost; no zero-overhead claim is made.

In performance mode, home, app-data, Electron user/session data, temporary paths,
OpenClaw state, credentials and Gateway port are isolated. Existing personal state
is never copied. Fixture model tools are denied globally (`tools.deny: ["*"]`),
not merely discouraged by the prompt. Auto-start synchronization is suppressed. A port collision fails
the fixture rather than reusing or terminating an external Gateway; forced cleanup
does not scan for unrelated listener PIDs. Cleanup targets the launched desktop
process; its normal lifeline shutdown owns the Gateway. Fixtures are retained for
diagnosis and are not recursively deleted by the runner. After a failed cleanup,
review the reported owned process before removing fixture directories.

Before launch the packaged `resources/app.asar` is checked for the isolation
contract. Older builds are reported unavailable without being launched. Rebuild
the application with the new hooks before measuring. This is an accidental-old-
artifact guard, not a trust or security verification of arbitrary executables.

## Clean-install VM adapter

There is deliberately no built-in command that installs/uninstalls on the user's
host, and no bundled Hyper-V/Windows Sandbox provisioning backend yet. A trusted
external VM adapter is required for actual clean-install measurements. The test
adapter under `scripts/performance/test-fixtures/` is synthetic test data only.

```powershell
npm run perf -- report --scenario install.clean --installer "C:\artifacts\MicroClawSetup.exe" --install-fixture "C:\fixtures\install-vm.json" --samples 3
```

The adapter descriptor has this contract:

```json
{
  "kind": "microclaw.performance.install-vm.v1",
  "disposable": true,
  "restorePerSample": true,
  "vmId": "dedicated-performance-vm",
  "imageId": "clean-image-version",
  "prerequisites": { "node": false, "git": false, "openclaw": false, "downloadCache": "empty" },
  "executable": "C:\\absolute\\path\\to\\adapter.exe",
  "args": []
}
```

For each attempt the runner executes the explicit executable without a shell,
appending `--request <request.json> --result <result.json>`. Requests include
`schemaVersion`, `runId`, `sampleId`, `installer`, VM/image identity and timeout.
The adapter must restore before installation, control the installer confirmation
boundary, collect existing installer step timings and first-launch milestones,
exclude human wait, handle cancellation/cleanup, and write the matching identity:

```json
{
  "schemaVersion": 1,
  "runId": "<from request>",
  "sampleId": "<from request>",
  "outcome": "success",
  "restored": true,
  "clean": true,
  "serviceReady": true,
  "finalValidation": true,
  "elapsedMs": 1234,
  "metrics": { "totalMs": 1234, "stage.installation": 1000 },
  "evidence": ["relative-sanitized-log.jsonl"]
}
```

Failures use `failed`, `timeout` or `cancelled`; unavailable completion metrics are
null. Evidence must stay inside the run directory and contain no credentials or
private chat contents. Successful extraction, upgrade checks or preinstalled
dependency checks are not a clean installation. The VM adapter is trusted code;
the descriptor's assertions do not independently prove its VM isolation.

## Focused tests

```powershell
npm run test:perf
cd desktop
npx --no-install vitest run src/performance-fixture.test.ts
cd renderer
npx --no-install vitest run src/performance-sample.test.ts src/performance-probe.test.ts
```

These tests cover contracts, isolation guards, deterministic SSE, request budgets,
report/compare behavior, failures and completion boundaries. They do not substitute
for a packaged-application end-to-end run or a real disposable-VM installation.
