/**
 * Document PiP request: opens an always-on-top browser window that can host real DOM.
 *
 * Responsibilities:
 * - Feature-detect `documentPictureInPicture` (not yet in lib.dom, so a minimal
 *   structural type is declared here instead of casting).
 * - Make the PiP document look like the page: the new window starts with an
 *   empty document, so stylesheets and `<html>` attributes must be copied.
 *   Both inline `<style>` (standalone bundle) and `<link rel=stylesheet>`
 *   (served build) are handled.
 * - Translate request failures into a closed set of reasons the UI can explain.
 */
import type { FrameSource } from "../scheduler";

/** The parts of a PiP window the app uses; a real `Window` fits, so do test fakes. */
export interface PipWindow extends FrameSource {
  readonly document: Document;
  readonly closed: boolean;
  close(): void;
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<PipWindow>;
}

/** Opener slice needed to request PiP; optional because most browsers lack the API. */
export interface DocPipHost {
  readonly document: Document;
  readonly documentPictureInPicture?: DocumentPictureInPicture;
}

export type DocPipFailure = "unsupported" | "no-activation" | "error";

export type DocPipResult =
  | { readonly ok: true; readonly pip: PipWindow }
  | {
      readonly ok: false;
      readonly reason: DocPipFailure;
      readonly error?: unknown;
    };

/** @returns the PiP API object, or `undefined` when the browser does not offer it. */
function pipApi(win: DocPipHost): DocumentPictureInPicture | undefined {
  return "documentPictureInPicture" in win
    ? win.documentPictureInPicture
    : undefined;
}

/** @returns `true` when Document PiP can be requested from `win` at all. */
export function isDocPipSupported(win: DocPipHost = window): boolean {
  return pipApi(win) !== undefined;
}

function copyDocumentLook(from: Document, to: Document): void {
  for (const attr of Array.from(from.documentElement.attributes)) {
    if (attr.name === "class" || attr.name.startsWith("data-")) {
      to.documentElement.setAttribute(attr.name, attr.value);
    }
  }
  for (const node of Array.from(
    from.querySelectorAll('style, link[rel="stylesheet"]'),
  )) {
    if (node instanceof HTMLLinkElement) {
      // `.href` is already absolute, so the link resolves even though the PiP document's URL is about:blank.
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = node.href;
      to.head.append(link);
    } else {
      const style = to.createElement("style");
      style.textContent = node.textContent;
      to.head.append(style);
    }
  }
}

/**
 * Requests a Document PiP window and prepares its document with the page's styles.
 * Must run inside a user activation (click), otherwise the browser rejects it.
 * @returns `{ok:true, pip}` with a styled, empty window; otherwise `{ok:false, reason}` where
 * `reason` is `"unsupported"` (no API), `"no-activation"` (`NotAllowedError`, i.e. missing
 * gesture or blocked by policy) or `"error"` (anything else, with the original `error`).
 */
export async function openDocPip(
  opts: { width: number; height: number },
  win: DocPipHost = window,
): Promise<DocPipResult> {
  const api = pipApi(win);
  if (api === undefined) return { ok: false, reason: "unsupported" };
  try {
    const pip = await api.requestWindow({
      width: opts.width,
      height: opts.height,
    });
    copyDocumentLook(win.document, pip.document);
    return { ok: true, pip };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "no-activation"
        : "error";
    return { ok: false, reason, error };
  }
}
