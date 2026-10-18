#!/usr/bin/env node
// nova: the command line for NOVA TV plugins.

import { readFileSync } from "node:fs";
import { c, CliError } from "../src/project.mjs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const COMMANDS = {
  create: { run: () => import("../src/create.mjs").then((m) => m.createCommand), help: "[carpeta]   Crea un plugin nuevo (pregunta lo necesario; --yes para no preguntar)" },
  dev: { run: () => import("../src/dev.mjs").then((m) => m.devCommand), help: "[carpeta]      Lo carga en el NOVA abierto y lo recarga cada vez que guardas" },
  test: { run: () => import("../src/test.mjs").then((m) => m.testCommand), help: "[carpeta]     Pasa sus pruebas (test/*.test.ts) en un NOVA de mentira" },
  validate: { run: () => import("../src/validate.mjs").then((m) => m.validateCommand), help: "[carpeta] Comprueba lo que NOVA y la tienda revisan, sin empaquetar" },
  pack: { run: () => import("../src/pack.mjs").then((m) => m.packCommand), help: "[carpeta]     Lo valida y empaqueta como dist/<id>-<versión>.novapkg" },
};

function help() {
  console.log(`${c.bold("nova")} ${c.dim(version)} · plugins para NOVA TV

Uso: nova <comando> [carpeta del plugin]   ${c.dim("(sin carpeta: la actual)")}

${Object.entries(COMMANDS)
  .map(([name, cmd]) => `  ${c.cyan(name)} ${cmd.help}`)
  .join("\n")}

Opciones de create: --name, --author, --id, --parts channels,rows,search,screensaver,
                    --domain api.ejemplo.es, --audience everyone|adults, --yes
Opciones de pack:   --no-types (no comprueba los tipos)

Guía del SDK: https://github.com/ivnovomi/nova-plugins`);
}

const [name, ...args] = process.argv.slice(2);
if (!name || name === "help" || name === "--help" || name === "-h") {
  help();
} else if (name === "--version" || name === "-v") {
  console.log(version);
} else if (!(name in COMMANDS)) {
  console.error(`${c.red("✗")} No existe «${name}».\n`);
  help();
  process.exit(1);
} else {
  try {
    const command = await COMMANDS[name].run();
    process.exitCode = await command(args);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`${c.red("✗")} ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  }
}
