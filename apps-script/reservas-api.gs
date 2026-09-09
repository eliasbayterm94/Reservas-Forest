// ═══════════════════════════════════════════════════════════════
// FOREST RESERVAS — Apps Script API v12
// Lee solo columnas A–V (datos puros, sin fórmulas).
// Calcula W, X, Y, Z, AA directamente en JavaScript.
//
// CAMBIOS RESPECTO A v11:
//   - Se expone el campo "fecha_reserva" (columna Q) en el JSON de salida.
//     Ya se leía para calcular dias_reserva, pero no se emitía. Lo necesita
//     la pestaña "Control Inventario" para la vista de Reservas Vencidas.
//     Único cambio funcional: una línea en rows.push().
// ═══════════════════════════════════════════════════════════════

const SHEET_ID  = "1UYREKkSoUPOX2hKfiZNxfgr2tylNDxNn6pzrsZ3tcqw";
const SHEET_GID = "1973971668";

// Índices en el array leído (A=0 … V=21) — solo 22 columnas
const C = {
  bodega:         0,  // A
  cliente:        1,  // B
  cafe:           2,  // C
  ico:            3,  // D
  cantidad:       4,  // E
  tipo:           7,  // H
  eta:            9,  // J  ← ETA Bodega (HOY()-J = días vejez)
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
  last_delivery:  21, // V  ← last_delivery: si existe, cambia lógica de fees
};

// Caché en chunks (límite Apps Script: 100 KB por key)
const CACHE_PREFIX = 'fv11_chunk_';
const CACHE_META   = 'fv11_meta';
const CACHE_SECS   = 60 * 60 * 4; // 4 horas
const CHUNK_SIZE   = 90000;

// Tasas por bodega
const WH_RATE   = { EU:1.4, UK:1.4, AU:2.5, MENA:4, DEFAULT:1.05 };
const FIN_RATE  = { EU:0.0062, UK:0.0054, AU:0.0103, MENA:0.0072*3.6725, DEFAULT:2.2046*0.0072 };

// ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const force = e && e.parameter && e.parameter.refresh === '1';
    const json  = force ? null : leerCache();
    if (json) {
      Logger.log("✅ Cache hit");
      return out(json);
    }
    Logger.log("🔄 Cache miss — leyendo sheet");
    const data    = leerSheet();
    const jsonStr = JSON.stringify(data);
    guardarCache(jsonStr);
    return out(jsonStr);
  } catch(err) {
    Logger.log("❌ " + err.message);
    return out(JSON.stringify({ error: err.message }));
  }
}

function out(json) {
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// LECTURA: UNA SOLA llamada getValues(), solo A–V (22 cols)
// ─────────────────────────────────────────────────────────────
function leerSheet() {
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  let sheet    = sheets.find(s => String(s.getSheetId()) === String(SHEET_GID));
  if (!sheet) sheet = sheets[0];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return vacío();

  // ✅ UNA sola llamada — solo columnas A a V (22 columnas, sin W..AA)
  const data = sheet.getRange(2, 1, lastRow - 1, 22).getValues();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const rows = [];

  for (let i = 0; i < data.length; i++) {
    const r = data[i];

    // Filtro rápido por estado (col K = índice 10)
    const estadoRaw = String(r[10] || '').toUpperCase().trim();
    const esFact = estadoRaw.includes("FACTURADO") || estadoRaw.includes("FACT");
    const esRes  = estadoRaw.includes("RESERVADO") || estadoRaw.includes("RESERV");
    if (!esFact && !esRes) continue;

    const cliente = String(r[C.cliente] || '').trim();
    const cafe    = String(r[C.cafe]    || '').trim();
    if (!cliente && !cafe) continue;

    const estado = esFact ? "FACTURADO SIN ROTAR" : "RESERVADO";
    const tipo   = String(r[C.tipo] || '').toUpperCase().trim() === "SPOT" ? "SPOT" : "CONTRACT";
    const bodega = String(r[C.bodega] || '').trim().toUpperCase();
    const bod    = WH_RATE[bodega] ? bodega : 'DEFAULT'; // clave normalizada

    // Cantidad
    const cantidad = toInt(r[C.cantidad]);

    // Fechas clave
    const etaDate            = toDate(r[C.eta]);           // J - ETA Bodega
    const fechaReservaDate   = toDate(r[C.fecha_reserva]); // Q
    const lastDeliveryDate   = toDate(r[C.last_delivery]); // V

    // ── W: Días de Vejez = HOY() - J (ETA)
    // =SI(estado activo, SI(J="","", HOY()-J), "")
    let diasVejez = null;
    if (etaDate) {
      diasVejez = Math.floor((todayMs - etaDate.getTime()) / 86400000);
    }

    // ── X: Días de Reserva
    // =SI(Q="","Sin Fecha", SI(Q<J, HOY()-J, HOY()-Q))
    let diasReserva = null;
    if (!fechaReservaDate) {
      diasReserva = null; // "Sin Fecha" → null
    } else if (etaDate && fechaReservaDate < etaDate) {
      // Q < J → HOY() - J
      diasReserva = etaDate ? Math.floor((todayMs - etaDate.getTime()) / 86400000) : null;
    } else {
      // HOY() - Q
      diasReserva = Math.floor((todayMs - fechaReservaDate.getTime()) / 86400000);
    }

    // ── Y: Warehouse Storage Fee
    // Lógica: si V<>"" (tiene last_delivery):
    //   si X<0 → ""  else E * tasa_bodega
    // si no:
    //   si Q="" → ""
    //   si SPOT: si X>=60 → E*tasa else ""
    //   si CONTRACT: si X>=180 → E*tasa else ""
    const tasaWH = WH_RATE[bod] || WH_RATE.DEFAULT;
    let warehouseFee = 0;
    if (lastDeliveryDate) {
      if (diasReserva !== null && diasReserva >= 0) {
        warehouseFee = cantidad * tasaWH;
      }
    } else {
      if (fechaReservaDate) {
        const umbral = tipo === "SPOT" ? 60 : 180;
        if (diasReserva !== null && diasReserva >= umbral) {
          warehouseFee = cantidad * tasaWH;
        }
      }
    }

    // ── Z: Finance Fee
    // Usa T (precio_kg) si existe, sino R (pallet_price); × S (bag_size) × E × tasa_fin
    // si V<>"": si X<0 → "" else (T||R)*E*tasa
    // si no: misma lógica de umbrales SPOT/CONTRACT
    const tasaFIN = FIN_RATE[bod] || FIN_RATE.DEFAULT;
    const precioKg    = toNum(r[C.precio_kg]);    // T
    const palletPrice = toNum(r[C.pallet_price]);  // R
    const bagSize     = toNum(r[C.bag_size]);       // S
    const precioBase  = precioKg > 0 ? precioKg : palletPrice;

    let financeFee = 0;
    if (lastDeliveryDate) {
      if (diasReserva !== null && diasReserva >= 0) {
        financeFee = precioBase * cantidad * tasaFIN;
      }
    } else {
      if (fechaReservaDate) {
        const umbral = tipo === "SPOT" ? 60 : 180;
        if (diasReserva !== null && diasReserva >= umbral) {
          // Con last_delivery: usa T o R; sin last_delivery: usa R*S*E
          financeFee = palletPrice * bagSize * cantidad * tasaFIN;
        }
      }
    }

    // ── AA: Fee en (días hasta que aplica el fee, negativo = ya aplica)
    // si V<>"": SI(J>V, (J+30)-HOY(), V-HOY())
    // si no:    SI(Q="","", SI(SPOT, 60-X, 180-X))
    let feeEn = null;
    if (lastDeliveryDate) {
      if (etaDate) {
        if (etaDate > lastDeliveryDate) {
          // (J+30) - HOY()
          feeEn = Math.floor((etaDate.getTime() + 30*86400000 - todayMs) / 86400000);
        } else {
          // V - HOY()
          feeEn = Math.floor((lastDeliveryDate.getTime() - todayMs) / 86400000);
        }
      }
    } else {
      if (fechaReservaDate && diasReserva !== null) {
        const umbral = tipo === "SPOT" ? 60 : 180;
        feeEn = umbral - diasReserva;
      }
    }

    // Factura (ignorar booleanos)
    let factura = String(r[C.factura] || '').trim();
    if (factura.toUpperCase() === "TRUE" || factura.toUpperCase() === "FALSE") factura = "";

    rows.push({
      bodega:         String(r[C.bodega]    || '').trim(),
      cliente,
      cafe,
      ico:            String(r[C.ico]       || '').trim(),
      cantidad,
      tipo,
      estado,
      contrato:       String(r[C.contrato]  || '').trim(),
      comercial:      String(r[C.comercial] || '').trim(),
      factura,
      serie:          String(r[C.serie]     || '').trim(),
      pallet_price:   palletPrice,
      bag_size:       bagSize,
      precio_kg:      precioKg,
      fecha_reserva:  toFechaISO(r[C.fecha_reserva]),
      first_delivery: toFechaISO(r[C.first_delivery]),
      last_delivery:  toFechaISO(r[C.last_delivery]),
      eta:            toFechaISO(r[C.eta]),
      dias:           diasVejez,
      dias_reserva:   diasReserva,
      warehouse_fee:  warehouseFee > 0 ? Math.round(warehouseFee) : null,
      finance_fee:    financeFee  > 0 ? Math.round(financeFee)    : null,
      fee_en:         feeEn,
    });
  }

  Logger.log("✅ Rows: " + rows.length);
  return {
    rows,
    updated: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd MMM yyyy HH:mm"),
    total:   rows.length,
    bags:    rows.reduce((s, r) => s + r.cantidad, 0),
  };
}

function vacío() {
  return { rows: [], updated: now(), total: 0, bags: 0 };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function toInt(v) {
  const n = toNum(v);
  return Math.round(n);
}

function toDate(v) {
  if (!v || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number' && v > 1000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d) ? null : d;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function toFechaISO(v) {
  const d = toDate(v);
  if (!d) return null;
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd MMM yyyy HH:mm");
}

// ─────────────────────────────────────────────────────────────
// CACHÉ EN CHUNKS (límite 100KB por key)
// ─────────────────────────────────────────────────────────────
function guardarCache(json) {
  try {
    const cache   = CacheService.getScriptCache();
    const entries = {};
    let   chunks  = 0;
    for (let i = 0; i < json.length; i += CHUNK_SIZE) {
      entries[CACHE_PREFIX + chunks] = json.slice(i, i + CHUNK_SIZE);
      chunks++;
    }
    entries[CACHE_META] = String(chunks);
    cache.putAll(entries, CACHE_SECS);
    Logger.log("📦 Cache: " + json.length + " bytes en " + chunks + " chunks");
  } catch(err) {
    Logger.log("⚠️ Cache error: " + err.message);
  }
}

function leerCache() {
  try {
    const cache    = CacheService.getScriptCache();
    const metaStr  = cache.get(CACHE_META);
    if (!metaStr) return null;
    const n    = parseInt(metaStr, 10);
    const keys = Array.from({ length: n }, (_, i) => CACHE_PREFIX + i);
    const all  = cache.getAll(keys);
    for (const k of keys) { if (!all[k]) return null; }
    return keys.map(k => all[k]).join('');
  } catch(err) {
    Logger.log("⚠️ Cache read error: " + err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// TRIGGER: calienta el caché cada 3 horas automáticamente
// Ejecuta setupTrigger() UNA SOLA VEZ manualmente
// ─────────────────────────────────────────────────────────────
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'calentarCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('calentarCache').timeBased().everyHours(3).create();
  Logger.log("✅ Trigger creado");
}

function calentarCache() {
  const data = leerSheet();
  guardarCache(JSON.stringify(data));
  Logger.log("🔥 Cache calentado: " + data.rows.length + " filas");
}

// ─────────────────────────────────────────────────────────────
// TEST — ejecutar desde el editor para verificar tiempos
// ─────────────────────────────────────────────────────────────
function testLeer() {
  const t0   = new Date();
  const data = leerSheet();
  Logger.log("⏱ " + ((new Date()-t0)/1000).toFixed(2) + "s | " + data.rows.length + " filas | " + data.bags + " bags");
  data.rows.filter(r => r.warehouse_fee > 0).slice(0, 3).forEach((r, i) => {
    Logger.log(`[${i+1}] ${r.cliente} | dr=${r.dias_reserva} | wh=${r.warehouse_fee} | fin=${r.finance_fee} | fee_en=${r.fee_en}`);
  });
}
