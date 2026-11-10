// Document PiP against the production build. Headless Chromium may not expose
// `documentPictureInPicture`; then only the degraded path (hidden Float button) is
// checked and the real open/close/reopen round trip is skipped.
import { expect, test, type Page } from "@playwright/test";

function pipSupported(page: Page): Promise<boolean> {
  return page.evaluate(() => "documentPictureInPicture" in window);
}

test("Float button is hidden when Document PiP is unsupported", async ({
  page,
}) => {
  await page.goto("/");
  test.skip(await pipSupported(page), "Document PiP available here");
  await expect(page.locator("#float-toggle")).toBeHidden();
  await expect(page.getByRole("timer")).toBeVisible();
});

test("open, close and reopen the floating timer", async ({ page }) => {
  await page.goto("/");
  test.skip(!(await pipSupported(page)), "Document PiP unavailable (headless)");

  const float = page.getByRole("button", { name: "Float" });
  for (let i = 0; i < 3; i++) {
    await float.click();
    await expect(float).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Timer is floating")).toBeVisible();
    await expect(page.getByRole("timer")).toHaveCount(0);

    await page.getByRole("button", { name: "Bring back" }).click();
    await expect(float).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("timer")).toHaveText("0");
  }
});
