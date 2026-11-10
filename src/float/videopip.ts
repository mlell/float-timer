/**
 * Video PiP fallback: renders read-only store snapshots into a captured canvas.
 * Owns playback, background refreshes, browser-close listeners and stream cleanup.
 * Keeps playback prepared after an activation failure so the next click can
 * request PiP synchronously, without consuming its gesture in video.play().
 */
import type { Store } from "../store";
import { TEXT } from "../texts";
import type { Snapshot } from "../timer";
import { formatMinutes, litSegments } from "../view";
import type { DocPipFailure } from "./docpip";

interface PipVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?(mode: string): boolean;
  webkitSetPresentationMode?(mode: string): void;
  readonly webkitPresentationMode?: string;
}

export type VideoPipResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DocPipFailure };

/** Lifecycle used by FloatManager; video mode never moves the interactive page face. */
export interface VideoPipController {
  open(onClose: () => void): Promise<VideoPipResult>;
  close(): void;
  dispose(): void;
}

function supportsPip(doc: Document, video: PipVideo): boolean {
  return (
    (doc.pictureInPictureEnabled &&
      typeof video.requestPictureInPicture === "function") ||
    // Safari's media-specific eligibility probe returns false before playback.
    typeof video.webkitSetPresentationMode === "function"
  );
}

/** @returns whether canvas capture and either standard or Safari video PiP are available. */
export function isVideoPipSupported(doc: Document = document): boolean {
  return (
    typeof doc.createElement("canvas").captureStream === "function" &&
    supportsPip(doc, doc.createElement("video"))
  );
}

interface Session {
  readonly video: PipVideo;
  readonly stream: MediaStream;
  readonly release: () => void;
  ready: boolean;
  entered: boolean;
}

export class VideoPip implements VideoPipController {
  private session: Session | null = null;
  private onClose: (() => void) | null = null;
  private readonly exiting = new Set<PipVideo>();

  constructor(
    private readonly store: Store,
    private readonly doc: Document = document,
  ) {}

  /** @returns success once PiP opens, or a failure allowing the page to explain a retry. */
  async open(onClose: () => void): Promise<VideoPipResult> {
    if (!isVideoPipSupported(this.doc)) {
      return { ok: false, reason: "unsupported" };
    }
    this.onClose = onClose;
    try {
      const session = this.session ?? this.prepare();
      if (!session.ready) {
        await session.video.play();
        if (this.session !== session) return { ok: false, reason: "error" };
        session.ready = true;
      }
      const video = session.video;
      if (
        this.doc.pictureInPictureEnabled &&
        typeof video.requestPictureInPicture === "function"
      ) {
        await video.requestPictureInPicture();
      } else {
        if (
          video.webkitSupportsPresentationMode?.("picture-in-picture") === false
        ) {
          this.close();
          return { ok: false, reason: "unsupported" };
        }
        await this.requestSafariPip(session);
      }
      if (this.session !== session) {
        this.exit(video);
        return { ok: false, reason: "error" };
      }
      session.entered = true;
      return { ok: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        return { ok: false, reason: "no-activation" };
      }
      this.close();
      return { ok: false, reason: "error" };
    }
  }

  /** Releases capture and rendering, and exits only this timer's video PiP. */
  close(): void {
    const session = this.session;
    this.session = null;
    this.onClose = null;
    if (session === null) return;
    session.release();
    this.exit(session.video);
    session.video.pause();
    session.video.srcObject = null;
    for (const track of session.stream.getTracks()) track.stop();
    session.video.remove();
  }

  private exit(video: PipVideo): void {
    if (this.doc.pictureInPictureElement === video) {
      void this.doc.exitPictureInPicture().catch(() => undefined);
    } else if (
      video.webkitPresentationMode === "picture-in-picture" &&
      !this.exiting.has(video)
    ) {
      const win = this.doc.defaultView;
      if (win === null) return;
      this.exiting.add(video);
      let attempts = 0;
      let timeout: number | null = null;
      const cleanup = (): void => {
        if (timeout !== null) win.clearTimeout(timeout);
        video.removeEventListener("webkitpresentationmodechanged", onChange);
        this.exiting.delete(video);
      };
      const onChange = (): void => {
        if (video.webkitPresentationMode === "inline") cleanup();
      };
      const retry = (): void => {
        if (video.webkitPresentationMode !== "picture-in-picture") {
          cleanup();
          return;
        }
        try {
          video.webkitSetPresentationMode?.("inline");
        } catch {
          cleanup();
          return;
        }
        onChange();
        attempts++;
        if (!this.exiting.has(video) || attempts >= 30) cleanup();
        else timeout = win.setTimeout(retry, 100);
      };
      // WebKit can ignore inline requests until its native entry animation ends,
      // even after announcing PiP. Retain bounded cleanup until exit is confirmed.
      video.addEventListener("webkitpresentationmodechanged", onChange);
      retry();
    }
  }

  /** Releases an open or prepared session; safe to call repeatedly. */
  dispose(): void {
    this.close();
  }

  private requestSafariPip(session: Session): Promise<void> {
    const win = this.doc.defaultView;
    if (win === null)
      return Promise.reject(new Error("Missing browsing context"));
    const video = session.video;
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = (): void => {
        finished = true;
        win.clearTimeout(timeout);
        video.removeEventListener("webkitpresentationmodechanged", onChange);
      };
      const onChange = (): void => {
        if (finished || video.webkitPresentationMode !== "picture-in-picture")
          return;
        session.entered = true;
        // WebKit queues entry without returning a promise. Keep this observer
        // separate from session cleanup so a cancelled request cannot enter orphaned PiP.
        if (this.session !== session) this.exit(video);
        cleanup();
        resolve();
      };
      const timeout = win.setTimeout(() => {
        onChange();
        if (finished) return;
        cleanup();
        // The prefixed setter can silently decline entry after play() consumes activation.
        reject(
          new DOMException("PiP entry was not confirmed", "NotAllowedError"),
        );
      }, 1500);
      video.addEventListener("webkitpresentationmodechanged", onChange);
      try {
        video.webkitSetPresentationMode?.("picture-in-picture");
        onChange();
      } catch (error) {
        cleanup();
        reject(
          error instanceof Error || error instanceof DOMException
            ? error
            : new Error("Safari PiP entry failed", { cause: error }),
        );
      }
    });
  }

  private prepare(): Session {
    const win = this.doc.defaultView;
    if (win === null) throw new Error("Video PiP requires a browsing context");
    const canvas = this.doc.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas rendering unavailable");
    const style = win.getComputedStyle(this.doc.documentElement);
    const color = (name: string): string => style.getPropertyValue(name).trim();
    let previous = "";
    const render = (snap: Snapshot, force = false): void => {
      const lit = litSegments(snap);
      const label = formatMinutes(snap.remaining);
      const key = `${String(lit)}:${label}:${snap.status}`;
      if (!force && previous === key) return;
      previous = key;
      context.fillStyle = color("--color-bg");
      context.fillRect(0, 0, 320, 320);
      for (let i = 0; i < 12; i++) {
        context.strokeStyle =
          snap.status === "done"
            ? color("--color-done")
            : color(i < lit ? "--color-segment-on" : "--color-segment-off");
        context.lineWidth = 26;
        context.beginPath();
        const start = -Math.PI / 2 + (i * Math.PI) / 6;
        context.arc(160, 160, 112, start, start + 23 / 50);
        context.stroke();
      }
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = color("--color-text");
      context.font = `bold 64px ${color("--font-family")}`;
      context.fillText(label, 160, 148);
      context.font = `18px ${color("--font-family")}`;
      if (snap.status === "done") {
        context.fillStyle = color("--color-done");
        context.fillText(TEXT.timesUp, 160, 198);
      } else if (snap.status === "paused") {
        context.fillText(TEXT.paused, 160, 198);
      }
    };
    const video: PipVideo = this.doc.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.className = "float-video";
    // Keep the video attached and laid out: Safari can reject PiP for display:none media.
    this.doc.body.append(video);
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(4);
    } catch (error) {
      video.remove();
      throw error;
    }
    const onLeave = (): void => {
      const notify = this.onClose;
      this.close();
      notify?.();
    };
    const onPresentationChange = (): void => {
      if (
        session.entered &&
        video.webkitPresentationMode !== "picture-in-picture"
      )
        onLeave();
    };
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener(
      "webkitpresentationmodechanged",
      onPresentationChange,
    );
    win.addEventListener("pagehide", onLeave);
    const unsubscribe = this.store.subscribe(render);
    // Hidden tabs stop rAF. Periodic reconciles keep the captured timer updating;
    // the deadline model stays accurate even if the browser throttles callbacks.
    const interval = win.setInterval(() => {
      this.store.dispatch({ type: "reconcile" });
      // Supply frames even when the minute label is unchanged, keeping video playback live.
      render(this.store.getSnapshot(), true);
    }, 250);
    const session: Session = {
      video,
      stream,
      ready: false,
      entered: false,
      release: () => {
        win.clearInterval(interval);
        unsubscribe();
        video.removeEventListener("leavepictureinpicture", onLeave);
        video.removeEventListener(
          "webkitpresentationmodechanged",
          onPresentationChange,
        );
        win.removeEventListener("pagehide", onLeave);
      },
    };
    this.session = session;
    video.srcObject = stream;
    render(this.store.getSnapshot());
    return session;
  }
}
