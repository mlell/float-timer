# Floating Timer PWA – Implementation Plan

## Task

These are impelmentation steps of PLAN.md

You are the orchestrator and use sub-agents with cheap models to implement
step by step.

## Architecture

- **Deadline model**: running = `{deadline, baseline}`; paused = `{remaining, baseline}`. Callback timing affects smoothness only, never duration.
- **Single source of truth**: pure timer functions taking `now` as parameter; page and floating views only render its snapshot.
- **Completion once**: emitted by the state transition, not detected by renderers.
- **Flow**: actions → timer → snapshot → plain subscriber list.
- **Files**: `timer.ts` (pure core), `store.ts` (state owner, ticks before every action), `scheduler.ts` (`Ticker`: rAF visible / deadline timeout hidden), `view.ts` (face, mountable into any `Document`), `audio.ts` (`Beeper`), `main.ts` (wiring), `texts.ts` (shared user-facing texts/constants), `float/` (`manager.ts` owns face placement, `docpip.ts`, `control.ts` header button; canvas fallback later), `sw.ts`.
- **Build**: `build.mjs` inlines CSS/JS into `dist/timer.html` by matching the literal `<link>`/`<script>` tags in `index.html` (hence `index.html` is in `.prettierignore`).

## Coding Style

- TypeScript, `strict` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. esbuild strips types; `tsc --noEmit` checks in CI.
- Timer state as discriminated union (`idle | running | paused | done`); exhaustive `switch` with `never` check.
- Branded types `Ms` (duration) vs `Epoch` (timestamp); integer ms, formatting only at view edge.
- `Readonly` snapshots; views cannot mutate.
- Validate untrusted input (localStorage, messages) at the boundary into typed values; no `as` casts beyond that.
- ESLint `typescript-eslint` type-checked: no `any`, `no-floating-promises`, `switch-exhaustiveness-check`.
- Pure functions in `timer.ts`; classes only for resource owners needing `dispose()`.
- Every acquired resource (listener, stream, window) has a paired release; teardown idempotent.
- CSS: custom properties as design tokens, reused by canvas via `getComputedStyle`. BEM-lite class names.
- No runtime dependencies. Dev: TypeScript, esbuild, Vitest, Playwright, ESLint, Prettier.
- Comments explain *why* (browser quirks, spec constraints), link MDN/bug where relevant.
- No repetition of logic that is in the code already
- Small commits per concept; feature flags not needed—waves gate scope.

## Testing

- **Unit (Vitest, fake clock)**: reducer transitions table-driven; completion fires exactly once; add-while-running/paused; clamp; invalid restore rejection; clock-skew reconciliation.
- **Property tests** for reducer invariants: `0 ≤ remaining ≤ baseline`, monotonic progress while running.
- **Browser (Playwright, Chromium primary)**: controls, keyboard, reload restore, duplicate tabs, offline reload, update flow, Document PiP open/close/reopen via `documentPictureInPicture` (headed).
- **Visual regression**: screenshot of face at key states (0, running, <1 min, done) in page and canvas.
- **Manual matrix** per release: Chrome/Edge/Firefox/Safari desktop, Android Chrome, iOS Safari – floating, hidden-tab frames, sleep/wake, sound.
- **CI**: lint, typecheck, unit, Playwright; Lighthouse PWA/a11y budget.

## Wave 1 – MVP: Timer Page ✅ (2026-11-10)

Done: 125 unit tests (95 % lines), 3 Playwright smoke tests, `npm run bundle`. Hidden-tab accuracy verified only by simulated `visibilityState`; real background tab, sleep/wake and sound output are open items for the manual matrix.

- Timer core + store + Classtimer face (ring, start/pause, reset, +1/+3/+5).
- Deadline scheduling, visibility reconcile.
- Visible completion state + Web Audio beep (gesture-unlocked, mute toggle).
- Unit tests for core; one Playwright smoke test.
- **Exit**: accurate countdown in a hidden tab;
- npm run bundle generates a stand-alone HTML.

## Wave 2 – Document PiP (implemented 2026-11-10, exit pending headed check)

Done: `float/docpip.ts`, `float/manager.ts`, `float/control.ts` (header button), `texts.ts`, `TickerHost` + `Ticker.setFrameSource` (PiP window drives rAF while opener is hidden). 142 unit tests, Playwright headless green (PiP round-trip skipped headless). Not verified: real PiP window (headed), resize at ~240×300, focus restore.

- `float/manager` + `docpip`: move face into PiP, placeholder in main page, restore on `pagehide`.
- Style sharing via tokens; resize-tolerant layout.
- Guard re-entrancy (opening state), failure messaging.
- Prep: shared constants for quick-add steps `[1, 3, 5]` and user-facing texts ("Time's up", announcements), reused by PiP/canvas.
- Prep: `Ticker` takes a structural window slice (like `AudioHost`) instead of `Window & typeof globalThis`.
- **Exit**: Chromium desktop: interactive floating timer, repeated open/close without leaks or timer side effects.

## Wave 3 – Persistence & Instances

- Versioned localStorage record, validation, in-memory fallback + warning.
- Restore running/paused/expired (no stale alarm).
- `parseTimerState(unknown)` next to `ms()`/`epoch()` as the only cast boundary.
- Mute becomes persisted preference state instead of living only on `Beeper`.
- Single-owner via Web Locks; followers read-only, explicit takeover.
- **Exit**: reload/duplicate-tab matrix green.

## Wave 4 – Canvas/Video PiP Fallback

- Capability probes (capture, play, PiP) independent.
- Display-only canvas renderer, frame keep-alive while hidden, stream cleanup.
- Explicit second click when activation consumed.
- Store notifies on every `reconcile`; canvas renderer throttles redraws itself.
- **Exit**: documented support per browser from manual matrix; no claims without verification.

## Wave 5 – PWA

- Manifest (relative scope/start URL), PNG + maskable + Apple icons.
- SW: app-prefixed versioned cache, atomic precache, same-origin GET only, old-cache cleanup by prefix.
- Update notice; deferred activation while timer/PiP active.
- **Exit**: offline reload + installed launch; subdirectory deployment on HTTPS.

## Wave 6 – Polish & Release

- Play/pause: stable accessible name with `aria-pressed` only (currently name switches Start/Pause as well).
- Accessibility: names, pressed state, live-region announcements on transitions only (incl. float open/close, not only failures), focus restore after PiP.
- Responsive/safe-area, reduced motion, high contrast, non-color completion cue.
- Optional: seconds display, opt-in notifications.
- Attribution/licenses (Tomodoro MIT, Classtimer verified).
- **Exit**: acceptance table in `PLAN.md` §10 fully checked.

## Wave 7 – Clean-up (collected from Wave 1/2 reviews)

From Wave 2:

- `float/docpip.ts`: one feature-detect helper shared by `isDocPipSupported` and `openDocPip`; export `DocPipFailure` once and reuse it in `FloatState`.
- `FloatManager`: replace the narrowing-workaround getters (`isDisposed`, `cancelledWhileOpening`) with a generation counter or explicit `disposed` state.
- Remaining face labels (Start/Pause/Reset/Mute/Timer, `describeRemaining` wording) move to `texts.ts` for the canvas renderer.
- One `Listenable` type for scheduler's `VisibilityDocument` and listener slices.
- CSS: replace magic `96px` in `--ring-size` with tokens for header/quick-row height.
- Drop static `aria-pressed` on `#float-toggle` in `index.html` (set by `control.ts`).

From Wave 1:

- `Snapshot`: replace ambiguous `progress` (0 for idle) with `fractionLeft`; drop the idle workaround in `view.ts`.
- Expose next wake delay from store/timer; `getState()` is not re-ticked and can report `running` past the deadline.
- `timer.ts`: single `toDone(baseline)` helper.
- `store.ts`: one `Listeners<T>` helper for `subscribe`/`onComplete`.
- `view.ts`: split `mountFace` (~200 lines) into `buildFace` + `bindControls`.
- `build.mjs`: single build function with output mode; derive inlining from parsed `index.html` instead of exact tag strings (removes `.prettierignore` entry).
- Tests: shared `tests/helpers.ts` for fake clock/store setup; remove `as unknown as` AudioContext stub cast (typed fake instead).
- Shared dev-server port constant; `engines` field for Node version.
