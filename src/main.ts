/**
 * Entry point of the floating timer PWA: composes store, ticker, beeper, the
 * float manager (owner of the face's placement) and the float control. Owns no
 * logic of its own, only the wiring and the single time source.
 */
import { Beeper } from "./audio";
import { bindFloatControl } from "./float/control";
import { isDocPipSupported } from "./float/docpip";
import { FloatManager } from "./float/manager";
import { isVideoPipSupported, VideoPip } from "./float/videopip";
import { Ticker } from "./scheduler";
import { createStore } from "./store";
import { epoch } from "./timer";
import { mountFace } from "./view";

function required<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`Missing #${id} in index.html`);
  }
  return el;
}

const host = required("app", HTMLElement);
const floatButton = required("float-toggle", HTMLButtonElement);
const floatStatus = required("float-status", HTMLElement);

const store = createStore(() => epoch(Date.now()));
const beeper = new Beeper();

// Intentionally never disposed: these live exactly as long as the page, and the
// browser reclaims listeners, frames and the AudioContext on unload. Disposing on
// `pagehide` would also break back/forward-cache restores (`event.persisted`).
const ticker = new Ticker(store);
const floating = new FloatManager(
  host,
  (h) => mountFace(h, store, beeper, floatButton),
  ticker,
  window,
  new VideoPip(store),
);
bindFloatControl(
  floatButton,
  floatStatus,
  floating,
  isDocPipSupported() || isVideoPipSupported(),
);
store.onComplete(() => {
  beeper.beep();
});
