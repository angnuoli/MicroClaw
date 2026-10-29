import { describe, expect, it } from "vitest";
import { PerformanceChatSample } from "./performance-sample";

function sample() {
  const value = new PerformanceChatSample(10);
  value.sessionReady("session", 20);
  value.sent(30);
  return value;
}

describe("performance chat completion boundary", () => {
  it("does not equate submit acknowledgment with completion", () => {
    const value = sample();
    expect(value.snapshot().outcome).toBeNull();
    expect(value.snapshot().metrics.sendToFinalRenderedMs).toBeNull();
  });

  it("requires a matching final and visible body after rendering", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.rendered(true, false, 40);
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    expect(value.outcome).toBeNull();
    value.rendered(true, true, 60);
    expect(value.snapshot()).toMatchObject({
      outcome: "success",
      metrics: {
        totalMs: 50,
        sessionReadyMs: 10,
        sendToFirstTextMs: 10,
        sendToFinalRenderedMs: 30,
      },
    });
  });

  it("ignores other sessions, other runs and duplicate terminal events", () => {
    const value = sample();
    value.event({ sessionKey: "other", runId: "background", state: "final" });
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.event({ sessionKey: "session", runId: "other-run", state: "final" });
    value.rendered(true, true, 45);
    expect(value.outcome).toBeNull();
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered(true, true, 50);
    value.event({ sessionKey: "session", runId: "run", state: "error" });
    value.rendered(true, true, 999);
    expect(value.outcome).toBe("success");
    expect(value.snapshot().metrics.totalMs).toBe(40);
  });

  it("does not treat reasoning/tool activity or an empty final as answer text", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "delta" });
    value.rendered(false, false, 40);
    value.event({ sessionKey: "session", runId: "run", state: "final" });
    value.rendered(false, true, 50);
    expect(value.outcome).toBe("empty-response");
    expect(value.snapshot().metrics.sendToFirstTextMs).toBeNull();
    expect(value.snapshot().metrics.totalMs).toBeNull();
  });

  it.each([
    ["error", "model-error"],
    ["aborted", "cancelled"],
  ])("keeps %s distinct", (state, outcome) => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state });
    expect(value.outcome).toBe(outcome);
    expect(value.snapshot().metrics.totalMs).toBeNull();
  });

  it("does not count lifecycle-end as a rendered final", () => {
    const value = sample();
    value.event({ sessionKey: "session", runId: "run", state: "status", lifecyclePhase: "end" });
    value.rendered(true, true, 50);
    expect(value.outcome).toBeNull();
  });
});
