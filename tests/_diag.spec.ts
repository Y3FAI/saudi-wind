import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const MANIFEST = "/data/processed/latest.json";

interface FixtureFrame {
  validTime?: string;
}

test("DIAG normal load", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (message) =>
    log.push(`console.${message.type()}: ${message.text()}`),
  );
  page.on("pageerror", (error) => log.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    log.push(`REQFAIL ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      log.push(`HTTP ${response.status()} ${response.url()}`);
  });

  await page.goto("/");
  await page.waitForTimeout(4000);

  console.log(
    "DIAG-normal applications=",
    await page.getByRole("application").count(),
  );
  console.log(
    "DIAG-normal badge=",
    JSON.stringify(await page.locator(".sample-badge").allInnerTexts()),
  );
  console.log("DIAG-normal log=", log.join(" | "));
});

test("DIAG reduced motion", async ({ page }) => {
  const log: string[] = [];
  page.on("pageerror", (error) => log.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    log.push(`REQFAIL ${request.url()} ${request.failure()?.errorText}`),
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForTimeout(4000);

  console.log(
    "DIAG-reduced applications=",
    await page.getByRole("application").count(),
  );
  console.log(
    "DIAG-reduced note=",
    await page.getByText("تم إيقاف الحركة حسب إعدادات الجهاز").count(),
  );
  console.log(
    "DIAG-reduced body=",
    (await page.locator("body").innerText())
      .slice(0, 300)
      .replace(/\n+/g, " / "),
  );
  console.log("DIAG-reduced log=", log.join(" | "));
});

test("DIAG stale manifest mock", async ({ page }) => {
  const original = JSON.parse(
    await readFile(
      new URL("../public/data/processed/latest.json", import.meta.url),
      "utf8",
    ),
  ) as {
    frames?: FixtureFrame[];
    validTime?: string;
    modelRun?: string;
    sample?: boolean;
  };

  console.log(
    "DIAG-fixture frames=",
    JSON.stringify(original.frames?.map((frame) => frame.validTime)),
  );
  console.log(
    "DIAG-fixture manifest=",
    original.validTime,
    original.modelRun,
    original.sample,
  );

  await page.route(`**${MANIFEST}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...original,
        sample: false,
        modelRun: "2020-01-01T00:00:00Z",
        validTime: "2020-01-01T00:00:00Z",
        publishedAt: "2020-01-01T04:00:00Z",
      }),
    }),
  );

  await page.goto("/");
  await page.waitForTimeout(4000);

  console.log(
    "DIAG-stale applications=",
    await page.getByRole("application").count(),
  );
  console.log(
    "DIAG-stale badge=",
    JSON.stringify(await page.locator(".sample-badge").allInnerTexts()),
  );
  console.log(
    "DIAG-stale body=",
    (await page.locator("body").innerText())
      .slice(0, 300)
      .replace(/\n+/g, " / "),
  );
});
