# Formatos oficiales de las ARL

Formatos **en blanco** que entrega cada ARL. `src/services/formatos-arl.service.js`
los abre, les escribe encima los datos de la orden de servicio y los adjunta al
correo de asignación del profesional.

Van versionados en el repositorio a propósito: sin ellos el despliegue no puede
generar ningún formato, y son documentos públicos de la ARL (formularios vacíos),
no documentación de clientes. Los ejemplos diligenciados que sirvieron para
mapear las casillas **no** están aquí — llevan nombres, cédulas y firmas de
asistentes reales; viven fuera de git, en `documentos/`.

| Archivo | Formato de la ARL | Cómo se rellena |
|---|---|---|
| `bolivar/asistencia.pdf` | Registro de Asistencia · FORMA AT-028 | Campos de formulario (AcroForm) |
| `bolivar/seguimiento.pdf` | Seguimiento de Reuniones y Actividades · Forma AT-031 | Campos de formulario (AcroForm) |
| `colmena/asistencia.pdf` | Registro de asistencia · PSP-F-006 V2.4 | Texto dibujado por coordenadas |
| `colmena/evaluacion.pdf` | Evaluación Sesión de Capacitación · PSP-F-010 V1.2 | Texto dibujado por coordenadas |
| `colpatria/asistencia.pdf` | Formato Registro Listado de Asistencia ARL AXA Colpatria | Texto dibujado por coordenadas |

La carpeta de AXA Colpatria se llama `colpatria` porque así se le llama aquí; el
nombre en la BD es "AXA Colpatria" y `carpetaArl()` hace la traducción.

## Bolívar · nombres de campo

Los dos PDF traen formulario, pero sus campos se llaman `Text2`, `13`, `27`…
como los dejó quien diseñó el formato. La correspondencia con la etiqueta
impresa está anotada campo a campo en `camposAsistenciaBolivar()` y
`camposSeguimientoBolivar()`; **al reemplazar un formato por una versión nueva
de la ARL hay que revisar esos dos mapas**, porque los nombres de campo no
tienen por qué mantenerse.

Los grupos de opción (`Tipo de Actividad`, `Tipo de Servicio`, `¿Próxima
reunión?`) se dejan sin marcar. No es un olvido: los seis botones de cada grupo
comparten el mismo valor de exportación (`Opción1`), así que marcar uno los
enciende todos. Se marcan a mano sobre el impreso.

## Los tres PDF planos · coordenadas

No traen formulario, así que el valor se **dibuja encima de la raya impresa** en
las coordenadas de `CASILLAS_*` del servicio, medidas sobre estos archivos
concretos. Si la ARL publica otra versión del formato hay que volver a medirlas:
la forma de hacerlo es extraer el texto con posición (`pdfjs-dist`,
`getTextContent()`) y leer dónde termina cada etiqueta y dónde empieza la
siguiente división de la tabla.

## Colmena · por qué su asistencia ya no es un `.docx`

Colmena entrega ese formato solo en Word, y durante una versión se envió como
`.docx` rellenando marcadores en `word/document.xml`. Word recolocaba el texto a
su aire: con el dato dentro, la casilla de "Empresa" se iba a una segunda línea y
el formato salía descuadrado. Se convirtió **una sola vez** a PDF —con Word, y
tras vaciar los datos de la sesión anterior que traía el documento del
cliente— y desde entonces se trata como los demás planos.

Para regenerarlo si la ARL publica una versión nueva: vaciar las casillas
dejando su raya, convertir a PDF y volver a medir las coordenadas. Ojo con el
ancho de la raya — el guion bajo de Gill Sans MT mide ~5,5 pt, así que una raya
demasiado larga hace saltar la línea ya en el formato vacío.
