// @vitest-environment jsdom
/** Exercises video PiP capability selection, gesture retry, rendering and resource ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVideoPipSupported, VideoPip } from "../src/float/videopip";
import { createStore } from "../src/store";
import { epoch } from "../src/timer";

const context = {
  fillRect: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
};
const stop = vi.fn();
const stream = { getTracks: () => [{ stop }] };
const request = vi.fn(() => Promise.resolve({ width: 320, height: 320 }));
const exit = vi.fn(() => Promise.resolve());
const capture = vi.fn(() => stream);
const play = vi.fn(() => Promise.resolve());
const restores: (() => void)[] = [];
const instances: VideoPip[] = [];

function property(target: object, name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, value });
  restores.push(() => {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  });
}

function setup() {
  const store = createStore(() => epoch(Date.now()));
  const pip = new VideoPip(store);
  instances.push(pip);
  return { store, pip };
}

function enterSafari(this: HTMLVideoElement, mode: string): void {
  property(this, "webkitPresentationMode", mode);
  this.dispatchEvent(new Event("webkitpresentationmodechanged"));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
  vi.clearAllMocks();
  request.mockReset().mockResolvedValue({ width: 320, height: 320 });
  play.mockReset().mockResolvedValue();
  property(HTMLCanvasElement.prototype, "captureStream", capture);
  property(HTMLCanvasElement.prototype, "getContext", () => context);
  property(HTMLMediaElement.prototype, "play", play);
  property(HTMLMediaElement.prototype, "pause", vi.fn());
  property(HTMLVideoElement.prototype, "requestPictureInPicture", request);
  property(document, "pictureInPictureEnabled", true);
  property(document, "exitPictureInPicture", exit);
});

afterEach(() => {
  for (const pip of instances.splice(0)) pip.dispose();
  for (const restore of restores.splice(0).reverse()) restore();
  vi.useRealTimers();
});

describe("video PiP", () => {
  it("requires capture plus a working PiP capability", () => {
    expect(isVideoPipSupported()).toBe(true);
    property(HTMLCanvasElement.prototype, "captureStream", undefined);
    expect(isVideoPipSupported()).toBe(false);
  });

  it("does not offer PiP when disabled by the browser", async () => {
    property(document, "pictureInPictureEnabled", false);
    const { pip } = setup();
    expect(isVideoPipSupported()).toBe(false);
    expect(await pip.open(vi.fn())).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures a painted timer and reflects page actions without starting it", async () => {
    const { pip, store } = setup();
    store.dispatch({ type: "add", minutes: 3 });
    expect(await pip.open(vi.fn())).toEqual({ ok: true });
    expect(capture).toHaveBeenCalledWith(4);
    expect(context.fillText).toHaveBeenCalledWith("3", 160, 148);
    expect(context.fillText).toHaveBeenCalledWith("Paused", 160, 198);
    expect(store.getState().status).toBe("paused");
    store.dispatch({ type: "add", minutes: 1 });
    expect(context.fillText).toHaveBeenCalledWith("4", 160, 148);
    expect(document.querySelector("video")?.srcObject).toBe(stream);
  });

  it("refreshes while hidden and reports completion once", async () => {
    const { pip, store } = setup();
    store.dispatch({ type: "add", minutes: 1 });
    store.dispatch({ type: "toggle" });
    const complete = vi.fn();
    store.onComplete(complete);
    property(document, "visibilityState", "hidden");
    await pip.open(vi.fn());
    vi.advanceTimersByTime(61_000);
    expect(store.getState().status).toBe("done");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(context.fillText).toHaveBeenCalledWith("Time's up", 160, 198);
  });

  it("avoids redraws for unchanged snapshots but keeps periodic video frames", async () => {
    const { pip, store } = setup();
    await pip.open(vi.fn());
    context.fillRect.mockClear();
    store.dispatch({ type: "reconcile" });
    expect(context.fillRect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(context.fillRect).toHaveBeenCalledTimes(1);
  });

  it("retains prepared playback for a synchronous second-click PiP request", async () => {
    request.mockRejectedValueOnce(
      new DOMException("Gesture", "NotAllowedError"),
    );
    const { pip } = setup();
    expect(await pip.open(vi.fn())).toEqual({
      ok: false,
      reason: "no-activation",
    });
    const retry = pip.open(vi.fn());
    expect(request).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await retry).toEqual({ ok: true });
  });

  it("retries playback when autoplay itself was blocked", async () => {
    play.mockRejectedValueOnce(new DOMException("Gesture", "NotAllowedError"));
    const { pip } = setup();
    expect(await pip.open(vi.fn())).toEqual({
      ok: false,
      reason: "no-activation",
    });
    expect(request).not.toHaveBeenCalled();
    expect(await pip.open(vi.fn())).toEqual({ ok: true });
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("releases resources after a failed PiP request", async () => {
    request.mockRejectedValueOnce(new Error("Capture failed"));
    const { pip } = setup();
    expect(await pip.open(vi.fn())).toEqual({ ok: false, reason: "error" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles an unavailable canvas context without acquiring capture", async () => {
    property(HTMLCanvasElement.prototype, "getContext", () => null);
    const { pip } = setup();
    expect(await pip.open(vi.fn())).toEqual({ ok: false, reason: "error" });
    expect(capture).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
  });

  it("cleans up on browser close and allows reopening", async () => {
    const { pip } = setup();
    const onClose = vi.fn();
    await pip.open(onClose);
    const video = document.querySelector("video");
    video?.dispatchEvent(new Event("leavepictureinpicture"));
    video?.dispatchEvent(new Event("leavepictureinpicture"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await pip.open(onClose)).toEqual({ ok: true });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("exits its own video PiP and disposes subscriptions idempotently", async () => {
    const { pip, store } = setup();
    await pip.open(vi.fn());
    property(
      document,
      "pictureInPictureElement",
      document.querySelector("video"),
    );
    pip.dispose();
    pip.dispose();
    context.fillText.mockClear();
    store.dispatch({ type: "add", minutes: 1 });
    expect(context.fillText).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not exit an unrelated video's PiP", async () => {
    const { pip } = setup();
    await pip.open(vi.fn());
    property(
      document,
      "pictureInPictureElement",
      document.createElement("video"),
    );
    pip.close();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not request PiP if closed while playback is pending", async () => {
    let resolve = (): void => undefined;
    play.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const { pip } = setup();
    const opening = pip.open(vi.fn());
    pip.close();
    resolve();
    expect(await opening).toEqual({ ok: false, reason: "error" });
    expect(request).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("supports Safari's prefixed PiP entry and close notification", async () => {
    property(document, "pictureInPictureEnabled", false);
    property(
      HTMLVideoElement.prototype,
      "webkitSupportsPresentationMode",
      () => true,
    );
    const setMode = vi.fn(enterSafari);
    property(HTMLVideoElement.prototype, "webkitSetPresentationMode", setMode);
    const { pip } = setup();
    const onClose = vi.fn();
    expect(isVideoPipSupported()).toBe(true);
    expect(await pip.open(onClose)).toEqual({ ok: true });
    expect(setMode).toHaveBeenCalledWith("picture-in-picture");
    expect(request).not.toHaveBeenCalled();
    const video = document.querySelector("video");
    if (video === null) throw new Error("Missing video");
    property(video, "webkitPresentationMode", "inline");
    video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("detects prefixed Safari before an unloaded video becomes eligible", async () => {
    property(document, "pictureInPictureEnabled", false);
    property(
      HTMLVideoElement.prototype,
      "webkitSupportsPresentationMode",
      function (this: HTMLVideoElement) {
        return Boolean(this.srcObject);
      },
    );
    property(
      HTMLVideoElement.prototype,
      "webkitSetPresentationMode",
      enterSafari,
    );
    expect(isVideoPipSupported()).toBe(true);
    const { pip } = setup();
    expect(await pip.open(vi.fn())).toEqual({ ok: true });
  });

  it("treats silently declined Safari entry as a fresh-gesture retry", async () => {
    property(document, "pictureInPictureEnabled", false);
    const setMode = vi.fn(enterSafari).mockImplementationOnce(() => undefined);
    property(HTMLVideoElement.prototype, "webkitSetPresentationMode", setMode);
    const { pip } = setup();
    const opening = pip.open(vi.fn());
    await vi.advanceTimersByTimeAsync(1500);
    expect(await opening).toEqual({ ok: false, reason: "no-activation" });
    const retry = pip.open(vi.fn());
    expect(setMode).toHaveBeenCalledTimes(2);
    expect(await retry).toEqual({ ok: true });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("closes Safari entry queued before cancellation without leaking its observer", async () => {
    property(document, "pictureInPictureEnabled", false);
    const setMode = vi.fn(function (this: HTMLVideoElement, mode: string) {
      if (mode === "inline") enterSafari.call(this, mode);
      else
        window.setTimeout(() => {
          enterSafari.call(this, mode);
        }, 10);
    });
    property(HTMLVideoElement.prototype, "webkitSetPresentationMode", setMode);
    const { pip } = setup();
    const opening = pip.open(vi.fn());
    await Promise.resolve();
    expect(setMode).toHaveBeenCalledWith("picture-in-picture");
    pip.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(await opening).toEqual({ ok: false, reason: "error" });
    expect(setMode).toHaveBeenCalledWith("inline");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries cancelled Safari exit until the native entry transition finishes", async () => {
    property(document, "pictureInPictureEnabled", false);
    let transitioning = false;
    const setMode = vi.fn(function (this: HTMLVideoElement, mode: string) {
      if (mode === "inline") {
        if (!transitioning) enterSafari.call(this, mode);
      } else {
        window.setTimeout(() => {
          transitioning = true;
          enterSafari.call(this, mode);
          window.setTimeout(() => {
            transitioning = false;
          }, 200);
        }, 10);
      }
    });
    property(HTMLVideoElement.prototype, "webkitSetPresentationMode", setMode);
    const { pip } = setup();
    const opening = pip.open(vi.fn());
    await Promise.resolve();
    const video = document.querySelector("video");
    pip.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(await opening).toEqual({ ok: false, reason: "error" });
    expect(video).toHaveProperty(
      "webkitPresentationMode",
      "picture-in-picture",
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(video).toHaveProperty("webkitPresentationMode", "inline");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits a PiP request that resolves after cancellation", async () => {
    let resolve: (size: { width: number; height: number }) => void = () =>
      undefined;
    request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { pip } = setup();
    const opening = pip.open(vi.fn());
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    const video = document.querySelector("video");
    pip.close();
    property(document, "pictureInPictureElement", video);
    resolve({ width: 320, height: 320 });
    expect(await opening).toEqual({ ok: false, reason: "error" });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
