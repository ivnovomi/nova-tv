// nova test: runs the plugin's tests (test/*.test.ts) in Node, against the
// pretend NOVA of @novatv/sdk/testing. Each test file is bundled with the SDK
// and the plugin into a temporary folder (deleted afterwards) and run with
// Node's own test runner.

import { build } from "rolldown";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CliError, loadProject, sdkAlias } from "./project.mjs";

export async function testCommand(args) {
  const { dir } = loadProject(args[0]);
  const folder = join(dir, "test");
  const tests = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".test.ts")) : [];
  if (!tests.length) throw new CliError("No hay pruebas: crea test/algo.test.ts (mira la guía del SDK, «Probar tu plugin»).");

  const out = mkdtempSync(join(tmpdir(), "nova-test-"));
  try {
    const files = [];
    for (const test of tests) {
      const file = join(out, test.replace(/\.ts$/, ".mjs"));
      await build({
        input: join(folder, test),
        resolve: { alias: sdkAlias(dir) },
        platform: "node",
        logLevel: "warn",
        output: { file, format: "esm", codeSplitting: false },
      });
      files.push(file);
    }
    return spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }).status ?? 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
