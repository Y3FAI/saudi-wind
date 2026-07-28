import { expect, test } from "@playwright/test";

test("renders the Arabic application and wind map", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "رياح السعودية" }),
  ).toBeVisible();
  await expect(page.getByRole("application")).toBeVisible();
  await expect(page.locator(".map-canvas--wind")).toBeVisible();

  const supportsWebgl2 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  });

  if (supportsWebgl2) {
    await expect(page.locator(".webgl-error")).toHaveCount(0);
  } else {
    await expect(page.getByRole("alert")).toContainText(
      "تعذر تحريك الرياح",
    );
    await expect(page.getByRole("alert")).toContainText("WebGL2");
  }
});

test("supports reduced motion without WebGL animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByRole("application")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
  await expect(
    page.getByText("تم إيقاف الحركة حسب إعدادات الجهاز"),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
