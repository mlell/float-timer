// PiP capability handling against the production build, including real canvas
// capture with a mocked video PiP request when no native PiP window is available.
import { expect, test, type Page } from "@playwright/test";

function pipSupported(page: Page): Promise<boolean> {
  return page.evaluate(() => "documentPictureInPicture" in window);
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
