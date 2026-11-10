/**
 * Ticker: drives the store's `reconcile` action from browser timing sources.
 *
 * Responsibilities:
 * - While the timer is running, request reconcile callbacks at the best rate
 *   the page state allows: requestAnimationFrame when visible (smooth ring),
 *   a single setTimeout aimed at the deadline when hidden.
 * - Optionally prefer a second window's frames (`setFrameSource`, e.g. a
 *   Document PiP window): the opener tab is often hidden while PiP is shown,
 *   which stops the opener's rAF although the face is still on screen.
 * - Reconcile on lifecycle events (visibility, focus, pageshow, `resume`) that
 *   signal the page may have been frozen or the machine slept.
 * - Reset the completion indication after 15 seconds unless a user action
 *   has already left the done state.
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
const DONE_RESET_MS = 15_000;

interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Window that can deliver animation frames; structural so a PiP window or a test fake fits. */
export interface FrameSource {
  readonly document: VisibilityDocument;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

/** The only part of `Window` the Ticker needs; structural (like `AudioHost`) so tests can supply fakes. */
export interface TickerHost extends FrameSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export class Ticker {
  private readonly store: Store;
  private readonly win: TickerHost;
  private readonly unsubscribe: () => void;
  private readonly lifecycleEvents: readonly (readonly [Listenable, string])[];
  private frameSource: FrameSource | null = null;
  /** Pending frame with the window that issued it; handles are only valid for their own window. */
  private frame: { readonly id: number; readonly owner: FrameSource } | null =
    null;
  private timeoutId: number | null = null;
  private resetTimeoutId: number | null = null;
  private disposed = false;

  constructor(store: Store, win: TickerHost = window) {
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

  /**
   * Sets (or clears with `null`) a window whose frames take precedence while its
   * document is visible, and reschedules immediately. The previous source's
   * visibility listener is released.
   */
  setFrameSource(source: FrameSource | null): void {
    if (this.disposed || source === this.frameSource) return;
    this.frameSource?.document.removeEventListener(
      "visibilitychange",
      this.onSourceVisibility,
    );
    this.frameSource = source;
    source?.document.addEventListener(
      "visibilitychange",
      this.onSourceVisibility,
    );
    this.schedule();
  }

  /** Releases listeners, pending frame/timeout and the store subscription; safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [target, type] of this.lifecycleEvents) {
      target.removeEventListener(type, this.onLifecycle);
    }
    this.frameSource?.document.removeEventListener(
      "visibilitychange",
      this.onSourceVisibility,
    );
    this.frameSource = null;
    this.cancelPending();
    if (this.resetTimeoutId !== null) {
      this.win.clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
    this.unsubscribe();
  }

  // The source's visibility only changes which frames are used, not the time, so no reconcile is needed.
  private readonly onSourceVisibility = (): void => {
    this.schedule();
  };

  private readonly onLifecycle = (): void => {
    this.store.dispatch({ type: "reconcile" });
  };

  private readonly onFrame = (): void => {
    this.frame = null;
    this.store.dispatch({ type: "reconcile" });
  };

  private readonly onTimeout = (): void => {
    this.timeoutId = null;
    this.store.dispatch({ type: "reconcile" });
  };

  private cancelPending(): void {
    if (this.frame !== null) {
      this.frame.owner.cancelAnimationFrame(this.frame.id);
      this.frame = null;
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
    // Video refreshes and lifecycle reconciles must not restart this delay.
    if (state.status === "done") {
      this.resetTimeoutId ??= this.win.setTimeout(() => {
        this.resetTimeoutId = null;
        this.store.dispatch({ type: "reset" });
      }, DONE_RESET_MS);
    } else if (this.resetTimeoutId !== null) {
      this.win.clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
    if (state.status !== "running") return;

    const owner = [this.frameSource, this.win].find(
      (w) => w?.document.visibilityState === "visible",
    );
    if (owner) {
      this.frame = { id: owner.requestAnimationFrame(this.onFrame), owner };
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
