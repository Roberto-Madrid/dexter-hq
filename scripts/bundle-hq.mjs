import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const outfile = "app/generated/hq.js";
mkdirSync(dirname(outfile), { recursive: true });

const inlineAssets = {
  name: "inline-assets",
  setup(build) {
    build.onLoad({ filter: /hq\/bundled-assets\.ts$/ }, () => {
      const roleSheet = readFileSync("gateway/role-sheet.yaml", "utf8");
      const crews = {};
      for (const name of readdirSync("crews")) {
        if (!name.endsWith(".yaml")) continue;
        crews[name] = readFileSync(join("crews", name), "utf8");
      }
      const personas = {};
      for (const name of readdirSync("personas")) {
        if (!name.endsWith(".md")) continue;
        personas[name] = readFileSync(join("personas", name), "utf8");
      }
      return {
        loader: "ts",
        contents: `export function bundledRoleSheet(){return ${JSON.stringify(roleSheet)};}export function bundledCrews(){return ${JSON.stringify(crews)};}export function bundledPersonas(){return ${JSON.stringify(personas)};}`,
      };
    });
  },
};

await esbuild.build({
  entryPoints: ["hq/server.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile,
  plugins: [inlineAssets],
  logLevel: "warning",
});
