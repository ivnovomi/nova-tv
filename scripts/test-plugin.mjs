// Runs a NOVA plugin's tests in Node, against the pretend NOVA of
// @novatv/sdk/testing:
//
//   npm run plugin:test -- plugins/canales-prueba
//
// Each test/*.test.ts is bundled (with the SDK and the plugin) into a temporary
// folder and run with Node's own test runner (`node:test`). The folder is
// deleted afterwards.
//
// This is the core of what `nova test` will be in @novatv/cli.

import { build } from "rolldown";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dir = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dir || !existsSync(join(dir, "nova-plugin.json"))) {
  console.error("Uso: npm run plugin:test -- plugins/<carpeta>   (con su nova-plugin.json)");
  process.exit(1);
}
const tests = existsSync(join(dir, "test")) ? readdirSync(join(dir, "test")).filter((f) => f.endsWith(".test.ts")) : [];
if (!tests.length) {
  console.error(`No hay pruebas: crea ${join(basename(dir), "test", "algo.test.ts")}`);
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "nova-plugin-test-"));
let status = 1;
try {
  const files = [];
  for (const test of tests) {
    const file = join(out, test.replace(/\.ts$/, ".mjs"));
    await build({
      input: join(dir, "test", test),
      resolve: {
        alias: {
          "@novatv/sdk/testing": join(root, "sdk", "src", "testing.ts"),
          "@novatv/sdk": join(root, "sdk", "src", "index.ts"),
        },
      },
      platform: "node",
      logLevel: "warn",
      output: { file, format: "esm", codeSplitting: false },
    });
    files.push(file);
  }
  status = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }).status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(status);
