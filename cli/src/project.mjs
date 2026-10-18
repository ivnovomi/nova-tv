// What every command shares: finding the plugin, the SDK it builds against,
// NOVA's data folder, and how to talk in the terminal.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** A mistake of the user's: shown without a stack trace. */
export class CliError extends Error {}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const c = { red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), dim: paint(2), bold: paint(1) };

/** The plugin in `arg` (or the current folder): its folder and its manifest. */
export function loadProject(arg) {
  const dir = resolve(arg ?? ".");
  const file = join(dir, "nova-plugin.json");
  if (!existsSync(file)) throw new CliError(`No hay nova-plugin.json en ${dir}. ¿Es la carpeta del plugin? (para empezar uno: nova create)`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError(`nova-plugin.json no es JSON válido: ${e.message}`);
  }
  return { dir, manifest };
}

/**
 * How `@novatv/sdk` resolves for this plugin. Inside the NOVA repository
 * (a parent folder has sdk/ with the SDK's source) it builds against that
 * source; anywhere else, against the @novatv/sdk installed in the project.
 */
export function sdkAlias(dir) {
  for (let at = dir; ; at = dirname(at)) {
    const sdk = join(at, "sdk");
    if (existsSync(join(sdk, "src", "index.ts"))) {
      try {
        if (JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).name === "@novatv/sdk") {
          return { "@novatv/sdk/testing": join(sdk, "src", "testing.ts"), "@novatv/sdk": join(sdk, "src", "index.ts") };
        }
      } catch {
        /* not ours */
      }
    }
    if (dirname(at) === at) break;
  }
  try {
    createRequire(join(dir, "package.json")).resolve("@novatv/sdk");
  } catch {
    throw new CliError("Este plugin no tiene instalado @novatv/sdk: npm install @novatv/sdk");
  }
  return {};
}

/** NOVA's data folder on this computer (Tauri's app_local_data_dir for com.ivnov.novatv). */
export function novaDataDir() {
  const id = "com.ivnov.novatv";
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), id);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", id);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id);
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
