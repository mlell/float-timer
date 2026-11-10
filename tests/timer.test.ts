// Verifies the pure timer core: transition table, completion-once, clamping,
// boundary validation, and invariants under random action sequences.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IDLE,
  MAX_DURATION,
  MINUTE,
  add,
  assertNever,
  epoch,
  ms,
  pause,
  reset,
  snapshot,
  start,
  tick,
  toggle,
  type Epoch,
  type TimerState,
} from "../src/timer";

const t = epoch;

const paused = (remaining: number, baseline = remaining): TimerState => ({
  status: "paused",
  remaining: ms(remaining),
  baseline: ms(baseline),
});
const running = (deadline: number, baseline: number): TimerState => ({
  status: "running",
  deadline: t(deadline),
  baseline: ms(baseline),
});
const done = (baseline: number): TimerState => ({
  status: "done",
  baseline: ms(baseline),
});

describe("constructors", () => {
  it("accept non-negative safe integers", () => {
    expect(ms(0)).toBe(0);
    expect(epoch(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([-1, NaN, 1.5, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "reject %s",
    (bad) => {
      expect(() => ms(bad)).toThrow(RangeError);
      expect(() => epoch(bad)).toThrow(RangeError);
    },
  );

  it("exposes minute and 24h maximum", () => {
    expect(MINUTE).toBe(60_000);
    expect(MAX_DURATION).toBe(86_400_000);
  });
});

describe("transitions", () => {
  const now = t(1000);
  const cases: readonly {
    name: string;
    fn: (s: TimerState, n: Epoch) => TimerState;
    from: TimerState;
    to: TimerState;
  }[] = [
    { name: "start idle", fn: start, from: IDLE, to: IDLE },
    {
      name: "start paused",
      fn: start,
      from: paused(5000, 9000),
      to: running(6000, 9000),
    },
    {
      name: "start running",
      fn: start,
      from: running(5000, 9000),
      to: running(5000, 9000),
    },
    { name: "start done", fn: start, from: done(9000), to: done(9000) },
    { name: "pause idle", fn: pause, from: IDLE, to: IDLE },
    {
      name: "pause running",
      fn: pause,
      from: running(5000, 9000),
      to: paused(4000, 9000),
    },
    {
      name: "pause at deadline",
      fn: pause,
      from: running(1000, 9000),
      to: done(9000),
    },
    {
      name: "pause after deadline",
      fn: pause,
      from: running(500, 9000),
      to: done(9000),
    },
    {
      name: "pause paused",
      fn: pause,
      from: paused(5000, 9000),
      to: paused(5000, 9000),
    },
    { name: "pause done", fn: pause, from: done(9000), to: done(9000) },
    { name: "toggle idle", fn: toggle, from: IDLE, to: IDLE },
    {
      name: "toggle paused",
      fn: toggle,
      from: paused(5000, 9000),
      to: running(6000, 9000),
    },
    {
      name: "toggle running",
      fn: toggle,
      from: running(5000, 9000),
      to: paused(4000, 9000),
    },
    { name: "toggle done", fn: toggle, from: done(9000), to: done(9000) },
  ];

  it.each(cases)("$name", ({ fn, from, to }) => {
    expect(fn(from, now)).toEqual(to);
  });

  it("reset returns IDLE", () => {
    expect(reset()).toBe(IDLE);
  });
});

describe("tick", () => {
  it("leaves non-running states untouched", () => {
    for (const s of [IDLE, paused(1000), done(1000)]) {
      expect(tick(s, t(10_000))).toEqual({ state: s, completed: false });
    }
  });

  it("does not complete before the deadline", () => {
    const s = running(5000, 5000);
    expect(tick(s, t(4999))).toEqual({ state: s, completed: false });
  });

  it("completes at and after the deadline", () => {
    expect(tick(running(5000, 7000), t(5000))).toEqual({
      state: done(7000),
      completed: true,
    });
    expect(tick(running(5000, 7000), t(99_999))).toEqual({
      state: done(7000),
      completed: true,
    });
  });

  it("fires completion exactly once over repeated ticks", () => {
    let s: TimerState = running(5000, 5000);
    let completions = 0;
    for (let now = 0; now <= 20_000; now += 250) {
      const r = tick(s, t(now));
      s = r.state;
      if (r.completed) completions++;
    }
    expect(completions).toBe(1);
    expect(s.status).toBe("done");
  });
});

describe("add", () => {
  const now = t(10_000);

  it("extends deadline and baseline while running", () => {
    expect(add(running(10_000 + 30_000, MINUTE), 1, now)).toEqual(
      running(10_000 + 90_000, 2 * MINUTE),
    );
  });

  it("restarts from zero when running state is already past its deadline", () => {
    expect(add(running(5000, MINUTE), 3, now)).toEqual(
      running(10_000 + 3 * MINUTE, 4 * MINUTE),
    );
  });

  it("extends remaining and baseline while paused, staying paused", () => {
    expect(add(paused(30_000, MINUTE), 5, now)).toEqual(
      paused(30_000 + 5 * MINUTE, 6 * MINUTE),
    );
  });

  it.each([
    ["idle", IDLE],
    ["done", done(MINUTE)],
  ] as const)("creates a paused timer from %s", (_, s) => {
    expect(add(s, 3, now)).toEqual(paused(3 * MINUTE));
  });

  it("clamps running state at MAX_DURATION", () => {
    const s = add(
      running(10_000 + MAX_DURATION - 1000, MAX_DURATION - 1000),
      5,
      now,
    );
    expect(s).toEqual(running(10_000 + MAX_DURATION, MAX_DURATION));
  });

  it("clamps paused state at MAX_DURATION", () => {
    expect(add(paused(MAX_DURATION - 1000, MAX_DURATION), 5, now)).toEqual(
      paused(MAX_DURATION, MAX_DURATION),
    );
  });

  it("clamps idle additions at MAX_DURATION", () => {
    expect(add(IDLE, 24 * 60 + 1, now)).toEqual(paused(MAX_DURATION));
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects minutes=%s", (bad) => {
    expect(() => add(IDLE, bad, now)).toThrow(RangeError);
  });
});

describe("snapshot", () => {
  const now = t(1000);

  it("reports idle as zero", () => {
    expect(snapshot(IDLE, now)).toEqual({
      status: "idle",
      remaining: 0,
      baseline: 0,
      progress: 0,
    });
  });

  it("derives running remaining from deadline", () => {
    expect(snapshot(running(4000, 6000), now)).toEqual({
      status: "running",
      remaining: 3000,
      baseline: 6000,
      progress: 0.5,
    });
  });

  it("clamps running remaining at zero", () => {
    expect(snapshot(running(500, 1000), now)).toMatchObject({
      remaining: 0,
      progress: 1,
    });
  });

  it("reports paused and done", () => {
    expect(snapshot(paused(1500, 6000), now)).toMatchObject({
      status: "paused",
      remaining: 1500,
      progress: 0.75,
    });
    expect(snapshot(done(6000), now)).toMatchObject({
      status: "done",
      remaining: 0,
      progress: 1,
    });
  });

  it("returns progress 0 for a zero baseline", () => {
    expect(snapshot(done(0), now).progress).toBe(0);
  });

  it("clamps progress when remaining exceeds baseline", () => {
    expect(snapshot(paused(5000, 1000), now).progress).toBe(0);
  });
});

describe("assertNever", () => {
  it("throws when reached at runtime", () => {
    expect(() => assertNever("x" as never)).toThrow();
  });
});

describe("properties", () => {
  type Action =
    | { kind: "start" }
    | { kind: "pause" }
    | { kind: "toggle" }
    | { kind: "reset" }
    | { kind: "add"; minutes: number }
    | { kind: "tick" };

  const actionArb: fc.Arbitrary<Action> = fc.oneof(
    fc.constant<Action>({ kind: "start" }),
    fc.constant<Action>({ kind: "pause" }),
    fc.constant<Action>({ kind: "toggle" }),
    fc.constant<Action>({ kind: "reset" }),
    fc.constant<Action>({ kind: "tick" }),
    fc
      .constantFrom(1, 3, 5, 600, 2000)
      .map<Action>((minutes) => ({ kind: "add", minutes })),
  );

  const stepArb = fc.record({
    dt: fc.integer({ min: 0, max: 10 * MINUTE }),
    action: actionArb,
  });

  // Mirrors the store contract: tick runs before every action.
  const apply = (s: TimerState, a: Action, now: Epoch): TimerState => {
    const ticked = tick(s, now).state;
    switch (a.kind) {
      case "start":
        return start(ticked, now);
      case "pause":
        return pause(ticked, now);
      case "toggle":
        return toggle(ticked, now);
      case "reset":
        return reset();
      case "add":
        return add(ticked, a.minutes, now);
      case "tick":
        return ticked;
      default:
        return assertNever(a);
    }
  };

  it("keeps 0 <= remaining <= baseline <= MAX_DURATION", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        let s: TimerState = IDLE;
        let now = 0;
        for (const { dt, action } of steps) {
          now += dt;
          s = apply(s, action, t(now));
          const snap = snapshot(s, t(now));
          expect(snap.remaining).toBeGreaterThanOrEqual(0);
          expect(snap.remaining).toBeLessThanOrEqual(snap.baseline);
          expect(snap.baseline).toBeLessThanOrEqual(MAX_DURATION);
          expect(snap.progress).toBeGreaterThanOrEqual(0);
          expect(snap.progress).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("never increases remaining while running without add", () => {
    const noAdd = actionArb.filter((a) => a.kind !== "add");
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ dt: fc.integer({ min: 0, max: MINUTE }), action: noAdd }),
          {
            maxLength: 60,
          },
        ),
        fc.integer({ min: 1, max: 30 }),
        (steps, minutes) => {
          let s = add(IDLE, minutes, t(0));
          s = start(s, t(0));
          let now = 0;
          let prev = snapshot(s, t(now)).remaining;
          for (const { dt, action } of steps) {
            now += dt;
            s = apply(s, action, t(now));
            const cur = snapshot(s, t(now)).remaining;
            // Pausing/starting/reset/done keep or lower remaining; only a paused
            // state may be resumed, which preserves it.
            expect(cur).toBeLessThanOrEqual(prev);
            prev = cur;
            if (s.status === "idle") break;
          }
        },
      ),
    );
  });

  it("reports every entry into done exactly once when tick precedes each action", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        let s: TimerState = IDLE;
        let now = 0;
        let completions = 0;
        let doneEntries = 0;
        for (const { dt, action } of steps) {
          now += dt;
          const wasDone = s.status === "done";
          const r = tick(s, t(now));
          if (r.completed) completions++;
          s = apply(r.state, action, t(now));
          if (!wasDone && (r.state.status === "done" || s.status === "done"))
            doneEntries++;
        }
        expect(completions).toBe(doneEntries);
      }),
    );
  });
});
