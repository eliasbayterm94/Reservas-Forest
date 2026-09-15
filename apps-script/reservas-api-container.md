# API de Reservas — traer la columna AB (Container)

Ref: proyecto de Apps Script del **API de Reservas** (el de `Drilldown Posiciones`),
NO el del dashboard. Es el que tiene `leerSheet()`, `calentarCache()` y `setupTrigger()`.

## Por qué hace falta

El `doGet` lee **solo las columnas A–V** (22 columnas) para ahorrar tiempo. La columna
AB es la número 28, así que hoy ni siquiera se lee. Por eso el payload no la trae y la
app no puede mostrarla.

Son tres cambios pequeños, todos en la función `leerSheet()` salvo el primero.

---

## 1. Declarar la columna

Busca el objeto `const C = {` (el mapa de índices) y agrega la última línea:

```js
const C = {
  bodega:         0,  // A
  cliente:        1,  // B
  cafe:           2,  // C
  ico:            3,  // D
  cantidad:       4,  // E
  tipo:           7,  // H
  eta:            9,  // J
  estado:         10, // K
  contrato:       11, // L
  comercial:      12, // M
  factura:        14, // O
  serie:          15, // P
  fecha_reserva:  16, // Q
  pallet_price:   17, // R
  bag_size:       18, // S
  precio_kg:      19, // T
  first_delivery: 20, // U
  last_delivery:  21, // V
  contenedor:     27, // AB  ← NUEVA
};
```

Los índices van desde 0, así que AB (la columna 28) es el índice 27.

## 2. Leer hasta AB, no hasta V

Busca esta línea dentro de `leerSheet()`:

```js
  const data = sheet.getRange(2, 1, lastRow - 1, 22).getValues();
```

Y reemplázala por estas dos:

```js
  // Se lee hasta AB (28 columnas) para incluir el contenedor. Si la hoja tuviera
  // menos columnas, se lee lo que haya en vez de reventar.
  const nCols = Math.min(28, sheet.getLastColumn());
  const data  = sheet.getRange(2, 1, lastRow - 1, nCols).getValues();
```

## 3. Incluirla en la respuesta

Dentro del `rows.push({ ... })`, junto al resto de campos de texto. Por ejemplo justo
después de la línea de `factura`:

```js
      factura,
      contenedor:     String(r[C.contenedor] || '').trim(),   // ← NUEVA
```

---

## Después de pegar

1. **Guardar** (Ctrl+S).
2. **Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar.**
3. Ejecutar **`calentarCache`** una vez desde el editor.

Ese último paso importa: el API cachea el payload 4 h, así que hasta que no se recalcule
seguirá entregando el de antes, sin contenedor. Y como el recálculo tarda más de lo que
Google aguanta en una petición web, hacerlo desde el editor es la vía fiable — igual que
hicimos con el dashboard.

## Cómo comprobar que quedó

En el log de `calentarCache` verás `🔥 Cache calentado: N filas`. Después, en la app, la
columna **Contenedor #** de Reservas Activas debe traer datos.

Ojo: en esa tabla hay **dos** columnas parecidas y no son lo mismo.

| Columna | Qué muestra |
|---|---|
| **Contenedor** | Spot / On float — calculado a partir de la ETA |
| **Contenedor #** | El contenedor real de la hoja (columna AB) |
