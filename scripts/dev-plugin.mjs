// `nova dev`: runs a plugin inside the NOVA open on this computer, straight from
// its folder, and reloads it every time you save:
//
//   npm run plugin:dev -- plugins/mi-plugin
//
// 1. bundles src/index.ts into the manifest's "main" (again on every change);
// 2. links the folder to NOVA (plugins-dev/<id>.json in NOVA's data folder) and
//    keeps the link alive while this runs. NOVA, in developer mode, loads the
//    plugin from here and reloads it when the code or the manifest change;
// 3. shows the plugin's log (and NOVA's messages about it) here.
//
// Ctrl+C removes the link, and NOVA undoes everything the plugin brought.
//
// This is the core of what `nova dev` will be in @novatv/cli.

import { build } from "rolldown";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, openSync, readSync, closeSync, utimesSync, watch } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir || !existsSync(join(dir, "nova-plugin.json"))) {
  console.error("Uso: npm run plugin:dev -- plugins/<carpeta>   (con su nova-plugin.json)");
  process.exit(1);
}

const color = { error: "\x1b[31m", warn: "\x1b[33m", nova: "\x1b[36m", ok: "\x1b[32m", dim: "\x1b[2m", off: "\x1b[0m" };
const time = (at = Date.now()) => new Date(at).toLocaleTimeString("es-ES");
const say = (kind, text, at) => console.log(`${color.dim}${time(at)}${color.off} ${color[kind] ?? ""}${text}${color.off}`);

const readManifest = () => JSON.parse(readFileSync(join(dir, "nova-plugin.json"), "utf8"));
let manifest = readManifest();
const id = manifest.id;

// NOVA's data folder (Tauri's app_local_data_dir for com.ivnov.novatv).
const nova = join(process.env.LOCALAPPDATA ?? "", "com.ivnov.novatv");
if (!existsSync(nova)) {
  console.error("No encuentro NOVA en este equipo: ábrelo una vez y vuelve a probar.");
  process.exit(1);
}
const devDir = join(nova, "plugins-dev");
const link = join(devDir, `${id}.json`);
const log = join(devDir, `${id}.log`);

// ───────────────────────── 1. Build ─────────────────────────

let building = false;
let again = false;
async function bundle() {
  if (building) return void (again = true);
  building = true;
  try {
    manifest = readManifest();
    if (manifest.id !== id) say("error", `Has cambiado el id a «${manifest.id}»: cierra (Ctrl+C) y vuelve a lanzar nova dev.`);
    await build({
      input: join(dir, "src", "index.ts"),
      resolve: { alias: { "@novatv/sdk": join(root, "sdk", "src", "index.ts") } },
      platform: "neutral",
      logLevel: "silent",
      output: { file: join(dir, manifest.main), format: "iife", name: "__novaBundle" },
    });
    say("ok", "✓ Compilado");
  } catch (e) {
    say("error", `✗ No compila:\n${e?.message ?? e}`);
  } finally {
    building = false;
    if (again) {
      again = false;
      void bundle();
    }
  }
}

// ───────────────────────── 2. Link to NOVA ─────────────────────────

function writeLink() {
  mkdirSync(devDir, { recursive: true });
  writeFileSync(link, JSON.stringify({ dir }));
  if (!existsSync(log)) writeFileSync(log, "");
}

function cleanup() {
  rmSync(link, { force: true });
  rmSync(log, { force: true });
}

console.log(`${color.nova}nova dev${color.off} · ${manifest.name} (${id})`);
await bundle();
mkdirSync(devDir, { recursive: true });
writeFileSync(log, "");
writeLink();

// Keeps the link alive (NOVA drops links not touched for 20 s).
setInterval(() => {
  try {
    const now = new Date();
    utimesSync(link, now, now);
  } catch {
    writeLink(); // NOVA removed it (e.g. the computer slept): link again.
  }
}, 5000);

// Rebuild on save (a short pause groups an editor's several writes).
let timer;
const changed = () => {
  clearTimeout(timer);
  timer = setTimeout(bundle, 150);
};
watch(join(dir, "src"), { recursive: true }, changed);
watch(join(dir, "nova-plugin.json"), changed);

// ───────────────────────── 3. The plugin's log ─────────────────────────

let offset = 0;
let heard = false;
setInterval(() => {
  let size;
  try {
    size = statSync(log).size;
  } catch {
    return;
  }
  if (size < offset) offset = 0;
  if (size === offset) return;
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(log, "r");
  readSync(fd, buffer, 0, buffer.length, offset);
  closeSync(fd);
  const text = buffer.toString("utf8");
  const complete = text.lastIndexOf("\n") + 1;
  offset += Buffer.byteLength(text.slice(0, complete));
  for (const raw of text.slice(0, complete).split("\n").filter(Boolean)) {
    heard = true;
    try {
      const line = JSON.parse(raw);
      say(line.level, line.level === "info" ? `  ${line.message}` : `${line.level === "nova" ? "NOVA" : line.level}: ${line.message}`, line.at * 1000);
    } catch {
      /* half-written line: it'll be complete next time */
    }
  }
}, 300);

setTimeout(() => {
  if (!heard) say("warn", "NOVA aún no ha respondido: ¿está abierto? (se carga solo en cuanto lo abras)");
}, 6000);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    say("nova", "Fuera de NOVA: todo lo que trajo el plugin se ha deshecho.");
    process.exit(0);
  });
}
process.on("exit", cleanup);
