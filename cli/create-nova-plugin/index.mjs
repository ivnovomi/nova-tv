#!/usr/bin/env node
// npm create nova-plugin [carpeta] → nova create [carpeta]

import { createCommand } from "@novatv/cli/create";

try {
  process.exitCode = await createCommand(process.argv.slice(2));
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
}
