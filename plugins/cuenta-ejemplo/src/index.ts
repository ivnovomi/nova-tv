// Ejemplo de inicio de sesión con código, como en todas las teles:
// NOVA enseña un código y un QR, el usuario lo escribe en el móvil y listo.
//
// deviceLogin() hace todo el baile con el servicio (OAuth 2.0 «device flow»):
// pedir el código, preguntar si ya lo escribieron, guardar la sesión cifrada
// (una por perfil de NOVA) y renovar el token cuando caduca. Tú solo dices
// dónde está el servicio y cómo saber quién ha entrado.
//
// El servicio de aquí (ejemplo.es) es inventado: mira test/ para verlo funcionar.

import { defineProvider, deviceLogin, http, type Item } from "@novatv/sdk";

const API = "https://api.ejemplo.es";

const cuenta = deviceLogin({
  deviceUrl: "https://auth.ejemplo.es/device",
  tokenUrl: "https://auth.ejemplo.es/token",
  clientId: "nova-tv",
  scopes: ["perfil", "lista"],

  // Quién ha entrado: NOVA lo enseña como «Conectado como …».
  async user(token) {
    const yo = await http.json<{ nombre: string; foto?: string }>(`${API}/yo`, { headers: { authorization: `Bearer ${token}` } });
    return { name: yo.nombre, avatar: yo.foto };
  },

  // Al cerrar sesión, le decimos al servicio que olvide el token.
  async revoke(token) {
    await http.postForm("https://auth.ejemplo.es/revoke", { token });
  },
});

interface Peli {
  id: string;
  titulo: string;
  poster?: string;
  sinopsis: string;
}

export default defineProvider({
  // Con esto, Ajustes → Plugins enseña «Iniciar sesión».
  account: cuenta.account,

  rows: {
    refresh: "30m",
    async load() {
      // Un token válido para el perfil que está viendo (renovado si hacía falta),
      // o undefined si nadie ha iniciado sesión.
      const token = await cuenta.token();
      if (!token) return [];
      const lista = await http.json<Peli[]>(`${API}/mi-lista`, { headers: { authorization: `Bearer ${token}` } });
      const items = lista.map((p): Item => ({ id: p.id, title: p.titulo, image: p.poster, action: { type: "detail", title: p.titulo, text: p.sinopsis } }));
      return [{ title: `Mi lista de ${cuenta.user()?.name ?? "tu cuenta"}`, style: "poster", items }];
    },
  },
});
