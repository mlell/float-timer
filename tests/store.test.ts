// Verifies the store: action routing, tick-before-action, completion exactly
// once (including late jumps), notification and unsubscribe semantics.
import { describe, expect, it, vi } from "vitest";
import { createStore, type Action } from "../src/store";
import { MINUTE, epoch, ms, type Epoch, type TimerState } from "../src/timer";

function setup(initial?: TimerState) {
  let now = 1_000_000;
  const clock = (): Epoch => epoch(now);
  const store = createStore(clock, initial);
  return {
    store,
    advance: (delta: number): void => {
      now += delta;
    },
  };
}

describe("store transitions", () => {
  it("starts idle by default", () => {
    expect(setup().store.getState()).toEqual({ status: "idle" });
  });

  it("add on idle yields paused with the added time", () => {
    const { store } = setup();
    store.dispatch({ type: "add", minutes: 3 });
    expect(store.getState()).toEqual({
      status: "paused",
      remaining: ms(3 * MINUTE),
      baseline: ms(3 * MINUTE),
    });
  });

  it("toggle runs and pauses, remaining follows the clock", () => {
    const { store, advance } = setup();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    expect(store.getState().status).toBe("running");
    advance(10_000);
    expect(store.getSnapshot().remaining).toBe(50_000);
    store.dispatch({ type: "toggle" });
    expect(store.getState()).toMatchObject({
      status: "paused",
      remaining: 50_000,
    });
  });

  it("reset returns to idle from any state", () => {
    const { store } = setup();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "reset" });
    expect(store.getState()).toEqual({ status: "idle" });
  });

  it("explicit playback actions are idempotent and preserve remaining time", () => {
    const { store, advance } = setup();
    store.dispatch({ type: "start" });
    store.dispatch({ type: "pause" });
    expect(store.getState().status).toBe("idle");
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "start" });
    advance(10_000);
    store.dispatch({ type: "start" });
    expect(store.getSnapshot().remaining).toBe(50_000);
    store.dispatch({ type: "pause" });
    advance(5_000);
    store.dispatch({ type: "pause" });
    expect(store.getSnapshot().remaining).toBe(50_000);
    store.dispatch({ type: "start" });
    advance(1_000);
    expect(store.getSnapshot().remaining).toBe(49_000);
  });

  it("rejects invalid minutes via the timer core", () => {
    const { store } = setup();
    expect(() => {
      store.dispatch({ type: "add", minutes: 0 });
    }).toThrow(RangeError);
  });

  it("reconcile without elapsed deadline leaves state untouched", () => {
    const { store, advance } = setup();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    const before = store.getState();
    advance(1_000);
    store.dispatch({ type: "reconcile" });
    expect(store.getState()).toBe(before);
  });

  it("throws on an unknown action type (exhaustive switch guard)", () => {
    const { store } = setup();
    // Simulates an unvalidated message reaching dispatch at runtime.
    const bad = JSON.parse('{"type":"nope"}') as Action;
    expect(() => {
      store.dispatch(bad);
    }).toThrow();
  });
});

describe("completion", () => {
  function running() {
    const ctx = setup();
    const done = vi.fn();
    ctx.store.onComplete(done);
    ctx.store.dispatch({ type: "add", minutes: 1 });
    ctx.store.dispatch({ type: "toggle" });
    return { ...ctx, done };
  }

  it("fires once on reconcile past the deadline, even across many reconciles", () => {
    const { store, advance, done } = running();
    advance(MINUTE);
    for (let i = 0; i < 5; i++) {
      store.dispatch({ type: "reconcile" });
      advance(1_000);
    }
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("done");
  });

  it("fires once after a late (sleep) jump far beyond the deadline", () => {
    const { store, advance, done } = running();
    advance(8 * 60 * 60_000);
    store.dispatch({ type: "reconcile" });
    store.dispatch({ type: "reconcile" });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("is reported before a toggle that arrives after the deadline", () => {
    const { store, advance, done } = running();
    advance(MINUTE + 1);
    store.dispatch({ type: "toggle" });
    expect(done).toHaveBeenCalledTimes(1);
    // Toggle on done is a no-op: the expired timer is not resurrected.
    expect(store.getState().status).toBe("done");
  });

  it.each(["start", "pause"] as const)(
    "reports completion before a late %s action without reviving the timer",
    (type) => {
      const { store, advance, done } = running();
      advance(MINUTE);
      store.dispatch({ type });
      store.dispatch({ type });
      expect(done).toHaveBeenCalledTimes(1);
      expect(store.getState().status).toBe("done");
    },
  );

  it("is reported before add restarts an expired timer", () => {
    const { store, advance, done } = running();
    advance(2 * MINUTE);
    store.dispatch({ type: "add", minutes: 1 });
    expect(done).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("paused");
  });

  it("fires again for a later, separate completion", () => {
    const { store, advance, done } = running();
    advance(MINUTE);
    store.dispatch({ type: "reconcile" });
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    advance(MINUTE);
    store.dispatch({ type: "reconcile" });
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("does not fire for pause before the deadline", () => {
    const { store, advance, done } = running();
    advance(MINUTE - 1);
    store.dispatch({ type: "toggle" });
    advance(MINUTE);
    store.dispatch({ type: "reconcile" });
    expect(done).not.toHaveBeenCalled();
  });

  it("does not fire when restoring an initial done state", () => {
    const { store } = setup({ status: "done", baseline: ms(MINUTE) });
    const done = vi.fn();
    store.onComplete(done);
    store.dispatch({ type: "reconcile" });
    expect(done).not.toHaveBeenCalled();
  });

  it("completion listener runs before subscribers see the done snapshot", () => {
    const { store, advance } = running();
    const order: string[] = [];
    store.onComplete(() => order.push("complete"));
    store.subscribe((s) => order.push(s.status));
    advance(MINUTE);
    store.dispatch({ type: "reconcile" });
    expect(order).toEqual(["complete", "done"]);
  });
});

describe("subscriptions", () => {
  it("notifies on every dispatch, including reconcile, with a fresh snapshot", () => {
    const { store, advance } = setup();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.remaining));
    advance(1_000);
    store.dispatch({ type: "reconcile" });
    advance(1_000);
    store.dispatch({ type: "reconcile" });
    expect(seen).toEqual([59_000, 58_000]);
  });

  it("unsubscribe stops notifications and is idempotent", () => {
    const { store } = setup();
    const fn = vi.fn();
    const other = vi.fn();
    const off = store.subscribe(fn);
    store.subscribe(other);
    off();
    off();
    store.dispatch({ type: "reconcile" });
    expect(fn).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("onComplete unsubscribe is idempotent", () => {
    const { store, advance } = setup();
    const done = vi.fn();
    const off = store.onComplete(done);
    off();
    off();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    advance(MINUTE);
    store.dispatch({ type: "reconcile" });
    expect(done).not.toHaveBeenCalled();
  });

  it("registering the same function twice yields independent unsubscribes", () => {
    const { store } = setup();
    const fn = vi.fn();
    const off1 = store.subscribe(fn);
    store.subscribe(fn);
    off1();
    store.dispatch({ type: "reconcile" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a subscriber unsubscribing during notification does not skip others", () => {
    const { store } = setup();
    const second = vi.fn();
    const off = store.subscribe(() => {
      off();
    });
    store.subscribe(second);
    store.dispatch({ type: "reconcile" });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
