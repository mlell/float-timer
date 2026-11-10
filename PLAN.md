# Floating Timer PWA Plan

Reviewed: 2026-11-07. Planning only; no application implementation is included.

## 1. Goal and Scope

Build a small, local-first countdown timer using Classtimer's visual design and Tomodoro's two Picture-in-Picture approaches. The timer should work offline after a successful initial load and cache installation, and float above other applications where the browser supports it.

Recommended first-release scope:

- One countdown with start/pause, reset, and +1, +3, and +5 minute buttons.
- Classtimer's segmented progress ring, dark palette, and inline SVG controls.
- A compact, interactive Document Picture-in-Picture window on supported browsers.
- A canvas-to-video Picture-in-Picture fallback where the complete pipeline works.
- A usable normal page when floating is unavailable.
- Local timer restoration, visible completion feedback, and an optional synthesized completion sound.
- Installable PWA with no backend, account, analytics, or runtime CDN dependencies.

Exclude classroom rosters, PDFs, slides, Markdown presentations, ZIP loading, Pomodoro rounds, tasks, statistics, and cloud synchronization. An installed PWA is not automatically always-on-top.

## 2. Findings From the Sources

### Classtimer: Preserve the UI, Not the Entire Application

- The timer face has twelve SVG progress segments, play/pause and reset inside the ring, and quick-add buttons below it. The current face is 160 by 160 CSS pixels.
- Its visual language uses a dark blue-gray background, blue progress segments, and pale text. Reuse these styles rather than introducing a new design system.
- The existing display rounds up to whole minutes and shows less than one minute near completion. Reset clears the timer to zero rather than restoring the starting duration.
- Time additions increase both remaining time and the progress baseline. Preserve this behavior so adding time does not produce an invalid ring.
- The stack is plain HTML, CSS, JavaScript modules, esbuild, and Jest. PDF.js, remark.js, and fflate belong to the larger classroom application and are unnecessary here.
- Existing timer execution subtracts a second per interval callback, and persistence stores remaining time rather than a deadline. Background throttling, sleep, and reload therefore need a different timing model.
- Existing PWA assets provide a reference, but cache cleanup is not application-namespaced, icons are not fully precached, and installation icons are SVG-only. The historical PWA plan does not exactly match the implemented source.

Primary local references:

- `/home/moritz/Coding/Classtimer/classtimer.html`, especially the timer markup around lines 59-92.
- `/home/moritz/Coding/Classtimer/lib/css/styles.css`, timer styling around lines 262-360.
- `/home/moritz/Coding/Classtimer/lib/js/timerLogic.js` and its tests in `lib/js/__tests__/timerLogic.test.js`.
- `/home/moritz/Coding/Classtimer/lib/js/app.js`, timer execution, audio, and restoration.
- `/home/moritz/Coding/Classtimer/lib/js/storageLogic.js`, `pwa/sw.js`, `pwa/manifest.webmanifest`, `build.js`, and `plan-pwa.md`.

### Tomodoro: Reuse the Floating Techniques Selectively

- Document PiP moves the actual timer element into another document, copies styles, and restores the element when the floating window closes. This preserves real HTML controls.
- Canvas mode draws a timer onto a canvas, captures it as a media stream, and displays that stream through a video element in video PiP. It does not provide arbitrary HTML controls in the floating window.
- Tomodoro also exposes the video for manual browser-specific PiP entry. Its Firefox and Android instructions are useful leads, not verified compatibility guarantees for this new app.
- Its worker counts interval callbacks rather than measuring elapsed time. A worker alone does not solve suspended-page or sleeping-device accuracy.
- Its Document PiP request includes older options for aspect ratio and automatic stylesheet copying. Use the currently documented width/height options and explicit styling instead of depending on those older options.
- Its PiP entry paths lack comprehensive request-failure handling. Video playback events are coupled to timer start/pause, which could make merely opening the floating view change the countdown. Do not inherit that coupling.
- Its service worker uses one fixed cache name, broadly caches fetched responses, and swallows precache installation errors. Use a bounded, versioned application cache with an explicit successful-install requirement.

Remote references reviewed:

- [Live application and UI](https://lazy-guy.github.io/tomodoro/index.html).
- [Application source, including PiP handling](https://lazy-guy.github.io/tomodoro/index.js).
- [Timer worker](https://lazy-guy.github.io/tomodoro/worker.js), [service worker](https://lazy-guy.github.io/tomodoro/sw.js), and [manifest](https://lazy-guy.github.io/tomodoro/site.webmanifest).
- [Source repository](https://github.com/lazy-guy/tomodoro) and [MIT license](https://github.com/lazy-guy/tomodoro/blob/main/LICENSE.md).

## 3. Recommended Technologies

| Concern | Recommendation | Reason |
| --- | --- | --- |
| Interface | Semantic HTML, CSS, SVG, and JavaScript modules | Matches Classtimer and keeps runtime dependencies small. |
| Build | Minimal esbuild setup | Reuse a familiar tool without importing the presentation bundle. |
| Floating HTML | Document Picture-in-Picture API | Real accessible controls and the closest match to the existing UI. |
| Floating fallback | Canvas 2D, canvas capture stream, and video Picture-in-Picture | Reuses Tomodoro's approach without assuming universal support. |
| Timer | Deadline-based state with lightweight display scheduling | Delayed callbacks must not extend the countdown. |
| Local state | Small versioned localStorage record | Sufficient for one timer and preferences; IndexedDB is unnecessary initially. |
| Offline | Service worker and Cache Storage | Precaches the complete application shell. |
| Installation | Web app manifest, PNG icons, and maskable icon | Supports standalone installation where offered. |
| Sound | Web Audio oscillator | No downloaded audio or offline sound asset required. |
| Tests | Jest for timer logic; Playwright for page/offline flows | Keeps timing tests deterministic and browser checks repeatable. |

Do not add a UI framework, Electron, a database, Workbox, or a dedicated timing worker unless a demonstrated need appears. PiP needs real-browser manual checks in addition to automation.

## 4. Logical Responsibilities

- Timer state owns duration, remaining time, running deadline, paused/running/completed status, and one-time completion handling. Neither renderer measures time independently.
- Main-page UI owns controls, progress rendering, keyboard access, offline/update messages, and floating-mode status.
- Floating-view management selects the available mode, handles opening/closing/failure, and releases window or media resources.
- Canvas rendering consumes the same timer snapshot and visual tokens as the HTML view. It must not become a second timer implementation.
- Persistence validates and restores timer state and preferences. Save on meaningful changes and lifecycle transitions rather than on every repaint.
- PWA infrastructure owns installation assets, offline availability, and safe application updates, not continuous countdown execution.

Keep these boundaries small; this is not a reason to build a generalized plugin or state-management framework.

## 5. Floating-Window Strategy

### Preferred: Document PiP

- Open only from an explicit user action in the top-level page. Require a secure context and check API availability at runtime.
- Move the complete compact timer panel, including quick-add controls, into PiP. Leave a clear placeholder and return control in the main page.
- Share local styles and theme variables explicitly. Support a resizable window rather than assuming the browser will lock its aspect ratio or honor an exact size.
- Restore the panel to its original location on close or return-to-tab, using the page lifecycle close signal. Preserve timer state, focus, and control behavior.
- Make teardown safe to run more than once. Repeated clicks, a request still opening, and browser-initiated closure must not duplicate panels or listeners.
- Opening or closing the floating view must not start, pause, or reset the timer.
- The PiP window depends on its originating page. Do not promise that it survives closing or navigating away from that page, and do not reopen it automatically after reload.

### Fallback: Canvas and Video PiP

- Check canvas capture, usable video playback, and PiP entry support separately. A fullscreen capability flag alone is not proof of floating-window support.
- Prepare a readable first frame and usable video state before requesting PiP. Handle media readiness, rejected playback, and transient user-activation requirements; offer another explicit click if preparation consumes activation.
- Default to a display-only floating timer. Keep full controls on the main page; native media controls are browser-dependent and are not equivalent to HTML buttons.
- Keep media transport events separate from countdown state. Opening a video must not implicitly start the countdown, and closing it must not stop the countdown.
- Redraw efficiently while active, including when the originating tab is hidden. Verify that captured frames actually update; timestamp accuracy does not guarantee live frames on a suspended page.
- Release stream tracks, video references, listeners, and rendering work when the fallback closes. Reopening must not leak another stream.
- Manual browser PiP entry can be documented only after testing it. Do not silently equate fullscreen video or an ordinary popup with always-on-top PiP.

### Failure and Compatibility Policy

- Try Document PiP first; offer canvas/video PiP if the relevant capabilities work. If a failed request consumes user activation, present an explicit fallback action rather than assuming an automatic retry will succeed.
- Keep the normal timer usable when requests are blocked by browser settings, policy, unsupported media streams, or OS restrictions. Explain the limitation rather than hiding all context.
- Desktop Chromium is the primary target for interactive floating mode. Firefox and Safari require separate validation of the fallback; mobile browsers and installed mobile PWAs must not be promised floating parity.
- PiP placement, minimum size, browser chrome, and behavior over fullscreen applications are controlled by the browser and OS. The app cannot guarantee exact positioning or visibility in every situation.

## 6. Timer and Interaction Rules

The following are proposed defaults, not additional confirmed user requirements:

- Preserve quick-add setup and reset-to-zero semantics. Starting at zero does nothing; no separate duration form is necessary for the first release.
- Preserve the rounded-minute visual emphasis, including the less-than-one-minute state. Supply an exact accessible time description; a seconds-display preference can follow if needed.
- Define a documented maximum duration and reject invalid, negative, non-finite, or excessive restored values.
- While running, calculate remaining time from an absolute deadline. Callback frequency affects visual smoothness, not countdown duration. Reconcile on focus, visibility changes, restoration, and resume after sleep.
- Pause stores the remaining duration; resume establishes a new deadline. Adding minutes while running extends both the deadline and progress baseline, and adding while paused leaves the timer paused.
- Complete at the deadline, clamp at zero, and fire the completion transition once. Do not inherit either source's extra-callback delay.
- On reload, restore a future running deadline and continue. If the deadline has already passed, show completion immediately without replaying a stale alarm; PiP still requires another user action.
- Sleep counts toward elapsed time, but alarms may be delayed until execution resumes. A late completion should produce at most one alert rather than a burst of catch-up events.
- Wall-clock changes can affect persisted deadlines. Use monotonic elapsed time as an in-session cross-check where practical, detect large disagreements, and make the reconciliation policy explicit. Do not claim immunity to manual clock changes across restarts.
- Keep one active timer owner across duplicate tabs/windows. Use browser-supported ownership and messaging mechanisms, such as Web Locks and BroadcastChannel, to make secondary instances read-only or require explicit takeover; do not allow silent competing persistence writes or duplicate alarms.

## 7. Offline, Installation, and Updates

- Serve static files over HTTPS, with localhost for development. Opening a downloaded HTML file directly is not the supported PWA installation path.
- Precache every required local asset: page, scripts, styles, manifest, icons, and any fonts. Prefer system fonts and inline SVG so no network dependency remains.
- An initial online visit must finish cache installation before the app claims offline readiness. Installation of the PWA itself is optional for offline use.
- Use an application-specific cache prefix and release version covering all shipped assets. Never delete another application's caches on a shared origin.
- Reject incomplete precache installation; keep the previous working release available. Cache only intended same-origin GET resources with acceptable responses, not arbitrary requests or error pages.
- Prefer a precached, internally consistent application shell for offline startup. Fetch release updates separately rather than mixing old and new scripts during a timer session.
- Keep manifest identity, start URL, asset paths, and service-worker scope valid under a hosting subdirectory. Avoid accidental root-wide interception.
- Show an update-ready notice, but do not force reload or immediate worker takeover while a timer or PiP session is active. Apply updates at a safe, user-approved point after persisting state.
- Provide PNG installation icons at 192 and 512 pixels, a suitable maskable icon, and an Apple touch icon. Reuse Classtimer artwork only after verifying its license notice.
- Treat browser storage as best effort. Cleared site data, private browsing, quota failures, and cache eviction may remove preferences or offline availability. Continue in memory when persistence is unavailable and show an honest warning.
- No service worker, worker, installed PWA, or notification permission guarantees an exact alarm while the app is closed, the device is asleep, or the OS has suspended it. This is not a replacement for a native background alarm.

## 8. Accessibility, Audio, and Privacy

- Retain the visual design but enlarge touch targets, give icon buttons accessible names, expose pressed/running state, and ensure keyboard operation in both documents.
- Do not bind global shortcuts while the user is typing or interacting with another control. Restore focus sensibly after returning from PiP.
- Support zoom, narrow windows, mobile safe areas, high contrast, and reduced motion. Do not use ring color alone to communicate completion.
- Announce start, pause, and completion without a screen-reader announcement every second. The canvas fallback is visual-only, so the accessible main-page timer remains available.
- Initialize or resume audio during a user gesture and offer mute. Completion must remain visible when autoplay restrictions, OS mute, or unavailable audio prevent sound.
- Browser notifications are optional and can be deferred. If added, request permission only after an explicit opt-in; denial must not break the timer, and notifications must not be presented as scheduled closed-app alarms.
- Keep user state on-device, with no account or network submission. Render any future user-supplied labels as text rather than HTML.

## 9. Delivery Order

1. Confirm timer semantics and build the smallest timer-only page from Classtimer's visual assets. Establish deadline logic, progress rules, and deterministic state-transition tests first.
2. Add Document PiP with reliable panel restoration, shared controls, request failure handling, and repeated-open/close tests.
3. Add canvas/video PiP and validate actual frame updates and entry behavior on target browsers. Document any browser-specific manual steps or unsupported combinations.
4. Add versioned local restoration, duplicate-instance ownership, completion sound, and lifecycle reconciliation.
5. Add manifest, installation icons, complete offline caching, and a non-disruptive update flow. Validate HTTPS and subdirectory deployment.
6. Finish accessibility, responsive layout, real-device testing, and third-party attribution before release.

## 10. Acceptance and Edge-Case Checks

| Area | Required checks |
| --- | --- |
| Countdown | Zero start, repeated start/pause, reset while running, rapid quick-add, maximum duration, accurate final second, and one completion event. |
| Lifecycle | Hidden tab, minimized browser, sleep/wake, reload while running or paused, expired restored deadline, clock adjustment, and back/forward restoration. |
| Shared state | Duplicate tabs and installed/browser instances, explicit takeover, owner closure, and no duplicate alarms or conflicting writes. |
| Document PiP | Main-page and floating controls, blocked entry, double clicks, resize, browser close, return-to-tab, parent navigation, repeated reopen, and correct focus restoration. |
| Canvas fallback | First frame, video readiness, rejected playback, native/manual PiP entry, live hidden-tab frames, theme/progress consistency, no unintended timer start/pause, and stream cleanup. |
| Offline | First completed install followed by airplane mode, offline reload and installed launch, all assets available, incomplete first install, storage denial, cache eviction, and shared-origin cache isolation. |
| Updates | New release during a running timer and during PiP, safe update after persistence, failed update download, no mixed-version shell, and a retained working offline release. |
| Interface | Narrow phone layout, small floating window, large zoom, touch targets, keyboard-only operation, screen reader, muted/blocked sound, and visible completion. |
| Deployment | HTTPS, localhost, hosting subdirectory, manifest identity/scope, install icons, and no runtime third-party fetches. |

The first release is acceptable when the offline timer works independently of PiP support, interactive floating mode works on the primary desktop target, and every unsupported floating path degrades clearly without losing the countdown. Do not declare fallback support for a browser solely because its API exists.

## 11. Licensing and Verification Limits

- Tomodoro is MIT-licensed, copyright 2022 lazy-guy. Preserve its copyright and permission notice when copying substantial source; include attribution in the distributed app's notices.
- Classtimer's package metadata declares MIT, but a standalone copyright/license notice was not found in the review. Verify that notice before redistributing copied source or artwork.
- This plan is based on source inspection, not a running-browser visual audit, installation test, or compatibility certification. Floating behavior, background rendering, and sound delivery remain implementation-time validation tasks.
- Current API behavior was cross-checked against MDN's [Document PiP request options](https://developer.mozilla.org/en-US/docs/Web/API/DocumentPictureInPicture/requestWindow), [Document PiP lifecycle guide](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API/Using), and [video PiP overview](https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API).
