import { nextTick } from "vue";
import { useChatStore } from "./stores/chat";
import { useGatewayStore } from "./stores/gateway";
import { PerformanceChatSample } from "./performance-sample";

export function installPerformanceProbe(): void {
  if (!window.openclaw.features.performance) return;
  const chat = useChatStore();
  const gateway = useGatewayStore();
  let sample: PerformanceChatSample | null = null;
  let disposed = false;
  const milestones: Record<string, number> = { probeInstalledAt: performance.now() };
  let serviceReady = false;
  const markServiceReady = () => {
    serviceReady = true;
    milestones.serviceReadyAt ??= performance.now();
  };
  const unsubscribeReady = window.openclaw.gateway.onServiceReady(markServiceReady);
  void window.openclaw.gateway
    .isServiceReady()
    .then((ready) => {
      if (ready) markServiceReady();
    })
    .catch(() => undefined);
  const ready = () => {
    const composer = document.querySelector<HTMLTextAreaElement>(".chat-view textarea");
    const usable = Boolean(composer && !composer.disabled && composer.getClientRects().length);
    if (!chat.loading && chat.wsConnected) milestones.initialSessionReadyAt ??= performance.now();
    if (usable) milestones.composerReadyAt ??= performance.now();
    const complete = serviceReady && gateway.ready && chat.wsConnected && !chat.loading && usable;
    if (complete) milestones.chatReadyAt ??= performance.now();
    return complete;
  };
  const unsubscribe = window.openclaw.chat.onEvent((event) => sample?.event(event));
  const afterPaintOpportunity = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const observe = async (active: PerformanceChatSample) => {
    await nextTick();
    await afterPaintOpportunity();
    if (disposed || sample !== active) return;
    if (sample.sessionReadyAt === null && ready()) {
      sample.sessionReady(chat.resolvedSessionKey || chat.sessionKey, performance.now());
    }
    const activeKey = chat.resolvedSessionKey || chat.sessionKey;
    if (sample.sessionKey === activeKey) {
      const bodies = document.querySelectorAll<HTMLElement>(".chat-bubble.assistant .chat-text");
      const hasBody = [...bodies].some(
        (body) => body.getClientRects().length > 0 && Boolean(body.innerText.trim()),
      );
      sample.rendered(hasBody, !chat.streaming && !chat.sending, performance.now());
    }
    if (!sample.outcome) requestAnimationFrame(() => void observe(active));
  };
  const probe = {
    version: 1,
    ready: () => ({ ready: ready(), milestones: { ...milestones } }),
    snapshot: () => sample?.snapshot() ?? null,
    arm: () => {
      sample = null;
      const button = document.querySelector<HTMLButtonElement>(".sp-create-btn");
      if (!button) throw new Error("New-conversation action is not available");
      button.addEventListener(
        "click",
        () => {
          sample = new PerformanceChatSample(performance.now());
          void observe(sample);
        },
        { once: true, capture: true },
      );
    },
    armSend: () => {
      const composer = document.querySelector<HTMLTextAreaElement>(".chat-view textarea");
      if (!composer || !sample) throw new Error("No active performance conversation");
      composer.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Enter" && !event.shiftKey) sample?.sent(performance.now());
        },
        { once: true, capture: true },
      );
    },
    dispose: () => {
      disposed = true;
      sample = null;
      unsubscribe();
      unsubscribeReady();
    },
  };
  Object.defineProperty(window, "__microclawPerf", { value: probe, configurable: true });
}
