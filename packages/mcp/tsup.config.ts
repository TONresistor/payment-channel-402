import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: { compilerOptions: { composite: false, incremental: false } },
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
    "@ton/ton",
    "@modelcontextprotocol/sdk",
    "@ton/core",
    "@ton/crypto",
    "zod",
  ],
});
