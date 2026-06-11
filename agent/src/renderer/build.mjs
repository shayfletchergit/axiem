import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/renderer/app.ts"],
  outfile: "dist/renderer/app.js",
  bundle: true,
  minify: true,
  target: "chrome120",
});

console.log("Renderer built.");
