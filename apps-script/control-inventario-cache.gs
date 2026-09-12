// ═══════════════════════════════════════════════════════════════
// CONTROL DE INVENTARIO — caché del dashboard
//
// Problema que resuelve: hoy cada visita al /exec vuelve a leer las tres
// hojas y a recalcular todo el payload. Son ~30 s de espera para quien abre
// la pestaña, cada vez, aunque los datos no hayan cambiado.
//
// Qué hace: guarda el payload ya calculado en CacheService y lo reutiliza.
// Un trigger lo recalienta cada 4 h, así la espera cae a un par de segundos
// prácticamente siempre. Es el mismo patrón que ya usa el API de Reservas
// (reservas-api.gs) en el otro proyecto.
//
// Qué NO toca:
//   - buildDataFromRaw ni la lógica del dashboard.
//   - construirDashboardHtml_ ni el menú dentro de Sheets, que siguen
//     generando todo fresco como hasta hoy.
//
// Instalación: ver INSTRUCCIONES-cache.md
// ═══════════════════════════════════════════════════════════════

// El payload ronda los 350 KB y CacheService admite 100 KB por clave,
// así que se guarda partido en trozos.
const CI_CACHE_PREFIX = 'ci_pay_chunk_';
const CI_CACHE_META   = 'ci_pay_meta';
const CI_CACHE_SECS   = 60 * 60 * 6;   // 6 h de vida; el trigger lo renueva cada 4
const CI_CHUNK_SIZE   = 90000;

// ─────────────────────────────────────────────────────────────
// CÁLCULO — lo mismo que hace construirDashboardHtml_, pero devolviendo
// el payload en JSON en vez de la página armada.
// ─────────────────────────────────────────────────────────────
function ciPayloadJson_() {
  const ssMain        = SpreadsheetApp.openById(DESTINO_SPREADSHEET_ID);
  const shConsolidado = ssMain.getSheetByName('CONSOLIDADO');
  const shVentas      = ssMain.getSheetByName('Informe Inventario 22+');
  if (!shConsolidado) throw new Error('No encontré una pestaña llamada "CONSOLIDADO" en este Sheet. Revisa el nombre exacto.');
  if (!shVentas)      throw new Error('No encontré una pestaña llamada "Informe Inventario 22+" en este Sheet. Revisa el nombre exacto.');

  const ssParser    = SpreadsheetApp.openById(SHEET_PARSER_ID);
  const shDrilldown = ssParser.getSheetByName('Drilldown Posiciones');
  if (!shDrilldown) throw new Error('No encontré "Drilldown Posiciones" en el archivo parser. Revisa el ID o el nombre de la pestaña.');

  const data = buildDataFromRaw(
    sheetToObjects_(shConsolidado),
    sheetToObjects_(shVentas),
    sheetToObjects_(shDrilldown)
  );
  return JSON.stringify(data);
}

// ─────────────────────────────────────────────────────────────
// HTML SERVIDO — usa el caché salvo que se pida refresco explícito.
// ─────────────────────────────────────────────────────────────
function ciDashboardHtml_(forzar) {
  let json = forzar ? null : ciLeerCache_();
  if (json) {
    Logger.log('✅ CI caché usado (' + json.length + ' caracteres)');
  } else {
    Logger.log('🔄 CI caché vacío — recalculando');
    json = ciPayloadJson_();
    ciGuardarCache_(json);
  }
  const dataJson = json.replace(/<\/script/g, '<\\/script');
  const html = HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
  // El reemplazo va con función y no con string: así un "$&" o un "$'" dentro
  // de los datos no se interpreta como patrón de reemplazo de JavaScript.
  return html.replace('__DATA_JSON__', function () { return dataJson; });
}

// ─────────────────────────────────────────────────────────────
// RECALENTADO — lo llama el trigger cada 4 h para que nadie pague la espera.
// ─────────────────────────────────────────────────────────────
function calentarCacheControlInv() {
  const t0 = Date.now();
  const json = ciPayloadJson_();
  ciGuardarCache_(json);
  Logger.log('✅ CI caché recalentado en ' + Math.round((Date.now() - t0) / 1000) + ' s · ' + json.length + ' caracteres');
}

// Ejecútala UNA vez a mano para dejar el trigger creado.
function crearTriggerCacheControlInv() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'calentarCacheControlInv') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('calentarCacheControlInv').timeBased().everyHours(4).create();
  Logger.log('✅ Trigger creado: calentarCacheControlInv cada 4 h');
}

// ─────────────────────────────────────────────────────────────
// CACHÉ EN TROZOS
// Si falta cualquier trozo se descarta el caché completo: los trozos pueden
// expirar por separado y medio payload es peor que ninguno.
// ─────────────────────────────────────────────────────────────
function ciGuardarCache_(json) {
  try {
    const cache   = CacheService.getScriptCache();
    const entries = {};
    let   chunks  = 0;
    for (let i = 0; i < json.length; i += CI_CHUNK_SIZE) {
      entries[CI_CACHE_PREFIX + chunks] = json.substring(i, i + CI_CHUNK_SIZE);
      chunks++;
    }
    entries[CI_CACHE_META] = String(chunks);
    cache.putAll(entries, CI_CACHE_SECS);
    Logger.log('💾 CI caché guardado en ' + chunks + ' trozos');
  } catch (err) {
    // Guardar es una optimización: si falla, la página igual se sirve.
    Logger.log('⚠️ CI no se pudo guardar el caché: ' + err.message);
  }
}

function ciLeerCache_() {
  try {
    const cache  = CacheService.getScriptCache();
    const chunks = Number(cache.get(CI_CACHE_META));
    if (!chunks) return null;

    const keys = [];
    for (let i = 0; i < chunks; i++) keys.push(CI_CACHE_PREFIX + i);
    const parts = cache.getAll(keys);

    let json = '';
    for (let i = 0; i < chunks; i++) {
      const part = parts[CI_CACHE_PREFIX + i];
      if (part == null) return null;   // trozo perdido → se recalcula todo
      json += part;
    }
    return json;
  } catch (err) {
    Logger.log('⚠️ CI no se pudo leer el caché: ' + err.message);
    return null;
  }
}

// Útil si alguna vez quieres invalidar el caché a mano.
function ciBorrarCache_() {
  const cache  = CacheService.getScriptCache();
  const chunks = Number(cache.get(CI_CACHE_META)) || 0;
  const keys   = [CI_CACHE_META];
  for (let i = 0; i < chunks; i++) keys.push(CI_CACHE_PREFIX + i);
  cache.removeAll(keys);
  Logger.log('🗑️ CI caché borrado');
}
