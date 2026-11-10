# Floating Timer PWA – Implementation Plan

Derived from `PLAN.md`. Concepts only; standard practice assumed.

## Architecture

- **Deadline model**: running = `{deadline, baseline}`; paused = `{remaining, baseline}`. Callback timing affects smoothness only, never duration.
- **Single source of truth**: pure timer functions taking `now` as parameter; page and floating views only render its snapshot.
- **Completion once**: emitted by the state transition, not detected by renderers.
- **Flow**: actions → timer → snapshot → plain subscriber list.
- **Files**: `timer.ts`, `view.ts` (face, mountable into any `Document`), `float.ts` (Document PiP + canvas fallback), `sw.ts`.

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
