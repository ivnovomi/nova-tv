# Plugins de NOVA

Plugins escritos con el SDK de [`../sdk`](../sdk/README.md). Cada uno en su carpeta:

```
plugins/
└── mi-plugin/
    ├── nova-plugin.json
    ├── icon.png
    ├── src/index.ts
    └── test/*.test.ts      ← pruebas (opcional)
```

Aquí se usa la CLI del propio repo ([`../cli`](../cli/README.md)): `npm run nova -- <comando> plugins/<carpeta>`, o los atajos de abajo.

| Comando | Qué hace |
|---|---|
| `npm run plugin:create -- plugins/nuevo` | Crea un plugin nuevo (pregunta nombre, partes y dominio). |
| `npm run plugin:validate -- plugins/mi-plugin` | Comprueba lo que NOVA y la tienda revisan, sin empaquetar. |
| `npm run plugin:check` | Comprueba los tipos de todos los plugins y sus pruebas. |
| `npm run plugin:dev -- plugins/mi-plugin` | Lo carga en el NOVA abierto y lo recarga cada vez que guardas, con su registro en la terminal ([guía](../sdk/README.md#8-nova-dev-tu-plugin-dentro-de-nova-mientras-lo-escribes)). |
| `npm run plugin:test -- plugins/mi-plugin` | Ejecuta sus pruebas en un NOVA de mentira ([guía](../sdk/README.md#9-probar-tu-plugin-sin-abrir-nova)). |
| `npm run plugin:build -- plugins/mi-plugin` | Lo valida (`nova pack`) y lo empaqueta en `dist/<id>-<versión>.novapkg`, listo para instalar. El código va minificado pero legible (sin comentarios ni código sin usar, con sus nombres y sangría, para poder revisarlo tal cual), los JSON compactos y sin basura del sistema (`.DS_Store`, `Thumbs.db`, `.map`…). |

`plugins/canales-prueba/test` tiene un ejemplo de pruebas.
