export interface PerformanceChatEvent {
  sessionKey: string;
  runId: string;
  state: string;
  lifecyclePhase?: string;
}

export class PerformanceChatSample {
  sessionKey: string | null = null;
  runId: string | null = null;
  sessionReadyAt: number | null = null;
  sentAt: number | null = null;
  firstTextAt: number | null = null;
  finalRenderedAt: number | null = null;
  terminal: string | null = null;
  outcome: string | null = null;

  constructor(readonly startedAt: number) {}

  sessionReady(sessionKey: string, now: number): void {
    if (this.sessionReadyAt !== null) return;
    this.sessionKey = sessionKey;
    this.sessionReadyAt = now;
  }

  sent(now: number): void {
    if (this.sentAt === null) this.sentAt = now;
  }

  event(event: PerformanceChatEvent): void {
    if (
      this.outcome ||
      this.sentAt === null ||
      event.sessionKey !== this.sessionKey ||
      !event.runId ||
      (this.runId && this.runId !== event.runId)
    )
      return;
    this.runId = event.runId;
    if (this.terminal) return;
    if (event.state === "error" || event.lifecyclePhase === "error") {
      this.outcome = "model-error";
    } else if (event.state === "aborted") {
      this.outcome = "cancelled";
    } else if (event.state === "final") {
      this.terminal = "final";
    }
  }

  rendered(hasBody: boolean, settled: boolean, now: number): void {
    if (this.outcome || this.sentAt === null || !this.runId) return;
    if (hasBody && this.firstTextAt === null) this.firstTextAt = now;
    if (this.terminal === "final" && settled) {
      this.outcome = hasBody ? "success" : "empty-response";
      if (hasBody) this.finalRenderedAt = now;
    }
  }

  snapshot() {
    return {
      sessionKey: this.sessionKey,
      runId: this.runId,
      outcome: this.outcome,
      metrics: {
        totalMs: this.finalRenderedAt === null ? null : this.finalRenderedAt - this.startedAt,
        sessionReadyMs: this.sessionReadyAt === null ? null : this.sessionReadyAt - this.startedAt,
        sendToFirstTextMs:
          this.firstTextAt === null || this.sentAt === null ? null : this.firstTextAt - this.sentAt,
        sendToFinalRenderedMs:
          this.finalRenderedAt === null || this.sentAt === null
            ? null
            : this.finalRenderedAt - this.sentAt,
      },
    };
  }
}
