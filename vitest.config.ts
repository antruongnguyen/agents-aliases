import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    // Force deterministic, uncolored output so summary/render assertions match plain
    // substrings regardless of TTY or CI (GitHub Actions sets CI/FORCE_COLOR, which
    // picocolors otherwise honors). picocolors reads NO_COLOR at import time.
    env: { NO_COLOR: "1", FORCE_COLOR: "0" },
  },
});
