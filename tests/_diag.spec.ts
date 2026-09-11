import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const MANIFEST = "/data/processed/latest.json";

test("DIAG normal load", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => log.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto("/");
  await page.waitForTimeout(4000);
  console.log("DIAG-normal applications=", await page.getByRole("application").count());
  console.log("DIAG-normal badgeTexts=", JSON.stringify(await page.locator(".sample-badge").allInnerTexts()));
  console.log("DIAG-normal log=", log.join(" | "));
});

test("DIAG reduced motion", async ({ page }) => {
  const log: string[] = [];
  page.on("console", (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => log.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForTimeout(4000);
  console.log("DIAG-reduced applications=", await page.getByRole("application").count());
  console.log("DIAG-reduced motionNote=", await page.getByText("تم إيقاف الحركة حسب إعدادات الجهاز").count());
  console.log("DIAG-reduced html=", (await page.locator("body").innerHTML()).slice(0, 900).replace(/\s+/g, " "));
  console.log("DIAG-reduced log=", log.join(" | "));
});

test("DIAG stale manifest mock", async ({ page }) => {
  const original = JSON.parse(await readFile(new URL("../public/data/processed/latest.json", import.meta.url), "utf8"));
  console.log("DIAG-fixture frames=", JSON.stringify(original.frames?.map((f: any) => f.validTime)));
  console.log("DIAG-fixture manifest validTime=", original.validTime, "modelRun=", original.modelRun, "sample=", original.sample);
  await page.route(`**${MANIFEST}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...original, sample: false, modelRun: "2020-01-01T00:00:00Z", validTime: "2020-01-01T00:00:00Z", publishedAt: "2020-01-01T04:00:00Z" }) }));
  await page.goto("/");
  await page.waitForTimeout(4000);
  console.log("DIAG-stale badgeTexts=", JSON.stringify(await page.locator(".sample-badge").allInnerTexts()));
  console.log("DIAG-stale applications=", await page.getByRole("application").count());
  console.log("DIAG-stale bodyText=", (await page.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " / "));
});
