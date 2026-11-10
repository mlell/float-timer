/**
 * Texts: shared user-facing strings and quick-add steps.
 *
 * Responsibilities:
 * - Single source for wording and quick-add minutes, so the page face, the
 *   Document PiP face and the canvas fallback cannot drift apart.
 * - Map status transitions to live-region announcements.
 */
import { assertNever, type Snapshot } from "./timer";

/** Minutes offered as quick-add buttons, in display order. */
export const QUICK_ADD_MINUTES = [1, 3, 5] as const;

export const TEXT = {
  timesUp: "Time's up",
  floatButton: "Float",
  floatPlaceholder: "Timer is floating",
  floatBringBack: "Bring back",
  floatVideoHint: "Timer is floating. Use the controls here to adjust it.",
  paused: "Paused",
} as const;

/**
 * Status-line explanation for a failed PiP request.
 * @returns one sentence telling the user why floating did not open and that the page timer still works.
 */
export function floatFailureText(
  reason: "unsupported" | "no-activation" | "error",
): string {
  switch (reason) {
    case "unsupported":
      return "Floating is not supported in this browser.";
    case "no-activation":
      return "The browser blocked the floating window. Click Float again.";
    case "error":
      return "The floating window could not be opened. The timer keeps running here.";
    default:
      return assertNever(reason);
  }
}

/**
 * Live-region text for a status the timer just transitioned into.
 * @returns a short phrase such as `"Timer started"` or `"Time's up"`.
 */
export function announcementFor(status: Snapshot["status"]): string {
  switch (status) {
    case "running":
      return "Timer started";
    case "paused":
      return "Timer paused";
    case "done":
      return TEXT.timesUp;
    case "idle":
      return "Timer reset";
    default:
      return assertNever(status);
  }
}
