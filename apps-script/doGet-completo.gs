// ═══════════════════════════════════════════════════════════════
// doGet COMPLETO — proyecto del dashboard "Control de Inventario"
//
// Va en el archivo donde ya tienes construirDashboardHtml_ y buildDataFromRaw
// (NO en el archivo CacheDashboard). Reemplaza tu doGet entero por este:
// selecciona desde "function doGet" hasta su llave de cierre, bórralo y pega.
//
// Las tres cosas que hace, y por qué:
//
//   1. Recibe (e)               → para poder leer los parámetros de la URL.
//   2. ?format=embed            → devuelve el mismo HTML envuelto en JSON, que es
//                                 lo que la app necesita para incrustarlo sin que
//                                 Google vea la sesión del visitante.
//   3. ciDashboardHtml_(forzar) → sirve desde el caché en vez de recalcular en
//                                 cada visita. Con ?refresh=1 recalcula a la
//                                 fuerza (~30 s).
//   4. ALLOWALL                 → permite que la app lo muestre embebido.
//
// Lo que NO cambia: construirDashboardHtml_, generarReporteDashboard y el menú
// dentro de Sheets siguen exactamente igual.
// ═══════════════════════════════════════════════════════════════

function doGet(e){
  try {
    const forzar = !!(e && e.parameter && e.parameter.refresh === '1');

    // La app pide las piezas por aquí: ContentService sí manda cabeceras CORS.
    const formato = e && e.parameter ? e.parameter.format : '';
    if (formato === 'tpl')   return ciServeTpl_();           // plantilla sola
    if (formato === 'json')  return ciServeJson_(forzar);    // datos solos
    if (formato === 'embed') return ciServeEmbed_(forzar);   // ambos juntos (pesado)

    const html = ciDashboardHtml_(forzar);
    return HtmlService.createHtmlOutput(html)
      .setTitle('Control de Inventario — Café Verde')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch(err){
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;max-width:600px;">' +
      '<h2 style="color:#B23A22;">No se pudo generar el dashboard</h2>' +
      '<p>' + String(err.message || err) + '</p>' +
      '<p style="color:#7A6E52;font-size:13px;">Si el error menciona permisos, pídele al dueño del script que vuelva a desplegar la Aplicación Web (Implementar → Administrar implementaciones → Editar → Nueva versión).</p>' +
      '</div>'
    ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}
