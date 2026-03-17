import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/channel",
    ],
    passWithNoTests: true,
  },
});
