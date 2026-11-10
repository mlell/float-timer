// Smoke tests against the production build. Time is driven by page.clock so the
// countdown is deterministic; the clock must be installed before navigation so the
// app's first Date.now() read already goes through the fake clock.
import { expect, test, type Page } from "@playwright/test";

const START_TIME = new Date("2026-01-01T10:00:00Z");

// Exposed as role=timer by view.ts, so the exact-remaining accessible name is asserted directly.
function timerDisplay(page: Page) {
  return page.getByRole("timer");
}

test("quick add, play, pause and reset", async ({ page }) => {
  await page.clock.install({ time: START_TIME });
  await page.goto("/");

  await page.getByRole("button", { name: "Add 1 minute" }).click();
  await expect(timerDisplay(page)).toHaveText("1");

  const play = page.getByRole("button", { name: "Start" });
  await play.click();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // 30 s elapsed of 60 s: under a minute the label reads "<1" (formatMinutes), and the ring has gone darker.
  await page.clock.runFor(30_000);
  await expect(timerDisplay(page)).toHaveText("<1");
  await expect(timerDisplay(page)).toHaveAttribute(
    "aria-label",
    "30 seconds remaining",
  );
  await expect(page.locator(".timer__segment--on")).toHaveCount(6);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(timerDisplay(page)).toHaveText("0");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("completes while the tab is hidden and shows the done cue", async ({
  page,
}) => {
  await page.clock.install({ time: START_TIME });
  await page.goto("/");

  await page.getByRole("button", { name: "Add 1 minute" }).click();
  await page.getByRole("button", { name: "Start" }).click();

  // Simulate a background tab: a hidden document schedules the setTimeout path in Ticker.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await page.clock.runFor(61_000);

  // The visible cue is scoped by class: the same text also lives in the live region.
  await expect(page.locator(".timer__cue")).toBeVisible();
  await expect(page.locator(".timer__cue")).toHaveText("Time's up");
});

test("standalone bundle renders the timer face", async ({ page }) => {
  await page.clock.install({ time: START_TIME });
  await page.goto("/timer.html");

  await expect(page.getByRole("timer")).toHaveText("0");
  await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add 1 minute" }),
  ).toBeVisible();
});
