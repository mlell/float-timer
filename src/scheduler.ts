/**
 * Ticker: drives the store's `reconcile` action from browser timing sources.
 *
 * Responsibilities:
 * - While the timer is running, request reconcile callbacks at the best rate
 *   the page state allows: requestAnimationFrame when visible (smooth ring),
 *   a single setTimeout aimed at the deadline when hidden.
 * - Reconcile on lifecycle events (visibility, focus, pageshow, `resume`) that
 *   signal the page may have been frozen or the machine slept.
 * - Own every acquired resource (listeners, frame/timeout handles, store
 *   subscription) and release them in an idempotent `dispose()`.
 *
 * Callback timing affects smoothness only: the deadline model in `timer.ts`
 * computes remaining time from the clock, so late or skipped callbacks never
 * change the countdown length.
 */
import type { Store } from "./store";

/** Largest delay setTimeout accepts; larger values overflow and fire immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type Win = Window & typeof globalThis;

export class Ticker {
  private readonly store: Store;
  private readonly win: Win;
  private readonly unsubscribe: () => void;
  private readonly lifecycleEvents: readonly (readonly [EventTarget, string])[];
  private frameId: number | null = null;
  private timeoutId: number | null = null;
  private disposed = false;

  constructor(store: Store, win: Win = window) {
    this.store = store;
    this.win = win;

    this.lifecycleEvents = [
      [win.document, "visibilitychange"],
      [win, "focus"],
      [win, "pageshow"],
      // Non-standard (Page Lifecycle API, Chromium): fired when a frozen page resumes.
      [win.document, "resume"],
    ];
    for (const [target, type] of this.lifecycleEvents) {
      target.addEventListener(type, this.onLifecycle);
    }

    // Rescheduling here (never dispatching) is what keeps the dispatch ->
    // notify -> subscriber loop free of synchronous recursion.
    this.unsubscribe = store.subscribe(() => {
      this.schedule();
    });
    this.schedule();
  }

  /** Releases listeners, pending frame/timeout and the store subscription; safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [target, type] of this.lifecycleEvents) {
      target.removeEventListener(type, this.onLifecycle);
    }
    this.cancelPending();
    this.unsubscribe();
  }

  private readonly onLifecycle = (): void => {
    this.store.dispatch({ type: "reconcile" });
  };

  private readonly onFrame = (): void => {
    this.frameId = null;
    this.store.dispatch({ type: "reconcile" });
  };

  private readonly onTimeout = (): void => {
    this.timeoutId = null;
    this.store.dispatch({ type: "reconcile" });
  };

  private cancelPending(): void {
    if (this.frameId !== null) {
      this.win.cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    if (this.timeoutId !== null) {
      this.win.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Re-evaluates which timing source should be pending for the current state.
   * Cancels and re-arms on every call so a changed deadline (add) or visibility
   * flip never leaves a stale callback behind.
   */
  private schedule(): void {
    if (this.disposed) return;
    this.cancelPending();

    const state = this.store.getState();
    if (state.status !== "running") return;

    if (this.win.document.visibilityState === "visible") {
      this.frameId = this.win.requestAnimationFrame(this.onFrame);
      return;
    }

    // Hidden tabs clamp timers to >= 1 s and pause rAF entirely
    // (https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#reasons_for_delays_longer_than_specified),
    // so aim straight at the deadline: completion fires as soon as the
    // browser allows, and nothing else is needed while nobody is looking.
    // `remaining` comes from the store's snapshot so the injected clock, not
    // Date.now(), stays the single time source.
    this.timeoutId = this.win.setTimeout(
      this.onTimeout,
      Math.min(this.store.getSnapshot().remaining, MAX_TIMEOUT_MS),
    );
  }
}
