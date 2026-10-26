import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.QA_STUDIO_PORT ?? 5199);
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.QA_STUDIO_URL ?? `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",   // synthetic camera (green pacman) + beeping mic
        "--use-fake-ui-for-media-stream",       // auto-accept the permission prompt
        "--autoplay-policy=no-user-gesture-required",
        "--enable-features=WebCodecs",
      ],
    },
    permissions: ["camera", "microphone"],
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  // Studio dev server (vite). Skip with QA_STUDIO_URL pointing at an already running studio.
  webServer: process.env.QA_STUDIO_URL ? undefined : {
    command: `npm --prefix ../studio run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
