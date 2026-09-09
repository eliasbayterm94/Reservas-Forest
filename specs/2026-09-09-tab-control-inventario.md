# Spec: Nueva pestaña "Control de Inventario"

Estado: Draft
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
| Ubicación | Pestaña de primer nivel, **no** dentro de Management |
| Acceso | Protegida con el **mismo código** que ya usa Management |
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

Pendientes de detallar una vez cierren las preguntas abiertas restantes.

## Criterios de aceptación

Pendientes de detallar.

## Preguntas abiertas / supuestos

> Debe quedar vacío antes de aprobar la spec.

1. **Nombre exacto** de la pestaña en la UI.
2. **Contrato JSON de Script B** — definir la forma exacta del payload agregado
   de ventas y verificar su tamaño real una vez implementado.
3. **TTL de caché de Script B** — qué tan fresco debe estar el inventario.
4. **Dos rotaciones conviviendo** — ¿se señala de alguna forma al usuario final
   que la rotación de esta pestaña se calcula distinto a la de Rotación & Vejez?
5. **Frecuencia del trigger** de `generarDrilldownPosiciones()` — dato que falta
   para poder documentar la frescura máxima real de la parte de reservas.

### Resueltas

- ~~**`Fecha Reserva`**~~ — ✅ existe como columna Q; el `doGet` ya la lee, solo
  falta emitirla (una línea).
- ~~**Script para el Drilldown**~~ — ✅ no hace falta: `API_URL` ya lo sirve.
- ~~**El 401 del Drilldown**~~ — ✅ no es bloqueo; no hay que tocar permisos.
- ~~**Código del `doGet`**~~ — ✅ recibido y analizado (Forest Reservas API v11).

## Fases de implementación

Pendientes de definir una vez cierren las preguntas abiertas. Borrador tentativo:

- [ ] Fase A: Apps Script — capa de datos (código + despliegue por la usuaria)
- [ ] Fase B: Andamiaje de la pestaña en `index.html` (tab, gate de código, contenedor aislado)
- [ ] Fase C: Módulo 1 — Estatus de Inventario Actual
- [ ] Fase D: Módulo 2 — Movimiento Mensual
- [ ] Fase E: Módulo 3 — Alertas de Vejez
- [ ] Fase F: Adaptación al design system Forest
- [ ] Fase G: Verificación móvil y exportaciones
