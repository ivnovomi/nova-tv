# @novatv/sdk

Crea plugins para **NOVA TV** en TypeScript: canales en directo, guía de programación, filas en «Para ti», resultados de búsqueda y fondos del salvapantallas.

Un plugin **no pinta pantallas**: devuelve datos y NOVA los muestra con su propio diseño. Por eso todo se maneja igual con el mando, venga de donde venga.

---

## 1. Cómo es un plugin

```
mi-plugin/
├── nova-plugin.json      ← el manifiesto: quién eres, qué aportas, qué permisos pides
├── icon.png              ← 256×256 o más
└── src/
    └── index.ts          ← el código: un defineProvider(...)
```

El código se empaqueta en un solo archivo (`dist/index.js`) y NOVA lo ejecuta **aislado**: no puede tocar archivos, ni otros programas, ni conectarse a donde quiera. Todo lo que hace pasa por las funciones de este SDK, y NOVA comprueba los permisos en cada llamada.

## 2. El manifiesto

```json
{
  "$schema": "https://unpkg.com/@novatv/sdk/schema/nova-plugin.schema.json",
  "id": "es.ejemplo.noticias",
  "name": "Noticias Ejemplo",
  "version": "1.0.0",
  "api": 1,
  "kind": ["provider"],
  "main": "dist/index.js",
  "icon": "icon.png",
  "description": "Las últimas noticias en una fila de Para ti.",
  "author": { "name": "Tu nombre" },
  "audience": "everyone",
  "permissions": {
    "network": ["api.ejemplo.es"],
    "rows": true
  }
}
```

Con la línea `$schema`, tu editor te autocompleta y avisa de errores.

| Campo | Qué es |
|---|---|
| `id` | Dominio invertido. Único y **para siempre**. |
| `audience` | `"everyone"` o `"adults"`. Los perfiles infantiles solo ven los `everyone` que un adulto active. |
| `permissions.network` | Dominios a los que puedes conectarte. Solo HTTPS. `"*.ejemplo.es"` permite sus subdominios. |
| `permissions.channels`, `guide`, `rows`, `search`, `screensaver` | Qué partes de NOVA ocupa tu plugin. Cada parte de `defineProvider` necesita su permiso. |
| `settings` | Opciones que NOVA enseña en Ajustes → Plugins (texto, interruptor, lista, número). |

## 3. `defineProvider`

Todo el plugin es un `export default defineProvider({ ... })` con las partes que aporte:

```ts
import { defineProvider } from "@novatv/sdk";

export default defineProvider({
  channels: { /* canales en directo */ },
  guide: { /* su programación */ },
  rows: { /* filas en Para ti */ },
  search: { /* resultados de búsqueda */ },
  screensaver: { /* fondos */ },
});
```

`defineProvider` comprueba la forma nada más cargarse: si falta una función o un `refresh` está mal escrito, te lo dice al momento.

Las funciones son `async` y reciben un **contexto**: `ctx.profile.kids` te dice si está viendo un perfil infantil, y `ctx.locale` el idioma (`"es-ES"`).

### `refresh`

Cada cuánto NOVA vuelve a pedir los datos: `"15m"`, `"6h"`, `"1d"`… Los mínimos los pone NOVA (15 minutos; canales, 1 hora). Si una carga falla, NOVA **se queda con lo último que funcionó**.

## 4. Canales en directo

```ts
channels: {
  refresh: "6h",
  async load(ctx) {
    return [
      { id: "noticias-24h", name: "Noticias 24h", logo: "https://…/logo.png", group: "Noticias", categories: ["Noticias"],
        stream: { type: "hls", url: "https://cdn.ejemplo.es/24h/master.m3u8" } },
    ];
  },
},
```

| Campo de `Channel` | Para qué |
|---|---|
| `id` | Único dentro de tu plugin. NOVA le añade el tuyo delante. |
| `number` | Posición preferida dentro de tu rango. NOVA mantiene los números fijos aunque cambie la lista. |
| `group` | Cómo se agrupa en la guía. |
| `categories` | Temas comunes de NOVA (`"Infantil"`, `"Cine"`…), para que tu canal salga en esas pestañas. |
| `stream` | Cómo se reproduce, **si la dirección no cambia nunca**. |

### Emisiones (`Stream`)

```ts
{ type: "hls", url: "https://…/master.m3u8" }              // vídeo HLS normal
{ type: "hls", url, proxy: true, headers: { … } }           // listas pedidas a través de NOVA
{ type: "twitch", channel: "nombre_del_canal" }             // reproductor oficial de Twitch
{ type: "youtube", video: "dQw4w9WgXcQ" }                   // un vídeo o directo de YouTube
{ type: "youtube", channel: "UC…" }                         // el directo de un canal de YouTube
```

- **`proxy: true`**: para servidores que no dejan que otras webs lean sus listas (CORS) o que piden cabeceras. NOVA pide las listas `.m3u8` por ti (solo a tus dominios de `network`); los trozos de vídeo siguen cargándose directos.

### Direcciones que caducan: `stream()`

Si la dirección lleva un token o una sesión que caduca, **no pongas `stream` en el canal**: implementa `stream(id)` y NOVA te la pedirá justo antes de reproducir.

```ts
async stream(id, ctx) {
  // ctx.retry === true → la anterior fue rechazada (401/403): consigue una nueva.
  return { type: "hls", url: await direccionFirmada(id, ctx.retry), proxy: true };
},
```

### ¿Sigue en directo?: `check()`

NOVA comprueba la señal de todos los canales. Si tu fuente sabe responder mejor (por ejemplo, preguntando a su API si el canal emite), implementa `check(id)` y devuelve `true` o `false`.

## 5. Guía

```ts
guide: {
  refresh: "1h",
  async load(ids, { from, to }, ctx) {
    // ids: tus canales. from/to: segundos Unix.
    return { "noticias-24h": [{ start: 1792107421, end: 1792111021, title: "Informativo" }] };
  },
},
```

## 6. Filas, búsqueda y salvapantallas

```ts
rows: {
  refresh: "30m",
  async load(ctx) {
    return [{ title: "Lo más visto", style: "landscape", items: [
      { id: "1", title: "Final de liga", image: "https://…", badge: "EN DIRECTO",
        action: { type: "play", stream: { type: "hls", url: "https://…" } } },
    ] }];
  },
},
search: { async search(query, ctx) { return [/* Item[] */]; } },
screensaver: { refresh: "1d", async load() { return ["https://…/foto1.jpg"]; } },
```

Lo que pasa al elegir un elemento (`action`) es una lista cerrada: `play` (reproducir), `tune` (sintonizar uno de tus canales), `detail` (una ficha con texto) o `app` (abrir la app de tu plugin). Un plugin no puede abrir otros programas ni webs sueltas.

## 7. Servicios

### `http`

```ts
import { http, HttpError } from "@novatv/sdk";

const lista = await http.json<Canal[]>("https://api.ejemplo.es/canales");          // GET → JSON
const html  = await http.text("https://ejemplo.es/pagina");                         // GET → texto
const datos = await http.postJson("https://api.ejemplo.es/graphql", { query },      // POST JSON → JSON
                                  { headers: { "client-id": "…" } });
const res   = await http.request({ url, method: "GET", headers });                  // control total: nunca lanza por el código HTTP
```

- `json`, `text` y `postJson` lanzan **`HttpError`** si la respuesta no es 2xx (`err.status` tiene el código).
- Solo HTTPS, solo tus dominios, 20 s como máximo y 5 MB por respuesta.

### `memo`: recordar resultados un rato

```ts
import { memo } from "@novatv/sdk";

const sesion = memo("8h", () => http.json<Sesion>("https://api.ejemplo.es/sesion"));
await sesion();       // la primera vez la pide
await sesion();       // durante 8 h, la misma
sesion.clear();       // olvídala (p. ej. si caducó antes de tiempo)
```

Si la función falla, `memo` no guarda el fallo: la siguiente llamada lo vuelve a intentar.

### `storage`

```ts
import { storage } from "@novatv/sdk";

storage.set("ultimaVisita", Date.now());            // compartido por todo el plugin
storage.get<number>("ultimaVisita");
storage.profile.set("favoritos", ["a", "b"]);       // separado para cada perfil de NOVA
```

Valores JSON, 5 MB en total. Se borra todo al desinstalar el plugin.

### `settings`, `location`, `log`

```ts
import { settings, location, log } from "@novatv/sdk";

const ciudad = settings.get("city") ?? "Madrid";     // opciones de tu manifiesto
const donde = location.get();                        // { city, country, latitude, longitude } · necesita "location"
log.info("Cargados", lista.length, "canales");       // se ve en `nova dev` y en Ajustes → Plugins → Registro
```

---

## Ejercicio: Twitch y Pluto TV

NOVA ya tiene Twitch y Pluto TV programados en Rust (`src-tauri/src/twitch.rs` y `src-tauri/src/pluto.rs`). Tu reto es reescribirlos como plugins con este SDK y que funcionen **igual**. Aquí tienes qué pieza del SDK resuelve cada cosa; el código es tuyo.

### Twitch

| Lo que hace hoy (`twitch.rs`) | Con el SDK |
|---|---|
| Una consulta GraphQL por POST a `gql.twitch.tv` con la cabecera `Client-Id` | `http.postJson(url, { query }, { headers })` · permiso `network: ["gql.twitch.tv"]` |
| Guarda la lista 5 minutos | `memo("5m", …)` |
| Filtra: sin etiquetas de contenido, sin apuestas/ASMR/+18, máx. 2 por juego | TypeScript normal sobre la respuesta (mira `pick()`) |
| Canales que se reproducen en el reproductor oficial | `stream: { type: "twitch", channel: login }` |
| «¿Sigue en directo?» preguntando `user(login){stream{id}}` | `channels.check(id)` |
| El título del directo como programa en la guía | `guide.load()` devolviendo un programa por canal |

### Pluto TV

| Lo que hace hoy (`pluto.rs`) | Con el SDK |
|---|---|
| Pide una sesión a `boot.pluto.tv` que caduca a las horas | `memo` con la duración que indique Pluto, y `.clear()` si falla antes |
| Lista de canales y categorías desde `service-channels.clusters.pluto.tv` con `Authorization: Bearer …` | `http.json(url, { headers })` |
| Traduce las categorías de Pluto a temas de NOVA | `categories` del canal (mira `theme()` y `promo()`) |
| Firma la lista maestra con la sesión, y las listas pasan por un proxy por CORS | `channels.stream(id, ctx)` devolviendo `{ type: "hls", url, proxy: true }` · `ctx.retry` para pedir sesión nueva |
| Programación de las próximas 6 horas, en lotes de 60 canales | `guide.load(ids, { from, to })` |
| Servidores `*.pluto.tv` | `network: ["boot.pluto.tv", "service-channels.clusters.pluto.tv", "*.pluto.tv"]` |

Cuando tengas algo, pásamelo y lo revisamos juntos.

---

Licencia MIT.
