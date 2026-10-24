import { cp, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("static", "dist", { recursive: true });

const options = {
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
