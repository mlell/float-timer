// PiP capability handling against the production build, including real canvas
// capture with a mocked video PiP request when no native PiP window is available.
import { expect, test, type Page } from "@playwright/test";

function pipSupported(page: Page): Promise<boolean> {
  return page.evaluate(() => "documentPictureInPicture" in window);
}

test("PiP layout scales without a cap and wraps controls in narrow windows", async ({
  page,
}) => {
  await page.goto("/");
  // Use the real mounted face and stylesheet without native PiP window-size limits.
  await page.evaluate(() => {
    const timer = document.querySelector(".timer");
    if (timer === null) throw new Error("Missing timer face");
    const host = document.createElement("div");
    host.className = "float-host";
    host.append(timer);
    document.body.replaceChildren(host);
  });

  let previousSize = 200;
  let previousFontSize = 32;
  for (const size of [400, 800, 1200]) {
    await page.setViewportSize({ width: size, height: size + 100 });
    const ring = await page.locator(".timer__ring").boundingBox();
    if (ring === null) throw new Error("Missing ring");
    expect(ring.width).toBeGreaterThan(previousSize);
    expect(ring.width).toBeCloseTo(ring.height);
    previousSize = ring.width;
    const fontSize = await page
      .getByRole("timer")
      .evaluate((display) =>
        Number.parseFloat(getComputedStyle(display).fontSize),
      );
    expect(fontSize).toBeGreaterThan(previousFontSize);
    previousFontSize = fontSize;
  }

  for (const width of [240, 160, 96]) {
    await page.setViewportSize({ width, height: 500 });
    const quick = await page.locator(".timer__quick").boundingBox();
    if (quick === null) throw new Error("Missing quick controls");
    expect(quick.height).toBeGreaterThan(44);
    const buttons = await page.locator(".timer__btn:visible").all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      if (box === null) throw new Error("Missing button");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(500);
    }
    const ring = await page.locator(".timer__ring").boundingBox();
    if (ring === null) throw new Error("Missing ring");
    expect(ring.y + ring.height).toBeLessThanOrEqual(quick.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  }
  const controls = await page.locator(".timer__main-controls").boundingBox();
  expect(controls?.height).toBeGreaterThan(44);
});

for (const view of ["page", "PiP"]) {
  test(`${view} hides controls below 150px and the ring below 100px`, async ({
    page,
  }) => {
    await page.goto("/");
    if (view === "PiP") {
      await page.evaluate(() => {
        const timer = document.querySelector(".timer");
        if (timer === null) throw new Error("Missing timer face");
        const host = document.createElement("div");
        host.className = "float-host";
        host.append(timer);
        document.body.replaceChildren(host);
      });
    }

    for (const height of [150, 149, 100, 99, 100, 150]) {
      await page.setViewportSize({ width: 400, height });
      await expect(page.getByRole("timer")).toBeVisible();
      if (height < 150) {
        await expect(page.locator("button:visible")).toHaveCount(0);
        await expect(page.locator(".timer__quick")).toBeHidden();
        await expect(page.locator(".timer__main-controls")).toBeHidden();
        const display = await page.getByRole("timer").boundingBox();
        if (display === null) throw new Error("Missing timer display");
        expect(display.y).toBeGreaterThanOrEqual(0);
        expect(display.y + display.height).toBeLessThanOrEqual(height);
      } else {
        await expect(
          page.getByRole("button", { name: "Reset", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".timer__quick")).toBeVisible();
      }
      if (height < 100) await expect(page.locator(".timer__ring")).toBeHidden();
      else await expect(page.locator(".timer__ring")).toBeVisible();
    }
  });
}

test("Float button is hidden when neither PiP mode is supported", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "documentPictureInPicture");
    Reflect.deleteProperty(Window.prototype, "documentPictureInPicture");
    Object.defineProperty(document, "pictureInPictureEnabled", {
      value: false,
    });
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "webkitSupportsPresentationMode",
      {
        value: () => false,
      },
    );
  });
  await page.goto("/");
  await expect(page.locator("#float-toggle")).toBeHidden();
  await expect(page.getByRole("timer")).toBeVisible();
});

test("video fallback keeps page controls and releases capture on close", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "documentPictureInPicture");
    Reflect.deleteProperty(Window.prototype, "documentPictureInPicture");
    Object.defineProperty(document, "pictureInPictureEnabled", { value: true });
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "requestPictureInPicture",
      {
        value: function (this: HTMLVideoElement) {
          Object.defineProperty(document, "pictureInPictureElement", {
            configurable: true,
            value: this,
          });
          return Promise.resolve({ width: 320, height: 320 });
        },
      },
    );
    Object.defineProperty(document, "exitPictureInPicture", {
      value: () => {
        Object.defineProperty(document, "pictureInPictureElement", {
          configurable: true,
          value: null,
        });
        return Promise.resolve();
      },
    });
  });
  await page.goto("/");
  const float = page.getByRole("button", { name: "Float" });
  await expect(page.getByRole("timer")).toHaveCount(1);
  await expect(page.locator(".timer__btn--mute + #float-toggle")).toBeVisible();
  await page.getByRole("button", { name: "Add 1 minute", exact: true }).click();
  await float.click();
  await expect(float).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Use the controls here", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toHaveText("1");
  await page
    .getByRole("button", { name: "Add 3 minutes", exact: true })
    .click();
  await expect(page.getByRole("timer")).toHaveText("4");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.pause();
  });
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeVisible();
  await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    await video.play();
  });
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("video")
      .evaluate(
        (video: HTMLVideoElement) =>
          video.srcObject instanceof MediaStream && video.srcObject.active,
      ),
  ).toBe(true);
  const capture = await page
    .locator("video")
    .evaluateHandle((video: HTMLVideoElement) => video.srcObject);
  await float.click();
  await expect(float).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("video")).toHaveCount(0);
  expect(
    await capture.evaluate(
      (stream) =>
        stream instanceof MediaStream &&
        stream.getTracks().every((track) => track.readyState === "ended"),
    ),
  ).toBe(true);
  await capture.dispose();
  await expect(page.getByRole("timer")).toHaveText("4");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
});

test("open, close and reopen the floating timer", async ({ page }) => {
  await page.goto("/");
  test.skip(!(await pipSupported(page)), "Document PiP unavailable (headless)");

  const float = page.getByRole("button", { name: "Float" });
  for (let i = 0; i < 3; i++) {
    await float.click();
    await expect(page.getByText("Timer is floating")).toBeVisible();
    await expect(page.getByRole("timer")).toHaveCount(0);

    await page.getByRole("button", { name: "Bring back" }).click();
    await expect(float).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("timer")).toHaveText("0");
  }
});

test("Safari-style video PiP waits for entry and restores Float after browser close", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "documentPictureInPicture");
    Reflect.deleteProperty(Window.prototype, "documentPictureInPicture");
    Object.defineProperty(document, "pictureInPictureEnabled", {
      value: false,
    });
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "webkitSupportsPresentationMode",
      {
        value: function (this: HTMLVideoElement) {
          return this.readyState >= 2;
        },
      },
    );
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "webkitSetPresentationMode",
      {
        value: function (this: HTMLVideoElement, mode: string) {
          window.setTimeout(() => {
            Object.defineProperty(this, "webkitPresentationMode", {
              configurable: true,
              value: mode,
            });
            this.dispatchEvent(new Event("webkitpresentationmodechanged"));
          }, 0);
        },
      },
    );
  });
  await page.goto("/");
  const float = page.getByRole("button", { name: "Float" });
  await expect(float).toBeVisible();
  await float.click();
  await expect(float).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("timer")).toBeVisible();
  await page.locator("video").evaluate((video) => {
    Object.defineProperty(video, "webkitPresentationMode", {
      configurable: true,
      value: "inline",
    });
    video.dispatchEvent(new Event("webkitpresentationmodechanged"));
  });
  await expect(float).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("video")).toHaveCount(0);
});
