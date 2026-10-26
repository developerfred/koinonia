import { defineConfig } from "vitest/config";
export default defineConfig({
  worker: { format: "es" },
  build: { target: "es2022" },
  test: { include: ["test/**/*.test.ts"], environment: "node", css: { include: [/ui\/styles\.css/] } },
});
