# Metodología de trabajo: Spec-Driven Development por fases

Este documento define cómo se planean e implementan los cambios en este
repositorio (Forest — Reservas Activas). Aplica a Claude y a cualquier
persona que contribuya.

## Rama de producción

`claude/amazing-euler-lrwa7p` es la rama de producción (`origin/HEAD`).
Netlify despliega desde ella. **Nunca se commitea directo ahí.**

## Reglas generales

1. **No asumir.** Si algo del pedido es ambiguo (alcance, fuente de datos,
   comportamiento esperado, caso borde), se pregunta antes de escribir
   código. Ninguna decisión de producto o de datos se rellena con un
   default silencioso.
2. **Spec antes que código.** Ningún cambio no trivial se implementa sin
   una spec aprobada en `specs/`.
3. **Fases pequeñas.** Cada spec se descompone en fases independientes,
   cada una revertible y verificable por separado.
4. **Control de versiones estricto.** Una rama de feature por spec, un
   commit por fase, PR para mergear a producción — nunca merge directo.
5. **Aprobación explícita.** Se pide confirmación del usuario en dos
   puntos obligatorios: (a) al aprobar la spec, antes de tocar código, y
   (b) al aprobar el PR final hacia producción. También al cierre de cada
   fase intermedia si la spec lo marca como checkpoint.

## Flujo paso a paso

### Fase 0 — Intake
Antes de escribir la spec, se hacen todas las preguntas necesarias:
objetivo, quién lo usa, alcance, fuera de alcance, fuentes de datos
afectadas (`API_URL`, `CART_CSV_URL`, `VENTAS_CSV_URL`, `ROT_CSV_URL`,
`VEJEZ_CSV_URL`, `SEG_API_URL`, u otra nueva), criterios de aceptación,
casos borde.

### Fase 1 — Escribir la spec
Se crea `specs/YYYY-MM-DD-slug.md` usando `specs/TEMPLATE.md`. El campo
"Preguntas abiertas / supuestos" debe quedar vacío antes de pedir
aprobación.

### Fase 2 — Aprobación de la spec
El usuario aprueba explícitamente el contenido de la spec. Sin esto, no
se abre rama ni se toca `index.html`.

### Fase 3 — Rama e implementación por fases
- Se crea `feature/<slug>` desde la rama de producción.
- Cada fase definida en la spec = un commit propio, con mensaje siguiendo
  el estilo ya usado en el historial (`Área: descripción corta`).
- Al cerrar cada fase se verifica manualmente contra los criterios de
  aceptación de esa fase (con datos reales de los sheets conectados,
  Browser tool o preview de Netlify) y se muestra el resultado antes de
  continuar a la siguiente fase.

### Fase 4 — Pull Request
Al completar todas las fases de la spec, se abre un PR de
`feature/<slug>` hacia `claude/amazing-euler-lrwa7p` con `gh pr create`.
**El merge solo ocurre tras aprobación explícita del usuario** (en el PR
de GitHub o en el chat).

### Fase 5 — Cierre
- La spec pasa a estado `Hecha`.
- El PR queda mergeado y la rama de feature se puede borrar.

## Verificación (sin test suite)

Este proyecto es un único `index.html` sin build ni tests automatizados,
alimentado por Google Sheets/Apps Script en vivo. La verificación de cada
fase es manual y debe cubrir, cuando aplique:
- Datos reales (no solo casos felices)
- Filas/columnas vacías o faltantes en el sheet
- Vista móvil (el proyecto tiene ajustes específicos de scroll/menú móvil)
- Exportaciones afectadas (Excel/PDF/PNG) si la fase las toca
