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
  output: {
    file: out,
    // The plugin registers itself through defineProvider(); the export just gets a name.
    format: "iife",
    name: "__novaBundle",
    // Light but readable, so a reviewer can go through it as it is: unused
    // code, comments and dead branches go; names, lines and indentation stay.
    minify: { compress: { target: "es2020" }, mangle: false, codegen: { removeWhitespace: false } },
    comments: { legal: true, annotation: false, jsdoc: false },
  },
});

// 2. The package.
const files = new Set(["nova-plugin.json", manifest.main]);
if (manifest.icon) files.add(manifest.icon);
if (existsSync(join(dir, "LICENSE"))) files.add("LICENSE");
// System and editor leftovers never go in a package.
const junk = (path) => path.split("/").some((part) => part.startsWith(".") || /^(thumbs\.db|desktop\.ini)$/i.test(part)) || /\.(map|ts|tsx|log)$/i.test(path);
const walk = (folder) => {
  if (!existsSync(join(dir, folder))) return;
  for (const item of readdirSync(join(dir, folder), { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(item.parentPath, item.name)).replaceAll("\\", "/");
    if (item.isFile() && !junk(path)) files.add(path);
  }
};
if (manifest.app) walk(manifest.app.split("/")[0]);
walk("assets");

const missing = [...files].filter((f) => !existsSync(join(dir, f)));
if (missing.length) {
  console.error(`Faltan archivos del paquete: ${missing.join(", ")}`);
  process.exit(1);
}
// NOVA doesn't show icons over 512 KB; big images slow every TV that installs it.
const big = [...files].filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f) && statSync(join(dir, f)).size > 1024 * 1024);
if (manifest.icon && statSync(join(dir, manifest.icon)).size > 512 * 1024) {
  console.error(`${manifest.icon} pesa más de 512 KB y NOVA no lo mostraría: redúcelo (256×256 basta).`);
  process.exit(1);
}

/** Each file as it goes in the package: JSON without spaces (and without the editor's "$schema"). */
const content = (path) => {
  const data = readFileSync(join(dir, path));
  if (!path.endsWith(".json")) return data;
  try {
    const json = JSON.parse(data.toString("utf8"));
    if (path === "nova-plugin.json") delete json.$schema;
    return Buffer.from(JSON.stringify(json));
  } catch {
    return data;
  }
};
const pkg = join(dir, "dist", `${manifest.id}-${manifest.version}.novapkg`);
const entries = [...files].map((path) => ({ path: path.replaceAll("\\", "/"), data: content(path) }));
writeFileSync(pkg, zip(entries));

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const unpacked = entries.reduce((n, e) => n + e.data.length, 0);
console.log(`✓ ${manifest.name} ${manifest.version}`);
console.log(`  código   ${manifest.main} (${kb(statSync(out).size)}, minificado y legible)`);
console.log(`  paquete  dist/${manifest.id}-${manifest.version}.novapkg (${kb(statSync(pkg).size)}; ${kb(unpacked)} instalado, ${files.size} archivos)`);
for (const f of big) console.warn(`  ⚠ ${f} pesa más de 1 MB: cada tele que lo instale lo descarga entero.`);
