// Bundles dk into one file: dist/dk.mjs (Node 18+, no node_modules needed next to it).
import { build } from "esbuild";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/dk.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: { __DK_VERSION__: JSON.stringify(pkg.version) },
  // Bundled CommonJS packages (adm-zip, …) call require() for Node's own modules.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __dkRequire } from 'node:module';\nconst require = __dkRequire(import.meta.url);" },
  logLevel: "info",
});
fs.chmodSync("dist/dk.mjs", 0o755);
