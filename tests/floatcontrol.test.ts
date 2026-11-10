// @vitest-environment jsdom
/** Verifies the shared header control exposes capabilities, pending requests and video-mode guidance. */
import { afterEach, expect, it, vi } from "vitest";
import { bindFloatControl } from "../src/float/control";
import { FloatManager } from "../src/float/manager";
import type { VideoPipController } from "../src/float/videopip";
import { TEXT } from "../src/texts";

const cleanups: (() => void)[] = [];

function setup(supported = true) {
  const button = document.createElement("button");
  const status = document.createElement("p");
  const video = {
    open: vi.fn<VideoPipController["open"]>().mockResolvedValue({ ok: true }),
    close: vi.fn(),
    dispose: vi.fn(),
  };
  const manager = new FloatManager(
    document.createElement("div"),
    () => ({ dispose: vi.fn() }),
    { setFrameSource: vi.fn() },
    { document },
    video,
  );
  const control = bindFloatControl(button, status, manager, supported);
  cleanups.push(() => {
    control.dispose();
    manager.dispose();
  });
  return { button, status, video, manager, control };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("hides Float only when no floating capability is available", () => {
  const { button } = setup(false);
  expect(button.hidden).toBe(true);
  expect(button.textContent).toBe("Float");
  expect(button.getAttribute("aria-pressed")).toBe("false");
});

it("explains video-mode controls and toggles the fallback closed", async () => {
  const { button, status, video } = setup();
  expect(button.hidden).toBe(false);
  button.click();
  expect(button.disabled).toBe(true);
  await vi.waitFor(() => {
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
  expect(button.disabled).toBe(false);
  expect(status.textContent).toBe(TEXT.floatVideoHint);
  button.click();
  expect(video.close).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(status.textContent).toBe("");
});

it("shows an actionable second-click message after activation is rejected", async () => {
  const { button, status, video } = setup();
  video.open.mockResolvedValueOnce({ ok: false, reason: "no-activation" });
  button.click();
  await vi.waitFor(() => {
    expect(status.textContent).toContain("Click Float again");
  });
  expect(button.disabled).toBe(false);
  button.click();
  await vi.waitFor(() => {
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

it("removes click and state listeners when disposed", async () => {
  const { button, status, video, manager, control } = setup();
  control.dispose();
  control.dispose();
  button.click();
  expect(video.open).not.toHaveBeenCalled();
  await manager.open();
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(status.textContent).toBe("");
});
