# Floating Timer PWA – Implementation Plan

Derived from `PLAN.md`. Concepts only; standard practice assumed.

## Architecture

- **Single source of truth**: pure timer core (`state + now → state`), no DOM, no clock access. Time injected.
- **Deadline model**: running = `{deadline, baseline}`; paused = `{remaining, baseline}`. Renderers derive everything from a snapshot.
- **Unidirectional flow**: intents (`start`, `pause`, `reset`, `add(n)`, `tick`, `reconcile`) → reducer → snapshot → subscribers (HTML view, canvas view, persistence, audio, sync).
- **Side effects at the edge**: completion emitted once as an event by the reducer transition, not detected by renderers.
- **Modules**:
  - `core/timer` – reducer, validation, limits.
  - `core/store` – subscription, scheduler (rAF visible / coarse interval hidden).
  - `ui/face` – SVG ring + controls; mountable into any `Document`.
  - `float/docpip`, `float/videopip`, `float/manager` – capability probing, mode selection, idempotent teardown.
  - `ui/canvas` – draws snapshot with shared design tokens.
  - `infra/persist`, `infra/instance` (Web Locks + BroadcastChannel), `infra/audio`, `infra/sw-client`.
  - `sw.js` – precache shell, versioned, scoped.
- **Ports over globals**: `clock`, `storage`, `lock`, `channel`, `audio` passed in → swappable in tests.
- **No framework, no state library**; module boundaries are the abstraction.

## Coding Style

- ES modules, plain JS + JSDoc types; `// @ts-check` with `tsc --noEmit` in CI.
- Pure functions in `core/`; classes only for resource owners needing `dispose()`.
- Every acquired resource (listener, stream, window, lock) has a paired release; teardown idempotent.
- Immutable snapshots; frozen in dev.
- Durations as integer milliseconds internally; formatting only at view edge.
- CSS: custom properties as design tokens, reused by canvas via `getComputedStyle`. BEM-lite class names.
- No runtime dependencies. Dev: esbuild, Jest, Playwright, ESLint, Prettier.
- Comments explain *why* (browser quirks, spec constraints), link MDN/bug where relevant.
- Small commits per concept; feature flags not needed—waves gate scope.

## Testing

- **Unit (Jest, fake clock)**: reducer transitions table-driven; completion fires exactly once; add-while-running/paused; clamp; invalid restore rejection; clock-skew reconciliation.
- **Property tests** for reducer invariants: `0 ≤ remaining ≤ baseline`, monotonic progress while running.
- **Contract tests** for ports with in-memory fakes (storage quota error, lock contention, channel messages).
- **Browser (Playwright, Chromium primary)**: controls, keyboard, reload restore, duplicate tabs, offline reload, update flow, Document PiP open/close/reopen via `documentPictureInPicture` (headed).
- **Visual regression**: screenshot of face at key states (0, running, <1 min, done) in page and canvas.
- **Manual matrix** per release: Chrome/Edge/Firefox/Safari desktop, Android Chrome, iOS Safari – floating, hidden-tab frames, sleep/wake, sound.
- **CI**: lint, typecheck, unit, Playwright; Lighthouse PWA/a11y budget.

## Wave 1 – MVP: Timer Page

- Timer core + store + Classtimer face (ring, start/pause, reset, +1/+3/+5).
- Deadline scheduling, visibility reconcile.
- Visible completion state + Web Audio beep (gesture-unlocked, mute toggle).
- Unit tests for core; one Playwright smoke test.
- **Exit**: accurate countdown in a hidden tab; served via localhost.

## Wave 2 – Document PiP

- `float/manager` + `docpip`: move face into PiP, placeholder in main page, restore on `pagehide`.
- Style sharing via tokens; resize-tolerant layout.
- Guard re-entrancy (opening state), failure messaging.
- **Exit**: Chromium desktop: interactive floating timer, repeated open/close without leaks or timer side effects.

## Wave 3 – Persistence & Instances

- Versioned localStorage record, validation, in-memory fallback + warning.
- Restore running/paused/expired (no stale alarm).
- Single-owner via Web Locks; followers read-only, explicit takeover.
- **Exit**: reload/duplicate-tab matrix green.

## Wave 4 – Canvas/Video PiP Fallback

- Capability probes (capture, play, PiP) independent.
- Display-only canvas renderer, frame keep-alive while hidden, stream cleanup.
- Explicit second click when activation consumed.
- **Exit**: documented support per browser from manual matrix; no claims without verification.

## Wave 5 – PWA

- Manifest (relative scope/start URL), PNG + maskable + Apple icons.
- SW: app-prefixed versioned cache, atomic precache, same-origin GET only, old-cache cleanup by prefix.
- Update notice; deferred activation while timer/PiP active.
- **Exit**: offline reload + installed launch; subdirectory deployment on HTTPS.

## Wave 6 – Polish & Release

- Accessibility: names, pressed state, live-region announcements on transitions only, focus restore after PiP.
- Responsive/safe-area, reduced motion, high contrast, non-color completion cue.
- Optional: seconds display, opt-in notifications.
- Attribution/licenses (Tomodoro MIT, Classtimer verified).
- **Exit**: acceptance table in `PLAN.md` §10 fully checked.
