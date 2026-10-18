// nova validate: everything NOVA (and the store's review) checks, before
// anyone installs the plugin.
//
// 1. the manifest, with NOVA's own rules;
// 2. the files it names (code, icon, app);
// 3. the code: it's built and run in an empty sandbox (no network, nothing)
//    to see what it provides, which must match the permissions it asks for;
// 4. the types, if the project has TypeScript and a tsconfig.json.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import { bundle } from "./bundle.mjs";
import { checkManifest } from "./manifest.mjs";
import { c, CliError, loadProject } from "./project.mjs";

const PARTS = ["channels", "guide", "rows", "search", "screensaver", "account"];

/** What the code provides, run with a host that refuses everything. */
function probe(code) {
  const refuse = () => {
    throw new Error("al validar no hay red ni datos: no llames al SDK al cargar el plugin, solo dentro de sus funciones");
  };
  const nova = { api: 1, http: refuse, storageGet: refuse, storageSet: refuse, storageDelete: refuse, secretGet: refuse, secretSet: refuse, secretDelete: refuse, setting: refuse, location: refuse, notify: refuse, log() {} };
  const sandbox = { __nova: nova, console: { log() {}, info() {}, warn() {}, error() {} } };
  vm.runInNewContext(code, sandbox, { timeout: 2000, filename: "plugin.js" });
  const plugin = sandbox.__novaPlugin;
  if (!plugin || typeof plugin !== "object") throw new Error("el código no llama a defineProvider()");
  return Object.fromEntries(
    Object.entries(plugin)
      .filter(([, v]) => v && typeof v === "object")
      .map(([k, v]) => [k, Object.keys(v).filter((f) => typeof v[f] === "function")]),
  );
}

/**
 * Checks the plugin; returns { errors, warnings }. With `print`, reports them.
 *
 * The code runs in node:vm, which keeps it away from the SDK's services but is
 * NOT a security boundary: it's for the developer's own plugin. The store's
 * review runs untrusted packages in NOVA's real sandbox instead.
 */
export async function validate(dir, manifest, { print = true, types = true } = {}) {
  const errors = checkManifest(manifest);
  const warnings = [];

  if (manifest.icon) {
    const icon = join(dir, manifest.icon);
    if (!existsSync(icon)) errors.push(`no encuentro el icono (${manifest.icon})`);
    else if (statSync(icon).size > 512 * 1024) errors.push(`${manifest.icon} pesa más de 512 KB y NOVA no lo mostraría (256×256 basta)`);
    else if (!/\.(png|jpe?g|webp)$/i.test(manifest.icon)) errors.push("el icono tiene que ser PNG, JPEG o WebP");
  } else warnings.push("sin «icon»: NOVA enseñará uno genérico");
  if (manifest.app && !existsSync(join(dir, manifest.app))) errors.push(`no encuentro la app (${manifest.app})`);

  if (Array.isArray(manifest.kind) && manifest.kind.includes("provider") && typeof manifest.main === "string") {
    const temp = mkdtempSync(join(tmpdir(), "nova-validate-"));
    try {
      const out = await bundle(dir, manifest, { minify: true, out: join(temp, "index.js") });
      const code = readFileSync(out, "utf8");
      const parts = probe(code);
      const perms = manifest.permissions ?? {};
      for (const part of Object.keys(parts)) {
        if (!PARTS.includes(part)) continue;
        if (!perms[part]) errors.push(`aporta «${part}» pero no pide ese permiso (NOVA no lo arrancaría)`);
      }
      for (const part of PARTS) if (part !== "account" && perms[part] && !parts[part]) warnings.push(`pide el permiso «${part}» pero no lo usa: quítalo (pide solo lo que necesitas)`);
      // The minified bundle keeps only the SDK functions the plugin calls.
      if (code.includes("host().notify(") && !perms.notify) errors.push("usa notify() pero no pide el permiso «notify»");
      if (code.includes("host().location(") && !perms.location) errors.push("usa location.get() pero no pide el permiso «location»");
      if (/host\(\)\.secret(Get|Set|Delete)\(/.test(code) && !perms.account) errors.push("usa secrets (o deviceLogin) pero no pide el permiso «account»");
      if (perms.account && !parts.account) errors.push("pide «account» pero no tiene la parte account (con deviceLogin: account: miLogin.account)");
      if (code.includes("host().http(") && !perms.network?.length) errors.push("usa http pero «permissions.network» no tiene ningún dominio");
      if (perms.network?.length && !code.includes("host().http(") && !code.includes("https://")) warnings.push("pide red («network») pero no parece usarla");
      if (perms.guide && !perms.channels) warnings.push("tiene guía sin canales: la guía solo sale para los canales del propio plugin");
    } catch (e) {
      if (e instanceof CliError) throw e;
      errors.push(`el código no carga: ${e.message ?? e}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  if (types && existsSync(join(dir, "tsconfig.json"))) {
    let tsc;
    try {
      tsc = createRequire(join(dir, "package.json")).resolve("typescript/bin/tsc");
    } catch {
      warnings.push("no compruebo los tipos: instala typescript en el proyecto (npm install -D typescript)");
    }
    if (tsc) {
      const run = spawnSync(process.execPath, [tsc, "-p", dir, "--noEmit", "--pretty", "false"], { encoding: "utf8" });
      if (run.status !== 0) errors.push(`errores de tipos:\n${(run.stdout || run.stderr).trim().split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }

  if (print) {
    for (const e of errors) console.log(`  ${c.red("✗")} ${e}`);
    for (const w of warnings) console.log(`  ${c.yellow("!")} ${w}`);
    if (!errors.length) console.log(`  ${c.green("✓")} ${manifest.name} ${manifest.version}: NOVA lo aceptaría${warnings.length ? " (mira los avisos)" : ""}`);
  }
  return { errors, warnings };
}

export async function validateCommand(args) {
  const { dir, manifest } = loadProject(args[0]);
  const { errors } = await validate(dir, manifest);
  return errors.length ? 1 : 0;
}
