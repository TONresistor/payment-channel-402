import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "channel",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
