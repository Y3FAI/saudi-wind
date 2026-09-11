import { rmSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * `public/data/processed` and `public/data/sample` hold dev-only wind fixtures:
 * the frozen single-frame manifest plus its grid, and the sample pair.
 *
 * They are read by `bun run dev` (the app's DEV manifest URL), by
 * `tests/support/preview-server.mjs` and by `tests/ui.spec.ts`. They are **not**
 * site data: production serves the manifest and every grid from R2 through
 * `/api/wind/*`. Vite copies `public/` verbatim, so without this plugin the
 * frozen fixture would ship inside the Pages bundle and stay publicly fetchable
 * at `https://saudi-wind.pages.dev/data/processed/latest.json`.
 *
 * The plugin strips those two directories from every build output;
 * `scripts/check-dist-manifest.mjs` (part of `bun run build`) fails the build if
 * either reappears.
 */
const DEV_ONLY_FIXTURE_DIRECTORIES = ["data/processed", "data/sample"];

function excludeDevOnlyWindFixtures(): Plugin {
  let outDir = "dist";
  return {
    name: "saudi-wind:exclude-dev-only-fixtures",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const directory of DEV_ONLY_FIXTURE_DIRECTORIES) {
        rmSync(resolve(outDir, directory), { recursive: true, force: true });
      }
      console.log(
        `[saudi-wind] excluded dev-only fixtures from ${outDir}: ` +
          DEV_ONLY_FIXTURE_DIRECTORIES.join(", "),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), excludeDevOnlyWindFixtures()],
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "functions/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
