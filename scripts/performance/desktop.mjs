import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FIXED_PROMPT, FIXED_TEXT } from "./model-service.mjs";

export class UnavailableError extends Error {}

export async function readLifecycle(fixture) {
  try {
    return (
      await readFile(
        path.join(fixture.root, "userData", "diagnostics", "electron-lifecycle.jsonl"),
        "utf8",
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export class DesktopDriver {
  constructor(options, fixture, electron) {
    this.options = options;
    this.fixture = fixture;
    this.electron = electron;
    this.application = null;
    this.usedSessions = new Set();
  }

  static async create(options, fixture) {
    let electron;
    try {
      ({ _electron: electron } = await import("playwright"));
    } catch {
      throw new UnavailableError("Playwright is missing; run npm install at the repository root");
    }
    return new DesktopDriver(options, fixture, electron);
  }

  async launch() {
    this.application = await this.electron.launch({
      executablePath: this.options.app,
      env: this.fixture.environment,
      timeout: this.options.timeoutMs,
    });
    const child = this.application.process();
    child.stdout?.resume();
    child.stderr?.resume();
    this.page = await this.application.firstWindow({ timeout: this.options.timeoutMs });
    await this.page.waitForFunction(() => window.__microclawPerf?.version === 1, null, {
      timeout: this.options.timeoutMs,
    });
    await this.page.waitForFunction(() => window.__microclawPerf.ready().ready, null, {
      timeout: this.options.timeoutMs,
    });
    return this.page.evaluate(() => window.__microclawPerf.ready());
  }

  async shutdown(preparedRecords) {
    if (!this.application) return;
    const application = this.application;
    const child = application.process();
    const records = preparedRecords ?? (await readLifecycle(this.fixture));
    const epochStart = records.findLastIndex(
      (record) => record.event === "main-process-start" && record.processId === child.pid,
    );
    const gatewayPids = new Set(
      records
        .slice(epochStart < 0 ? records.length : epochStart)
        .map((record) => record.gatewayPid)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
    const started = performance.now();
    await application.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    while ((child.exitCode === null && child.signalCode === null) || [...gatewayPids].some(alive)) {
      if (performance.now() - started > this.options.timeoutMs) {
        throw new Error("Timed out waiting for the owned desktop/Gateway to exit normally");
      }
      await delay(25);
    }
    this.application = null;
    return performance.now();
  }

  async restart() {
    const previousRecords = await readLifecycle(this.fixture);
    const started = performance.now();
    const stopped = await this.shutdown(previousRecords);
    const launching = performance.now();
    const readiness = await this.launch();
    const completed = performance.now();
    const records = await readLifecycle(this.fixture);
    const epochStart = records.findLastIndex(
      (record) =>
        record.event === "main-process-start" &&
        record.processId === this.application.process().pid,
    );
    const summary = records
      .slice(epochStart < 0 ? records.length : epochStart)
      .filter((record) => record.event === "startup-summary")
      .at(-1);
    const forced = records
      .slice(previousRecords.length)
      .some((record) => record.event === "gateway-stop-force-fallback");
    const complete = summary?.mode === "spawned" && !forced;
    const metrics = {
      totalMs: completed - started,
      shutdownMs: stopped - started,
      launchToChatReadyMs: completed - launching,
    };
    if (summary) {
      for (const key of [
        "appBeforeAttemptMs",
        "microclawPreflightMs",
        "openclawHttpMs",
        "integrationMs",
      ]) {
        metrics[`stage.${key}`] = Number.isFinite(summary[key]) ? summary[key] : null;
      }
    }
    return {
      outcome: complete ? "success" : "incomplete-restart",
      metrics,
      readiness,
      gatewayMode: summary?.mode ?? "unknown",
      failure: complete
        ? null
        : {
            classification: forced ? "forced-shutdown" : "gateway-not-spawned",
            message:
              "A normal full restart requires graceful shutdown and an observed newly spawned Gateway",
          },
    };
  }

  async chat() {
    await this.page.evaluate(() => window.__microclawPerf.arm());
    await this.page.locator(".sp-create-btn").click({ timeout: this.options.timeoutMs });
    await this.page.waitForFunction(
      () => window.__microclawPerf.snapshot()?.metrics.sessionReadyMs !== null,
      null,
      { timeout: this.options.timeoutMs },
    );
    const before = await this.page.evaluate(() => window.__microclawPerf.snapshot());
    if (!before?.sessionKey || this.usedSessions.has(before.sessionKey))
      throw new Error("New-conversation action did not produce an unused session");
    this.usedSessions.add(before.sessionKey);
    const composer = this.page.locator(".chat-view textarea");
    await composer.fill(FIXED_PROMPT, { timeout: this.options.timeoutMs });
    await this.page.evaluate(() => window.__microclawPerf.armSend());
    await composer.press("Enter", { timeout: this.options.timeoutMs });
    await this.page.waitForFunction(
      () => Boolean(window.__microclawPerf.snapshot()?.outcome),
      null,
      { timeout: this.options.timeoutMs },
    );
    const result = await this.page.evaluate(() => window.__microclawPerf.snapshot());
    if (result.outcome === "success" && this.options.profile === "fixed-response") {
      const bodies = await this.page.locator(".chat-bubble.assistant .chat-text").allInnerTexts();
      if (!bodies.some((text) => text.trim() === FIXED_TEXT)) {
        result.outcome = "unexpected-response";
      }
    }
    if (result.outcome !== "success")
      result.failure = {
        classification: result.outcome,
        message: `Chat ended with ${result.outcome}`,
      };
    return result;
  }

  async snapshot() {
    if (!this.application || this.page?.isClosed()) return null;
    return this.page.evaluate(() => window.__microclawPerf?.snapshot() ?? null).catch(() => null);
  }

  async close() {
    try {
      await this.shutdown();
    } catch (error) {
      const child = this.application?.process();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      throw error;
    }
  }
}
