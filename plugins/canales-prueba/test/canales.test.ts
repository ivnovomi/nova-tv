// Pruebas del plugin sin abrir NOVA:  npm run nova -- test plugins/canales-prueba
//
// testPlugin() monta un NOVA de mentira con las mismas reglas que el de verdad
// y revisa lo que devuelve el plugin: lo que NOVA descartaría sale en `problems`.

import { testPlugin, test, assert } from "@novatv/sdk/testing";
import manifest from "../nova-plugin.json";
import plugin from "../src/index";

const LISTA = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nbajo.m3u8\n";

// offline: ninguna petición sale a internet; las respuestas son las de `mock`.
const nova = testPlugin(manifest, plugin, {
  offline: true,
  print: false,
  mock: {
    "https://devstreaming-cdn.apple.com/*": LISTA,
    "https://test-streams.mux.dev/*": { status: 404, body: "" },
  },
});

test("da dos canales válidos", async () => {
  const canales = await nova.channels();
  assert.deepEqual(canales.map((c) => c.id), ["bipbop", "mux"]);
  assert.deepEqual(nova.problems, []);
});

test("pide la emisión de Mux al reproducir, con proxy", async () => {
  const stream = await nova.stream("mux");
  assert.deepEqual(stream, { type: "hls", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", proxy: true });
  assert.ok(nova.logs.some((l) => l.message.includes("mux")));
});

test("comprueba la señal preguntando a la lista", async () => {
  assert.equal(await nova.check("bipbop"), true);
  assert.equal(await nova.check("mux"), false); // el mock responde 404
});

test("la guía cubre las próximas 6 horas sin huecos", async () => {
  const guia = await nova.guide();
  assert.deepEqual(Object.keys(guia), ["bipbop", "mux"]);
  for (const programas of Object.values(guia)) {
    programas.slice(1).forEach((p, i) => assert.equal(p.start, programas[i].end));
  }
  assert.deepEqual(nova.problems, []);
});

test("no tiene filas en Para ti (no pide ese permiso)", async () => {
  await assert.rejects(nova.rows(), /permiso «rows»/);
});
