# Consumo clientes — cómo implementarlo

La vista **Consumo clientes** vive en la pestaña **Control Inventario** de la app, al lado
del dashboard: un botón arriba cambia entre *Dashboard* y *Consumo clientes*.

Son dos piezas, y se implementan en este orden:

| # | Pieza | Dónde | Quién |
|---|---|---|---|
| 1 | `consumo-clientes.gs` + una línea en `doGet` | Proyecto de Apps Script de **Control de Inventario** (el del dashboard, sobre el Sheet *Inventario Actual*) | Laura |
| 2 | `index.html` | La app (Netlify despliega solo desde `main`) | Merge del PR |

El orden importa. Si la app sale antes que el script, el botón *Consumo clientes* muestra un
aviso de que el script no responde. El dashboard sigue funcionando igual.

---

## Parte 1 — Apps Script de Control de Inventario

### Paso 1. Abrir el proyecto correcto

Sheet **Inventario Actual** → **Extensiones → Apps Script**. Es el proyecto que tiene los
archivos `CacheDashboard` y `Dashboard`, **no** el del API de Reservas.

### Paso 2. Agregar el archivo nuevo

1. En la barra de archivos: **＋ → Secuencia de comandos**.
2. Nombre: `ConsumoClientes`.
3. Borra lo que trae por defecto y pega **todo** el contenido de
   [`consumo-clientes.gs`](consumo-clientes.gs).
4. Guarda (Ctrl+S).

No choca con nada: todo lo nuevo empieza por `cc` o `CC_`. Usa dos constantes que el
proyecto ya tiene, `DESTINO_SPREADSHEET_ID` y `SHEET_PARSER_ID`.

### Paso 3. Agregar una línea al `doGet`

Abre el archivo donde está `function doGet(e)`. Busca esta línea:

```js
    if (formato === 'embed') return ciServeEmbed_(forzar);   // ambos juntos (pesado)
```

Y **debajo** agrega esta:

```js
    if (formato === 'consumo') return ccServeJson_(forzar);  // consumo por cliente (consumo-clientes.gs)
```

Guarda (Ctrl+S). El `doGet` completo, ya con la línea, está en
[`doGet-completo.gs`](doGet-completo.gs).

### Paso 4. Calcular por primera vez

En el selector de funciones (arriba, junto a ▶ Ejecutar), elige **`calentarCacheConsumo`**
→ **▶ Ejecutar**.

- Si Google pide permisos, acéptalos. Son los mismos que ya tiene el dashboard.
- En el **Registro de ejecución** debe aparecer algo como
  `✅ Consumo: 1954 filas, 135 reservas sin cruzar, 294 KB, 12 s`.

Si sale un error, detente aquí y mándame el mensaje.

### Paso 5. Dejar el caché siempre caliente

Selector de funciones → **`crearTriggerConsumo`** → **▶ Ejecutar**. Se hace una sola vez.
Deja `calentarCacheConsumo` corriendo cada 2 h.

Es el mismo motivo que con el dashboard: recalcular desde las hojas tarda más de lo que
Google aguanta en una petición web. Sin el activador, cuando el caché vence (6 h) la vista
se queda sin datos hasta que alguien pulse *Actualizar*.

### Paso 6. Publicar la versión nueva

**Implementar → Administrar implementaciones → ✏️ (lápiz) → Versión: Nueva versión →
Implementar.**

⚠️ **No uses "Nueva implementación".** Esa crea una URL distinta y la app deja de encontrar
el dashboard. Tiene que ser el lápiz sobre la implementación que ya existe.

### Paso 7. Comprobar

Abre en el navegador la URL del script con `?format=consumo` al final:

```
https://script.google.com/macros/s/AKfycbztojL2jnqEOecJgi4Vg4YhZHpWRq45xIXeSS7h_IzJBbEhroS9jZI26LO0o0_6mIEjWw/exec?format=consumo
```

Debe mostrar un JSON que empieza por `{"meta":{"generado":…`. Si muestra el dashboard, el
paso 3 o el paso 6 no quedaron.

---

## Parte 2 — La app

Cuando el paso 7 funcione, se hace merge del PR con los cambios de `index.html` a `main`, y
Netlify lo publica solo.

Para comprobarlo: **Control Inventario** → ingresa el código → botón **Consumo clientes**.

---

## Opcional — corregir el cruce de clientes

En reservas los clientes vienen abreviados ("Almanac" en lugar de "Almanac Coffee"). El
script los empareja solo y acierta la mayoría. Para corregir los que falle:

1. Selector de funciones → **`crearHojaMapeoConsumo`** → **▶ Ejecutar**. Crea la pestaña
   **Consumo Mapeo** en *Inventario Actual*, con el cruce automático de hoy.
2. En la columna amarilla (B), escribe el nombre **exacto** como aparece en ventas, para las
   filas que estén mal o vacías.
3. Ejecuta **`calentarCacheConsumo`** para que la app tome el cambio. También se aplica
   solo en la siguiente corrida del activador.

---

## Qué muestra la vista

- **Tarjetas:**
  - Estimado mensual y proyección de los próximos 6 meses (después del mes en curso), en
    kg, sacos y cajas.
  - Lo facturado en esos mismos 6 meses un año antes, para comparar.
  - Lo reservado y lo que queda por cubrir.
  - Clientes **Recurrentes**, **En riesgo** y **Esporádicos**, con cuánto pesan en el
    estimado. Un clic en la tarjeta filtra por ese grupo.
- **Por cliente** (la vista que abre por defecto): estado, periodo de compra, meses con
  compra, última compra, días sin comprar, próxima compra estimada (en rojo si ya se
  pasó), cafés que compra y categorías, estimado mensual, proyección a 6 meses, reservado
  y por cubrir. En sacos y cajas, o en kg.
- **Por café:** clientes y recurrentes que lo compran, estimado, resto del mes, proyección
  a 6 meses, el mismo periodo del año anterior, reservado, por cubrir y cierre del año. En
  *Unidades* separa por presentación (70 kg, 35 kg, 24 kg), porque sacos de tamaños
  distintos no se suman. En *Kg* agrupa el café completo.
- **Detalle:** una fila por cliente × café × presentación. Muestra el estado del cliente, el
  periodo de ese café, una minigráfica de los últimos 12 meses, promedios, tendencia,
  última y próxima compra, proyección, reservas y meses cubiertos.
- **Clic en una fila** de *Por cliente* o *Por café*: abre el detalle filtrado por ese
  cliente o ese café.
- **Filtros:** región, categoría, estado, periodo, búsqueda por texto y cómo ponderar el
  estimado.
- **Excel:** descarga la vista actual, más las reservas sin cruzar y el mapeo de clientes.

### Cómo se calcula

- **Consumo:** ventas facturadas de *Informe Inventario 22+*, en unidades tal como se
  facturan. kg = unidades × presentación.
- **Meses:** los promedios usan meses completos. El mes en curso va aparte, y un mes sin
  compra cuenta como 0.
- **Estimado mensual:** promedio ponderado de los promedios de 3, 6 y 12 meses. Por defecto
  pesan igual; el selector de la vista lo cambia sin tocar el script.
- **Proyección a 6 meses:** estimado mensual × 6, para los 6 meses que siguen al mes en
  curso. Lo que falta del mes en curso (estimado − ya facturado, mínimo 0) va en su propia
  columna.
- **Por cubrir:** resto del mes + proyección − reservas *RESERVADO*, café por café.
  *FACTURADO SIN ROTAR* no suma, porque ya está facturado y cuenta como venta.
- **Pedido:** las facturas del mismo cliente a 7 días o menos entre sí cuentan como un solo
  pedido. Así, un despacho partido en dos facturas no parece una compra doble.
- **Periodo:** la mediana de días entre pedidos en los últimos 24 meses, contando cualquier
  café.

  | Periodo | Días típicos entre pedidos |
  |---|---|
  | Mensual | hasta 40 |
  | Bimensual | 41 a 75 |
  | Trimestral | 76 a 120 |
  | Semestral | 121 a 240 |
  | Irregular | más de 240 |
  | Una compra | un solo pedido, no hay intervalo |

- **Estado del cliente:**

  | Estado | Regla |
  |---|---|
  | Recurrente | Pedidos en 3 o más de los últimos 12 meses, y al día |
  | En riesgo | Cumple lo anterior, pero lleva más del doble de su intervalo (y al menos 60 días) sin comprar |
  | Esporádico | Pedidos en 1 o 2 de los últimos 12 meses |

  Los clientes sin compras en los últimos 12 meses no aparecen.
- **Próxima compra:** última compra + intervalo típico.
- **Clientes con dos nombres:** si un cliente está facturado con dos nombres que solo se
  diferencian en palabras como *Coffee*, *Roasters*, *Co* o *LLC*, y los dos compran en la
  **misma región**, la app los suma como uno. Queda el nombre con más volumen, con la marca
  "+1 nombre" al lado; la lista va en la hoja *Clientes unidos* del Excel. Si las regiones
  son distintas no se unen, porque pueden ser empresas diferentes (por ejemplo GOLD BOX
  ROASTERY LLC en MENA y Goldbox en UK).

Todos los cortes (días, meses, horizonte) están como constantes al comienzo del bloque
*Consumo clientes* de `index.html` (`CC_PERIODOS`, `CC_REC`, `CC_HORIZONTE`). Cambiarlos
no requiere tocar el script.

## Verificación hecha antes de entregarlo

- **Cálculo:** el del script se corrió fuera de Google con las ventas y reservas del
  2026-09-23. El estimado dio lo mismo que el Excel de ese día: 102.272 kg/mes. Con esos
  datos salen 599 clientes: 187 recurrentes (86.868 kg/mes, el 85 % del estimado), 29 en
  riesgo y 383 esporádicos.
- **App:** se probó con esos mismos datos, en escritorio y en celular. Se revisaron las
  tres vistas, unidades y kg, los filtros de estado y periodo, las tarjetas que filtran y
  el Excel.
- **Lo que no se pudo probar:** la ejecución real dentro de Apps Script (permisos y tiempos).
  Por eso el paso 4 se hace desde el editor, mirando el registro.
