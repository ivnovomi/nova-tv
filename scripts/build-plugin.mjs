// Builds a NOVA plugin: bundles src/index.ts and the SDK into the single
// script the manifest's "main" points to (what NOVA's plugin host runs).
//
//   npm run plugin:build -- plugins/twitch
//
// This is the core of what `nova pack` will be in @novatv/cli.

import { build } from "rolldown";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir || !existsSync(join(dir, "nova-plugin.json"))) {
  console.error("Uso: npm run plugin:build -- plugins/<carpeta>   (con su nova-plugin.json)");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dir, "nova-plugin.json"), "utf8"));
const entry = join(dir, "src", "index.ts");
if (!existsSync(entry)) {
  console.error(`Falta ${entry}`);
  process.exit(1);
}
if (typeof manifest.main !== "string" || manifest.main.includes("..")) {
  console.error("nova-plugin.json: «main» tiene que ser una ruta dentro del plugin (dist/index.js)");
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

const kb = (statSync(out).size / 1024).toFixed(1);
console.log(`✓ ${manifest.name} ${manifest.version} → ${manifest.main} (${kb} KB)`);
