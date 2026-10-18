// Plugin de ejemplo: una fila en «Para ti».
// Enseña las piezas básicas del SDK sin necesitar internet:
// defineProvider, el contexto (ctx), settings, storage y log.

import { defineProvider, log, settings, storage, type Item } from "@novatv/sdk";

export default defineProvider({
  rows: {
    // Cada cuánto NOVA vuelve a pedir la fila.
    refresh: "30m",

    async load(ctx) {
      // Una opción del manifiesto: el usuario la cambia en Ajustes → Plugins.
      const saludo = settings.get("saludo") ?? "¡Hola!";

      // storage.profile es distinto para cada perfil de NOVA.
      const visitas = (storage.profile.get<number>("visitas") ?? 0) + 1;
      storage.profile.set("visitas", visitas);

      log.info("Cargando la fila", { visitas, infantil: ctx.profile.kids });

      const items: Item[] = [
        {
          id: "saludo",
          title: saludo,
          subtitle: ctx.profile.kids ? "Perfil infantil" : "Perfil de adulto",
          badge: "EJEMPLO",
          action: { type: "detail", title: saludo, text: "Este elemento lo ha creado un plugin con @novatv/sdk." },
        },
        {
          id: "visitas",
          title: `${visitas} ${visitas === 1 ? "visita" : "visitas"}`,
          subtitle: "Guardado con storage.profile",
          action: { type: "detail", text: `Has cargado esta fila ${visitas} veces con este perfil.` },
        },
      ];

      return [{ title: "Desde un plugin", style: "landscape", items }];
    },
  },
});
