// Ejemplo de canales en directo con @novatv/sdk.
// Usa emisiones públicas de prueba (Apple y Mux), así que funciona sin cuentas.
//
// Enseña las tres formas de dar la emisión de un canal:
//  1. fija y directa: `stream` en el propio canal;
//  2. pedida justo antes de reproducir: `channels.stream(id)` (para direcciones que caducan);
//  3. con proxy: `proxy: true`, para servidores que no dejan leer sus listas a otras webs.
// Y además: la guía (`guide.load`) y la comprobación de señal (`channels.check`).

import { defineProvider, http, log, type Program } from "@novatv/sdk";

const APPLE = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
const MUX = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

export default defineProvider({
  channels: {
    refresh: "6h",

    async load() {
      return [
        {
          id: "bipbop",
          name: "Bip Bop (fijo)",
          number: 1,
          group: "Pruebas",
          categories: ["Otros"],
          // 1. Emisión fija y directa: NOVA la reproduce tal cual.
          stream: { type: "hls", url: APPLE },
        },
        {
          id: "mux",
          name: "Mux (al reproducir)",
          number: 2,
          group: "Pruebas",
          categories: ["Otros"],
          // Sin `stream`: NOVA llamará a channels.stream("mux") al sintonizar.
        },
      ];
    },

    async stream(id, ctx) {
      log.info("Pidiendo la emisión de", id, ctx.retry ? "(reintento)" : "");
      // 2 y 3. Aquí podrías pedir una dirección firmada a tu API. Con proxy: true,
      // NOVA pide las listas .m3u8 por ti (solo a tus dominios de "network").
      return { type: "hls", url: MUX, proxy: true };
    },

    async check(id) {
      // ¿Sigue en el aire? Aquí, que la lista responda.
      const url = id === "bipbop" ? APPLE : MUX;
      const res = await http.request({ url, method: "GET" });
      return res.status === 200 && res.body.startsWith("#EXTM3U");
    },
  },

  guide: {
    refresh: "1h",

    async load(ids, { from, to }) {
      // Un programa de 30 minutos tras otro, para cada canal.
      const slot = 30 * 60;
      const programs: Record<string, Program[]> = {};
      for (const id of ids) {
        const list: Program[] = [];
        for (let start = Math.floor(from / slot) * slot; start < to; start += slot) {
          const n = (start / slot) % 3;
          list.push({ start, end: start + slot, title: ["Carta de ajuste", "Pruebas de emisión", "Bip bop en directo"][n], genre: "Pruebas" });
        }
        programs[id] = list;
      }
      return programs;
    },
  },
});
