import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "pc402-core",
    "pc402-channel",
    "pc402-fetch",
    "commander",
    "@ton/ton",
    "@ton/core",
    "@ton/crypto",
  ],
});
