# @novatv/cli

La línea de comandos de los plugins de **NOVA TV**: crea, prueba, carga en NOVA y empaqueta plugins hechos con [`@novatv/sdk`](https://www.npmjs.com/package/@novatv/sdk).

```
npm create nova-plugin
```

o, en un proyecto que ya tengas:

```
npm install -D @novatv/cli
npx nova --help
```

## Comandos

| Comando | Qué hace |
|---|---|
| `nova create [carpeta]` | Crea un plugin nuevo. Pregunta el nombre, el id, qué aporta (canales, filas, búsqueda, salvapantallas) y el dominio de tu API, y te deja el código, sus pruebas y un icono. |
| `nova dev` | Lo carga en el NOVA abierto en este equipo, **sin empaquetar ni instalar**, y lo recarga cada vez que guardas. Su registro sale en la terminal. Necesita el modo desarrollador (Ajustes → Plugins). Con Ctrl+C, NOVA vuelve a como estaba. |
| `nova test` | Pasa las pruebas de `test/*.test.ts` en un NOVA de mentira con sus mismas reglas (`@novatv/sdk/testing`). |
| `nova validate` | Comprueba lo que NOVA y la revisión de la tienda miran: el manifiesto con las reglas de NOVA, los archivos, que lo que aporta coincida con los permisos que pide, y los tipos. |
| `nova pack` | Lo valida y lo empaqueta en `dist/<id>-<versión>.novapkg`: código minificado pero legible, JSON compactos y sin basura del sistema. |

Sin carpeta, todos trabajan con la actual.

### `nova create` sin preguntas

```
nova create noticias --yes --name "Noticias" --author "Tu nombre" --parts rows,search --domain api.ejemplo.es
```

`--parts`: `channels` (con su guía), `rows`, `search`, `screensaver`. `--audience`: `everyone` o `adults`.

Requiere Node 22.12 o más nuevo. Licencia MIT.
