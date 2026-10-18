// Builds a NOVA plugin and packs it as a .novapkg:
// 1. bundles src/index.ts and the SDK into the single script the manifest's
//    "main" points to (what NOVA's plugin host runs);
// 2. packs the manifest, that script, the icon, app/, assets/ and LICENSE into
//    dist/<id>-<version>.novapkg, ready to install in NOVA.
//
//   npm run plugin:build -- plugins/twitch
//
// This is the core of what `nova pack` will be in @novatv/cli.

import { build } from "rolldown";
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { zip } from "./novapkg.mjs";

const root = resolve(import.meta.dirname, "..");
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir || !existsSync(join(dir, "nova-plugin.json"))) {
  console.error("Uso: npm run plugin:build -- plugins/<carpeta>   (con su nova-plugin.json)");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dir, "nova-plugin.json"), "utf8"));
const inside = (p) => typeof p === "string" && !p.includes("..") && !/^[\\/]|:/.test(p);
if (!inside(manifest.main) || (manifest.icon && !inside(manifest.icon)) || (manifest.app && !inside(manifest.app))) {
  console.error("nova-plugin.json: «main», «icon» y «app» tienen que ser rutas dentro del plugin");
  process.exit(1);
}

// 1. The code.
const entry = join(dir, "src", "index.ts");
if (!existsSync(entry)) {
  console.error(`Falta ${entry}`);
  process.exit(1);
}
const out = join(dir, manifest.main);
await build({
  input: entry,
  resolve: { alias: { "@novatv/sdk": join(root, "sdk", "src", "index.ts") } },
  // No Node or browser APIs exist in the plugin sandbox: everything goes through the SDK.
  platform: "neutral",
  logLevel: "warn",
  // The plugin registers itself through defineProvider(); the export just gets a name.
  output: { file: out, format: "iife", name: "__novaBundle", minify: false },
});

// 2. The package.
const files = new Set(["nova-plugin.json", manifest.main]);
if (manifest.icon) files.add(manifest.icon);
if (existsSync(join(dir, "LICENSE"))) files.add("LICENSE");
const walk = (folder) => {
  if (!existsSync(join(dir, folder))) return;
  for (const item of readdirSync(join(dir, folder), { recursive: true, withFileTypes: true })) {
    if (item.isFile()) files.add(relative(dir, join(item.parentPath, item.name)).replaceAll("\\", "/"));
  }
};
if (manifest.app) walk(manifest.app.split("/")[0]);
walk("assets");

const missing = [...files].filter((f) => !existsSync(join(dir, f)));
if (missing.length) {
  console.error(`Faltan archivos del paquete: ${missing.join(", ")}`);
  process.exit(1);
}
const pkg = join(dir, "dist", `${manifest.id}-${manifest.version}.novapkg`);
writeFileSync(pkg, zip([...files].map((path) => ({ path: path.replaceAll("\\", "/"), data: readFileSync(join(dir, path)) }))));

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`✓ ${manifest.name} ${manifest.version}`);
console.log(`  código   ${manifest.main} (${kb(out)} KB)`);
console.log(`  paquete  dist/${manifest.id}-${manifest.version}.novapkg (${kb(pkg)} KB, ${files.size} archivos)`);
