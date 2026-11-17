# Spec: Nueva pestaña "Control de Inventario"

Estado: Aprobada — en progreso (Fase A1)
Fecha: 2026-09-09
Rama: feature/tab-control-inventario

## Contexto

Existe un dashboard independiente (`Dashboard Control Inventario.html`, 2.048 líneas)
con 3 módulos de análisis de inventario de café verde, documentado en
`Manual_Dashboard_Control_Inventario.md`. Hoy vive como archivo suelto, se
alimenta de Google Sheets vía `gviz` CSV y arranca desde un snapshot de datos
embebido en el propio HTML.

Se quiere integrarlo a la app Forest como una pestaña más, con datos en vivo.

## Objetivo

Que el dashboard de Control de Inventario funcione como una pestaña dentro de
`index.html`, leyendo datos en vivo, sin snapshot embebido y sin romper ninguna
funcionalidad existente.

## Alcance

- Nueva pestaña de primer nivel en la barra de tabs de `index.html`.
- Los 3 módulos del dashboard: Estatus de Inventario Actual, Movimiento Mensual,
  Alertas de Vejez.
- Capa de datos vía Apps Script Web App que devuelve JSON procesado.
- Adaptación visual al design system Forest.

## Fuera de alcance

- Unificar las dos definiciones de "rotación" que quedarán conviviendo en la app
  (la de la pestaña Rotación & Vejez, desde `19E-_Kj1…`, y la de esta pestaña
  nueva, desde `15CQqV…`). Se documenta el solapamiento, no se resuelve aquí.
- Cambios en las pestañas existentes (Reservas, Cartera, Historial, Cartera
  Comisiones, Rotación & Vejez, Management).
- Migrar las fuentes de la app actual a Apps Script.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Nombre en la UI | **"Control Inventario"** |
| Ubicación | Pestaña de primer nivel, **no** dentro de Management |
| Acceso | Protegida con el **mismo código** que ya usa Management |
| Frescura | Caché de **1 h** + botón "Actualizar" que fuerza `?refresh=1` |
| Arquitectura | **Script B en proyecto aparte** (no se mezcla con Reservas) |
| Carga de datos | **100% en vivo**, sin snapshot embebido |
| Diseño | **Adaptado al design system Forest** |
| Mecanismo de datos | **Apps Script Web App → JSON**, no `gviz` CSV directo |
| Ventas | Incluidas, **agregadas del lado del servidor** (~100 KB en vez de 3,67 MB) |

## Fuentes de datos

### Verificado en vivo (2026-09-09)

| Fuente | Archivo | Estado | Volumen |
|---|---|---|---|
| `CONSOLIDADO` | `15CQqV…` (público) | ✅ HTTP 200 | 355 filas · 63 KB |
| `Informe Inventario 22+` | `15CQqV…` (público) | ✅ HTTP 200 | 11.644 filas · **3,67 MB** · ene-2025 → sep-2026 |
| `Drilldown Posiciones` | `1UYRE…` gid `1973971668` (privado) | ❌ HTTP 401 vía gviz | — |
| `API_URL` (Apps Script v11) | sirve ese mismo Drilldown | ✅ HTTP 200 | 389 filas · 161 KB |

**El 401 no es un bloqueo.** Revisado el `doGet` (Forest Reservas API v11), sus
constantes son `SHEET_ID = "1UYRE…"` y `SHEET_GID = "1973971668"` — exactamente
la hoja privada. `API_URL` ya la sirve como JSON, corriendo con los permisos del
dueño. No hay que cambiar permisos ni construir un script para el Drilldown.

### Reconciliación en vivo: API de Reservas vs CONSOLIDADO

| Medición | Resultado |
|---|---|
| ICOs del API que están On Spot en CONSOLIDADO | 212 |
| Bolsas reservadas que coinciden exacto | **182 (86%)** |
| Difieren (por 1–8 bolsas) | 30 |
| ICOs del API en On Float | 12 |
| ICOs del API ausentes del CONSOLIDADO | 31 |

Los 31 ausentes corresponden a la "brecha de reconciliación" documentada en la
sección 8 del manual. El dashboard ya los descarta con
`if(!invIcoSetOnSpot.has(ico)) return;`.

### CONFIRMADO: `API_URL` sirve `Drilldown Posiciones`

Revisado el código de `generarDrilldownPosiciones()` (v4), el script que genera
la hoja. El layout que produce calza con el payload de `API_URL` en 17 de 18
campos:

| Col | Campo generado | Campo en `API_URL` |
|---|---|---|
| A | Bodega | `bodega` |
| B | Cliente | `cliente` |
| C | Cafe | `cafe` |
| D | ICO | `ico` |
| E | Cantidad | `cantidad` |
| H | Spot/Contrato? | `tipo` (SPOT/CONTRACT) |
| J | ICO ETA | `eta` |
| K | Estado (fórmula) | `estado` |
| L | Contrato | `contrato` |
| M | Comercial | `comercial` |
| O | Factura # | `factura` |
| P | Serie | `serie` |
| **Q** | **Fecha Reserva** | ⚠️ **no expuesta** (solo `dias_reserva`) |
| R | Pallet Price | `pallet_price` |
| S | Bag Size | `bag_size` |
| T | Price Per KG | `precio_kg` |
| U | First Delivery | `first_delivery` |
| V | Last Delivery | `last_delivery` |

La fórmula de la columna K produce 4 estados (`RESERVADO`,
`FACTURADO SIN ROTAR`, `DESPACHADO`, `INCONSISTENTE`) y `API_URL` solo devuelve
los dos primeros (324 + 65 = 389 filas). El `doGet` ya aplica **el mismo filtro
que el dashboard** (`['RESERVADO','FACTURADO SIN ROTAR']`).

**Consecuencia:** no hay que construir un Apps Script para el Drilldown. Basta
con extender el `doGet` existente para exponer `fecha_reserva` (columna Q).

### Cadena de datos y frescura real

```
Offering Lists ─┐
CONSOLIDADO     ├─[trigger: generarDrilldownPosiciones]─> Drilldown Posiciones
CONTRATOS       ┘                                                │
                                          [trigger: calentarCache cada 3 h]
                                          [CacheService TTL: 4 h]
                                                                 ▼
                                                           API_URL ──> app
```

`API_URL` cachea en `CacheService` con TTL de 4 h (`CACHE_SECS = 60*60*4`) y un
trigger `calentarCache` lo recalienta cada 3 h. `?refresh=1` salta ese caché,
pero **no** vuelve a correr `generarDrilldownPosiciones()`.

**Implicación:** la parte de reservas de la pestaña nueva puede mostrar datos de
hasta 3–4 h atrás, más el desfase del generador del Drilldown. El inventario
(CONSOLIDADO) sí puede ser al minuto, porque se lee directo.

### `fecha_reserva`: cambio de una línea en Script A

El `doGet` ya lee la columna Q (`C.fecha_reserva: 16`) y la usa para calcular
`dias_reserva`, pero no la emite. Basta agregar al `rows.push({...})`:

```js
fecha_reserva:  toFechaISO(r[C.fecha_reserva]),
```

y redesplegar.

## Restricciones técnicas detectadas

1. **Colisión de variables globales.** El dashboard declara `DATA`, `CATEGORIES`,
   `REGIONS`, `activeRegion`, `activeCategory`, `statusFilter`. `index.html` ya
   tiene un `DATA` global (el array de reservas). Pegar el JS tal cual rompe la
   app — hay que encapsular en IIFE/namespace.
2. **Aislamiento de CSS.** El dashboard trae sus propios tokens (`--age-1..7`,
   colores por región) que no deben filtrarse a las otras pestañas.
3. **Dependencia nueva.** El dashboard usa PapaParse; `index.html` ya tiene su
   propio `parseCSV()`. Decidir si se agrega la dependencia o se reutiliza.
4. **Peso.** Con las ventas agregadas en el servidor el problema se neutraliza,
   pero hay que confirmar el tamaño real del payload agregado.
5. **Despliegue.** El código del Apps Script lo puede escribir Claude, pero
   **el despliegue lo hace la usuaria** en script.google.com — requiere su cuenta
   de Google.

## Arquitectura de la capa de datos

| | Rol | Cambio | Riesgo |
|---|---|---|---|
| **Script A** — existente (`API_URL`) | Reservas / Drilldown Posiciones | +1 línea (`fecha_reserva`) y redesplegar | Mínimo |
| **Script B** — nuevo, proyecto aparte | CONSOLIDADO crudo + ventas agregadas | Código nuevo; despliegue por la usuaria | Cero sobre Reservas |

Script B va en un **proyecto separado** para que un fallo suyo no pueda afectar
la pestaña de Reservas, que es crítica y ya está en producción.

Reparto de cálculo:

- **En el servidor (Script B):** agregación de ventas — mensual por
  región/categoría, top 5, vejez al vender, KG vendidos 12 m. Es aritmética
  estable que casi nunca cambia, y es la que pesa (3,67 MB → ~150 KB).
- **En el navegador (`index.html`):** lógica de inventario, alertas, criticidad
  y cruce con reservas. Es la que más se va a ajustar con el uso, y conviene
  poder cambiarla editando el HTML sin redesplegar nada.

## Requisitos funcionales

El comportamiento funcional de los 3 módulos es **el que ya describe
`Manual_Dashboard_Control_Inventario.md`** (secciones 2 a 5). Ese documento es la
referencia; aquí solo se listan los cambios respecto a él.

| # | Requisito | Delta vs. el dashboard original |
|---|---|---|
| RF-1 | Pestaña "Control Inventario" de primer nivel, protegida con el código de Management | nuevo |
| RF-2 | Datos siempre en vivo; no existe snapshot embebido | cambia: antes arrancaba de snapshot |
| RF-3 | Carga perezosa: solo consulta al abrir la pestaña por primera vez | nuevo |
| RF-4 | Botón "Actualizar" que fuerza `?refresh=1` en ambos scripts | equivalente al botón original |
| RF-5 | Reservas y cruce cliente↔ICO desde `API_URL` (Script A) | cambia: antes leía el sheet por gviz |
| RF-6 | Inventario y ventas desde Script B | cambia: antes gviz directo, ventas sin agregar |
| RF-7 | Los 3 módulos conservan filtros, ordenamientos y clics del original | sin cambio |
| RF-8 | Estética adaptada al design system Forest | cambia |
| RF-9 | No se altera ninguna pestaña existente | restricción |

### Nota sobre las dos rotaciones

La app tendrá dos cifras de "rotación" calculadas distinto y desde archivos
distintos: la de `Rotación & Vejez` (desde `19E-_Kj1…`, ponderada por región) y
la de esta pestaña (`KG vendido 12m ÷ KG inventario hoy`, desde `15CQqV…`).

**Decisión:** se añade una nota al pie visible en las tablas de rotación de la
pestaña nueva, indicando la fórmula usada y que no es comparable con la de
`Rotación & Vejez`. No se unifican las fuentes en esta spec.

## Criterios de aceptación

| # | Criterio | Cómo se verifica |
|---|---|---|
| CA-1 | Las 6 pestañas existentes siguen funcionando igual | Recorrido manual de cada una, comparando contra producción |
| CA-2 | No hay errores en consola al cargar la app ni al cambiar de pestaña | DevTools console limpia |
| CA-3 | La pestaña pide el código de Management y solo entra con el correcto | Probar código válido e inválido |
| CA-4 | Con la pestaña cerrada, la app no consulta Script A ni B | Pestaña Network: cero requests hasta abrir la tab |
| CA-5 | Los KPIs y tablas del Módulo 1 cuadran con `CONSOLIDADO` | Contraste manual de totales KG y nº de lotes |
| CA-6 | El Módulo 2 cuadra con `Informe Inventario 22+` | Contraste de KG vendidos de un mes contra el sheet |
| CA-7 | "Reservas Vencidas" usa `last_delivery` real y muestra `fecha_reserva` | Contraste contra `API_URL` con el campo nuevo |
| CA-8 | El payload de Script B pesa menos de 300 KB | Medición del response |
| CA-9 | El botón "Actualizar" trae datos nuevos saltando el caché | Comparar `updated` antes y después |
| CA-10 | Funciona en móvil: sin scroll horizontal de página, tablas con scroll propio | Prueba en viewport 375px |
| CA-11 | Los colores de la pestaña nueva no se filtran a las demás | Inspección visual tras navegar entre tabs |

## Preguntas abiertas / supuestos

> Debe quedar vacío antes de aprobar la spec.

Ninguna bloqueante. Queda un dato pendiente de documentar, que **no impide
implementar**:

- **Frecuencia del trigger** de `generarDrilldownPosiciones()` — necesario para
  documentar la frescura máxima real de la parte de reservas. Se consulta en
  Apps Script → Activadores.

### Resueltas

- ~~**Nombre de la pestaña**~~ — ✅ "Control Inventario".
- ~~**TTL de caché**~~ — ✅ 1 h + botón "Actualizar" con `?refresh=1`.
- ~~**Arquitectura**~~ — ✅ Script B en proyecto aparte.
- ~~**Dos rotaciones**~~ — ✅ nota al pie en las tablas de la pestaña nueva.
- ~~**`Fecha Reserva`**~~ — ✅ existe como columna Q; el `doGet` ya la lee, solo
  falta emitirla (una línea).
- ~~**Script para el Drilldown**~~ — ✅ no hace falta: `API_URL` ya lo sirve.
- ~~**El 401 del Drilldown**~~ — ✅ no es bloqueo; no hay que tocar permisos.
- ~~**Código del `doGet`**~~ — ✅ recibido y analizado (Forest Reservas API v11).

## Fases de implementación

Cada fase es un commit independiente y verificable. Se cierra una antes de
empezar la siguiente, mostrando el resultado.

### Fase A1 — Script A: exponer `fecha_reserva`
Agregar una línea al `rows.push({...})` del `doGet` y redesplegar.
- **Hace Claude:** entrega la línea exacta y dónde va.
- **Hace la usuaria:** pega y redespliega.
- **Verificación:** `API_URL` devuelve `fecha_reserva` con formato ISO.

### Fase A2 — Script B: inventario + ventas agregadas
Proyecto nuevo de Apps Script: lee `CONSOLIDADO` (crudo) e
`Informe Inventario 22+` (agregado), caché 1 h, soporta `?refresh=1`.
- **Hace Claude:** escribe el `Code.gs` completo + instrucciones de despliegue.
- **Hace la usuaria:** crea el proyecto, pega, despliega y entrega la URL.
- **Verificación:** el endpoint responde JSON con la forma acordada y pesa <300 KB (CA-8).

### Fase B — Andamiaje + design system
Tab "Control Inventario", gate de código, contenedor aislado, carga perezosa, y
**el mapeo de tokens Forest desde el inicio** (para no repintar después).
- **Verificación:** CA-1, CA-2, CA-3, CA-4. La tab entra y muestra el nº de
  registros cargados. Nada existente se rompe.

### Fase C — Módulo 1: Estatus de Inventario Actual
KPIs, filtro On Spot/On Float/Ambos, y las 6 secciones del manual.
- **Verificación:** CA-5.

### Fase D — Módulo 2: Movimiento Mensual
Tabla mensual por categoría + Top 5.
- **Verificación:** CA-6.

### Fase E — Módulo 3: Alertas de Vejez
Las 4 vistas (A, B, B2, C), criticidad, e ICOs por Grupo.
- **Verificación:** CA-7.

### Fase F — Pulido visual y consistencia
Repaso de detalles contra el design system, nota al pie de rotación.
- **Verificación:** CA-11.

### Fase G — Móvil y cierre
Viewport 375px, scroll de tablas, botón Actualizar.
- **Verificación:** CA-9, CA-10, y repaso completo de CA-1 a CA-11.

## Reparto de trabajo

| | Claude | Usuaria |
|---|---|---|
| Código Apps Script | escribe | revisa |
| **Despliegue Apps Script** | — | **despliega** (requiere su cuenta Google) |
| Código `index.html` | escribe | revisa |
| Verificación por fase | ejecuta y muestra | confirma antes de seguir |
| Merge a producción | abre el PR | **aprueba** |
