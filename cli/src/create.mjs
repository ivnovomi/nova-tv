// nova create: a new plugin, ready to run with `nova dev` and to test with
// `nova test`. Asks a few questions (or takes them as options) and writes the
// manifest, the code for the parts chosen, tests for them and an icon.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { deflateSync, crc32 } from "node:zlib";
import { validId } from "./manifest.mjs";
import { c, CliError, sdkAlias } from "./project.mjs";

const PARTS = {
  channels: "canales en directo (con su guía)",
  rows: "filas en «Para ti»",
  search: "resultados en la búsqueda",
  screensaver: "fondos del salvapantallas",
};

const slug = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `--name "Mi plugin" --parts rows,search --yes` → { name, parts, yes }. */
function options(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a === "--yes" || a === "-y") out.yes = true;
    else out[a.slice(2)] = args[++i];
  }
  return out;
}

// ───────────────────────── The icon ─────────────────────────

/** A 256×256 PNG: NOVA's violet gradient, so the plugin has an icon from day one. */
function icon() {
  const size = 256;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const r = Math.round(0x6e + (0x9a - 0x6e) * t);
      const g = Math.round(0x6c + (0x6b - 0x6c) * t);
      const corner = Math.min(x, y, size - 1 - x, size - 1 - y);
      row.writeUInt32BE(((r << 24) | (g << 16) | (0xff << 8) | (corner < 2 ? 0x80 : 0xff)) >>> 0, 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ───────────────────────── The code ─────────────────────────

function code(parts, domain) {
  const items = parts.includes("rows") || parts.includes("search");
  const imports = ["defineProvider", "http", ...(parts.includes("channels") ? ["log", "type Channel", "type Program"] : []), ...(items ? ["type Item"] : [])];
  const blocks = [];
  if (parts.includes("channels")) {
    blocks.push(`  // Canales en directo. NOVA les da números de tu bloque (5001, 5002…).
  channels: {
    refresh: "6h",
    async load() {
      const lista = await http.json<CanalApi[]>(\`\${API}/canales\`);
      log.info("Cargados", lista.length, "canales");
      return lista.map(
        (canal): Channel => ({
          id: canal.id,
          name: canal.nombre,
          logo: canal.logo,
          group: "Mis canales",
          stream: { type: "hls", url: canal.emision },
        }),
      );
    },
  },

  // Su programación, entre \`from\` y \`to\` (segundos Unix).
  guide: {
    refresh: "1h",
    async load(ids, { from, to }) {
      const guia = await http.json<Record<string, ProgramaApi[]>>(\`\${API}/guia?desde=\${from}&hasta=\${to}\`);
      const programas: Record<string, Program[]> = {};
      for (const id of ids) {
        programas[id] = (guia[id] ?? []).map((p) => ({ start: p.inicio, end: p.fin, title: p.titulo }));
      }
      return programas;
    },
  },`);
  }
  if (parts.includes("rows")) {
    blocks.push(`  // Filas en «Para ti» (como mucho 5, de hasta 40 elementos).
  rows: {
    refresh: "30m",
    async load(ctx) {
      const noticias = await http.json<NoticiaApi[]>(\`\${API}/noticias\`);
      const titulo = ctx.profile.kids ? "Para los peques" : "Lo último";
      return [{ title: titulo, style: "landscape", items: noticias.slice(0, 20).map(elemento) }];
    },
  },`);
  }
  if (parts.includes("search")) {
    blocks.push(`  // Resultados en la búsqueda de NOVA.
  search: {
    async search(texto) {
      const resultados = await http.json<NoticiaApi[]>(\`\${API}/buscar?q=\${encodeURIComponent(texto)}\`);
      return resultados.slice(0, 20).map(elemento);
    },
  },`);
  }
  if (parts.includes("screensaver")) {
    blocks.push(`  // Fondos del salvapantallas (imágenes https://).
  screensaver: {
    refresh: "1d",
    async load() {
      const fotos = await http.json<{ url: string }[]>(\`\${API}/fotos\`);
      return fotos.map((f) => f.url);
    },
  },`);
  }

  const types = [];
  if (parts.includes("channels")) {
    types.push(`interface CanalApi {
  id: string;
  nombre: string;
  logo?: string;
  emision: string;
}

interface ProgramaApi {
  inicio: number;
  fin: number;
  titulo: string;
}`);
  }
  if (items) {
    types.push(`interface NoticiaApi {
  id: string;
  titulo: string;
  resumen: string;
  imagen?: string;
}

/** Una noticia como elemento de NOVA: al elegirla, se abre su ficha. */
function elemento(n: NoticiaApi): Item {
  return { id: n.id, title: n.titulo, image: n.imagen, action: { type: "detail", title: n.titulo, text: n.resumen } };
}`);
  }

  return `// Tu plugin para NOVA TV. Guía del SDK: https://github.com/ivnovomi/nova-plugins
//
//   nova dev    lo carga en NOVA y lo recarga cada vez que guardas
//   nova test   pasa sus pruebas (test/) sin abrir NOVA
//   nova pack   lo empaqueta como .novapkg

import { ${imports.join(", ")} } from "@novatv/sdk";

// Cambia esto por tu API (y su dominio en "network" del manifiesto).
const API = "https://${domain}";

${types.join("\n\n")}

export default defineProvider({
${blocks.join("\n\n")}
});
`;
}

function tests(parts, domain) {
  const mocks = [];
  const cases = [];
  if (parts.includes("channels")) {
    mocks.push(`    "https://${domain}/canales": [{ id: "uno", nombre: "Canal Uno", emision: "https://${domain}/uno.m3u8" }],
    "https://${domain}/guia*": { uno: [{ inicio: 1800000000, fin: 1800001800, titulo: "Informativo" }] },`);
    cases.push(`test("da sus canales y su guía sin problemas", async () => {
  const canales = await nova.channels();
  assert.equal(canales[0].name, "Canal Uno");
  assert.deepEqual(nova.problems, []);

  const guia = await nova.guide();
  assert.equal(guia.uno[0].title, "Informativo");
  assert.deepEqual(nova.problems, []);
});`);
  }
  if (parts.includes("rows") || parts.includes("search")) {
    mocks.push(`    "https://${domain}/noticias": [{ id: "1", titulo: "Abre el nuevo metro", resumen: "Desde hoy…", imagen: "https://${domain}/1.jpg" }],
    "https://${domain}/buscar*": [{ id: "2", titulo: "Fútbol: final de liga", resumen: "…" }],`);
  }
  if (parts.includes("rows")) {
    cases.push(`test("una fila en Para ti", async () => {
  const filas = await nova.rows();
  assert.equal(filas[0].items[0].title, "Abre el nuevo metro");
  assert.deepEqual(nova.problems, []);
});

test("otro título en los perfiles infantiles", async () => {
  nova.setProfile({ kids: true });
  const filas = await nova.rows();
  assert.equal(filas[0].title, "Para los peques");
  nova.setProfile({ kids: false });
});`);
  }
  if (parts.includes("search")) {
    cases.push(`test("busca lo que se escribe", async () => {
  const resultados = await nova.search("fútbol");
  assert.equal(resultados.length, 1);
  assert.match(nova.requests[nova.requests.length - 1].url, /q=f%C3%BAtbol/);
});`);
  }
  if (parts.includes("screensaver")) {
    mocks.push(`    "https://${domain}/fotos": [{ url: "https://${domain}/fondo.jpg" }],`);
    cases.push(`test("fondos para el salvapantallas", async () => {
  assert.deepEqual(await nova.screensaver(), ["https://${domain}/fondo.jpg"]);
  assert.deepEqual(nova.problems, []);
});`);
  }
  return `// Pruebas sin abrir NOVA: nova test
// testPlugin() monta un NOVA de mentira con sus mismas reglas; lo que NOVA
// descartaría de tus respuestas aparece en \`nova.problems\`.

import { testPlugin, test, assert } from "@novatv/sdk/testing";
import manifest from "../nova-plugin.json";
import plugin from "../src/index";

const nova = testPlugin(manifest, plugin, {
  offline: true, // nada sale a internet: las respuestas son estas
  print: false,
  mock: {
${mocks.join("\n")}
  },
});

${cases.join("\n\n")}
`;
}

// ───────────────────────── The command ─────────────────────────

export async function createCommand(args) {
  const opt = options(args);
  const interactive = !opt.yes && process.stdin.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question, fallback) => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${c.cyan("?")} ${question} ${c.dim(`(${fallback})`)} `)).trim();
    return answer || fallback;
  };

  try {
    console.log(c.cyan("nova create · un plugin nuevo para NOVA TV\n"));
    const name = (opt.name ?? (await ask("Nombre del plugin:", opt._[0] ? basename(opt._[0]) : "Mi plugin"))).slice(0, 40);
    const author = opt.author ?? (await ask("Tu nombre (o el de tu equipo):", "Yo"));
    let id = opt.id ?? (await ask("Id (dominio invertido, para siempre):", `es.${slug(author) || "yo"}.${slug(name) || "plugin"}`));
    while (!validId(id)) {
      if (!rl) throw new CliError(`«${id}» no vale como id: minúsculas, números y guiones, con tres partes o más (es.tunombre.plugin)`);
      id = await ask(c.yellow("Ese id no vale: minúsculas y tres partes o más. Id:"), `es.${slug(author) || "yo"}.${slug(name) || "plugin"}`);
    }

    let parts = opt.parts?.split(",").map((p) => p.trim());
    if (!parts) {
      const keys = Object.keys(PARTS);
      if (rl) console.log(`\n¿Qué aporta? ${c.dim("(números separados por comas)")}\n${keys.map((k, i) => `  ${i + 1}. ${PARTS[k]}`).join("\n")}`);
      const picked = await ask("Partes:", "2");
      parts = picked.split(/[\s,]+/).map((n) => keys[Number(n) - 1]).filter(Boolean);
    }
    parts = [...new Set(parts)].filter((p) => p in PARTS);
    if (!parts.length) throw new CliError(`Elige al menos una parte: ${Object.keys(PARTS).join(", ")}`);

    const domain = (opt.domain ?? (await ask("Dominio de tu API:", "api.ejemplo.es"))).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const adults = (opt.audience ?? (await ask("¿Solo para adultos? (s/n):", "n"))).toLowerCase().startsWith(opt.audience ? "adults" : "s");

    const dir = resolve(opt._[0] ?? slug(name));
    if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} ya existe y no está vacía.`);

    const permissions = { network: [domain] };
    for (const p of parts) permissions[p] = true;
    if (parts.includes("channels")) permissions.guide = true;
    const manifest = {
      $schema: "https://unpkg.com/@novatv/sdk/schema/nova-plugin.schema.json",
      id,
      name,
      version: "0.1.0",
      api: 1,
      kind: ["provider"],
      main: "dist/index.js",
      icon: "icon.png",
      description: `${name}: ${parts.map((p) => PARTS[p]).join(", ")}.`,
      author: { name: author },
      audience: adults ? "adults" : "everyone",
      permissions,
    };

    // Inside the NOVA repository the plugin builds against sdk/ and shares plugins/tsconfig.json.
    let inRepo = false;
    try {
      inRepo = Object.keys(sdkAlias(dir)).length > 0;
    } catch {
      /* outside: it gets its own package.json */
    }

    const files = {
      "nova-plugin.json": JSON.stringify(manifest, null, 2) + "\n",
      "src/index.ts": code(parts, domain),
      "test/index.test.ts": tests(parts, domain),
      "icon.png": icon(),
    };
    if (!inRepo) {
      files["package.json"] =
        JSON.stringify(
          {
            name: slug(name) || "nova-plugin",
            version: "0.1.0",
            private: true,
            type: "module",
            scripts: { dev: "nova dev", test: "nova test", validate: "nova validate", pack: "nova pack" },
            dependencies: { "@novatv/sdk": "^0.1.0" },
            devDependencies: { "@novatv/cli": "^0.1.0", typescript: "^6.0.0" },
          },
          null,
          2,
        ) + "\n";
      files["tsconfig.json"] =
        JSON.stringify(
          {
            compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2020"], strict: true, noEmit: true, skipLibCheck: true, resolveJsonModule: true },
            include: ["src", "test"],
          },
          null,
          2,
        ) + "\n";
      files[".gitignore"] = "node_modules/\ndist/\n";
    }

    for (const [path, data] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), data);
    }

    const where = relative(process.cwd(), dir) || ".";
    console.log(`\n${c.green("✓")} ${name} creado en ${c.bold(where)}\n`);
    console.log("Ahora:");
    if (!inRepo) console.log(`  cd ${where}\n  npm install`);
    const nova = inRepo ? `npm run nova --` : "npx nova";
    const arg = inRepo ? ` ${where}` : "";
    console.log(`  ${nova} dev${arg}      ${c.dim("lo carga en NOVA (con el modo desarrollador) y lo recarga al guardar")}`);
    console.log(`  ${nova} test${arg}     ${c.dim("pasa sus pruebas sin abrir NOVA")}`);
    console.log(`  ${nova} pack${arg}     ${c.dim("lo empaqueta como .novapkg")}`);
    console.log(`\nEmpieza por ${c.bold("src/index.ts")}: cambia la API de ejemplo por la tuya.`);
    return 0;
  } finally {
    rl?.close();
  }
}
