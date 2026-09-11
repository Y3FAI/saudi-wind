import { expect, test } from "@playwright/test";

test("matches the approved Arabic layout", async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("رياح السعودية");
  await page.evaluate(() => document.fonts.ready);

  // The frame this snapshot approves no longer carries the eyebrow, the
  // time-zone line, the freshness pill or the zoom buttons, and its second and
  // third statistics are cities rather than a grid-cell maximum.
  await expect(page.locator(".eyebrow")).toHaveCount(0);
  await expect(page.getByText("المملكة العربية السعودية")).toHaveCount(0);
  await expect(page.getByText("بتوقيت المملكة")).toHaveCount(0);
  await expect(page.locator(".sample-badge")).toHaveCount(0);
  await expect(page.locator(".map-controls")).toHaveCount(0);
  await expect(page.getByText("أعلى خلية في النموذج")).toHaveCount(0);
  await expect(page.locator(".statistics > div")).toHaveCount(3);
  await expect(
    page.locator(".statistics > div").filter({ hasText: "أسرع مدينة" }),
  ).toBeVisible();
  await expect(
    page.locator(".statistics > div").filter({ hasText: "أبطأ مدينة" }),
  ).toBeVisible();

  await expect(page).toHaveScreenshot("arabic-layout.png", {
    animations: "disabled",
    fullPage: isMobile,
    maxDiffPixelRatio: 0.03,
  });
});
