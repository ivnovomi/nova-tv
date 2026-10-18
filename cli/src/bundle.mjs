// src/index.ts and the SDK into the single script NOVA's plugin host runs.

import { build } from "rolldown";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError, sdkAlias } from "./project.mjs";

/**
 * Bundles the plugin into `out` (default: the manifest's "main").
 * `minify`: light but readable, for packages; off for `nova dev`, so errors
 * point at the code as written.
 */
export async function bundle(dir, manifest, { minify = false, out = join(dir, manifest.main) } = {}) {
  const input = join(dir, "src", "index.ts");
  if (!existsSync(input)) throw new CliError(`Falta ${join("src", "index.ts")}: es donde empieza el plugin.`);
  await build({
    input,
    resolve: { alias: sdkAlias(dir) },
    // No Node or browser APIs exist in the plugin sandbox: everything goes through the SDK.
    platform: "neutral",
    logLevel: "silent",
    output: {
      file: out,
      // The plugin registers itself through defineProvider(); the export just gets a name.
      format: "iife",
      name: "__novaBundle",
      // Unused code, comments and dead branches go; names, lines and indentation
      // stay, so a reviewer can read the package as it is.
      minify: minify ? { compress: { target: "es2020" }, mangle: false, codegen: { removeWhitespace: false } } : false,
      comments: minify ? { legal: true, annotation: false, jsdoc: false } : undefined,
    },
  });
  return out;
}
