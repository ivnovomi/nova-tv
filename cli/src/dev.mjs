// nova dev: runs the plugin inside the NOVA open on this computer, straight
// from its folder, and reloads it every time you save.
//
// 1. builds src/index.ts into the manifest's "main" (again on every change);
// 2. links the folder to NOVA (plugins-dev/<id>.json in NOVA's data folder) and
//    keeps the link alive while this runs. NOVA, in developer mode, loads the
//    plugin from here and reloads it when the code or the manifest change
//    (src-tauri/src/plugins/dev.rs);
// 3. shows the plugin's log, and NOVA's messages about it, here.
//
// Ctrl+C removes the link, and NOVA undoes everything the plugin brought.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, openSync, readSync, closeSync, utimesSync, watch } from "node:fs";
import { join } from "node:path";
import { bundle } from "./bundle.mjs";
import { checkManifest } from "./manifest.mjs";
import { c, CliError, loadProject, novaDataDir } from "./project.mjs";

const time = (at = Date.now()) => new Date(at).toLocaleTimeString("es-ES");
const tone = { error: c.red, warn: c.yellow, nova: c.cyan, ok: c.green };
const say = (kind, text, at) => console.log(`${c.dim(time(at))} ${(tone[kind] ?? String)(text)}`);

export async function devCommand(args) {
  const { dir, manifest: first } = loadProject(args[0]);
  const problems = checkManifest(first);
  if (problems.length) throw new CliError(`nova-plugin.json tiene errores:\n${problems.map((p) => `  ✗ ${p}`).join("\n")}`);
  const id = first.id;

  const nova = novaDataDir();
  if (!existsSync(nova)) throw new CliError("No encuentro NOVA en este equipo: ábrelo una vez y vuelve a probar.");
  const devDir = join(nova, "plugins-dev");
  const link = join(devDir, `${id}.json`);
  const log = join(devDir, `${id}.log`);

  // ───── 1. Build ─────
  let building = false;
  let again = false;
  const rebuild = async () => {
    if (building) return void (again = true);
    building = true;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "nova-plugin.json"), "utf8"));
      const wrong = checkManifest(manifest);
      if (manifest.id !== id) say("error", `Has cambiado el id a «${manifest.id}»: cierra (Ctrl+C) y vuelve a lanzar nova dev.`);
      else if (wrong.length) say("error", `nova-plugin.json:\n${wrong.map((p) => `  ✗ ${p}`).join("\n")}`);
      else {
        await bundle(dir, manifest);
        say("ok", "✓ Compilado");
      }
    } catch (e) {
      say("error", `✗ No compila:\n${e?.message ?? e}`);
    } finally {
      building = false;
      if (again) {
        again = false;
        void rebuild();
      }
    }
  };

  // ───── 2. Link to NOVA ─────
  const writeLink = () => {
    mkdirSync(devDir, { recursive: true });
    writeFileSync(link, JSON.stringify({ dir }));
    if (!existsSync(log)) writeFileSync(log, "");
  };
  const cleanup = () => {
    rmSync(link, { force: true });
    rmSync(log, { force: true });
  };

  console.log(`${c.cyan("nova dev")} · ${first.name} (${id})`);
  await rebuild();
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
    timer = setTimeout(rebuild, 150);
  };
  watch(join(dir, "src"), { recursive: true }, changed);
  watch(join(dir, "nova-plugin.json"), changed);

  // ───── 3. The plugin's log ─────
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
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    offset += Buffer.byteLength(complete);
    for (const raw of complete.split("\n").filter(Boolean)) {
      heard = true;
      try {
        const line = JSON.parse(raw);
        say(line.level, line.level === "info" ? `  ${line.message}` : `${line.level === "nova" ? "NOVA" : line.level}: ${line.message}`, line.at * 1000);
      } catch {
        /* not a line of ours */
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
  // Runs until Ctrl+C.
  return new Promise(() => {});
}
