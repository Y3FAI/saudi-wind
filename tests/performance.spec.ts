import { expect, test } from "@playwright/test";

test("sustains the animation frame-rate target @performance", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const canvas = page.locator(".map-canvas--wind");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("data-fps", /\d/, { timeout: 10_000 });

  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    await page.waitForTimeout(1100);
    const value = Number(await canvas.getAttribute("data-fps"));
    expect(Number.isFinite(value)).toBe(true);
    samples.push(value);
  }
  samples.sort((left, right) => left - right);
  const median = samples[1];
  const configuredMinimum = Number(
    process.env[
      isMobile
        ? "PERFORMANCE_MOBILE_FPS_MINIMUM"
        : "PERFORMANCE_DESKTOP_FPS_MINIMUM"
    ],
  );
  const minimum =
    Number.isFinite(configuredMinimum) && configuredMinimum > 0
      ? configuredMinimum
      : isMobile
        ? 30
        : 55;
  console.info(
    `${isMobile ? "mobile" : "desktop"} animation FPS: ${samples.join(", ")} (median ${median})`,
  );

  expect(
    median,
    `${isMobile ? "mobile" : "desktop"} FPS samples: ${samples.join(", ")}`,
  ).toBeGreaterThanOrEqual(minimum);
  await expect(canvas).toHaveAttribute("data-particles", /\d+/);
});
