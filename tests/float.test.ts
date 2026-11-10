// @vitest-environment jsdom
// Verifies Document PiP handling with a fake `documentPictureInPicture`: style copying and
// failure mapping in docpip, and the FloatManager's face placement, re-entrancy guard,
// browser-initiated close, repeated open/close without leaks, and idempotent dispose.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openDocPip,
  type DocPipHost,
  type PipWindow,
} from "../src/float/docpip";
import { FloatManager, type FloatState } from "../src/float/manager";
import type { FrameSource } from "../src/scheduler";
import type { VideoPipController, VideoPipResult } from "../src/float/videopip";

class FakePip extends EventTarget implements PipWindow {
  readonly document = document.implementation.createHTMLDocument("pip");
  closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("pagehide"));
  }
  requestAnimationFrame(): number {
    return 1;
  }
  cancelAnimationFrame(): void {
    /* no frames are ever pending in these tests */
  }
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeHost(requestWindow: () => Promise<PipWindow>): DocPipHost {
  return { document, documentPictureInPicture: { requestWindow } };
}

function setup(
  requestWindow = vi.fn(() => Promise.resolve<PipWindow>(new FakePip())),
  video: VideoPipController | null = null,
) {
  const pageHost = document.createElement("div");
  let mounts = 0;
  let disposes = 0;
  const mount = (host: HTMLElement) => {
    mounts++;
    const el = host.ownerDocument.createElement("div");
    el.className = "face";
    host.append(el);
    let done = false;
    return {
      dispose(): void {
        if (done) return;
        done = true;
        disposes++;
        el.remove();
      },
    };
  };
  const sources: (FrameSource | null)[] = [];
  const ticker = {
    setFrameSource: (s: FrameSource | null): void => {
      sources.push(s);
    },
  };
  const manager = new FloatManager(
    pageHost,
    mount,
    ticker,
    video === null ? fakeHost(requestWindow) : { document },
    video,
  );
  return {
    pageHost,
    manager,
    requestWindow,
    sources,
    counts: () => ({ mounts, disposes }),
  };
}

beforeEach(() => {
  document.head.innerHTML =
    '<style>.a{color:red}</style><link rel="stylesheet" href="/styles.css">';
  document.documentElement.className = "theme";
});

describe("openDocPip", () => {
  it("reports unsupported without the API", async () => {
    expect(await openDocPip({ width: 1, height: 1 }, { document })).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("maps NotAllowedError to no-activation and others to error", async () => {
    const denied = await openDocPip(
      { width: 1, height: 1 },
      fakeHost(() => Promise.reject(new DOMException("x", "NotAllowedError"))),
    );
    expect(denied).toMatchObject({ ok: false, reason: "no-activation" });
    const boom = new Error("boom");
    const failed = await openDocPip(
      { width: 1, height: 1 },
      fakeHost(() => Promise.reject(boom)),
    );
    expect(failed).toEqual({ ok: false, reason: "error", error: boom });
  });

  it("copies inline styles, stylesheet links and html class", async () => {
    const pip = new FakePip();
    const result = await openDocPip(
      { width: 1, height: 1 },
      fakeHost(() => Promise.resolve(pip)),
    );
    expect(result.ok).toBe(true);
    expect(pip.document.head.querySelector("style")?.textContent).toBe(
      ".a{color:red}",
    );
    expect(pip.document.head.querySelector("link")?.href).toMatch(
      /\/styles\.css$/,
    );
    expect(pip.document.documentElement.className).toBe("theme");
  });
});

describe("FloatManager", () => {
  it("keeps the page face and ticker intact while video PiP opens and closes", async () => {
    const video = {
      open: vi.fn(() => Promise.resolve<VideoPipResult>({ ok: true })),
      close: vi.fn(),
      dispose: vi.fn(),
    };
    const { manager, pageHost, sources, counts } = setup(undefined, video);
    await manager.open();
    expect(manager.getState()).toEqual({ kind: "open", mode: "video" });
    expect(pageHost.querySelector(".face")).not.toBeNull();
    expect(pageHost.querySelector(".float-placeholder")).toBeNull();
    manager.close();
    expect(manager.getState()).toEqual({ kind: "closed" });
    expect(video.close).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ mounts: 1, disposes: 0 });
    expect(sources).toEqual([]);
  });

  it("propagates video activation failure and permits retry", async () => {
    const video = {
      open: vi
        .fn<VideoPipController["open"]>()
        .mockResolvedValueOnce({ ok: false, reason: "no-activation" })
        .mockResolvedValueOnce({ ok: true }),
      close: vi.fn(),
      dispose: vi.fn(),
    };
    const { manager } = setup(undefined, video);
    await manager.open();
    expect(manager.getState()).toEqual({
      kind: "failed",
      reason: "no-activation",
    });
    await manager.open();
    expect(manager.getState()).toEqual({ kind: "open", mode: "video" });
    manager.dispose();
    expect(video.dispose).toHaveBeenCalledTimes(1);
  });

  it("discards video PiP that finishes after cancellation", async () => {
    const pending = deferred<VideoPipResult>();
    const video = {
      open: vi.fn(() => pending.promise),
      close: vi.fn(),
      dispose: vi.fn(),
    };
    const { manager, counts } = setup(undefined, video);
    const opening = manager.open();
    manager.close();
    pending.resolve({ ok: true });
    await opening;
    expect(manager.getState()).toEqual({ kind: "closed" });
    expect(video.close).toHaveBeenCalled();
    expect(counts()).toEqual({ mounts: 1, disposes: 0 });
  });

  it("mounts the page face initially", () => {
    const { pageHost, manager } = setup();
    expect(pageHost.querySelector(".face")).not.toBeNull();
    expect(manager.getState()).toEqual({ kind: "closed" });
  });

  it("moves the face into PiP, shows a placeholder and sets the frame source", async () => {
    const pip = new FakePip();
    const { pageHost, manager, sources } = setup(
      vi.fn(() => Promise.resolve<PipWindow>(pip)),
    );
    await manager.open();
    expect(manager.getState()).toEqual({ kind: "open", mode: "document" });
    expect(pageHost.querySelector(".face")).toBeNull();
    expect(pageHost.textContent).toContain("Timer is floating");
    expect(pip.document.querySelector(".float-host .face")).not.toBeNull();
    expect(sources).toEqual([pip]);
  });

  it("ignores open() while a request is pending", async () => {
    const d = deferred<PipWindow>();
    const { manager, requestWindow } = setup(vi.fn(() => d.promise));
    const first = manager.open();
    void manager.open();
    void manager.toggle();
    expect(manager.getState()).toEqual({ kind: "opening" });
    d.resolve(new FakePip());
    await first;
    expect(requestWindow).toHaveBeenCalledTimes(1);
  });

  it("restores the page face and clears the frame source on pagehide", async () => {
    const pip = new FakePip();
    const { pageHost, manager, sources } = setup(
      vi.fn(() => Promise.resolve<PipWindow>(pip)),
    );
    await manager.open();
    pip.close();
    expect(manager.getState()).toEqual({ kind: "closed" });
    expect(pageHost.querySelector(".face")).not.toBeNull();
    expect(pageHost.querySelector(".float-placeholder")).toBeNull();
    expect(pip.document.querySelector(".face")).toBeNull();
    expect(sources).toEqual([pip, null]);
  });

  it("Bring back closes the window", async () => {
    const pip = new FakePip();
    const { pageHost, manager } = setup(
      vi.fn(() => Promise.resolve<PipWindow>(pip)),
    );
    await manager.open();
    pageHost
      .querySelector<HTMLButtonElement>(".float-placeholder button")
      ?.click();
    expect(pip.closed).toBe(true);
    expect(manager.getState()).toEqual({ kind: "closed" });
  });

  it("open/close/reopen 3x leaves exactly one live face and no extra listeners", async () => {
    const { pageHost, manager, counts } = setup();
    const seen: FloatState["kind"][] = [];
    const unsubscribe = manager.onStateChange((s) => seen.push(s.kind));
    for (let i = 0; i < 3; i++) {
      await manager.toggle();
      await manager.toggle();
    }
    const { mounts, disposes } = counts();
    // 1 initial + 3x (pip face + page remount) mounts; every mount but the current page face disposed.
    expect(mounts).toBe(7);
    expect(mounts - disposes).toBe(1);
    expect(pageHost.querySelectorAll(".face")).toHaveLength(1);
    expect(seen).toEqual(Array(3).fill(["opening", "open", "closed"]).flat());
    unsubscribe();
    manager.close();
    expect(seen).toHaveLength(9);
  });

  it("reports failures and allows retry", async () => {
    const request = vi
      .fn<() => Promise<PipWindow>>()
      .mockRejectedValueOnce(new DOMException("x", "NotAllowedError"))
      .mockResolvedValueOnce(new FakePip());
    const { manager, pageHost } = setup(request);
    await manager.open();
    expect(manager.getState()).toEqual({
      kind: "failed",
      reason: "no-activation",
    });
    expect(pageHost.querySelector(".face")).not.toBeNull();
    await manager.open();
    expect(manager.getState()).toEqual({ kind: "open", mode: "document" });
  });

  it("closes a window that arrives after close() was requested", async () => {
    const d = deferred<PipWindow>();
    const pip = new FakePip();
    const { manager, pageHost, sources } = setup(vi.fn(() => d.promise));
    const opening = manager.open();
    manager.close();
    d.resolve(pip);
    await opening;
    expect(pip.closed).toBe(true);
    expect(manager.getState()).toEqual({ kind: "closed" });
    expect(pageHost.querySelector(".face")).not.toBeNull();
    expect(sources).toEqual([]);
  });

  it("dispose is idempotent and releases everything", async () => {
    const pip = new FakePip();
    const { manager, pageHost, counts, sources } = setup(
      vi.fn(() => Promise.resolve<PipWindow>(pip)),
    );
    await manager.open();
    manager.dispose();
    manager.dispose();
    expect(pip.closed).toBe(true);
    expect(sources).toEqual([pip, null]);
    expect(pageHost.childElementCount).toBe(0);
    expect(counts().mounts - counts().disposes).toBe(0);
    await manager.open();
    expect(manager.getState()).toEqual({ kind: "closed" });
  });
});
