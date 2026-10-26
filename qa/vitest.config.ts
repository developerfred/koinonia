import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["{contract,integration,security,fuzz,properties,evals}/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Daemon-spawning tests bind ephemeral ports, but keep files serial to keep CI logs readable and avoid CPU skew in evals.
    fileParallelism: false,
    coverage: { provider: "v8", include: ["lib/**"], reporter: ["text-summary"] },
  },
});
