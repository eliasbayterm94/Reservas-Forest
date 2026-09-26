// ═══════════════════════════════════════════════════════════════
// CONSUMO DE CLIENTES — datos para la vista "Consumo clientes" de la pestaña
// Control Inventario de la app.
//
// Archivo NUEVO para el proyecto de Apps Script de CONTROL DE INVENTARIO (el del
// dashboard, instalado sobre el Sheet "Inventario Actual"). Usa las constantes que
// ese proyecto ya tiene: DESTINO_SPREADSHEET_ID y SHEET_PARSER_ID.
// Todo lo nuevo lleva prefijo "cc"/"CC_" para no chocar con nada existente.
//
// Qué entrega  ?format=consumo  (lo agrega una línea en doGet):
//   Las ventas de "Informe Inventario 22+" agregadas por cliente × producto ×
//   presentación, mes a mes (unidades), más las reservas RESERVADO de "Drilldown
//   Posiciones" ya cruzadas con cada fila. Los promedios, el estimado y la
//   proyección los calcula la app: así se pueden ajustar sin volver a desplegar.
//
// Mismo patrón que el dashboard: el resultado se guarda en caché 6 h y un
// activador lo recalienta cada 2 h, porque recalcular desde las hojas tarda
// más de lo que Google aguanta en una petición web.
//
// Instalación paso a paso: ver consumo-clientes.md
// ═══════════════════════════════════════════════════════════════

const CC_CFG = {
  HOJA_VENTAS: 'Informe Inventario 22+',
  HOJA_DRILLDOWN: 'Drilldown Posiciones',
  // Opcional: pestaña en Inventario Actual para corregir a mano el cruce de clientes.
  // Columna A = cliente como viene en reservas, columna B = nombre exacto en ventas.
  HOJA_CORRECCIONES: 'Consumo Mapeo',
  MESES_HISTORIA: 24,     // cuántos meses completos hacia atrás se mandan a la app
  // Igual que el dashboard.
  WAREHOUSE_TO_REGION: {
    'Annex':'USA','NJ':'USA','Dupuy':'USA','Seattle':'USA','Canada':'USA','Direct From Colombia':'USA',
    'Melbourne':'AU','UK':'UK','Rotterdam':'EU','Barcelona':'EU','Dubai':'MENA'
  },
};

const CC_PEDIDO_DIAS  = 7;   // facturas a 7 días o menos entre sí = un mismo pedido
const CC_CACHE_PREFIX = 'cc_pay_chunk_';
const CC_CACHE_META   = 'cc_pay_meta';
const CC_CACHE_SECS   = 60 * 60 * 6;
const CC_CHUNK_SIZE   = 90000;

const CC_STOP = ['coffee','coffees','roasters','roaster','roastery','roasting','roast','co','company',
  'ltd','llc','limited','pty','srl','inc','specialty','speciality','trading','the','fze','sl','gmbh','bv',
  'cafe','caffe','and','fzco','spc','lda','sa','sas','ab','as','kft'];

// Drilldown Posiciones, índices de columna (A=0). Los mismos que usa el API de Reservas.
const CC_DD = { bodega: 0, cliente: 1, cafe: 2, ico: 3, cantidad: 4, estado: 10, bag_size: 18 };


// ═══════════════ ENDPOINT Y CACHÉ ═══════════════

/** Lo llama doGet con ?format=consumo. */
function ccServeJson_(forzar) {
  try {
    let json = forzar ? null : ccLeerCache_();
    if (!json) { json = ccPayloadJson_(); ccGuardarCache_(json); }
    return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/** Ejecútala a mano la primera vez, y cuando quieras ver el resultado en el registro. */
function calentarCacheConsumo() {
  const t0 = Date.now();
  const json = ccPayloadJson_();
  ccGuardarCache_(json);
  const p = JSON.parse(json);
  Logger.log('✅ Consumo: %s filas, %s reservas sin cruzar, %s KB, %s s',
    p.filas.length, p.sinCruzar.length, Math.round(json.length / 1024), Math.round((Date.now() - t0) / 1000));
}

/** Ejecútala UNA vez: deja calentarCacheConsumo corriendo cada 2 h. */
function crearTriggerConsumo() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'calentarCacheConsumo') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('calentarCacheConsumo').timeBased().everyHours(2).create();
  Logger.log('✅ Trigger creado: calentarCacheConsumo cada 2 h');
}

/** Opcional: crea la pestaña "Consumo Mapeo" con el cruce automático de hoy, para corregirlo. */
function crearHojaMapeoConsumo() {
  const ss = SpreadsheetApp.openById(DESTINO_SPREADSHEET_ID);
  let sh = ss.getSheetByName(CC_CFG.HOJA_CORRECCIONES);
  if (sh) throw new Error('La pestaña "' + CC_CFG.HOJA_CORRECCIONES + '" ya existe; no la sobrescribo.');
  const p = JSON.parse(ccPayloadJson_());
  sh = ss.insertSheet(CC_CFG.HOJA_CORRECCIONES);
  const filas = [['Cliente en reservas', 'Cliente en ventas (corrige aquí)', 'Cómo se emparejó (automático)', 'Otros candidatos']]
    .concat(p.mapeo.map(m => [m[0], m[1], m[2], m[3]]));
  sh.getRange(1, 1, filas.length, 4).setValues(filas);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.getRange(2, 2, Math.max(filas.length - 1, 1), 1).setBackground('#fff2a8');
  sh.setFrozenRows(1);
  Logger.log('📄 Pestaña "%s" creada con %s clientes.', CC_CFG.HOJA_CORRECCIONES, filas.length - 1);
}

function ccPayloadJson_() {
  const ss = SpreadsheetApp.openById(DESTINO_SPREADSHEET_ID);
  const shV = ss.getSheetByName(CC_CFG.HOJA_VENTAS);
  if (!shV) throw new Error('No encontré la pestaña "' + CC_CFG.HOJA_VENTAS + '".');
  const ventas = shV.getDataRange().getValues();

  const shD = SpreadsheetApp.openById(SHEET_PARSER_ID).getSheetByName(CC_CFG.HOJA_DRILLDOWN);
  if (!shD) throw new Error('No encontré "' + CC_CFG.HOJA_DRILLDOWN + '" en el archivo parser.');
  const drill = shD.getLastRow() > 1 ? shD.getRange(2, 1, shD.getLastRow() - 1, 19).getValues() : [];

  const correcciones = {};
  const shC = ss.getSheetByName(CC_CFG.HOJA_CORRECCIONES);
  if (shC && shC.getLastRow() > 1) {
    shC.getRange(2, 1, shC.getLastRow() - 1, 2).getValues().forEach(r => {
      if (ccStr_(r[0]) && ccStr_(r[1])) correcciones[ccStr_(r[0])] = ccStr_(r[1]);
    });
  }

  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return JSON.stringify(ccAgregar_(ventas, drill, correcciones, hoy));
}

function ccGuardarCache_(json) {
  try {
    const entries = {}; let n = 0;
    for (let i = 0; i < json.length; i += CC_CHUNK_SIZE) entries[CC_CACHE_PREFIX + n++] = json.substring(i, i + CC_CHUNK_SIZE);
    entries[CC_CACHE_META] = String(n);
    CacheService.getScriptCache().putAll(entries, CC_CACHE_SECS);
  } catch (err) {
    Logger.log('⚠️ Consumo: no se pudo guardar el caché: ' + err.message);
  }
}

function ccLeerCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(CC_CACHE_META));
    if (!n) return null;
    const keys = []; for (let i = 0; i < n; i++) keys.push(CC_CACHE_PREFIX + i);
    const parts = cache.getAll(keys);
    let json = '';
    for (let i = 0; i < n; i++) { const p = parts[CC_CACHE_PREFIX + i]; if (p == null) return null; json += p; }
    return json;
  } catch (err) {
    return null;
  }
}


// ═══════════════ AGREGACIÓN (sin llamadas a Google: se puede probar aparte) ═══════════════
//
// Devuelve:
//   meta.meses  → etiquetas de los meses de "m" (del más viejo al último mes completo)
//   meta.hoy    → fecha de corte (aaaa-mm-dd); el mes de hoy va aparte, en "mtd"
//   cols        → nombres de las columnas de cada fila
//   filas       → [región, cliente, comercial, categoría, producto, presentación kg,
//                  m (unidades por mes), mtd (unidades del mes en curso),
//                  última compra (aaaa-mm-dd), pedidos (hace cuántos días; del más viejo
//                  al más reciente), reservado RESERVADO (unidades de esta presentación)]
//   clientes    → { cliente: pedidos } con las compras de cualquier café: de ahí salen la
//                  periodicidad y si el cliente es recurrente o esporádico.
//                  Un "pedido" junta las facturas a CC_PEDIDO_DIAS días o menos entre sí:
//                  un despacho partido en dos facturas no cuenta como dos compras.
//   sinCruzar   → reservas que no encontraron fila: [cliente, café, ICO, bodega, unidades, bag size, motivo]
//   mapeo       → [cliente en reservas, cliente en ventas, cómo se emparejó, otros candidatos]
function ccAgregar_(ventas, drill, correcciones, hoy) {
  const N = CC_CFG.MESES_HISTORIA;
  const mk = d => d.getFullYear() * 12 + d.getMonth();
  const mesHoy = mk(hoy), ini = mesHoy - N;
  const MES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const etiqueta = m => MES[m % 12] + '-' + String(Math.floor(m / 12)).slice(-2);
  const iso = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  const DIA = 86400000;

  const H = ventas[0].map(h => String(h).trim());
  const col = n => { const i = H.indexOf(n); if (i < 0) throw new Error('Falta la columna "' + n + '" en ' + CC_CFG.HOJA_VENTAS); return i; };
  const iQty = col('Quantity (Line > Sales Item Line Detail)'), iSize = col('SIZE'), iCat = col('Category'),
        iName = col('Name'), iWh = col('Warehouse**'), iDate = col('Transaction Date'),
        iCli = col('Customer Name (Customer Reference)'), iCom = col('Comercial');

  // ── Ventas → grupos cliente × producto × presentación
  const grupos = new Map(), kgPorCliente = {}, productos = new Set(), diasCliente = {};
  for (let i = 1; i < ventas.length; i++) {
    const r = ventas[i];
    const cat = ccStr_(r[iCat]), name = ccStr_(r[iName]);
    if (r[iQty] === '' || r[iQty] == null || r[iSize] === '' || r[iSize] == null) continue;
    if (!cat || cat === 'NOT FOUND' || cat === 'SERVICE' || !name) continue;
    const region = CC_CFG.WAREHOUSE_TO_REGION[ccStr_(r[iWh])];
    const fecha = ccFecha_(r[iDate]);
    const qty = ccNum_(r[iQty]), size = ccNum_(r[iSize]), cli = ccLimpiaCliente_(r[iCli]);
    if (!region || !fecha || !size || !cli) continue;
    const m = mk(fecha);
    if (m < ini) continue;
    productos.add(name);

    const k = cli + '|' + name + '|' + size;
    let g = grupos.get(k);
    if (!g) {
      g = { cli, prod: name, size, m: new Array(N).fill(0), mtd: 0, dias: new Set(), ultima: null,
            comercial: '', kgReg: {}, kgCat: {}, kg12: 0 };
      grupos.set(k, g);
    }
    if (m < mesHoy) g.m[m - ini] += qty; else if (m === mesHoy) g.mtd += qty;
    if (m >= mesHoy - 12) { g.kg12 += qty * size; kgPorCliente[cli] = (kgPorCliente[cli] || 0) + qty * size; }
    const dia = Math.round(fecha.getTime() / DIA);
    g.dias.add(dia);
    (diasCliente[cli] = diasCliente[cli] || new Set()).add(dia);
    if (!g.ultima || fecha >= g.ultima) { g.ultima = fecha; g.comercial = ccStr_(r[iCom]) || g.comercial; }
    g.kgReg[region] = (g.kgReg[region] || 0) + qty * size;
    g.kgCat[cat] = (g.kgCat[cat] || 0) + qty * size;
  }
  // Solo quien compró en los últimos 12 meses (o en el mes en curso).
  const activos = [...grupos.values()].filter(g => g.kg12 > 0);
  const porClave = new Map(activos.map(g => [g.cli + '|' + g.prod + '|' + g.size, g]));
  const porPar = {};
  activos.forEach(g => (porPar[g.cli + '|' + g.prod] = porPar[g.cli + '|' + g.prod] || []).push(g));

  // ── Reservas RESERVADO → misma fila (FACTURADO SIN ROTAR ya está en ventas)
  const clientes = [...new Set(activos.map(g => g.cli))];
  const claveCli = {}; clientes.forEach(c => claveCli[c] = ccClaveCliente_(c));
  const prods = [...productos];
  const claveProd = {}; prods.forEach(p => claveProd[p] = ccClaveProd_(p));
  const mapeoCli = {}, mapeoProd = {}, sinCruzar = [];

  drill.forEach(r => {
    const estado = ccStr_(r[CC_DD.estado]).toUpperCase();
    if (estado.indexOf('FACT') >= 0 || estado.indexOf('RESERV') < 0) return;   // igual que el API de Reservas
    const cliRes = ccStr_(r[CC_DD.cliente]), cafe = ccStr_(r[CC_DD.cafe]);
    const unid = ccNum_(r[CC_DD.cantidad]), size = ccNum_(r[CC_DD.bag_size]);
    if (!cliRes || !cafe || !unid) return;
    if (!mapeoCli[cliRes]) mapeoCli[cliRes] = ccEmparejar_(ccClaveCliente_(cliRes), clientes, claveCli, 4, c => kgPorCliente[c] || 0);
    if (!mapeoProd[cafe]) mapeoProd[cafe] = ccEmparejar_(ccClaveProd_(cafe), prods, claveProd, 5, () => 0);
    const cli = correcciones[cliRes] || mapeoCli[cliRes].valor, prod = mapeoProd[cafe].valor;
    let g = cli && prod ? porClave.get(cli + '|' + prod + '|' + size) : null;
    if (!g && cli && prod && porPar[cli + '|' + prod]) g = porPar[cli + '|' + prod].slice().sort((a, b) => b.kg12 - a.kg12)[0];
    if (g) { g.res = (g.res || 0) + unid * (size || g.size) / g.size; return; }
    sinCruzar.push([cliRes, cafe, ccStr_(r[CC_DD.ico]), ccStr_(r[CC_DD.bodega]), unid, size,
      !cli ? 'Cliente sin emparejar' : !prod ? 'Café sin emparejar' : 'Sin compras de ese café en 12 meses']);
  });

  const r1 = x => Math.round(x * 100) / 100;
  const diaHoy = Math.round(hoy.getTime() / DIA);
  const filas = activos.map(g => [ccMax_(g.kgReg), g.cli, g.comercial, ccMax_(g.kgCat), g.prod, g.size, g.m.map(r1), r1(g.mtd),
    iso(g.ultima), ccPedidos_(g.dias, diaHoy), r1(g.res || 0)]);
  const pedidosCliente = {};
  clientes.forEach(c => pedidosCliente[c] = ccPedidos_(diasCliente[c], diaHoy));
  const mapeo = Object.keys(mapeoCli).sort().map(k => [k, correcciones[k] || mapeoCli[k].valor || '',
    correcciones[k] ? 'Corrección manual' : mapeoCli[k].metodo, mapeoCli[k].otros]);

  return {
    meta: { generado: new Date().toISOString(), hoy: iso(hoy), meses: Array.from({ length: N }, (_, j) => etiqueta(ini + j)),
            mesActual: etiqueta(mesHoy) },
    cols: ['region', 'cliente', 'comercial', 'categoria', 'producto', 'size', 'm', 'mtd', 'ultima', 'pedidos', 'res'],
    filas, clientes: pedidosCliente, sinCruzar, mapeo,
  };
}

/** Días de compra → pedidos, como "hace cuántos días", del más viejo al más reciente. */
function ccPedidos_(dias, diaHoy) {
  const d = [...dias].sort((a, b) => a - b), out = [];
  let prev = null;
  d.forEach(x => { if (prev == null || x - prev > CC_PEDIDO_DIAS) out.push(diaHoy - x); prev = x; });
  return out;
}

/** Busca el nombre de ventas que corresponde a uno de reservas: exacto, luego por prefijo. */
function ccEmparejar_(clave, candidatos, claves, minLen, peso) {
  let lista = candidatos.filter(c => claves[c] === clave), metodo = 'Exacto';
  if (!lista.length) {
    lista = candidatos.filter(c => clave.length >= minLen && claves[c].length >= minLen &&
                                   (claves[c].indexOf(clave) === 0 || clave.indexOf(claves[c]) === 0));
    metodo = lista.length === 1 ? 'Aproximado' : lista.length > 1 ? 'Revisar (' + lista.length + ' candidatos)' : 'Sin coincidencia';
  }
  lista.sort((a, b) => peso(b) - peso(a));
  return { valor: lista[0] || null, metodo, otros: lista.slice(1).join('; ') };
}

function ccNorm_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function ccClaveCliente_(s) {
  const toks = ccNorm_(s).split(' ').filter(Boolean);
  return toks.filter(t => CC_STOP.indexOf(t) < 0).join('') || toks.join('');
}
function ccClaveProd_(s) { return ccNorm_(s).replace(/ /g, ''); }
// "17 Grams Roastery (GBP)" y "17 Grams Roastery" son el mismo cliente.
function ccLimpiaCliente_(s) { return ccStr_(s).replace(/\s*\((GBP|USD|EUR|AED|AUD|CAD)\)\s*$/i, '').trim(); }
function ccMax_(o) { return Object.keys(o).sort((a, b) => o[b] - o[a])[0] || ''; }
function ccStr_(v) { return v == null ? '' : String(v).trim(); }
function ccNum_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(/[$%\s]/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
function ccFecha_(v) {
  if (v instanceof Date) return isNaN(v) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // d/m/aaaa
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
