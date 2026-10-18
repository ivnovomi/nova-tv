# La tienda de plugins de NOVA

NOVA enseña la tienda en la pestaña **Tienda** (no en perfiles infantiles). Todo lo que se ve sale de un único archivo, el **catálogo**, en el repositorio `ivnovomi/nova-plugins`:

```
https://raw.githubusercontent.com/ivnovomi/nova-plugins/main/store/catalog.json
```

NOVA lo descarga como mucho cada 6 horas y guarda el último que funcionó para cuando no hay conexión. Cambiar el escaparate (destacados, colecciones, orden) es editar ese archivo: no hace falta sacar una versión de NOVA.

Implementación: [`src-tauri/src/plugins/store.rs`](../../src-tauri/src/plugins/store.rs) (catálogo e instalación) y [`src/features/store/`](../../src/features/store/) (la interfaz).

## Cómo instala NOVA desde la tienda

1. El usuario ve los permisos (los de la ficha del catálogo) y acepta.
2. NOVA descarga el paquete enseñando el progreso. Si ocupa más de lo que dice `package.size`, se para.
3. Comprueba su **SHA-256** con el del catálogo.
4. Comprueba la **firma de la tienda** con la clave pública que lleva NOVA dentro.
5. Comprueba que el manifiesto del paquete es el que anuncia la tienda: mismo `id`, misma `version` y **exactamente los permisos que el usuario acaba de aprobar**.
6. Lo instala igual que un `.novapkg` (de forma atómica y guardando la versión anterior) y **borra la descarga**.

Un paquete sin firma, o firmado con otra clave, no se instala nunca desde la tienda (ni siquiera en modo desarrollador: para probar paquetes propios está «Instalar .novapkg»).

## La clave de la tienda (una vez)

Es **distinta de la del actualizador**, y su mitad privada vive en las credenciales del equipo, nunca en el repositorio.

En PowerShell (en cmd sería `%USERPROFILE%`; en PowerShell eso no se sustituye y crearía la carpeta dentro del repo):

```
npx tauri signer generate -w "$env:USERPROFILE\.nova\store.key"
```

Hecho el 18 de octubre de 2026: la clave pública está en `STORE_PUBLIC_KEY` de `src-tauri/src/plugins/store.rs`, y `store.key` (con su contraseña) se guarda con las credenciales del equipo. Si algún día se cambia, las versiones de NOVA anteriores dejarán de aceptar los paquetes nuevos.

## Publicar un plugin (o una versión nueva)

1. Revisión: el código del paquete (`nova pack` lo deja minificado pero legible), sus permisos y que haga lo que dice.
2. Empaquetar: `nova pack`. Al final escribe el tamaño y la huella para el catálogo:
   ```
   tienda   "size": 9500, "sha256": "3f1c…"
   ```
3. Firmar el paquete con la clave de la tienda:
   ```
   npx tauri signer sign -f "$env:USERPROFILE\.nova\store.key" dist\es.novatv.pluto-tv-1.1.0.novapkg
   ```
   Escribe `…novapkg.sig`: su contenido (una línea) va en `package.signature`.
4. Subir el `.novapkg` a una release de `nova-plugins` (por ejemplo, la etiqueta `es.novatv.pluto-tv@1.1.0`).
5. Actualizar su ficha en `store/catalog.json`: `version`, `package`, `changelog`, `updatedAt` y `reviewedAt`.

## El catálogo

```jsonc
{
  "version": 1,
  "updatedAt": 1792300000,
  // El carrusel de arriba, en orden.
  "featured": ["es.novatv.pluto-tv"],
  "collections": [
    // "ranked": números gigantes (top) · "wide": portadas grandes · "cards": tarjetas
    // "editorial": un cartel a todo lo ancho que abre la colección (con "accent" e "image" opcionales)
    { "id": "top", "title": "Lo más instalado", "style": "ranked", "ids": ["es.novatv.pluto-tv"] },
    { "id": "peques", "title": "Para los peques", "subtitle": "…", "style": "editorial", "accent": "#ec4899", "ids": ["…"] }
  ],
  "plugins": [
    {
      "id": "es.novatv.pluto-tv",
      "name": "Pluto TV",
      "version": "1.1.0",
      "tagline": "Cientos de canales gratis, con su guía",
      "description": "Párrafos separados por una línea en blanco.\n\nSegundo párrafo.",
      "author": { "name": "NOVA TV", "verified": true, "url": "https://…" },
      // tv · sports · kids · movies · music · news · games · tools
      "category": "tv",
      "audience": "everyone",
      "icon": "https://…/icon.png",          // cuadrado, 512×512
      "banner": "https://…/banner.jpg",      // 16:9 o más ancho, 1920×1080
      "accent": "#f5c400",                   // pinta sus páginas
      "screenshots": [{ "url": "https://…/1.jpg", "caption": "La guía, dentro de la de NOVA" }],
      // Exactamente los del manifiesto: si no, NOVA no lo instala.
      "permissions": { "network": ["*.pluto.tv"], "channels": true, "guide": true },
      "changelog": [{ "version": "1.1.0", "date": 1792300000, "notes": ["…"] }],
      "languages": ["es", "en"],
      "updatedAt": 1792300000,
      "reviewedAt": 1792300000,
      "package": {
        "url": "https://github.com/ivnovomi/nova-plugins/releases/download/…/es.novatv.pluto-tv-1.1.0.novapkg",
        "sha256": "…",
        "signature": "…",
        "size": 9500
      }
    }
  ]
}
```

- Imágenes y descargas, siempre `https://`. Lo que no lo es se ignora.
- Una ficha mal escrita no tumba la tienda: NOVA la salta y enseña el resto.
- Sin `icon`, `banner` o capturas, NOVA genera arte con el `accent` del plugin.
- Los campos que NOVA aún no conoce se ignoran, así el catálogo puede crecer sin romper versiones antiguas.

## En desarrollo

Si NOVA no consigue el catálogo y es una compilación de desarrollo (`npm run tauri dev` o `npm run dev`), la tienda enseña un **catálogo de ejemplo** ([`preview.ts`](../../src/features/store/preview.ts)) con un aviso bien visible, para poder diseñarla. Salvo Pluto TV, sus plugins son inventados, y las versiones publicadas nunca lo enseñan.
