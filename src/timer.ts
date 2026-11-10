/**
 * Pure countdown core: the single source of truth for timer semantics.
 *
 * Responsibilities:
 * - Model the timer as a discriminated union driven by an absolute deadline
 *   (running) or a stored remaining duration (paused), so callback frequency
 *   only affects rendering smoothness, never the countdown length.
 * - Provide transition functions that receive `now` as a parameter; this
 *   module never reads a clock and never touches the DOM, which keeps it
 *   deterministic under test and shareable by page, floating and canvas views.
 * - Emit completion exactly once, from `tick` only. The store is expected to
 *   call `tick` before every other transition (see `pause`).
 * - Own the branded `Ms`/`Epoch` types and their validating constructors, the
 *   one place where untrusted numbers become typed values.
 */

/** Duration in whole milliseconds. Distinct from `Epoch` so they cannot be mixed up. */
export type Ms = number & { readonly __brand: "Ms" };

/** Timestamp in whole milliseconds since the Unix epoch. */
export type Epoch = number & { readonly __brand: "Epoch" };

function assertNonNegativeSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(
      `${what} must be a non-negative safe integer, got ${String(n)}`,
    );
  }
}

// Arithmetic on branded values is routed through the validating constructors
// (rather than casting) so a bug producing a negative or fractional value fails loudly.

/**
 * Validated boundary for durations; the only place a number is cast to `Ms`.
 * @returns `n` typed as `Ms`; throws `RangeError` unless `n` is a non-negative safe integer.
 */
export function ms(n: number): Ms {
  assertNonNegativeSafeInteger(n, "Ms");
  return n as Ms;
}

/**
 * Validated boundary for timestamps; the only place a number is cast to `Epoch`.
 * @returns `n` typed as `Epoch`; throws `RangeError` unless `n` is a non-negative safe integer.
 */
export function epoch(n: number): Epoch {
  assertNonNegativeSafeInteger(n, "Epoch");
  return n as Epoch;
}

export const MINUTE: Ms = ms(60_000);

/** Upper bound for both remaining time and baseline, so the ring and display stay bounded. */
export const MAX_DURATION: Ms = ms(24 * 60 * 60_000);

export type TimerState = Readonly<
  | { status: "idle" }
  | { status: "running"; deadline: Epoch; baseline: Ms }
  | { status: "paused"; remaining: Ms; baseline: Ms }
  | { status: "done"; baseline: Ms }
>;

/** Reset-to-zero state; starting from it is a no-op by design. */
export const IDLE: TimerState = { status: "idle" };

/** Lets `switch` statements fail to compile when a new status is added without handling. */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

function minMs(a: number, b: number): Ms {
  return ms(Math.min(a, b));
}

/** Remaining time of a running state; clamped at zero so a late callback never yields a negative duration. */
function remainingOf(deadline: Epoch, now: Epoch): Ms {
  return ms(Math.max(0, deadline - now));
}

/**
 * Resumes a paused timer with a fresh deadline of `now + remaining`.
 * @returns the running state for `paused`; the input state unchanged for `idle`, `running` and `done`.
 */
export function start(s: TimerState, now: Epoch): TimerState {
  switch (s.status) {
    case "paused":
      return {
        status: "running",
        deadline: epoch(now + s.remaining),
        baseline: s.baseline,
      };
    case "idle":
    case "running":
    case "done":
      return s;
    default:
      return assertNever(s);
  }
}

/**
 * Freezes a running timer at its remaining time.
 *
 * Contract: completion is only reported by `tick`. The store must call `tick`
 * before every action so a deadline passed before the pause is reported there;
 * for safety this function still returns the same `done` state `tick` would if
 * `now` is at or after the deadline, but it cannot report `completed`.
 * @returns a paused state with `remaining = deadline - now` while time is left; a `done`
 * state when none is left; the input state unchanged for non-running states.
 */
export function pause(s: TimerState, now: Epoch): TimerState {
  switch (s.status) {
    case "running": {
      const remaining = remainingOf(s.deadline, now);
      return remaining === 0
        ? { status: "done", baseline: s.baseline }
        : { status: "paused", remaining, baseline: s.baseline };
    }
    case "idle":
    case "paused":
    case "done":
      return s;
    default:
      return assertNever(s);
  }
}

/**
 * Single-button play/pause behaviour.
 * @returns `pause(s, now)` when running, otherwise `start(s, now)`.
 */
export function toggle(s: TimerState, now: Epoch): TimerState {
  return s.status === "running" ? pause(s, now) : start(s, now);
}

/**
 * Reset-to-zero (not restore-to-start) semantics, matching Classtimer.
 * @returns the `IDLE` state regardless of any input.
 */
export function reset(): TimerState {
  return IDLE;
}

/**
 * Adds whole minutes to remaining time and progress baseline, so the ring never shows an invalid fraction.
 * Remaining time of a running state is derived from `now` first, which makes an already
 * expired running state restart from zero instead of resurrecting stale time.
 * Both values are clamped to `MAX_DURATION`.
 * @returns running: same status with moved deadline and raised baseline; paused: raised
 * remaining and baseline; idle/done: a paused state holding exactly the added time.
 * Throws `RangeError` unless `minutes` is a positive integer.
 */
export function add(s: TimerState, minutes: number, now: Epoch): TimerState {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new RangeError(
      `minutes must be a positive integer, got ${String(minutes)}`,
    );
  }
  const delta = ms(minutes * MINUTE);
  switch (s.status) {
    case "running": {
      const remaining = minMs(
        remainingOf(s.deadline, now) + delta,
        MAX_DURATION,
      );
      return {
        status: "running",
        deadline: epoch(now + remaining),
        baseline: minMs(s.baseline + delta, MAX_DURATION),
      };
    }
    case "paused":
      return {
        status: "paused",
        remaining: minMs(s.remaining + delta, MAX_DURATION),
        baseline: minMs(s.baseline + delta, MAX_DURATION),
      };
    case "idle":
    case "done": {
      const initial = minMs(delta, MAX_DURATION);
      return { status: "paused", remaining: initial, baseline: initial };
    }
    default:
      return assertNever(s);
  }
}

/**
 * The only producer of the completion event, so renderers cannot double-fire or miss it.
 * @returns `{state: done, completed: true}` when running and `now >= deadline`;
 * otherwise the input state with `completed: false`, so repeated ticks report completion once.
 */
export function tick(
  s: TimerState,
  now: Epoch,
): { readonly state: TimerState; readonly completed: boolean } {
  if (s.status === "running" && now >= s.deadline) {
    return { state: { status: "done", baseline: s.baseline }, completed: true };
  }
  return { state: s, completed: false };
}

/** Read-only view model so renderers never inspect `TimerState` variants themselves. */
export interface Snapshot {
  readonly status: TimerState["status"];
  readonly remaining: Ms;
  readonly baseline: Ms;
  /** Fraction elapsed in [0, 1]; 0 when there is no baseline. */
  readonly progress: number;
}

/**
 * Derives display values from state at `now`.
 * @returns a `Snapshot` whose `remaining` is computed from the deadline when running
 * (0 for idle/done) and whose `progress` is `1 - remaining / baseline` (0 if baseline is 0).
 */
export function snapshot(s: TimerState, now: Epoch): Snapshot {
  const zero = ms(0);
  switch (s.status) {
    case "idle":
      return { status: s.status, remaining: zero, baseline: zero, progress: 0 };
    case "running":
      return view(s.status, remainingOf(s.deadline, now), s.baseline);
    case "paused":
      return view(s.status, s.remaining, s.baseline);
    case "done":
      return view(s.status, zero, s.baseline);
    default:
      return assertNever(s);
  }
}

function view(
  status: Snapshot["status"],
  remaining: Ms,
  baseline: Ms,
): Snapshot {
  // Clamped because a hand-built or restored state may violate remaining <= baseline.
  const progress =
    baseline === 0 ? 0 : Math.min(1, Math.max(0, 1 - remaining / baseline));
  return { status, remaining, baseline, progress };
}
