import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "fs";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  minify: !watch,
  target: "chrome120",
  logLevel: "info",
};

const builds = [
  { entryPoints: ["src/background.ts"],       outfile: "dist/background.js",    format: "esm"  },
  { entryPoints: ["src/content.ts"],          outfile: "dist/content.js",       format: "iife" },
  { entryPoints: ["src/injected.ts"],         outfile: "dist/injected.js",      format: "iife" },
  { entryPoints: ["src/popup/popup.ts"],      outfile: "dist/popup/popup.js",   format: "iife" },
];

mkdirSync("dist/popup", { recursive: true });

// Copy static files
cpSync("manifest.json",          "dist/manifest.json");
cpSync("src/popup/index.html",   "dist/popup/index.html");
try { cpSync("icons", "dist/icons", { recursive: true }); } catch {}

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context({ ...shared, ...b })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("Watching for changes…");
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...shared, ...b })));
  console.log("Extension built → dist/");
}
