/**
 * Audio: completion beep through Web Audio, owned by a single `Beeper`.
 *
 * Responsibilities:
 * - Create/resume the `AudioContext` lazily from a user gesture, because
 *   browsers keep contexts created outside a gesture in the "suspended" state
 *   (autoplay policy:
 *   https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices#autoplay_policy).
 *   The completion itself usually fires from a timer callback, which is not a
 *   gesture, so the context must already be running by then.
 * - Own the mute preference and make `beep()` a silent no-op when muted or when
 *   audio is unavailable; completion stays visible either way (see `view.ts`).
 * - Release the context in an idempotent `dispose()`.
 */

// Webkit-prefixed constructor still exists on older Safari.
type AudioContextCtor = new () => AudioContext;
/** The only part of `Window` the Beeper needs; structural so tests and other windows (PiP) can supply it. */
export interface AudioHost {
  readonly AudioContext?: AudioContextCtor | undefined;
  readonly webkitAudioContext?: AudioContextCtor | undefined;
}

/** Classtimer's original completion tone: 800 Hz sine, gain 0.3. */
const FREQUENCY_HZ = 800;
const GAIN = 0.3;
const BEEP_SECONDS = 0.2;
const BEEP_GAP_SECONDS = 0.1;
const BEEP_COUNT = 3;
/** Short ramp at both ends prevents the audible click of an abruptly started/stopped oscillator. */
const RAMP_SECONDS = 0.01;

export class Beeper {
  private readonly win: AudioHost;
  private context: AudioContext | null = null;
  private isMuted = false;
  private disposed = false;

  constructor(win: AudioHost = window) {
    this.win = win;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
  }

  /**
   * Must be called from a user-gesture handler. Creates the context on first call
   * and resumes it on later calls (it may have been suspended by the browser).
   * Does nothing when `AudioContext` is unavailable or after `dispose()`.
   */
  unlock(): void {
    if (this.disposed) return;
    if (this.context === null) {
      const Ctor = this.win.AudioContext ?? this.win.webkitAudioContext;
      if (Ctor === undefined) return;
      try {
        this.context = new Ctor();
      } catch {
        // Construction can throw when the browser limits the number of contexts; sound is optional.
        return;
      }
    }
    if (this.context.state === "suspended") {
      // resume() rejects when not in a gesture; the next click retries, so the error is not actionable.
      this.context.resume().catch(() => undefined);
    }
  }

  /**
   * Plays the completion pattern (three short tones). No-op while muted, before
   * `unlock()`, or when audio is unavailable.
   */
  beep(): void {
    const ctx = this.context;
    if (this.isMuted || ctx === null || this.disposed) return;

    const start = ctx.currentTime;
    for (let i = 0; i < BEEP_COUNT; i++) {
      const t0 = start + i * (BEEP_SECONDS + BEEP_GAP_SECONDS);
      const t1 = t0 + BEEP_SECONDS;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = FREQUENCY_HZ;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(GAIN, t0 + RAMP_SECONDS);
      gain.gain.setValueAtTime(GAIN, t1 - RAMP_SECONDS);
      gain.gain.linearRampToValueAtTime(0, t1);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(t0);
      oscillator.stop(t1);
    }
  }

  /** Closes the context; safe to call repeatedly. Later `unlock()`/`beep()` calls are no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.context;
    this.context = null;
    // close() rejects if the context is already closed; teardown must not surface that.
    ctx?.close().catch(() => undefined);
  }
}
