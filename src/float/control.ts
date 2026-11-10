/**
 * Float control: binds the header's Float button and status line to a `FloatManager`.
 *
 * Responsibilities:
 * - Hide the button where neither PiP mode is available, so no dead control is offered.
 * - Reflect manager state: `aria-pressed` while floating, disabled while a
 *   request is pending (double clicks), failure explanation in a status region.
 * - Release its listeners and subscription in `dispose()`.
 */
import { TEXT, floatFailureText } from "../texts";
import type { FloatManager, FloatState } from "./manager";

/**
 * @returns a handle whose idempotent `dispose()` removes the click listener and state subscription.
 */
export function bindFloatControl(
  button: HTMLButtonElement,
  status: HTMLElement,
  manager: FloatManager,
  supported: boolean,
): { dispose(): void } {
  button.textContent = TEXT.floatButton;
  button.hidden = !supported;

  const render = (s: FloatState): void => {
    button.setAttribute("aria-pressed", String(s.kind === "open"));
    button.disabled = s.kind === "opening";
    status.textContent =
      s.kind === "failed"
        ? floatFailureText(s.reason)
        : s.kind === "open" && s.mode === "video"
          ? TEXT.floatVideoHint
          : "";
  };
  const onClick = (): void => {
    void manager.toggle();
  };

  button.addEventListener("click", onClick);
  render(manager.getState());
  const unsubscribe = manager.onStateChange(render);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      button.removeEventListener("click", onClick);
      unsubscribe();
    },
  };
}
