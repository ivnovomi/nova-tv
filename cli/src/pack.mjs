// nova pack: validates the plugin, builds it (minified but readable) and packs
// it as dist/<id>-<version>.novapkg, ready to install in NOVA.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { bundle } from "./bundle.mjs";
import { zip } from "./novapkg.mjs";
import { validate } from "./validate.mjs";
import { c, CliError, kb, loadProject } from "./project.mjs";

// System and editor leftovers never go in a package.
const junk = (path) => path.split("/").some((part) => part.startsWith(".") || /^(thumbs\.db|desktop\.ini)$/i.test(part)) || /\.(map|ts|tsx|log)$/i.test(path);

/** Each file as it goes in the package: JSON without spaces (and the manifest without the editor's "$schema"). */
function content(dir, path) {
  const data = readFileSync(join(dir, path));
  if (!path.endsWith(".json")) return data;
  try {
    const json = JSON.parse(data.toString("utf8"));
    if (path === "nova-plugin.json") delete json.$schema;
    return Buffer.from(JSON.stringify(json));
  } catch {
    return data;
  }
}

export async function packCommand(args) {
  const { dir, manifest } = loadProject(args[0]);
  console.log(c.cyan(`nova pack · ${manifest.name ?? manifest.id}`));
  const { errors } = await validate(dir, manifest, { types: !args.includes("--no-types") });
  if (errors.length) throw new CliError("No se empaqueta hasta que se arreglen los errores de arriba.");

  // 1. The code.
  const out = manifest.kind.includes("provider") ? await bundle(dir, manifest, { minify: true }) : null;

  // 2. The package.
  const files = new Set(["nova-plugin.json"]);
  if (out) files.add(manifest.main);
  if (manifest.icon) files.add(manifest.icon);
  if (existsSync(join(dir, "LICENSE"))) files.add("LICENSE");
  const walk = (folder) => {
    if (!existsSync(join(dir, folder))) return;
    for (const item of readdirSync(join(dir, folder), { recursive: true, withFileTypes: true })) {
      const path = relative(dir, join(item.parentPath, item.name)).replaceAll("\\", "/");
      if (item.isFile() && !junk(path)) files.add(path);
    }
  };
  if (manifest.app) walk(manifest.app.split("/")[0]);
  walk("assets");

  const entries = [...files].map((path) => ({ path: path.replaceAll("\\", "/"), data: content(dir, path) }));
  mkdirSync(join(dir, "dist"), { recursive: true });
  const pkg = join(dir, "dist", `${manifest.id}-${manifest.version}.novapkg`);
  writeFileSync(pkg, zip(entries));

  const unpacked = entries.reduce((n, e) => n + e.data.length, 0);
  const bytes = readFileSync(pkg);
  if (out) console.log(`  código   ${manifest.main} (${kb(statSync(out).size)}, minificado y legible)`);
  console.log(`  paquete  ${relative(process.cwd(), pkg)} (${kb(bytes.length)}; ${kb(unpacked)} instalado, ${files.size} archivos)`);
  // What the store's catalogue needs for this version (docs/plugins/store.md).
  console.log(c.dim(`  tienda   "size": ${bytes.length}, "sha256": "${createHash("sha256").update(bytes).digest("hex")}"`));
  for (const f of files) {
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(f) && statSync(join(dir, f)).size > 1024 * 1024) console.log(`  ${c.yellow("!")} ${f} pesa más de 1 MB: cada tele que lo instale lo descarga entero.`);
  }
  console.log(c.green("✓ Listo para instalar en NOVA (Ajustes → Plugins → Instalar .novapkg)"));
  return 0;
}
