// Verifies the Beeper's gesture-gated lifecycle against a stub AudioContext:
// mute/no-context no-ops, single lazy creation, resume on suspend, one-time close.
import { describe, expect, it, vi } from "vitest";
import { Beeper, type AudioHost } from "../src/audio";

class StubContext {
  static instances: StubContext[] = [];
  state: AudioContextState = "running";
  currentTime = 0;
  readonly destination = {};
  readonly oscillators: { start: number[]; stop: number[] }[] = [];
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());

  constructor() {
    StubContext.instances.push(this);
  }

  createOscillator() {
    const record: { start: number[]; stop: number[] } = { start: [], stop: [] };
    this.oscillators.push(record);
    return {
      type: "",
      frequency: { value: 0 },
      connect: vi.fn(),
      start: (t: number) => record.start.push(t),
      stop: (t: number) => record.stop.push(t),
    };
  }

  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
  }
}

/**
 * The stub implements only the AudioContext members the Beeper calls, so it is cast once
 * here, at the test boundary, rather than reproducing the full Web Audio interface.
 */
const StubCtor = StubContext as unknown as NonNullable<
  AudioHost["AudioContext"]
>;

function makeWin(host: AudioHost = { AudioContext: StubCtor }): AudioHost {
  StubContext.instances = [];
  return host;
}

describe("Beeper", () => {
  it("is a no-op before unlock", () => {
    const beeper = new Beeper(makeWin());
    beeper.beep();
    expect(StubContext.instances).toHaveLength(0);
  });

  it("creates the context once across repeated unlocks", () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    beeper.unlock();
    expect(StubContext.instances).toHaveLength(1);
  });

  it("resumes a suspended context on unlock", () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    const ctx = StubContext.instances[0];
    expect(ctx).toBeDefined();
    if (!ctx) return;
    ctx.state = "suspended";
    beeper.unlock();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("does not throw when resume rejects", async () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    const ctx = StubContext.instances[0];
    if (!ctx) throw new Error("no context");
    ctx.state = "suspended";
    ctx.resume.mockRejectedValueOnce(new Error("no gesture"));
    expect(() => {
      beeper.unlock();
    }).not.toThrow();
    await Promise.resolve();
  });

  it("plays three scheduled tones when unmuted", () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    beeper.beep();
    const ctx = StubContext.instances[0];
    expect(ctx?.oscillators).toHaveLength(3);
    expect(
      ctx?.oscillators.every(
        (o) => o.start.length === 1 && o.stop.length === 1,
      ),
    ).toBe(true);
  });

  it("stays silent while muted and sounds again after unmuting", () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    beeper.setMuted(true);
    expect(beeper.muted).toBe(true);
    beeper.beep();
    expect(StubContext.instances[0]?.oscillators).toHaveLength(0);
    beeper.setMuted(false);
    beeper.beep();
    expect(StubContext.instances[0]?.oscillators).toHaveLength(3);
  });

  it("uses the webkit-prefixed constructor when AudioContext is missing", () => {
    const beeper = new Beeper(makeWin({ webkitAudioContext: StubCtor }));
    beeper.unlock();
    expect(StubContext.instances).toHaveLength(1);
  });

  it("degrades gracefully without any AudioContext", () => {
    const win = makeWin({ AudioContext: undefined });
    const beeper = new Beeper(win);
    expect(() => {
      beeper.unlock();
      beeper.beep();
      beeper.dispose();
    }).not.toThrow();
  });

  it("survives a throwing constructor", () => {
    const Throwing = vi.fn(() => {
      throw new Error("too many contexts");
    });
    const beeper = new Beeper(makeWin({ AudioContext: Throwing }));
    expect(() => {
      beeper.unlock();
      beeper.beep();
    }).not.toThrow();
  });

  it("closes the context exactly once and ignores later use", () => {
    const beeper = new Beeper(makeWin());
    beeper.unlock();
    const ctx = StubContext.instances[0];
    beeper.dispose();
    beeper.dispose();
    expect(ctx?.close).toHaveBeenCalledTimes(1);
    beeper.unlock();
    beeper.beep();
    expect(StubContext.instances).toHaveLength(1);
    expect(ctx?.oscillators).toHaveLength(0);
  });
});
