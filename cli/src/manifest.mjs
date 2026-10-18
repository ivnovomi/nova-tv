// nova-plugin.json, checked with the same rules NOVA applies when it installs
// a package (src-tauri/src/plugins/manifest.rs), so nothing that passes here
// is refused there. NOVA rejects unknown fields, so they're errors here too.

const FIELDS = ["$schema", "id", "name", "version", "api", "kind", "main", "app", "icon", "description", "author", "audience", "permissions", "settings"];
const PERMISSIONS = ["network", "channels", "guide", "rows", "search", "screensaver", "notify", "location"];
const SETTING_FIELDS = ["key", "type", "label", "help", "default", "options"];
const SETTING_TYPES = ["text", "toggle", "number", "choice"];

const label = (s) => s.length > 0 && s.length <= 63 && /^[a-z0-9-]+$/.test(s) && !s.startsWith("-") && !s.endsWith("-");
export const validId = (id) => typeof id === "string" && id.length <= 100 && id.split(".").length >= 3 && id.split(".").every(label);
const validDomain = (d) => {
  const name = d.startsWith("*.") ? d.slice(2) : d;
  return name.length <= 253 && name.split(".").length >= 2 && name.split(".").every(label);
};
const validPath = (p) => typeof p === "string" && p.length > 0 && !/^[\\/]/.test(p) && !p.includes(":") && p.split(/[\\/]/).every((part) => part && part !== "..");
const validVersion = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v.split("-")[0]);

/** The problems in a manifest (empty if NOVA would accept it). */
export function checkManifest(m) {
  const errors = [];
  const fail = (text) => errors.push(text);
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["nova-plugin.json tiene que ser un objeto"];

  for (const k of Object.keys(m)) if (!FIELDS.includes(k)) fail(`«${k}» no es un campo del manifiesto (NOVA lo rechazaría)`);
  if (!validId(m.id)) fail("«id» tiene que ser un dominio invertido en minúsculas, con tres partes o más (es.ejemplo.plugin)");
  if (typeof m.name !== "string" || !m.name.trim() || [...m.name].length > 40) fail("«name» tiene que tener entre 1 y 40 caracteres");
  if (!validVersion(m.version)) fail("«version» tiene que ser SemVer (1.0.0)");
  if (m.api !== 1) fail(`«api» tiene que ser 1 (la de este SDK)`);
  if (!Array.isArray(m.kind) || !m.kind.length || m.kind.some((k) => k !== "provider" && k !== "app")) fail("«kind» es una lista con \"provider\" y/o \"app\"");
  if (!validPath(m.main)) fail("«main» tiene que ser una ruta dentro del plugin (dist/index.js)");
  if (m.app !== undefined && !validPath(m.app)) fail("«app» tiene que ser una ruta dentro del plugin");
  if (m.icon !== undefined && !validPath(m.icon)) fail("«icon» tiene que ser una ruta dentro del plugin");
  if (typeof m.description !== "string" || !m.description.trim()) fail("falta «description»");
  if (!m.author || typeof m.author.name !== "string" || !m.author.name.trim()) fail("falta «author.name»");
  else for (const k of Object.keys(m.author)) if (!["name", "url", "email"].includes(k)) fail(`«author.${k}» no existe (puede ser name, url o email)`);
  if (m.audience !== "everyone" && m.audience !== "adults") fail("«audience» es \"everyone\" o \"adults\"");

  const p = m.permissions;
  if (!p || typeof p !== "object") fail("falta «permissions» (aunque sea {})");
  else {
    for (const k of Object.keys(p)) if (!PERMISSIONS.includes(k)) fail(`el permiso «${k}» no existe (pueden ser: ${PERMISSIONS.join(", ")})`);
    for (const k of PERMISSIONS.slice(1)) if (p[k] !== undefined && typeof p[k] !== "boolean") fail(`«permissions.${k}» es true o false`);
    if (p.network !== undefined) {
      if (!Array.isArray(p.network)) fail("«permissions.network» es una lista de dominios");
      else {
        for (const d of p.network) if (typeof d !== "string" || !validDomain(d)) fail(`el dominio «${d}» no es válido (api.ejemplo.es o *.ejemplo.es, sin https:// ni rutas)`);
        if (p.network.length > 20) fail("como mucho 20 dominios");
      }
    }
  }

  if (m.settings !== undefined) {
    if (!Array.isArray(m.settings)) fail("«settings» es una lista");
    else {
      if (m.settings.length > 20) fail("como mucho 20 opciones");
      const keys = new Set();
      m.settings.forEach((s, i) => {
        const where = `settings[${i}]`;
        for (const k of Object.keys(s ?? {})) if (!SETTING_FIELDS.includes(k)) fail(`«${where}.${k}» no existe`);
        if (typeof s?.key !== "string" || !s.key) fail(`«${where}» necesita «key»`);
        else if (keys.has(s.key)) fail(`la opción «${s.key}» está repetida`);
        else keys.add(s.key);
        if (!SETTING_TYPES.includes(s?.type)) fail(`«${where}.type» es ${SETTING_TYPES.join(", ")}`);
        if (typeof s?.label !== "string" || !s.label) fail(`«${where}» necesita «label»`);
        if (s?.type === "choice" && (!Array.isArray(s.options) || !s.options.length)) fail(`«${where}» es una lista: necesita «options»`);
      });
    }
  }
  return errors;
}
