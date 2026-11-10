// @vitest-environment jsdom
// Verifies the ticker's scheduling decisions (rAF when visible, deadline
// timeout when hidden), lifecycle-triggered reconciles and teardown. The clock
// is controlled and advanced together with vitest fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ticker, type FrameSource } from "../src/scheduler";
import { createStore } from "../src/store";
import { MINUTE, epoch, ms, type Epoch } from "../src/timer";

let visibility: DocumentVisibilityState;
let now: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

const clock = (): Epoch => epoch(now);

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
}

/** Advances both the controlled clock and fake timers so timeouts see the same time. */
function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

/** Runs and clears all pending animation frames, like one display refresh. */
function flushFrames(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(now);
}

function startedStore(minutes = 1) {
  const store = createStore(clock);
  store.dispatch({ type: "add", minutes });
  store.dispatch({ type: "toggle" });
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  visibility = "visible";
  frames = new Map();
  nextFrameId = 1;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  // jsdom only provides rAF with pretendToBeVisual; a manual stub makes frames deterministic.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hidden path", () => {
  it("completes via setTimeout aimed at the deadline", () => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    setVisibility("hidden");
    const ticker = new Ticker(store, window);

    expect(frames.size).toBe(0);
    advance(MINUTE - 1);
    expect(done).not.toHaveBeenCalled();
    advance(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("done");
    // The completion indication retains only its reset timeout.
    expect(vi.getTimerCount()).toBe(1);
    ticker.dispose();
  });

  it("re-aims the timeout when time is added while running", () => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    setVisibility("hidden");
    const ticker = new Ticker(store, window);

    advance(30_000);
    store.dispatch({ type: "add", minutes: 1 });
    advance(MINUTE);
    expect(done).not.toHaveBeenCalled();
    advance(30_000);
    expect(done).toHaveBeenCalledTimes(1);
    ticker.dispose();
  });

  it("caps the delay at 2^31-1 ms", () => {
    const store = startedStore();
    // Reaching the cap needs more than 24 h, so spy on the delay itself.
    const spy = vi.spyOn(window, "setTimeout");
    vi.spyOn(store, "getSnapshot").mockReturnValue({
      status: "running",
      remaining: ms(2 ** 31 + 5),
      baseline: ms(0),
      progress: 0,
    });
    setVisibility("hidden");
    const ticker = new Ticker(store, window);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 2 ** 31 - 1);
    ticker.dispose();
  });

  it("schedules nothing while paused or idle", () => {
    const store = createStore(clock);
    setVisibility("hidden");
    const ticker = new Ticker(store, window);
    expect(vi.getTimerCount()).toBe(0);
    store.dispatch({ type: "add", minutes: 1 });
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    ticker.dispose();
  });
});

describe("completion reset", () => {
  it.each(["visible", "hidden"] as const)(
    "resets to idle after 15 seconds while %s without repeating completion",
    (state) => {
      setVisibility(state);
      const store = startedStore();
      const done = vi.fn();
      store.onComplete(done);
      const ticker = new Ticker(store, window);
      advance(MINUTE);
      flushFrames();
      advance(14_999);
      expect(store.getState().status).toBe("done");
      advance(1);
      expect(store.getSnapshot()).toMatchObject({
        status: "idle",
        remaining: 0,
        baseline: 0,
      });
      expect(done).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      ticker.dispose();
    },
  );

  it("does not postpone reset on repeated video refreshes or lifecycle events", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    advance(MINUTE);
    flushFrames();
    for (let i = 0; i < 59; i++) {
      advance(250);
      store.dispatch({ type: "reconcile" });
    }
    window.dispatchEvent(new Event("focus"));
    advance(250);
    expect(store.getState().status).toBe("idle");
    ticker.dispose();
  });

  it.each(["reset", "add"] as const)(
    "cancels the pending reset after a user %s action",
    (type) => {
      const store = startedStore();
      const ticker = new Ticker(store, window);
      advance(MINUTE);
      flushFrames();
      advance(5_000);
      if (type === "add") store.dispatch({ type, minutes: 1 });
      else store.dispatch({ type });
      expect(vi.getTimerCount()).toBe(0);
      store.dispatch({ type: "add", minutes: 1 });
      store.dispatch({ type: "start" });
      advance(10_000);
      expect(store.getState().status).toBe("running");
      ticker.dispose();
    },
  );

  it("rearms the reset for each new completion", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    advance(MINUTE);
    flushFrames();
    advance(5_000);
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "start" });
    advance(MINUTE);
    flushFrames();
    advance(14_999);
    expect(store.getState().status).toBe("done");
    advance(1);
    expect(store.getState().status).toBe("idle");
    ticker.dispose();
  });

  it("cancels the completion reset on disposal", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    advance(MINUTE);
    flushFrames();
    ticker.dispose();
    expect(vi.getTimerCount()).toBe(0);
    advance(15_000);
    expect(store.getState().status).toBe("done");
  });
});

describe("visible path", () => {
  it("drives reconcile through rAF and completes at the deadline", () => {
    const store = startedStore();
    const done = vi.fn();
    const seen = vi.fn();
    store.onComplete(done);
    store.subscribe(seen);
    const ticker = new Ticker(store, window);

    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    advance(16);
    flushFrames();
    expect(seen).toHaveBeenCalledTimes(1);
    // Re-armed for the next frame after the notification.
    expect(frames.size).toBe(1);
    expect(done).not.toHaveBeenCalled();

    advance(MINUTE);
    flushFrames();
    expect(done).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    ticker.dispose();
  });

  it("keeps exactly one pending frame across repeated notifications", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    store.dispatch({ type: "reconcile" });
    store.dispatch({ type: "reconcile" });
    expect(frames.size).toBe(1);
    ticker.dispose();
  });

  it("starts scheduling when the timer starts after construction", () => {
    const store = createStore(clock);
    const ticker = new Ticker(store, window);
    expect(frames.size).toBe(0);
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    expect(frames.size).toBe(1);
    ticker.dispose();
  });

  it("does not recurse synchronously: dispatch from a frame schedules, not re-dispatches", () => {
    const store = startedStore();
    const dispatch = vi.spyOn(store, "dispatch");
    const ticker = new Ticker(store, window);
    flushFrames();
    expect(dispatch).toHaveBeenCalledTimes(1);
    ticker.dispose();
  });
});

describe("lifecycle events", () => {
  it.each([
    ["visibilitychange", () => document],
    ["focus", () => window],
    ["pageshow", () => window],
    ["resume", () => document],
  ] as const)("%s triggers a reconcile", (type, target) => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    const ticker = new Ticker(store, window);
    now += MINUTE; // e.g. machine slept; no timer callback ran
    target().dispatchEvent(new Event(type));
    expect(done).toHaveBeenCalledTimes(1);
    ticker.dispose();
  });

  it("switches from rAF to timeout when the tab becomes hidden", () => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    const ticker = new Ticker(store, window);
    expect(frames.size).toBe(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    advance(MINUTE);
    expect(done).toHaveBeenCalledTimes(1);
    ticker.dispose();
  });
});

describe("dispose", () => {
  it("is idempotent and cancels pending frame, timeout and subscription", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    expect(frames.size).toBe(1);
    ticker.dispose();
    ticker.dispose();
    expect(frames.size).toBe(0);

    // A later notification must not re-arm anything.
    store.dispatch({ type: "reconcile" });
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending hidden timeout", () => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    setVisibility("hidden");
    const ticker = new Ticker(store, window);
    expect(vi.getTimerCount()).toBe(1);
    ticker.dispose();
    expect(vi.getTimerCount()).toBe(0);
    advance(MINUTE);
    expect(done).not.toHaveBeenCalled();
  });

  it("removes lifecycle listeners", () => {
    const store = startedStore();
    const done = vi.fn();
    store.onComplete(done);
    const ticker = new Ticker(store, window);
    ticker.dispose();
    now += MINUTE;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("resume"));
    expect(done).not.toHaveBeenCalled();
  });
});

describe("frame source", () => {
  function fakeSource(initial: DocumentVisibilityState = "visible") {
    const sourceFrames = new Map<number, FrameRequestCallback>();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: initial,
    });
    const source = {
      document: doc,
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        const id = nextFrameId++;
        sourceFrames.set(id, cb);
        return id;
      }),
      cancelAnimationFrame: vi.fn((id: number) => {
        sourceFrames.delete(id);
      }),
    } satisfies FrameSource;
    const setSourceVisibility = (v: DocumentVisibilityState): void => {
      doc.visibilityState = v;
      doc.dispatchEvent(new Event("visibilitychange"));
    };
    return { source, sourceFrames, setSourceVisibility };
  }

  it("uses the source's rAF while its document is visible, even with the host hidden", () => {
    const store = startedStore();
    setVisibility("hidden");
    const ticker = new Ticker(store, window);
    const { source, sourceFrames } = fakeSource();
    ticker.setFrameSource(source);
    expect(sourceFrames.size).toBe(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const [cb] = [...sourceFrames.values()];
    sourceFrames.clear();
    cb?.(now);
    expect(sourceFrames.size).toBe(1);
    ticker.dispose();
    expect(sourceFrames.size).toBe(0);
  });

  it("falls back to the host when the source becomes hidden", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    const { source, sourceFrames, setSourceVisibility } = fakeSource();
    ticker.setFrameSource(source);
    setSourceVisibility("hidden");
    expect(sourceFrames.size).toBe(0);
    expect(frames.size).toBe(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    setSourceVisibility("visible");
    expect(sourceFrames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    ticker.dispose();
  });

  it("cancels a pending frame with the window that requested it", () => {
    const store = startedStore();
    const hostCancel = vi.spyOn(window, "cancelAnimationFrame");
    const ticker = new Ticker(store, window);
    const { source } = fakeSource();
    ticker.setFrameSource(source);
    // The host frame from construction is cancelled on the host.
    expect(hostCancel).toHaveBeenCalledTimes(1);
    expect(source.cancelAnimationFrame).not.toHaveBeenCalled();
    ticker.setFrameSource(null);
    expect(source.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(hostCancel).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(1);
    ticker.dispose();
  });

  it("releases the source listener when cleared", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    const { source, sourceFrames, setSourceVisibility } = fakeSource("hidden");
    ticker.setFrameSource(source);
    ticker.setFrameSource(null);
    setSourceVisibility("visible");
    expect(sourceFrames.size).toBe(0);
    expect(frames.size).toBe(1);
    ticker.dispose();
  });

  it("releases the source listener on dispose and ignores later sources", () => {
    const store = startedStore();
    const ticker = new Ticker(store, window);
    const { source, sourceFrames, setSourceVisibility } = fakeSource("hidden");
    ticker.setFrameSource(source);
    ticker.dispose();
    ticker.dispose();
    setSourceVisibility("visible");
    expect(sourceFrames.size).toBe(0);
    ticker.setFrameSource(fakeSource().source);
    expect(frames.size).toBe(0);
  });
});
