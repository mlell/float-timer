/**
 * View: the timer face (segmented ring, time label, controls), mountable into any `Document`.
 *
 * Responsibilities:
 * - Build the face DOM from `host.ownerDocument` only (never the global
 *   `document`), so the same code can later mount into a Document PiP window.
 * - Render store snapshots without owning any timing: every frame is compared
 *   against the previously rendered values so rAF-rate updates touch the DOM
 *   only when something visible changed.
 * - Translate clicks into store actions and gesture-unlock the `Beeper`
 *   (a click is the user activation Web Audio requires).
 * - Provide non-visual feedback: exact remaining time as an accessible name and
 *   a polite live region that speaks only on status transitions, never per frame.
 * - Release listeners, subscription and DOM in an idempotent `dispose()`.
 *
 * Also exports the pure formatting helpers so they are testable without a DOM.
 */
import type { Beeper } from "./audio";
import type { Store } from "./store";
import { announcementFor, QUICK_ADD_MINUTES, TEXT } from "./texts";
import { MINUTE, type Ms, type Snapshot } from "./timer";

const SVG_NS = "http://www.w3.org/2000/svg";
const SEGMENT_COUNT = 12;

// Icon paths and segment geometry are copied from Classtimer (24x24 Material-style icons).
const ICON_PLAY = "M8 5v14l11-7z";
const ICON_PAUSE = "M6 5h4v14H6zm8 0h4v14h-4z";
const ICON_RESET =
  "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
// Speaker with and without sound waves; Material "volume_up" / "volume_off".
const ICON_SOUND_ON =
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z";
const ICON_SOUND_OFF =
  "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z";

/**
 * Center label in Classtimer's style.
 * @returns whole minutes rounded up (`"5"` for 4:12), `"<1"` for 1..59 999 ms, `"0"` for none left.
 */
export function formatMinutes(remaining: Ms): string {
  if (remaining === 0) return "0";
  if (remaining < MINUTE) return "<1";
  return String(Math.ceil(remaining / MINUTE));
}

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Exact time for assistive technology, seconds rounded up so it never reads 0 while time remains.
 * @returns e.g. `"4 minutes 12 seconds remaining"`, `"1 minute remaining"`,
 * `"30 seconds remaining"`, or `"No time remaining"` for zero.
 */
export function describeRemaining(remaining: Ms): string {
  const totalSeconds = Math.ceil(remaining / 1000);
  if (totalSeconds === 0) return "No time remaining";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(plural(minutes, "minute"));
  if (seconds > 0) parts.push(plural(seconds, "second"));
  return `${parts.join(" ")} remaining`;
}

/**
 * Classtimer's ring rule: the ring shows what is *left*, so segments go dark as time elapses.
 * @returns the number of lit segments in 0..12; 0 without a baseline (idle has progress 0,
 * which would otherwise read as "everything left"); `ceil` keeps one lit until the very end.
 */
export function litSegments(snap: Snapshot): number {
  if (snap.baseline === 0) return 0;
  return Math.min(
    SEGMENT_COUNT,
    Math.max(0, Math.ceil((1 - snap.progress) * SEGMENT_COUNT)),
  );
}

function svgIcon(doc: Document, className: string, path: string): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className !== "") svg.setAttribute("class", className);
  const p = doc.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

function button(
  doc: Document,
  className: string,
  label: string,
  content: readonly (Node | string)[],
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(...content);
  return b;
}

/** Latest rendered values; `null` forces the first render to write everything. */
interface Rendered {
  lit: number | null;
  label: string | null;
  described: string | null;
  status: Snapshot["status"] | null;
}

/**
 * Builds the face inside `host` and keeps it in sync with `store`.
 * @returns a handle whose `dispose()` removes listeners, the store subscription and
 * the face DOM; calling it again does nothing.
 */
export function mountFace(
  host: HTMLElement,
  store: Store,
  beeper: Beeper,
): { dispose(): void } {
  const doc = host.ownerDocument;

  // Section: static structure (Classtimer markup, BEM-renamed).
  const root = doc.createElement("section");
  root.className = "timer";
  root.setAttribute("aria-label", "Timer");

  const visual = doc.createElement("div");
  visual.className = "timer__visual";

  const ring = doc.createElementNS(SVG_NS, "svg");
  ring.setAttribute("class", "timer__ring");
  ring.setAttribute("viewBox", "0 0 120 120");
  ring.setAttribute("aria-hidden", "true");
  const segments: SVGCircleElement[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const c = doc.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", "timer__segment");
    c.setAttribute("cx", "60");
    c.setAttribute("cy", "60");
    c.setAttribute("r", "50");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "8");
    // 23 of 314 (circumference) leaves a gap between the 30-degree segments.
    c.setAttribute("stroke-dasharray", "23 291");
    c.setAttribute("transform", `rotate(${String(-90 + i * 30)} 60 60)`);
    ring.append(c);
    segments.push(c);
  }

  const center = doc.createElement("div");
  center.className = "timer__center";

  const display = doc.createElement("div");
  display.className = "timer__display";
  // role=timer is implicitly non-live; the exact value is the accessible name, spoken on focus/read only.
  display.setAttribute("role", "timer");

  const cue = doc.createElement("div");
  cue.className = "timer__cue";
  cue.hidden = true;
  cue.textContent = TEXT.timesUp;

  const playIcon = svgIcon(doc, "timer__icon timer__icon--play", ICON_PLAY);
  const pauseIcon = svgIcon(doc, "timer__icon timer__icon--pause", ICON_PAUSE);
  const playPause = button(doc, "timer__btn", "Start", [playIcon, pauseIcon]);
  const resetBtn = button(doc, "timer__btn", "Reset", [
    svgIcon(doc, "timer__icon", ICON_RESET),
  ]);
  const mainControls = doc.createElement("div");
  mainControls.className = "timer__main-controls";
  mainControls.append(playPause, resetBtn);

  center.append(display, cue, mainControls);
  visual.append(ring, center);

  const quick = doc.createElement("div");
  quick.className = "timer__quick";
  const quickButtons = QUICK_ADD_MINUTES.map((minutes) => {
    const b = button(
      doc,
      "timer__btn timer__btn--text",
      `Add ${plural(minutes, "minute")}`,
      [`+${String(minutes)}m`],
    );
    return [b, minutes] as const;
  });
  quick.append(...quickButtons.map(([b]) => b));

  const muteIconOn = svgIcon(
    doc,
    "timer__icon timer__icon--sound-on",
    ICON_SOUND_ON,
  );
  const muteIconOff = svgIcon(
    doc,
    "timer__icon timer__icon--sound-off",
    ICON_SOUND_OFF,
  );
  const muteBtn = button(doc, "timer__btn timer__btn--mute", "Mute sound", [
    muteIconOn,
    muteIconOff,
  ]);
  muteBtn.setAttribute("aria-pressed", String(beeper.muted));
  quick.append(muteBtn);

  // Visually hidden so it is not shown twice; separate from the display so per-frame updates never re-announce.
  const live = doc.createElement("div");
  live.className = "visually-hidden";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("role", "status");

  root.append(visual, quick, live);
  host.append(root);

  // Section: rendering, writing only values that differ from the previous frame.
  const rendered: Rendered = {
    lit: null,
    label: null,
    described: null,
    status: null,
  };

  function render(snap: Snapshot): void {
    const lit = litSegments(snap);
    if (lit !== rendered.lit) {
      rendered.lit = lit;
      segments.forEach((seg, i) => {
        seg.classList.toggle("timer__segment--on", i < lit);
      });
    }

    const label = formatMinutes(snap.remaining);
    if (label !== rendered.label) {
      rendered.label = label;
      display.textContent = label;
    }

    const described = describeRemaining(snap.remaining);
    if (described !== rendered.described) {
      rendered.described = described;
      display.setAttribute("aria-label", described);
    }

    if (snap.status !== rendered.status) {
      const first = rendered.status === null;
      rendered.status = snap.status;
      const running = snap.status === "running";
      root.classList.toggle("timer--done", snap.status === "done");
      root.dataset["status"] = snap.status;
      cue.hidden = snap.status !== "done";
      playPause.setAttribute("aria-pressed", String(running));
      playPause.setAttribute("aria-label", running ? "Pause" : "Start");
      playPause.title = running ? "Pause" : "Start";
      playIcon.classList.toggle("timer__icon--hidden", running);
      pauseIcon.classList.toggle("timer__icon--hidden", !running);
      // The initial render is not a user-visible transition, so it stays silent.
      if (!first) live.textContent = announcementFor(snap.status);
    }
  }

  function renderMute(): void {
    const muted = beeper.muted;
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteIconOn.classList.toggle("timer__icon--hidden", muted);
    muteIconOff.classList.toggle("timer__icon--hidden", !muted);
  }

  // Section: input.
  const onPlayPause = (): void => {
    store.dispatch({ type: "toggle" });
  };
  const onReset = (): void => {
    store.dispatch({ type: "reset" });
  };
  const onMute = (): void => {
    beeper.setMuted(!beeper.muted);
    renderMute();
  };
  // Every button click is a user activation, so each handler unlocks audio first (before an
  // action could complete the timer and beep) via this single wrapper.
  const gesture = (handler: () => void) => (): void => {
    beeper.unlock();
    handler();
  };
  const bindings: readonly (readonly [HTMLElement, () => void])[] = [
    [playPause, onPlayPause],
    [resetBtn, onReset],
    [muteBtn, onMute],
    ...quickButtons.map(
      ([b, minutes]) =>
        [
          b,
          (): void => {
            store.dispatch({ type: "add", minutes });
          },
        ] as const,
    ),
  ];
  const listeners = bindings.map(
    ([target, handler]) => [target, gesture(handler)] as const,
  );
  for (const [target, handler] of listeners) {
    target.addEventListener("click", handler);
  }

  renderMute();
  render(store.getSnapshot());
  const unsubscribe = store.subscribe(render);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [target, handler] of listeners) {
        target.removeEventListener("click", handler);
      }
      root.remove();
    },
  };
}
