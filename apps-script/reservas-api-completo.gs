// ═══════════════════════════════════════════════════════════════
// FOREST RESERVAS — Apps Script API v13
// Lee las columnas A–V (datos puros, sin fórmulas) + AB (Container).
// Calcula W, X, Y, Z, AA directamente en JavaScript.
//
// CAMBIOS RESPECTO A v12:
//   Storage y Finance Fee siguen la política por bodega (ver "Política de
//   fees" más abajo): tarifas por bodega con tramos, cobro por día mes vencido, inicio
//   según SPOT / CONTRACT, y cada fee con su moneda (wh_cur / fin_cur).
//   Ya no coinciden con las columnas Y / Z de la hoja.
//
// CAMBIOS DE v12 RESPECTO A v11:
//   1. Se expone "contenedor" (columna AB, índice 27). W..AA son las columnas
//      calculadas, así que AB queda justo después del rango de datos.
//      → 3 puntos marcados con "NUEVA" más abajo.
//   2. Caché de 4 h → 6 h y trigger de 3 h → 2 h. Marcados con "MARGEN".
//      Motivo: cuando el caché expira, releer la hoja tarda más de lo que
//      Google aguanta en una petición web, así que el /exec devuelve 404 hasta
//      que corra el trigger. Con 6 h de caché y trigger cada 2 h hay tres
//      oportunidades de renovarlo antes de que se venza, en vez de una.
//      Si prefieres dejarlo como estaba, son esos dos números.
//      ⚠️ El cambio del trigger solo aplica al volver a ejecutar setupTrigger().
// ═══════════════════════════════════════════════════════════════

const SHEET_ID  = "1UYREKkSoUPOX2hKfiZNxfgr2tylNDxNn6pzrsZ3tcqw";
const SHEET_GID = "1973971668";

// Índices en el array leído (A=0 … V=21, AB=27)
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
  contenedor:     27, // AB ← Container                                  NUEVA
};

// Caché en chunks (límite Apps Script: 100 KB por key)
const CACHE_PREFIX = 'fv11_chunk_';
const CACHE_META   = 'fv11_meta';
const CACHE_SECS   = 60 * 60 * 6; // 6 horas — máximo que permite CacheService  MARGEN
const CHUNK_SIZE   = 90000;

// ── Política de fees (v13) ──────────────────────────────────────
// Inicio del cobro (storage y finance usan la misma fecha):
//   SPOT:     60 días libres tras la reserva (sin fecha de reserva no se cobra)
//   CONTRACT: con Last Delivery → día siguiente a V
//             sin Last Delivery → 180 días libres tras la llegada (ETA)
//             (la fecha de reserva no cuenta en CONTRACT)
//   SPOT: si la reserva es anterior a la llegada, se cuenta desde la llegada.
// Tarifas mensuales, cobradas por día (tarifa / 30). Solo se cobra si el café
// sigue en bodega el día 1 siguiente al inicio (aviso): ver fee_estado.
const DIAS_LIBRES = { SPOT: 60, CONTRACT: 180 };
// Tasa mensual del finance fee sobre el valor del contrato (AU tiene la suya)
const FIN_RATE    = { AU: 0.0103, DEFAULT: 0.0072 };
const LB_POR_KG   = 2.2046;

// Moneda del precio del contrato (Pallet Price) por región:
// USA = USD/lb · MENA = USD/kg · EU = EUR/kg · UK = GBP/kg · AU = AUD/kg
const PRECIO_MONEDA = { USA:'USD', EU:'EUR', UK:'GBP', AU:'AUD', MENA:'USD' };

// Columna A → bodega. Lo que no se reconoce se trata como Annex (USA, 1.05).
function bodegaInfo(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (s.includes('DUP'))                                      return { wh:'DUPUY',       region:'USA' };
  if (s.includes('ANNEX'))                                    return { wh:'ANNEX',       region:'USA' };
  if (s === 'NJ' || s.includes('CONTINENTAL'))                return { wh:'CONTINENTAL', region:'USA' };
  if (s.includes('CANAD'))                                    return { wh:'CANADA',      region:'USA' };
  if (s === 'EU' || s.includes('ROTTERDAM') || s.includes('BARCELONA')) return { wh:'EU', region:'EU' };
  if (s === 'UK')                                             return { wh:'UK',          region:'UK' };
  if (s === 'AU' || s.includes('AUSTRAL') || s.includes('MELBOURNE'))   return { wh:'AU', region:'AU' };
  if (s === 'MENA' || s.includes('DUBAI') || s === 'DXB')     return { wh:'MENA',        region:'MENA' };
  return { wh:'OTRA', region:'USA' };
}

// Storage de UN mes para la fila → { monto, moneda }
function storageMensual(wh, sacos, bagKg) {
  switch (wh) {
    case 'DUPUY':  return { monto: sacos * (sacos <= 10 ? 10 : 1.00), moneda:'USD' };
    case 'CANADA': return { monto: sacos <= 8 ? sacos * bagKg * LB_POR_KG * 0.132 : sacos * 1.72, moneda:'USD' };
    case 'EU':     return { monto: sacos * (bagKg >= 60 ? 1.37 : 1.05), moneda:'EUR' }; // 70 kg vs 35 kg / caja 24 kg
    case 'UK':     return { monto: sacos * (sacos < 7 ? 1.40 : 0.70),   moneda:'GBP' };
    case 'AU':     return { monto: sacos * 2.5, moneda:'AUD' };
    case 'MENA':   return { monto: sacos * 4,   moneda:'AED' };
    default:       return { monto: sacos * (sacos <= 10 ? 10 : 1.05), moneda:'USD' }; // ANNEX, CONTINENTAL, OTRA
  }
}

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
// LECTURA: UNA SOLA llamada getValues(), A–AB (28 cols)
// ─────────────────────────────────────────────────────────────
function leerSheet() {
  const ss     = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  let sheet    = sheets.find(s => String(s.getSheetId()) === String(SHEET_GID));
  if (!sheet) sheet = sheets[0];

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return vacío();

  // ✅ UNA sola llamada — hasta AB (28 columnas) para incluir Container.      NUEVA
  // Si la hoja tuviera menos columnas, se lee lo que haya en vez de fallar.
  const nCols = Math.min(28, sheet.getLastColumn());
  const data  = sheet.getRange(2, 1, lastRow - 1, nCols).getValues();

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
    const info   = bodegaInfo(r[C.bodega]);

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

    // ── Y, Z, AA: fees según la política v13 (ver DIAS_LIBRES arriba)
    const precioKg    = toNum(r[C.precio_kg]);    // T (solo se expone)
    const palletPrice = toNum(r[C.pallet_price]);  // R — precio del contrato
    const bagSize     = toNum(r[C.bag_size]);       // S — kg por saco

    // Primer día cobrado: los días libres se cuentan completos después de la
    // fecha base (reserva 22 jul + 60 → libre hasta 20 sep, cobra desde 21 sep)
    const baseReserva = (fechaReservaDate && etaDate && fechaReservaDate < etaDate) ? etaDate : fechaReservaDate;
    let inicioMs = null;
    if (tipo === "SPOT") {
      if (baseReserva) inicioMs = diaMs(baseReserva) + (DIAS_LIBRES.SPOT + 1) * 86400000;
    } else if (lastDeliveryDate) {
      inicioMs = diaMs(lastDeliveryDate) + 86400000;              // día siguiente a V
      if (etaDate) inicioMs = Math.max(inicioMs, diaMs(etaDate));  // no antes de llegar a bodega
    } else if (etaDate) {                                          // CONTRACT: la reserva no cuenta
      inicioMs = diaMs(etaDate) + (DIAS_LIBRES.CONTRACT + 1) * 86400000;
    }

    // Aviso el día 1 siguiente al inicio. Si el café sale antes, no paga nada;
    // si sigue ahí, paga TODOS los días desde el inicio (tarifa mensual / 30).
    //   GRATIS  → aún en periodo libre
    //   ACUMULA → ya corren días; sin cobro si sale antes del aviso
    //   COBRA   → pasó el aviso; paga todos los días acumulados
    // fee_mes_dias    = días del último mes calendario cerrado (factura del día 1).
    // fee_salida_dias = días del mes en curso: se cobran con la factura del café al sacarlo.
    let feeEstado = null, feeEn = null, diasAcum = 0, notifMs = null, diasMes = 0, diasSalida = 0;
    if (inicioMs !== null) {
      const ini = new Date(inicioMs);
      notifMs  = new Date(ini.getFullYear(), ini.getMonth() + 1, 1).getTime();
      feeEn    = Math.round((notifMs - todayMs) / 86400000);    // días hasta el aviso (<= 0 = cobra)
      diasAcum = Math.max(0, Math.round((todayMs - inicioMs) / 86400000));
      feeEstado = todayMs < inicioMs ? 'GRATIS'
                : todayMs < notifMs  ? 'ACUMULA'
                :                      'COBRA';
      if (feeEstado === 'COBRA') {
        const mesIni = new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime();
        const mesFin = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
        diasMes = Math.max(0, Math.round((mesFin - Math.max(mesIni, inicioMs)) / 86400000));
        // Mes en curso: si el café sale hoy, estos días van en la factura del café
        diasSalida = Math.max(0, Math.round((todayMs - Math.max(mesFin, inicioMs)) / 86400000));
      }
    }
    const diasCobro = feeEstado === 'COBRA' ? diasAcum : 0;

    const st = storageMensual(info.wh, cantidad, bagSize);
    // Facturación mensual: el monto a facturar es el del último mes cerrado;
    // el acumulado (todos los días desde el inicio) va aparte.
    const whDia  = st.monto / 30;

    const valorContrato = palletPrice * bagSize * cantidad * (info.region === 'USA' ? LB_POR_KG : 1);
    const finDia = valorContrato * (FIN_RATE[info.region] || FIN_RATE.DEFAULT) / 30;
    const r2     = x => x > 0 ? Math.round(x * 100) / 100 : null;

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
      contenedor:     String(r[C.contenedor] || '').trim(),   //              NUEVA
      serie:          String(r[C.serie]     || '').trim(),
      pallet_price:   palletPrice,
      bag_size:       bagSize,
      precio_kg:      precioKg,
      first_delivery: toFechaISO(r[C.first_delivery]),
      last_delivery:  toFechaISO(r[C.last_delivery]),
      eta:            toFechaISO(r[C.eta]),
      dias:           diasVejez,
      dias_reserva:   diasReserva,
      warehouse_fee:  r2(whDia  * diasMes),             // storage a facturar (último mes cerrado)
      finance_fee:    r2(finDia * diasMes),             // finance a facturar (último mes cerrado)
      warehouse_acum: r2(whDia  * diasCobro),           // storage acumulado desde el inicio
      finance_acum:   r2(finDia * diasCobro),           // finance acumulado desde el inicio
      warehouse_salida: r2(whDia  * diasSalida),        // storage a sumar a la factura del café si sale hoy
      finance_salida:   r2(finDia * diasSalida),        // finance a sumar a la factura del café si sale hoy
      wh_cur:         st.moneda,                        // moneda del storage fee
      fin_cur:        PRECIO_MONEDA[info.region],       // moneda del finance fee
      fee_estado:     feeEstado,                        // GRATIS / ACUMULA / COBRA
      fee_dias:       diasAcum,                         // días acumulados desde el inicio
      fee_mes_dias:   diasMes,                          // días del último mes cerrado
      fee_salida_dias: diasSalida,                      // días del mes en curso (van con la factura del café)
      fee_inicio:     inicioMs !== null ? isoLocal(inicioMs) : null,
      fee_notif:      notifMs  !== null ? isoLocal(notifMs) : null,
      fee_en:         feeEn,                            // días hasta el aviso (<= 0 = cobra)
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

// ms (medianoche local) → "yyyy-MM-dd" en la zona del script
function isoLocal(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// Medianoche local del día de la fecha, en ms
function diaMs(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x.getTime();
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
// TRIGGER: calienta el caché cada 2 horas automáticamente
// Ejecuta setupTrigger() UNA SOLA VEZ manualmente
// ─────────────────────────────────────────────────────────────
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'calentarCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('calentarCache').timeBased().everyHours(2).create(); //  MARGEN
  Logger.log("✅ Trigger creado: calentarCache cada 2 h");
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
