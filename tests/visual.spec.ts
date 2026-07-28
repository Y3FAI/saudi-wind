import { expect, test } from "@playwright/test";

test("matches the approved Arabic layout", async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("رياح السعودية");
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot("arabic-layout.png", {
    animations: "disabled",
    fullPage: isMobile,
    maxDiffPixelRatio: 0.03,
  });
});
