/**
 * Entry point of the floating timer PWA: composes store, ticker, beeper and the
 * page face. Owns no logic of its own, only the wiring and the single time source.
 */
import { Beeper } from "./audio";
import { Ticker } from "./scheduler";
import { createStore } from "./store";
import { epoch } from "./timer";
import { mountFace } from "./view";

const host = document.getElementById("app");
if (host === null) {
  throw new Error("Missing #app mount point in index.html");
}

const store = createStore(() => epoch(Date.now()));
const beeper = new Beeper();

// Intentionally never disposed: these live exactly as long as the page, and the
// browser reclaims listeners, frames and the AudioContext on unload. Disposing on
// `pagehide` would also break back/forward-cache restores (`event.persisted`).
new Ticker(store);
mountFace(host, store, beeper);
store.onComplete(() => {
  beeper.beep();
});
