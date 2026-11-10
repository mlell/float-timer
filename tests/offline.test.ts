// Verify that offline registration and update failures never interrupt timer use.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerOffline } from "../src/offline";

const update = vi.fn(() => Promise.resolve());
const register = vi.fn(() => Promise.resolve({ update }));
let events: EventTarget;

beforeEach(() => {
  events = new EventTarget();
  vi.stubGlobal("window", events);
  vi.stubGlobal("location", new URL("https://example.com/timer/"));
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("registers beside the bundle without HTTP caching and checks on reconnection", async () => {
  await registerOffline();
  expect(register).toHaveBeenCalledWith(
    new URL("../src/service-worker.js", import.meta.url),
    { updateViaCache: "none" },
  );
  events.dispatchEvent(new Event("online"));
  expect(update).toHaveBeenCalledOnce();
});

it("skips unsupported browsers", async () => {
  vi.stubGlobal("navigator", {});
  await registerOffline();
  expect(register).not.toHaveBeenCalled();
});

it("leaves downloaded standalone files usable without a service worker", async () => {
  vi.stubGlobal("location", new URL("file:///timer.html"));
  await registerOffline();
  expect(register).not.toHaveBeenCalled();
});

it("handles registration failures without rejecting", async () => {
  const error = new Error("Storage denied");
  register.mockRejectedValueOnce(error);
  await expect(registerOffline()).resolves.toBeUndefined();
  expect(console.warn).toHaveBeenCalledWith(
    "Offline caching is unavailable",
    error,
  );
  events.dispatchEvent(new Event("online"));
  expect(update).not.toHaveBeenCalled();
});

it("handles failed update checks without an unhandled rejection", async () => {
  const error = new Error("Network unavailable");
  update.mockRejectedValueOnce(error);
  await registerOffline();
  events.dispatchEvent(new Event("online"));
  await Promise.resolve();
  expect(console.warn).toHaveBeenCalledWith(
    "Could not check for an offline app update",
    error,
  );
});
