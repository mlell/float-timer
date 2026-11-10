/**
 * Store: the only stateful owner of `TimerState`.
 *
 * Responsibilities:
 * - Hold the current state and apply user/ticker actions through the pure
 *   functions of `timer.ts`, reading the clock exactly once per dispatch so a
 *   single action sees one consistent `now`.
 * - Run `tick` before every action so a deadline that passed earlier (late
 *   callback, sleep/wake, hidden tab) is reported as completion before the
 *   action could pause or extend the timer (see the contract of `pause`).
 * - Fan out completion and snapshots to plain listener lists; renderers only
 *   consume, they never detect completion themselves.
 */
import {
  add,
  assertNever,
  reset,
  snapshot,
  tick,
  toggle,
  IDLE,
  type Epoch,
  type Snapshot,
  type TimerState,
} from "./timer";

export type Action =
  | { readonly type: "toggle" }
  | { readonly type: "reset" }
  | { readonly type: "add"; readonly minutes: number }
  // Ticker frame action: applies only the pre-action `tick`, so time passing
  // alone can complete the timer.
  | { readonly type: "reconcile" };

/** Injected time source so tests and callers control `now`; returns the current `Epoch`. */
export type Clock = () => Epoch;

export interface Store {
  /** @returns a fresh `Snapshot` derived from the current state at `clock()`. */
  getSnapshot(): Snapshot;
  /** @returns the current `TimerState` as of the last dispatch (not re-ticked). */
  getState(): TimerState;
  dispatch(a: Action): void;
  /** @returns an idempotent function that removes this subscriber. */
  subscribe(fn: (s: Snapshot) => void): () => void;
  /** @returns an idempotent function that removes this completion listener. */
  onComplete(fn: () => void): () => void;
}

function applyAction(s: TimerState, a: Action, now: Epoch): TimerState {
  switch (a.type) {
    case "toggle":
      return toggle(s, now);
    case "reset":
      return reset();
    case "add":
      return add(s, a.minutes, now);
    case "reconcile":
      return s;
    default:
      return assertNever(a);
  }
}

/**
 * Creates a store reading time from `clock`.
 * @returns a `Store` starting in `initial` (default `IDLE`). Completion listeners fire once
 * per `running -> done` transition, before subscribers are notified of the resulting snapshot.
 */
export function createStore(clock: Clock, initial: TimerState = IDLE): Store {
  let state = initial;
  // Arrays (not Sets) because the same function may legitimately be registered
  // twice and each registration needs its own idempotent unsubscribe.
  const subscribers: ((s: Snapshot) => void)[] = [];
  const completeListeners: (() => void)[] = [];

  function remover<T>(list: T[], item: T): () => void {
    return () => {
      const i = list.indexOf(item);
      if (i !== -1) list.splice(i, 1);
    };
  }

  return {
    getSnapshot: () => snapshot(state, clock()),
    getState: () => state,
    dispatch(a) {
      const now = clock();
      const ticked = tick(state, now);
      state = applyAction(ticked.state, a, now);
      // Copies so listeners (un)subscribing during notification cannot skip or repeat others.
      if (ticked.completed) {
        for (const fn of [...completeListeners]) fn();
      }
      // Always notified: `remaining` changes with time even when state is unchanged.
      const snap = snapshot(state, now);
      for (const fn of [...subscribers]) fn(snap);
    },
    subscribe(fn) {
      // Wrapped so registering the same function twice yields distinct entries.
      const entry = (s: Snapshot): void => {
        fn(s);
      };
      subscribers.push(entry);
      return remover(subscribers, entry);
    },
    onComplete(fn) {
      const entry = (): void => {
        fn();
      };
      completeListeners.push(entry);
      return remover(completeListeners, entry);
    },
  };
}
