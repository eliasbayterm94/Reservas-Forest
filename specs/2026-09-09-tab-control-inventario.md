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
| `Drilldown Posiciones` | `1UYRE…` (privado) | ❌ **HTTP 401** | no legible sin autenticación |
| `API_URL` (Reservas, Apps Script) | — | ✅ HTTP 200 | 389 filas · 161 KB |

El 401 del Drilldown es lo que motiva la capa Apps Script: un Web App corre con
los permisos del dueño y puede leer la hoja privada **sin volverla pública**.

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

### Hipótesis abierta

`API_URL` (el Apps Script que alimenta Reservas Activas) podría **ya estar
leyendo `Drilldown Posiciones`**. Evidencia:

| Campo que el dashboard necesita del Drilldown | Campo en `API_URL` |
|---|---|
| `Estado` (RESERVADO / FACTURADO SIN ROTAR) | `estado` — **valores idénticos** |
| `ICO` / `Cliente` / `Cantidad` / `Bag Size` / `Bodega` | `ico` / `cliente` / `cantidad` / `bag_size` / `bodega` |
| `Last Delivery` | `last_delivery` (123 de 389 filas con valor) |
| `Fecha Reserva` | `dias_reserva` (días, no fecha) — derivable |

Pendiente de confirmar leyendo el código del Apps Script. Si se confirma, no hay
que construir un script para el Drilldown: basta con extender el existente.

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

## Requisitos funcionales

Pendientes de detallar una vez se cierre la arquitectura de la capa de datos.

## Criterios de aceptación

Pendientes de detallar.

## Preguntas abiertas / supuestos

> Debe quedar vacío antes de aprobar la spec.

1. **Código del Apps Script existente** — la usuaria lo va a pegar. Define si se
   extiende el script actual o se construye uno nuevo para el Drilldown.
2. **`Fecha Reserva`** — ¿existe como fecha en el Drilldown? Necesaria para la
   vista "Reservas Vencidas"; en `API_URL` solo hay `dias_reserva`.
3. **Nombre exacto** de la pestaña en la UI.
4. **Payload agregado** — definir el contrato JSON exacto que devolverá el script
   de ventas, y verificar su tamaño real.
5. **Dos rotaciones conviviendo** — ¿se señala de alguna forma al usuario final
   que la rotación de esta pestaña se calcula distinto a la de Rotación & Vejez?

## Fases de implementación

Pendientes de definir una vez cierren las preguntas abiertas. Borrador tentativo:

- [ ] Fase A: Apps Script — capa de datos (código + despliegue por la usuaria)
- [ ] Fase B: Andamiaje de la pestaña en `index.html` (tab, gate de código, contenedor aislado)
- [ ] Fase C: Módulo 1 — Estatus de Inventario Actual
- [ ] Fase D: Módulo 2 — Movimiento Mensual
- [ ] Fase E: Módulo 3 — Alertas de Vejez
- [ ] Fase F: Adaptación al design system Forest
- [ ] Fase G: Verificación móvil y exportaciones
