# Formatos oficiales de las ARL

Formatos **en blanco** que entrega cada ARL. `src/services/formatos-arl.service.js`
los abre, les escribe encima los datos de la orden de servicio y los adjunta al
correo de asignación del profesional.

Los cinco primeros van versionados en el repositorio a propósito: sin ellos el
despliegue no puede generar ningún formato, y son documentos públicos de la ARL
(formularios vacíos), no documentación de clientes. Los ejemplos diligenciados
que sirvieron para mapear las casillas **no** están aquí — llevan nombres,
cédulas y firmas de asistentes reales; viven fuera de git, en `documentos/`.

> 🔴 **SIETE DE ESTOS ARCHIVOS NO ESTÁN EN GIT** (decisión del equipo, 22-ago-2026):
> `colpatria/ficha-gestion.pdf`, `colpatria/informe-tecnico.docx`,
> `colmena/prestacion-servicios.pdf`, `colmena/informe-tipo-a.docx`,
> `colmena/informe-tipo-b.docx`, `colmena/registro-ejecucion.xls` y
> `colmena/plantilla-presentaciones.pptx`.
>
> **El código de la fase 2 los abre en ejecución**, así que en una máquina o un
> despliegue que no los tenga, asignar una orden de **AXA Colpatria** o de
> **Colmena** falla con `ENOENT`. Bolívar no se ve afectada: sus dos formatos sí
> están versionados.
>
> **Se copian a mano** desde `jdd_consultores_app/docs/Formatos/` (que tampoco
> viaja por git), con los nombres de la tabla de abajo. No están en `.gitignore`
> a propósito: así aparecen como archivos sin rastrear y se ve que faltan.

**No salen todos en cada orden.** Cuáles se adjuntan lo decide
`src/services/entrega-arl.service.js` a partir de la ARL, el tipo de actividad,
las horas y la modalidad; este README solo dice qué es cada archivo.

| Archivo | Formato de la ARL | Cómo se rellena | Alcance |
|---|---|---|---|
| `bolivar/seguimiento.pdf` | Seguimiento de Reuniones y Actividades · Forma AT-031 | AcroForm + marcas dibujadas | sesión |
| `bolivar/asistencia.pdf` | Registro de Asistencia · FORMA AT-028 | AcroForm | sesión |
| `colpatria/asistencia.pdf` | Registro Listado de Asistencia | Coordenadas | sesión |
| `colpatria/ficha-gestion.pdf` | Ficha de Gestión · Proveedor de Gestión del Riesgo (3 págs.) | AcroForm | **orden** |
| `colpatria/informe-tecnico.docx` | Formato Informe Técnico | **se adjunta tal cual** | **orden** |
| `colmena/prestacion-servicios.pdf` | Informe de Prestación de Servicios · PSP-F-007 V3.3 | Coordenadas | sesión |
| `colmena/asistencia.pdf` | Registro de asistencia · PSP-F-006 V2.4 | Coordenadas | sesión |
| `colmena/evaluacion.pdf` | Evaluación Sesión de Capacitación · PSP-F-010 V1.2 | Coordenadas | sesión |
| `colmena/informe-tipo-a.docx` | Informe de prestación de servicios · tipo A | **se adjunta tal cual** | **orden** |
| `colmena/informe-tipo-b.docx` | Informe técnico de servicios · tipo B | **se adjunta tal cual** | **orden** |
| `colmena/registro-ejecucion.xls` | Registro de ejecución de actividades | **se adjunta tal cual** | **orden** |
| `colmena/plantilla-presentaciones.pptx` | Plantilla de presentaciones corporativas | **se adjunta tal cual** | **orden** |

**Alcance** distingue los formatos de SESIÓN —uno por franja de visita, cada uno
con su fecha y su propia lista de asistentes— de los de ORDEN: un informe o una
ficha técnica de una asistencia técnica de tres días es UNO, no tres.

**«Se adjunta tal cual»** son los `.docx`, `.xls` y `.pptx`: no son formatos con
casillas, son guiones que el profesional redacta en Word o en Excel. No se
prediligencian a propósito — reescribirles el contenido los descuadraría sin
ganar nada (ver abajo el caso de Colmena).

⚠️ **Falta el informe de gestión de Bolívar.** Las asistencias técnicas lo
exigen, pero lo único que entregó el cliente es un ejemplo **ya diligenciado**,
con la razón social y el NIT de una empresa real y el nombre y el número de
licencia del profesional que lo firmó. No se versiona por eso. Mientras tanto la
regla se lo pide al profesional como soporte y el correo se lo advierte; hay que
pedirle a la ARL (o al cliente) el formato en blanco.

La carpeta de AXA Colpatria se llama `colpatria` porque así se le llama aquí; el
nombre en la BD es "AXA Colpatria" y `carpetaArl()` hace la traducción.

## Bolívar · nombres de campo

Los dos PDF traen formulario, pero sus campos se llaman `Text2`, `13`, `27`…
como los dejó quien diseñó el formato. La correspondencia con la etiqueta
impresa está anotada campo a campo en `camposAsistenciaBolivar()` y
`camposSeguimientoBolivar()`; **al reemplazar un formato por una versión nueva
de la ARL hay que revisar esos dos mapas**, porque los nombres de campo no
tienen por qué mantenerse.

### Los grupos de opción del AT-031

Son tres: `Group1` (**Tipo de Actividad**, seis botones: A · T · C · E · M · O),
`Group2` (**Tipo de Servicio**: Presencial · Virtual) y `Group3` (**¿Próxima
reunión?**: SÍ · NO).

Los seis botones de cada grupo **comparten el mismo valor de exportación**
(`Opción1`), tal como los dejó quien diseñó el formato, así que
`form.getRadioGroup('Group1').select('Opción1')` **los enciende todos a la vez**.
Por eso los dos primeros grupos estuvieron sin marcar hasta ago-2026 y la
casilla se rellenaba a bolígrafo sobre el impreso.

Desde ago-2026 se marcan **dibujando una equis sobre el rectángulo del widget
elegido** (`marcarOpcion()` en el servicio), igual que se rellenan los formatos
planos. El grupo se queda sin valor, que en un papel que se imprime da igual, y
el resultado no depende de cómo cada visor resuelva un grupo ambiguo. El índice
del botón sale de `src/utils/bolivar.js`, cuyas listas están **en el mismo orden
en que están impresas las casillas**: reordenarlas mueve la marca.

`Group3` (¿Próxima reunión?) sigue sin marcarse a propósito: es un dato de la
sesión, y solo se sabe cuando la visita ya ocurrió.

Para volver a medir los rectángulos si la ARL publica otra versión del formato:
`node scripts/inspeccionar-formato.mjs "<pdf>" --y <min> <max>`, que lista los
widgets de cada grupo junto al texto impreso con su coordenada `x`.

## Los PDF planos · coordenadas

No traen formulario, así que el valor se **dibuja encima de la raya impresa** en
las coordenadas de `CASILLAS_*` del servicio, medidas sobre estos archivos
concretos. Si la ARL publica otra versión del formato hay que volver a medirlas.

**Cómo medirlas, y por qué no basta con el texto.** Lo primero que se intenta es
listar las etiquetas con su posición y deducir dónde va cada valor. No funciona:
en una tabla el rótulo puede estar encima de su celda, a la izquierda o dentro, y
deducirlo produce un PDF impecable con los datos en la columna de al lado. Hay
que **ver el formato**:

```bash
# 1. la hoja entera, para reconocer la estructura
node scripts/inspeccionar-formato.mjs "<pdf>" --png /tmp/f.png --escala 2
# 2. la zona concreta, ampliada, para medir la casilla (coordenadas PDF)
node scripts/inspeccionar-formato.mjs "<pdf>" --png /tmp/z.png --escala 4 --zona 60 890 830 1000
# 3. el texto con su x/y, ya sabiendo qué se busca
node scripts/inspeccionar-formato.mjs "<pdf>" --y 890 1000
```

Y **después de rellenarlo, volver a renderizarlo**: es la única comprobación que
distingue "el valor está en el PDF" de "el valor está donde tiene que estar".

### El PSP-F-007 de Colmena · la fecha se deja a mano

Sus casillas DD/MM/AAAA miden 33 pt y llevan el rótulo impreso **dentro**, sin
renglón libre encima ni debajo: el número solo cabe pisando el rótulo, y un
formato que sale con `01` encima de `DD` parece un error del sistema. En papel se
rellena a bolígrafo, y la fecha va igualmente en los otros dos formatos de
Colmena. La casilla PERSONA NATURAL / PERSONA JURÍDICA tampoco se marca: es una
declaración sobre la figura legal del proveedor y la plataforma no guarda ese
dato.

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
