/**
 * FloatManager: owns Document PiP face placement and the read-only video fallback.
 *
 * Responsibilities:
 * - Mount the page face on construction, so exactly one module decides which
 *   document shows the face and two faces never coexist.
 * - Move the face into a PiP window on `open()`, leaving a placeholder with a
 *   "Bring back" action in the page; restore on `close()` or when the browser
 *   closes the window (`pagehide`).
 * - Point the ticker's frames at the PiP window while it is open, because the
 *   opener tab is often hidden then and its rAF stops.
 * - Guard re-entrancy (a pending request makes `open()` a no-op) and expose a
 *   small state machine for UI controls.
 * - Never touch the store: floating is presentation only and must not start,
 *   pause or reset the timer.
 */
import { TEXT } from "../texts";
import type { FrameSource } from "../scheduler";
import {
  isDocPipSupported,
  openDocPip,
  type DocPipFailure,
  type DocPipHost,
  type PipWindow,
} from "./docpip";
import type { VideoPipController } from "./videopip";

export type FloatState =
  | { readonly kind: "closed" }
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly mode: "document" | "video" }
  | { readonly kind: "failed"; readonly reason: DocPipFailure };

export interface Mounted {
  dispose(): void;
}

/** The only part of `Ticker` the manager needs. */
export interface FrameSourceSink {
  setFrameSource(source: FrameSource | null): void;
}

// A compact portrait window that fits the ring plus the quick-add row; browsers may clamp it.
const PIP_SIZE = { width: 240, height: 300 } as const;

interface Session {
  readonly pip: PipWindow;
  readonly face: Mounted;
  readonly placeholder: HTMLElement;
  readonly bringBack: HTMLButtonElement;
}

export class FloatManager {
  private state: FloatState = { kind: "closed" };
  private readonly listeners = new Set<(s: FloatState) => void>();
  private pageFace: Mounted | null;
  private session: Session | null = null;
  private videoOpen = false;
  /** Set when close()/dispose() arrive while a request is pending; the window is closed on arrival. */
  private abandonOpening = false;
  private disposed = false;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly mount: (host: HTMLElement) => Mounted,
    private readonly ticker: FrameSourceSink,
    private readonly win: DocPipHost = window,
    private readonly video: VideoPipController | null = null,
  ) {
    this.pageFace = mount(pageHost);
  }

  /** @returns the current float state (a stable object until the next transition). */
  getState(): FloatState {
    return this.state;
  }

  /** @returns an idempotent function that removes `cb`. */
  onStateChange(cb: (s: FloatState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** @returns a promise settling once the triggered open or close has finished. */
  async toggle(): Promise<void> {
    if (this.state.kind === "open") this.close();
    else await this.open();
  }

  /** @returns a promise settling after the request resolved; a no-op while opening/open. */
  async open(): Promise<void> {
    if (
      this.disposed ||
      this.state.kind === "opening" ||
      this.state.kind === "open"
    )
      return;
    this.abandonOpening = false;
    this.setState({ kind: "opening" });
    if (!isDocPipSupported(this.win) && this.video !== null) {
      const result = await this.video.open(this.onPipHide);
      if (this.cancelledWhileOpening()) {
        this.video.close();
        if (!this.isDisposed()) this.setState({ kind: "closed" });
      } else if (!result.ok) {
        this.setState({ kind: "failed", reason: result.reason });
      } else {
        this.videoOpen = true;
        this.setState({ kind: "open", mode: "video" });
      }
      return;
    }
    const result = await openDocPip(PIP_SIZE, this.win);
    // Re-read through a method: close()/dispose() may have run during the await,
    // which TypeScript's narrowing of `this` fields cannot see.
    if (this.cancelledWhileOpening()) {
      if (result.ok) result.pip.close();
      if (!this.isDisposed()) this.setState({ kind: "closed" });
      return;
    }
    if (!result.ok) {
      this.setState({ kind: "failed", reason: result.reason });
      return;
    }
    this.attach(result.pip);
    this.setState({ kind: "open", mode: "document" });
  }

  /** Restores the face to the page; safe in any state and repeatedly. */
  close(): void {
    if (this.state.kind === "opening") {
      this.abandonOpening = true;
      this.video?.close();
      return;
    }
    this.video?.close();
    if (this.videoOpen) {
      this.videoOpen = false;
      this.setState({ kind: "closed" });
      return;
    }
    if (this.state.kind === "failed") this.setState({ kind: "closed" });
    if (this.session === null) return;
    this.detach(this.session);
    this.pageFace = this.mount(this.pageHost);
    this.setState({ kind: "closed" });
  }

  /** Closes PiP, removes the face and all listeners; safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video?.dispose();
    this.videoOpen = false;
    if (this.session !== null) this.detach(this.session);
    this.pageFace?.dispose();
    this.pageFace = null;
    this.listeners.clear();
    this.state = { kind: "closed" };
  }

  // Browser-initiated close (window X, tab navigation) ends the session the same way as "Bring back".
  private readonly onPipHide = (): void => {
    this.close();
  };

  private readonly onBringBack = (): void => {
    this.close();
  };

  private attach(pip: PipWindow): void {
    this.pageFace?.dispose();
    this.pageFace = null;

    const doc = this.pageHost.ownerDocument;
    const placeholder = doc.createElement("div");
    placeholder.className = "float-placeholder";
    const note = doc.createElement("p");
    note.textContent = TEXT.floatPlaceholder;
    const bringBack = doc.createElement("button");
    bringBack.type = "button";
    bringBack.className = "timer__btn";
    bringBack.textContent = TEXT.floatBringBack;
    bringBack.addEventListener("click", this.onBringBack);
    placeholder.append(note, bringBack);
    this.pageHost.append(placeholder);

    const wrapper = pip.document.createElement("div");
    wrapper.className = "float-host";
    pip.document.body.append(wrapper);
    const face = this.mount(wrapper);

    pip.addEventListener("pagehide", this.onPipHide);
    this.ticker.setFrameSource(pip);
    this.session = { pip, face, placeholder, bringBack };
  }

  private detach(s: Session): void {
    // Cleared first so the pagehide fired by pip.close() below re-enters close() as a no-op.
    this.session = null;
    s.pip.removeEventListener("pagehide", this.onPipHide);
    s.face.dispose();
    this.ticker.setFrameSource(null);
    if (!s.pip.closed) s.pip.close();
    s.bringBack.removeEventListener("click", this.onBringBack);
    s.placeholder.remove();
  }

  private cancelledWhileOpening(): boolean {
    return this.disposed || this.abandonOpening;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private setState(s: FloatState): void {
    this.state = s;
    for (const cb of [...this.listeners]) cb(s);
  }
}
