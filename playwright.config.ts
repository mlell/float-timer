// E2E tests run against the production build served statically, so the browser
// exercises exactly the artifact that ships rather than an esbuild dev transform.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // The standalone bundle is part of the served artifact, so it is built here too; it
    // only adds dist/timer.html and leaves the build outputs in place.
    command: `npm run build && npm run bundle && python3 -m http.server ${String(PORT)} --directory dist`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
  },
});
