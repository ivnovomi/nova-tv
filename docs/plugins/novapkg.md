# `.novapkg` — formato de paquete de NOVA TV

Versión del formato: **1** (mínimo viable). Implementación: [`src-tauri/src/plugins/package.rs`](../../src-tauri/src/plugins/package.rs). Empaquetado: `nova pack` ([`cli/src/pack.mjs`](../../cli/src/pack.mjs)).

## Qué es

Un `.novapkg` es un archivo **ZIP** con extensión propia. Distribuye, instala y actualiza aplicaciones y extensiones de NOVA TV sin modificar NOVA.

```
es.ejemplo.noticias-1.0.0.novapkg
├── nova-plugin.json      ← manifiesto (obligatorio, en la raíz)
├── dist/index.js         ← código de la extensión ("main"), ya empaquetado con el SDK
├── app/                  ← interfaz de la aplicación ("app"), si la tiene
├── assets/               ← recursos estáticos
├── icon.png              ← "icon", si lo declara
└── LICENSE
```

Nunca contiene ninguna parte del runtime de NOVA ni puede sustituir componentes del host.

## Manifiesto

Es `nova-plugin.json`, el mismo contrato del SDK ([esquema](../../sdk/schema/nova-plugin.schema.json), [tipos](../../sdk/src/manifest.ts)). Equivalencias con la especificación inicial:

| Especificación | `nova-plugin.json` |
|---|---|
| `schemaVersion` / `apiVersion` | `api` (hoy `1`; un cambio incompatible sube el número) |
| `type: application` | `kind: ["app"]`, entrada en `app` |
| `type: extension` | `kind: ["provider"]`, entrada en `main` |
| `entry` | `main` y/o `app` |
| `permissions` | `permissions` (objeto): `network` con sus dominios, y `channels`, `guide`, `rows`, `search`, `screensaver`, `notify`, `location` |

Pedir un permiso no es tenerlo: el usuario los aprueba al instalar y NOVA los comprueba en cada llamada.

## Qué comprueba NOVA (Rust) antes de instalar

1. Que es un ZIP válido y no pasa de **50 MB**.
2. Cada entrada, **sin escribir nada todavía**:
   - ruta relativa con `/`; se rechazan `..`, `.`, rutas absolutas, `C:`, `\`, caracteres de control y nombres reservados de Windows (`CON`, `NUL`, `COM1`…);
   - sin enlaces simbólicos;
   - sin archivos repetidos (tampoco cambiando mayúsculas);
   - **límites contra bombas ZIP**: 2000 archivos, 50 MB por archivo, 200 MB en total y una proporción de compresión máxima de 200:1.
3. El manifiesto: existe en la raíz, es JSON válido de menos de 64 KB, sin campos desconocidos, `id` de dominio invertido, versión SemVer, rutas internas y dominios bien formados.
4. Compatibilidad: `api` igual a la de este NOVA.
5. Que existen los archivos que declara (`main`, `app`, `icon`).
6. *(Con la tienda)* la firma: de la tienda en la Box; o de una clave de desarrollador en modo desarrollador.

## Instalación atómica

```
.novapkg → inspección → extracción en .staging-<id>-<aleatorio>/ (comprobando el tamaño real de cada archivo)
        → se mueve a plugins/<id>/<versión>/ → solo entonces plugins/<id>/current apunta a la nueva versión
```

- Un fallo en cualquier paso deja **la versión instalada tal cual** y no quedan restos de la instalación.
- Se conservan la versión actual y **la anterior**, para poder volver atrás (`rollback`). Las más antiguas se borran.
- Los datos del plugin están en otra carpeta (`plugin-data/<id>/`) y **sobreviven a las actualizaciones**.

## Desinstalación

Borra `plugins/<id>/` entero. NOVA pregunta «¿Borrar también sus datos?», con **Sí** marcado por defecto para que la Box quede limpia. Si se responde No, `plugin-data/<id>/` se conserva para una reinstalación.

## Runtime

**Extensiones (`provider`)**: cada una en su propio hilo con su propio motor **QuickJS** ([`rquickjs`](https://crates.io/crates/rquickjs)), dentro de NOVA.

- No hay `fetch`, ni archivos, ni procesos, ni comandos de Tauri: solo el objeto `__nova`, cuyas funciones comprueban los permisos del manifiesto.
- Límites: **32 MB** de memoria y **5 s de cálculo por llamada** (esperar a la red no cuenta). Si se pasa, se corta.
- Red: solo HTTPS, solo a sus dominios, 20 s y 5 MB por respuesta, sin seguir redirecciones por su cuenta.
- Por qué QuickJS: unos 1 MB, arranca en milisegundos, y Rust puede limitar memoria, pila y tiempo. V8 sería más rápido pero añadiría decenas de MB a la Box y minutos a cada compilación. Para extensiones que piden y ordenan datos, sobra.

**Aplicaciones (`app`)**: *(pendiente, fase 4)* una WebView aislada por aplicación, con origen propio `nova-plugin://<id>/`, CSP que solo permite sus dominios y ningún comando de NOVA salvo el puente del SDK (mando, Atrás, almacenamiento, avisos). El botón Inicio siempre vuelve a NOVA.

Firma, integridad, permisos y aislamiento son mecanismos complementarios: ninguno sustituye a los demás, y descargar un paquete de la tienda no lo convierte en seguro por sí solo.

## Pendiente

- Firma y verificación de procedencia (con la tienda, fase 5).
- ~~`nova validate` y `nova pack` en `@novatv/cli`~~ Hecho ([`cli/`](../../cli/README.md)).
- Instalar desde la interfaz de NOVA (Ajustes → Plugins) con la pantalla de permisos.
