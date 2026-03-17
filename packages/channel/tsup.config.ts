import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: { compilerOptions: { composite: false, incremental: false } },
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  outDir: "dist",
  external: ["pc402-core", "@ton/ton", "@ton/core", "@ton/crypto"],
});
