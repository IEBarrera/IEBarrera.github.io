# Sitio personal — IE Barrera

Sitio estático hecho con [Jekyll](https://jekyllrb.com/) (nativo de GitHub
Pages). Blanco y negro, orientado a entradas tipo blog.

## Añadir una entrada nueva

1. Crea un archivo en `_posts/` con el nombre `AAAA-MM-DD-titulo.md`.
   El nombre del archivo define la fecha y la URL.
2. Empieza con este encabezado (front matter) y escribe en Markdown debajo:

   ```markdown
   ---
   layout: post
   title: "Título de la entrada"
   date: 2026-08-01
   tags: [proyecto, notas]
   summary: "Una frase que se muestra en el listado de la portada."
   ---

   Primer párrafo (aparece como resumen si no defines `summary`).

   <!--more-->

   Resto del contenido…
   ```

3. Eso es todo: la entrada aparece sola en la portada, ordenada por fecha.
   Las imágenes van en `assets/img/` y se referencian con
   `![alt](/assets/img/archivo.png)`.

## Ver el sitio localmente (opcional)

Necesitas Ruby. Luego:

```bash
bundle install
bundle exec jekyll serve
```

Abre <http://localhost:4000>. Si no quieres instalar Ruby, simplemente haz
push y GitHub lo construye.

## Publicar en GitHub Pages

Este sitio vive hoy en la carpeta `webpage/` del repo `moireGL`. GitHub Pages
**no** sirve subcarpetas arbitrarias, así que elige una opción:

- **Recomendado — repo propio:** crea un repo `IEBarrera.github.io`, mueve el
  contenido de `webpage/` a su raíz y actívalo en *Settings → Pages*. Quedará
  en `https://iebarrera.github.io` con `baseurl: ""`.
- **Dentro de este repo:** renombra `webpage/` a `docs/`, y en
  *Settings → Pages* elige *Deploy from branch → main → /docs*. En ese caso
  pon `baseurl: "/moireGL"` en `_config.yml`.

## Estructura

```
_config.yml          Configuración e identidad del sitio
index.html           Portada (nombre + listado de entradas)
sobre-mi.md          Página "Sobre mí"
_layouts/            Plantillas (default, post)
_posts/              Entradas del blog (una por archivo)
assets/css/style.css Estilos (monocromo, con modo oscuro)
assets/img/          Imágenes
```
