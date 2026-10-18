// El inicio de sesión de principio a fin, contra un servicio de mentira:
//   npm run nova -- test plugins/cuenta-ejemplo
//
// `advance()` adelanta el reloj: así se prueba en un momento lo que caduca
// (el código a los 10 minutos, el token a la hora).

import { testPlugin, test, assert } from "@novatv/sdk/testing";
import manifest from "../nova-plugin.json";
import plugin from "../src/index";

// ───── El servicio de mentira ─────
const servicio = { aprobado: false, denegado: false, renovarFunciona: true, tokens: 0, revocados: [] as string[] };
const campos = (body = "") => Object.fromEntries(body.split("&").map((par) => par.split("=").map(decodeURIComponent)));
const error = (codigo: string) => ({ status: 400, body: JSON.stringify({ error: codigo }) });

const nova = testPlugin(manifest, plugin, {
  offline: true,
  print: false,
  mock: (req) => {
    const f = campos(req.body);
    switch (req.url) {
      case "https://auth.ejemplo.es/device":
        return { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://ejemplo.es/activar", verification_uri_complete: "https://ejemplo.es/activar?code=ABCD-1234", expires_in: 600, interval: 5 };
      case "https://auth.ejemplo.es/token":
        if (f.grant_type === "refresh_token") {
          return servicio.renovarFunciona ? { access_token: `tok-${++servicio.tokens}`, expires_in: 3600 } : error("invalid_grant");
        }
        if (servicio.denegado) return error("access_denied");
        if (!servicio.aprobado) return error("authorization_pending");
        return { access_token: `tok-${++servicio.tokens}`, refresh_token: "ref-1", expires_in: 3600 };
      case "https://auth.ejemplo.es/revoke":
        servicio.revocados.push(f.token);
        return "";
      case "https://api.ejemplo.es/yo":
        return { nombre: "Ana", foto: "https://img.ejemplo.es/ana.jpg" };
      case "https://api.ejemplo.es/mi-lista":
        return req.headers?.authorization?.startsWith("Bearer tok-") ? [{ id: "1", titulo: "Amélie", sinopsis: "París." }] : { status: 401, body: "" };
    }
  },
});

test("sin sesión: nadie conectado y sin filas", async () => {
  assert.equal(await nova.account.status(), null);
  assert.deepEqual(await nova.rows(), []);
});

test("pide un código válido para enseñar en la tele", async () => {
  const codigo = await nova.account.start();
  assert.equal(codigo.code, "ABCD-1234");
  assert.equal(codigo.urlComplete, "https://ejemplo.es/activar?code=ABCD-1234");
  assert.deepEqual(nova.problems, []);
});

test("mientras no se escribe el código, sigue esperando (sin agobiar al servicio)", async () => {
  assert.deepEqual(await nova.account.poll(), { status: "pending" });
  const peticiones = nova.requests.length;
  // NOVA vuelve a preguntar antes de tiempo: no se molesta al servicio.
  assert.deepEqual(await nova.account.poll(), { status: "pending" });
  assert.equal(nova.requests.length, peticiones);
});

test("al escribir el código, entra y sabe quién es", async () => {
  servicio.aprobado = true;
  nova.advance(5);
  const fin = await nova.account.poll();
  assert.deepEqual(fin, { status: "done", user: { name: "Ana", avatar: "https://img.ejemplo.es/ana.jpg" } });
  assert.deepEqual(await nova.account.status(), { name: "Ana", avatar: "https://img.ejemplo.es/ana.jpg" });
});

test("con sesión, su lista sale en Para ti", async () => {
  const filas = await nova.rows();
  assert.equal(filas[0].title, "Mi lista de Ana");
  assert.equal(filas[0].items[0].title, "Amélie");
  assert.deepEqual(nova.problems, []);
});

test("la sesión es de este perfil: otro perfil no ha entrado", async () => {
  nova.setProfile({ id: "perfil-2" });
  assert.equal(await nova.account.status(), null);
  nova.setProfile({ id: "perfil-1" });
});

test("cuando el token caduca, lo renueva solo", async () => {
  nova.advance(3600);
  await nova.rows();
  const renovar = nova.requests.find((r) => r.body?.includes("grant_type=refresh_token"));
  assert.ok(renovar, "pidió un token nuevo");
  assert.equal(servicio.tokens, 2);
});

test("si el servicio ya no acepta la sesión, queda cerrada", async () => {
  servicio.renovarFunciona = false;
  nova.advance(3600);
  assert.deepEqual(await nova.rows(), []);
  assert.equal(await nova.account.status(), null);
});

test("cerrar sesión avisa al servicio y lo borra todo", async () => {
  servicio.renovarFunciona = true;
  await nova.account.start();
  nova.advance(5);
  await nova.account.poll();
  await nova.account.signOut();
  assert.deepEqual(servicio.revocados, [`tok-${servicio.tokens}`]);
  assert.equal(await nova.account.status(), null);
  assert.equal(nova.secrets.get("perfil-1")?.size ?? 0, 0, "no queda ningún secreto");
});

test("si el usuario dice que no, o el código caduca, NOVA lo sabe", async () => {
  servicio.denegado = true;
  await nova.account.start();
  nova.advance(5);
  assert.deepEqual(await nova.account.poll(), { status: "denied" });

  servicio.denegado = false;
  servicio.aprobado = false;
  await nova.account.start();
  nova.advance(601);
  assert.deepEqual(await nova.account.poll(), { status: "expired" });
});
