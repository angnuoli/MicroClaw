import { afterEach, describe, expect, it, vi } from "vitest";
import { installPerformanceProbe } from "./performance-probe";
import type { PerformanceChatSample } from "./performance-sample";

const stores = vi.hoisted(() => ({ chat: vi.fn(), gateway: vi.fn() }));
vi.mock("./stores/chat", () => ({ useChatStore: stores.chat }));
vi.mock("./stores/gateway", () => ({ useGatewayStore: stores.gateway }));

afterEach(() => {
  Reflect.get(window, "__microclawPerf")?.dispose();
  Reflect.deleteProperty(window, "__microclawPerf");
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("performance probe default path", () => {
  it("does not subscribe, read stores, create observers or schedule frames when disabled", () => {
    window.openclaw = { features: { githubCopilot: false, performance: false } } as OpenClawAPI;
    const animation = vi.spyOn(window, "requestAnimationFrame");
    installPerformanceProbe();
    expect(stores.chat).not.toHaveBeenCalled();
    expect(stores.gateway).not.toHaveBeenCalled();
    expect(animation).not.toHaveBeenCalled();
    expect("__microclawPerf" in window).toBe(false);
  });
});

describe("performance probe enabled DOM boundaries", () => {
  it("observes the actual action, ignores reasoning text, and waits for matching final rendering", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const chat = {
      sessionKey: "session",
      resolvedSessionKey: null,
      loading: false,
      wsConnected: true,
      streaming: false,
      sending: false,
    };
    stores.chat.mockReturnValue(chat);
    stores.gateway.mockReturnValue({ ready: true });
    let receiveChat: (event: ChatEventPayload) => void = () => undefined;
    const unsubscribe = vi.fn();
    window.openclaw = {
      features: { githubCopilot: false, performance: true },
      gateway: { isServiceReady: async () => true, onServiceReady: () => unsubscribe },
      chat: {
        onEvent: (callback: (event: ChatEventPayload) => void) => {
          receiveChat = callback;
          return unsubscribe;
        },
      },
    } as unknown as OpenClawAPI;
    document.body.innerHTML =
      '<button class="sp-create-btn"></button><div class="chat-view"><textarea></textarea><div class="thinking-block__text">reasoning only</div></div>';
    installPerformanceProbe();
    const probe = Reflect.get(window, "__microclawPerf") as {
      arm(): void;
      armSend(): void;
      snapshot(): ReturnType<PerformanceChatSample["snapshot"]>;
      dispose(): void;
    };
    probe.arm();
    document.querySelector<HTMLButtonElement>(".sp-create-btn")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sessionReadyMs).not.toBeNull();
    probe.armSend();
    document
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    chat.streaming = true;
    receiveChat({ sessionKey: "session", runId: "run", state: "delta" });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sendToFirstTextMs).toBeNull();
    const answer = document.createElement("div");
    answer.className = "chat-bubble assistant";
    const body = document.createElement("div");
    body.className = "chat-text";
    body.innerText = "MICROCLAW_PERF_OK";
    answer.append(body);
    document.querySelector(".chat-view")!.append(answer);
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().metrics.sendToFirstTextMs).not.toBeNull();
    receiveChat({ sessionKey: "session", runId: "unrelated", state: "final" });
    chat.streaming = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().outcome).toBeNull();
    receiveChat({ sessionKey: "session", runId: "run", state: "final" });
    expect(probe.snapshot().outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.snapshot().outcome).toBe("success");
    probe.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
