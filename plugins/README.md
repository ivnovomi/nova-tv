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

| Comando | Qué hace |
|---|---|
| `npm run plugin:check` | Comprueba los tipos de todos los plugins y sus pruebas. |
| `npm run plugin:dev -- plugins/mi-plugin` | Lo carga en el NOVA abierto y lo recarga cada vez que guardas, con su registro en la terminal ([guía](../sdk/README.md#8-nova-dev-tu-plugin-dentro-de-nova-mientras-lo-escribes)). |
| `npm run plugin:test -- plugins/mi-plugin` | Ejecuta sus pruebas en un NOVA de mentira ([guía](../sdk/README.md#9-probar-tu-plugin-sin-abrir-nova)). |
| `npm run plugin:build -- plugins/mi-plugin` | Lo empaqueta en `dist/<id>-<versión>.novapkg`, listo para instalar. |

`plugins/canales-prueba/test` tiene un ejemplo de pruebas.
