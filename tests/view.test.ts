// @vitest-environment jsdom
// Verifies the face: label/ring/aria states across the timer lifecycle with a
// fake-clock store, button wiring and gesture unlock, transition-only live
// announcements, and idempotent teardown. Formatting helpers are tested as pure functions.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Beeper } from "../src/audio";
import { createStore, type Store } from "../src/store";
import { MINUTE, epoch, ms, type Epoch } from "../src/timer";
import { describeRemaining, formatMinutes, mountFace } from "../src/view";

describe("formatMinutes", () => {
  it.each([
    [0, "0"],
    [1, "<1"],
    [59_999, "<1"],
    [60_000, "1"],
    [60_001, "2"],
    [4 * 60_000 + 12_000, "5"],
    [5 * 60_000, "5"],
  ])("%i ms -> %s", (value, expected) => {
    expect(formatMinutes(ms(value))).toBe(expected);
  });
});

describe("describeRemaining", () => {
  it.each([
    [0, "No time remaining"],
    [1, "1 second remaining"],
    [30_000, "30 seconds remaining"],
    [60_000, "1 minute remaining"],
    [4 * 60_000 + 12_000, "4 minutes 12 seconds remaining"],
    [61_000, "1 minute 1 second remaining"],
    [4 * 60_000 + 11_001, "4 minutes 12 seconds remaining"],
  ])("%i ms -> %s", (value, expected) => {
    expect(describeRemaining(ms(value))).toBe(expected);
  });
});

let now: number;
let store: Store;
let beeper: Beeper;
let unlock: MockInstance<() => void>;
let setMuted: MockInstance<(m: boolean) => void>;
let host: HTMLElement;

function mount() {
  return mountFace(host, store, beeper);
}

function q(selector: string): Element {
  const found = host.querySelector(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

function qButton(selector: string): HTMLButtonElement {
  const found = q(selector);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`${selector} is not a button`);
  }
  return found;
}

const label = (): string | null => q(".timer__display").textContent;
const live = (): string | null => q("[aria-live]").textContent;
const playPause = (): HTMLButtonElement =>
  qButton(".timer__main-controls .timer__btn");
const litCount = (): number =>
  host.querySelectorAll(".timer__segment--on").length;

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function clickByLabel(text: string): void {
  const b = [...host.querySelectorAll("button")].find(
    (x) => x.getAttribute("aria-label") === text,
  );
  if (!b) throw new Error(`no button ${text}`);
  click(b);
}

beforeEach(() => {
  now = 1_000_000;
  store = createStore((): Epoch => epoch(now));
  // jsdom has no AudioContext, so a real Beeper's unlock/beep are inert and only calls are observed.
  beeper = new Beeper(window);
  unlock = vi.spyOn(beeper, "unlock");
  setMuted = vi.spyOn(beeper, "setMuted");
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

describe("mountFace rendering", () => {
  it("renders idle: 12 dark segments, label 0, silent live region", () => {
    mount();
    expect(host.querySelectorAll(".timer__segment")).toHaveLength(12);
    expect(litCount()).toBe(0);
    expect(label()).toBe("0");
    expect(live()).toBe("");
    expect(q(".timer__cue").hasAttribute("hidden")).toBe(true);
  });

  it("shows full ring and rounded-up minutes when paused with time", () => {
    mount();
    clickByLabel("Add 5 minutes");
    expect(label()).toBe("5");
    expect(litCount()).toBe(12);
    expect(playPause().getAttribute("aria-pressed")).toBe("false");
  });

  it("lights segments by remaining fraction while running", () => {
    mount();
    clickByLabel("Add 3 minutes");
    click(playPause());
    now += 90_000; // half elapsed
    store.dispatch({ type: "reconcile" });
    expect(litCount()).toBe(6);
    expect(label()).toBe("2");
    expect(q(".timer__display").getAttribute("aria-label")).toBe(
      "1 minute 30 seconds remaining",
    );
  });

  it("shows <1 under one minute and keeps one segment lit until the end", () => {
    mount();
    clickByLabel("Add 1 minute");
    click(playPause());
    now += MINUTE - 1_000;
    store.dispatch({ type: "reconcile" });
    expect(label()).toBe("<1");
    expect(litCount()).toBeGreaterThanOrEqual(1);
  });

  it("shows the done state with class and visible text cue", () => {
    mount();
    clickByLabel("Add 1 minute");
    click(playPause());
    now += MINUTE;
    store.dispatch({ type: "reconcile" });
    expect(q(".timer").classList.contains("timer--done")).toBe(true);
    expect(q(".timer__cue").hasAttribute("hidden")).toBe(false);
    expect(q(".timer__cue").textContent).toBe("Time's up");
    expect(label()).toBe("0");
    expect(litCount()).toBe(0);
  });

  it("builds DOM in the host's own document", () => {
    const other = document.implementation.createHTMLDocument("pip");
    const otherHost = other.createElement("div");
    other.body.append(otherHost);
    mountFace(otherHost, store, beeper);
    expect(otherHost.querySelector(".timer")?.ownerDocument).toBe(other);
    expect(host.querySelector(".timer")).toBeNull();
  });
});

describe("mountFace controls", () => {
  it("toggles aria-pressed and label between Start and Pause", () => {
    mount();
    clickByLabel("Add 1 minute");
    click(playPause());
    expect(playPause().getAttribute("aria-pressed")).toBe("true");
    expect(playPause().getAttribute("aria-label")).toBe("Pause");
    click(playPause());
    expect(playPause().getAttribute("aria-pressed")).toBe("false");
    expect(playPause().getAttribute("aria-label")).toBe("Start");
  });

  it("reset returns to idle", () => {
    mount();
    clickByLabel("Add 3 minutes");
    clickByLabel("Reset");
    expect(label()).toBe("0");
    expect(store.getState().status).toBe("idle");
  });

  it("every button click unlocks audio", () => {
    mount();
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons).toHaveLength(6);
    for (const b of buttons) click(b);
    expect(unlock).toHaveBeenCalledTimes(6);
  });

  it("keeps the shared float button beside mute across document remounts", () => {
    const floatButton = document.createElement("button");
    const onFloat = vi.fn();
    floatButton.addEventListener("click", onFloat);
    floatButton.setAttribute("aria-pressed", "true");
    const face = mountFace(host, store, beeper, floatButton);
    expect(q(".timer__btn--mute").nextElementSibling).toBe(floatButton);
    expect(floatButton.querySelector("svg")).not.toBeNull();
    face.dispose();

    const other = document.implementation.createHTMLDocument("pip");
    const pipFace = mountFace(other.body, store, beeper, floatButton);
    expect(other.querySelector(".timer__btn--mute")?.nextElementSibling).toBe(
      floatButton,
    );
    expect(floatButton.ownerDocument).toBe(other);
    expect(floatButton.getAttribute("aria-pressed")).toBe("true");
    floatButton.click();
    expect(onFloat).toHaveBeenCalledTimes(1);
    pipFace.dispose();

    const restored = mountFace(host, store, beeper, floatButton);
    expect(q(".timer__btn--mute").nextElementSibling).toBe(floatButton);
    expect(host.querySelectorAll(".timer")).toHaveLength(1);
    expect(other.querySelector(".timer")).toBeNull();
    floatButton.click();
    expect(onFloat).toHaveBeenCalledTimes(2);
    restored.dispose();
  });

  it("mute button flips beeper state and aria-pressed", () => {
    mount();
    const mute = qButton(".timer__btn--mute");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    click(mute);
    expect(setMuted).toHaveBeenLastCalledWith(true);
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    click(mute);
    expect(setMuted).toHaveBeenLastCalledWith(false);
    expect(mute.getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects an already muted beeper on mount", () => {
    beeper.setMuted(true);
    mount();
    expect(q(".timer__btn--mute").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("live region", () => {
  it("changes only on status transitions, not on frames", () => {
    mount();
    clickByLabel("Add 3 minutes");
    expect(live()).toBe("Timer paused");
    click(playPause());
    expect(live()).toBe("Timer started");

    const region = q("[aria-live]");
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) writes.push(r.type);
    });
    observer.observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    for (let i = 0; i < 20; i++) {
      now += 1_000;
      store.dispatch({ type: "reconcile" });
    }
    expect(observer.takeRecords()).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(live()).toBe("Timer started");

    now += MINUTE * 3;
    store.dispatch({ type: "reconcile" });
    expect(live()).toBe("Time's up");
    clickByLabel("Reset");
    expect(live()).toBe("Timer reset");
    observer.disconnect();
  });
});

describe("DOM minimality", () => {
  it("does not rewrite unchanged label or segments between frames", () => {
    mount();
    clickByLabel("Add 5 minutes");
    click(playPause());
    const observer = new MutationObserver(() => undefined);
    observer.observe(host, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    now += 100;
    store.dispatch({ type: "reconcile" });
    now += 100;
    store.dispatch({ type: "reconcile" });
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });
});

describe("dispose", () => {
  it("removes DOM and stops reacting; second call is a no-op", () => {
    const face = mount();
    const unlockBefore = unlock.mock.calls.length;
    face.dispose();
    face.dispose();
    expect(host.querySelector(".timer")).toBeNull();
    store.dispatch({ type: "add", minutes: 1 });
    expect(unlock.mock.calls.length).toBe(unlockBefore);
  });

  it("removes the store subscription", () => {
    const subscribe = vi.spyOn(store, "subscribe");
    const unsubscribe = vi.fn();
    subscribe.mockReturnValue(unsubscribe);
    const face = mount();
    face.dispose();
    face.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
