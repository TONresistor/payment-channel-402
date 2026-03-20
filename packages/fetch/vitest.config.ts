import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "fetch",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
