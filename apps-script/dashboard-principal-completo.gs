/**
 * CONTROL DE INVENTARIO — Generador de Dashboard desde Google Sheets
 * ---------------------------------------------------------------
 * Se instala DIRECTAMENTE en el Google Sheet "Inventario Actual"
 * (Extensiones > Apps Script). Agrega un menú que lee las 3 hojas fuente
 * y genera el dashboard completo (3 módulos) con los datos más recientes.
 *
 * Hojas que lee:
 *   - "CONSOLIDADO"              (en este mismo Spreadsheet)
 *   - "Informe Inventario 22+"   (en este mismo Spreadsheet)
 *   - "Drilldown Posiciones"     (en el Spreadsheet "parser", ID abajo)
 *
 * CAMBIOS DE ESTA VERSIÓN (2026-09-14):
 *   - Se lee la columna "Container" de CONSOLIDADO y se expone en
 *     master_ico_full, para que el dashboard pueda mostrar el contenedor en
 *     el Detalle de Reservas y en Alertas de Vejez. Son dos líneas, marcadas
 *     abajo con "NUEVA".
 *   - construirDashboardHtml_ hace el reemplazo de __DATA_JSON__ con función
 *     en vez de string, para que un "$&" dentro de los datos no se interprete
 *     como patrón de reemplazo. Misma corrección que ya tenía ciDashboardHtml_.
 */

// ⚠️ Si el ID del archivo "parser" (Drilldown de Posiciones) cambia algún día,
// actualízalo aquí. Es el único dato que hay que tocar a mano.
const SHEET_PARSER_ID = '1UYREKkSoUPOX2hKfiZNxfgr2tylNDxNn6pzrsZ3tcqw';

// ⚠️ El menú (onOpen) de este proyecto vive en ActualizarConsolidado.gs,
// combinado con el menú "Consolidado". No agregues otro onOpen() aquí —
// solo puede haber uno por proyecto, o uno le gana al otro en silencio.

// ================= FUNCIÓN PRINCIPAL =================
// ================= CONSTRUCCIÓN DEL HTML (compartida entre menú y Web App) =================
function construirDashboardHtml_(){
  // Se usa openById (no getActiveSpreadsheet) para que esto funcione también
  // desde doGet() cuando se despliega como Aplicación Web, donde no hay una
  // hoja "activa" — DESTINO_SPREADSHEET_ID viene de ActualizarConsolidado.gs,
  // que vive en el mismo proyecto y comparte el mismo espacio de nombres.
  const ssMain = SpreadsheetApp.openById(DESTINO_SPREADSHEET_ID);
  const shConsolidado = ssMain.getSheetByName('CONSOLIDADO');
  const shVentas = ssMain.getSheetByName('Informe Inventario 22+');
  if(!shConsolidado) throw new Error('No encontré una pestaña llamada "CONSOLIDADO" en este Sheet. Revisa el nombre exacto.');
  if(!shVentas) throw new Error('No encontré una pestaña llamada "Informe Inventario 22+" en este Sheet. Revisa el nombre exacto.');

  const ssParser = SpreadsheetApp.openById(SHEET_PARSER_ID);
  const shDrilldown = ssParser.getSheetByName('Drilldown Posiciones');
  if(!shDrilldown) throw new Error('No encontré "Drilldown Posiciones" en el archivo parser. Revisa el ID o el nombre de la pestaña.');

  const consolidadoRows = sheetToObjects_(shConsolidado);
  const ventasRows = sheetToObjects_(shVentas);
  const drilldownRows = sheetToObjects_(shDrilldown);

  const data = buildDataFromRaw(consolidadoRows, ventasRows, drilldownRows);
  const dataJson = JSON.stringify(data).replace(/<\/script/g, '<\\/script');

  let html = HtmlService.createHtmlOutputFromFile('Dashboard').getContent();
  // Con función y no con string: así un "$&" o un "$'" dentro de los datos no se
  // interpreta como patrón de reemplazo de JavaScript.
  html = html.replace('__DATA_JSON__', function(){ return dataJson; });
  return html;
}

// ================= MENÚ: abre el dashboard en una ventana dentro de Sheets =================
function generarReporteDashboard(){
  const ui = SpreadsheetApp.getUi();
  try {
    const html = construirDashboardHtml_();
    const output = HtmlService.createHtmlOutput(html)
      .setWidth(1450)
      .setHeight(900);
    ui.showModalDialog(output, 'Control de Inventario — ' + new Date().toLocaleDateString('es-CO'));
  } catch(err){
    ui.alert('No se pudo generar el dashboard', String(err.message || err), ui.ButtonSet.OK);
  }
}

// ═══════════════════════════════════════════════════════════════
// doGet — proyecto del dashboard "Control de Inventario"
//
//   1. Recibe (e)               → para poder leer los parámetros de la URL.
//   2. ?format=tpl / json       → entrega plantilla y datos por separado, que es
//                                 lo que consume la app (ContentService sí manda
//                                 cabeceras CORS; HtmlService no).
//   3. ?format=embed            → ambos juntos. Se conserva por compatibilidad,
//                                 pero es pesado: úsalo solo si hace falta.
//   4. ciDashboardHtml_(forzar) → sirve desde el caché en vez de recalcular en
//                                 cada visita. Con ?refresh=1 recalcula a la
//                                 fuerza (~30 s).
//   5. ALLOWALL                 → permite que la app lo muestre embebido.
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

// ================= LECTURA DE HOJAS =================
function sheetToObjects_(sheet){
  const values = sheet.getDataRange().getValues();
  if(values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for(let i=1; i<values.length; i++){
    const row = {};
    for(let j=0; j<headers.length; j++){
      row[headers[j]] = values[i][j];
    }
    rows.push(row);
  }
  return rows;
}

// ================= HELPERS DE FECHA/NÚMERO (Apps Script no tiene DOM/fetch) =================
function toDate_(v){
  if(v===null||v===undefined||v==='') return null;
  if(v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function parseGSheetDate(v){ return toDate_(v); }


// ================= LÓGICA DE AGREGACIÓN (portada 1:1 del dashboard) =================
const WAREHOUSE_TO_REGION = {
  'Annex':'USA','NJ':'USA','Dupuy':'USA','Seattle':'USA','Canada':'USA','Direct From Colombia':'USA',
  'Melbourne':'AU','UK':'UK','Rotterdam':'EU','Barcelona':'EU','Dubai':'MENA'
};

function toNum(v){
  if(v===null||v===undefined||v==='') return 0;
  if(typeof v === 'number') return v;
  const cleaned = String(v).replace(/[,%$]/g,'').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function toStr(v){ return (v===null||v===undefined) ? '' : String(v).trim(); }

function buildDataFromRaw(consolidadoRows, ventasRows, drilldownRows){
  const TODAY = new Date();
  const last12Start = new Date(TODAY); last12Start.setMonth(last12Start.getMonth()-12);

  // ---------- 1. Inventory (CONSOLIDADO) — incluye On Spot y On Float, con status ----------
  const inv = [];
  consolidadoRows.forEach(row=>{
    const status = toStr(row['Status']);
    if(status !== 'On Spot' && status !== 'On Float') return;
    const ico = toStr(row['ICO']);
    if(!ico) return;
    const bagSize = toNum(row['Bag Size']);
    const totalBags = toNum(row['Total Available']);
    const totalKg = toNum(row['Total Available (Kg)']);
    const freeBags = toNum(row['ACTUAL (Free)']);
    const resOrders = toNum(row['Reserved Orders']);
    const resContracts = toNum(row['Reserved Contracts']);
    inv.push({
      ico, status, region: toStr(row['Region']), warehouse: toStr(row['Warehouse']),
      product: toStr(row['NAME']), series: toStr(row['Series']),
      container: toStr(row['Container']),                                    // ← NUEVA
      bag_size: bagSize, price: toNum(row['Price']),
      vejez_dias: toNum(row['Vejes']), vejez_grupo: toStr(row['Group Of Days Vejes']),
      total_bags: totalBags, total_kg: totalKg,
      free_bags: freeBags, free_kg: freeBags*bagSize,
      reserved_orders_bags: resOrders, reserved_contracts_bags: resContracts,
      reserved_kg: (resOrders+resContracts)*bagSize,
    });
  });
  if(inv.filter(r=>r.status==='On Spot').length===0){
    throw new Error('La hoja CONSOLIDADO no devolvió lotes "On Spot". Revisa que el nombre de la pestaña y las columnas no hayan cambiado.');
  }

  // ---------- 2. Sales (Informe Inventario 22+), filtered to valid product lines ----------
  const valid = [];
  ventasRows.forEach(row=>{
    const qty = row['Quantity (Line > Sales Item Line Detail)'];
    const size = row['SIZE'];
    const category = toStr(row['Category']);
    const name = toStr(row['Name']);
    const wh = toStr(row['Warehouse**']);
    const region = WAREHOUSE_TO_REGION[wh];
    const dt = parseGSheetDate(row['Transaction Date']);
    if(qty===undefined||qty===null||qty===''||size===undefined||size===null||size===''||
       !category||category==='NOT FOUND'||category==='SERVICE'||!name||!region||!dt) return;
    const q = toNum(qty), sz = toNum(size);
    valid.push({
      region, warehouse: wh, date: dt, category, name,
      qty: q, size: sz, kg: q*sz,
      customer: toStr(row['Customer Name (Customer Reference)']),
      comercial: toStr(row['Comercial']),
      eta: parseGSheetDate(row['ETA']),
    });
  });
  if(valid.length===0){
    throw new Error('La hoja "Informe Inventario 22+" no devolvió líneas de venta válidas. Revisa nombres de columnas.');
  }
  const trailing12 = valid.filter(v=>v.date>=last12Start && v.date<=TODAY);

  function wavg(rows, valKey, wKey){
    const w = rows.reduce((s,r)=>s+(r[wKey]||0),0);
    if(w===0) return null;
    return rows.reduce((s,r)=>s+(r[valKey]||0)*(r[wKey]||0),0)/w;
  }

  // ---------- 3. master_ico_full (ICO x cliente cross-reference, incl. On Spot + On Float) ----------
  // ---------- 4. master_ico_full (ICO x cliente cross-reference, incl. On Spot + On Float) ----------
  const REGIONS5 = ['USA','AU','UK','EU','MENA'];
  const catsFound = [...new Set(inv.filter(r=>r.status==='On Spot').map(r=>r.series))].filter(c=>c && c!=='SERVICE').sort();
  const openPos = drilldownRows.filter(r=> ['RESERVADO','FACTURADO SIN ROTAR'].includes(toStr(r['Estado'])));
  const invIcoSetOnSpot = new Set(inv.filter(r=>r.status==='On Spot').map(r=>r.ico));
  const clientsByIco = {};
  openPos.forEach(row=>{
    const ico = toStr(row['ICO']);
    if(!invIcoSetOnSpot.has(ico)) return;
    const cliente = toStr(row['Cliente']);
    if(!cliente) return;
    const bags = toNum(row['Cantidad']);
    const bagSize = toNum(row['Bag Size']);
    const kg = bags*bagSize;
    const key = ico+'||'+cliente;
    if(!clientsByIco[key]) clientsByIco[key] = {ico, cliente, bags:0, kg:0};
    clientsByIco[key].bags += bags;
    clientsByIco[key].kg += kg;
  });
  const clientListByIco = {};
  Object.values(clientsByIco).forEach(c=>{
    if(!clientListByIco[c.ico]) clientListByIco[c.ico] = [];
    clientListByIco[c.ico].push({cliente:c.cliente, bags:c.bags, kg:c.kg});
  });
  Object.values(clientListByIco).forEach(arr=>arr.sort((a,b)=>b.bags-a.bags));

  const master_ico_full = inv.map(r=>{
    const clients = clientListByIco[r.ico] || [];
    return {
      ico:r.ico, status:r.status, region:r.region, warehouse:r.warehouse, product:r.product, series:r.series,
      container:r.container,                                                 // ← NUEVA
      bag_size:r.bag_size, price:r.price, vejez_dias:r.vejez_dias, vejez_grupo:r.vejez_grupo,
      total_bags:r.total_bags, total_kg:r.total_kg, free_bags:r.free_bags,
      reserved_orders_bags:r.reserved_orders_bags, reserved_contracts_bags:r.reserved_contracts_bags,
      clients, n_clients:clients.length,
    };
  });

  // ---------- 8. warehouse_category_sales (con split sacos/cajas) ----------
  const wcsMap = {};
  trailing12.forEach(v=>{
    const key = v.region+'|'+v.warehouse+'|'+v.category;
    if(!wcsMap[key]) wcsMap[key] = {region:v.region, warehouse:v.warehouse, category:v.category, kg:0, bags_sacos:0, bags_cajas:0};
    wcsMap[key].kg += v.kg;
    if(v.size<=24) wcsMap[key].bags_cajas += v.qty; else wcsMap[key].bags_sacos += v.qty;
  });
  const warehouse_category_sales = Object.values(wcsMap);

  // ---------- 9. top5_by_region (con split sacos/cajas) ----------
  const windows = [3,6,9,12];
  const top5_by_region = {};
  REGIONS5.forEach(region=>{
    top5_by_region[region] = {};
    const rdf = valid.filter(v=>v.region===region);
    windows.forEach(w=>{
      const start = new Date(TODAY); start.setMonth(start.getMonth()-w);
      const wdf = rdf.filter(v=>v.date>=start && v.date<=TODAY);
      top5_by_region[region][String(w)] = {};
      const buildTop5 = (rows)=>{
        const totalKg = rows.reduce((s,v)=>s+v.kg,0);
        const totalSacos = rows.filter(v=>v.size>24).reduce((s,v)=>s+v.qty,0);
        const totalCajas = rows.filter(v=>v.size<=24).reduce((s,v)=>s+v.qty,0);
        const byName = {};
        rows.forEach(v=>{
          if(!byName[v.name]) byName[v.name]={kg:0,sacos:0,cajas:0};
          byName[v.name].kg+=v.kg;
          if(v.size<=24) byName[v.name].cajas+=v.qty; else byName[v.name].sacos+=v.qty;
        });
        const top5 = Object.entries(byName).sort((a,b)=>b[1].kg-a[1].kg).slice(0,20)
          .map(([name,d])=>({name, kg:d.kg, bags_sacos:d.sacos, bags_cajas:d.cajas, pct: totalKg>0?d.kg/totalKg*100:0}));
        return {total_kg:totalKg, total_bags_sacos:totalSacos, total_bags_cajas:totalCajas, top5};
      };
      top5_by_region[region][String(w)]['ALL'] = buildTop5(wdf);
      catsFound.forEach(cat=>{
        top5_by_region[region][String(w)][cat] = buildTop5(wdf.filter(v=>v.category===cat));
      });
    });
  });

  // ---------- 9b. product_monthly_trend: KG mensual por producto, 12 meses móviles ----------
  const trendMonthStarts = [];
  { let cursor = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    for(let i=0;i<12;i++){ trendMonthStarts.unshift(new Date(cursor)); cursor.setMonth(cursor.getMonth()-1); } }
  const trendMonthLabels = trendMonthStarts.map(d=>d.toLocaleDateString('en-US',{month:'short',year:'numeric'}));
  function monthlySeriesFor(rows){
    const byName = {};
    rows.forEach(v=>{ if(!byName[v.name]) byName[v.name]=trendMonthStarts.map(()=>0); });
    Object.keys(byName).forEach(name=>{
      const nameRows = rows.filter(v=>v.name===name);
      trendMonthStarts.forEach((ms,i)=>{
        let me = new Date(ms.getFullYear(), ms.getMonth()+1, 0);
        if(me>TODAY) me = TODAY;
        const kg = nameRows.filter(v=>v.date>=ms && v.date<=me).reduce((s,v)=>s+v.kg,0);
        byName[name][i] = Math.round(kg*10)/10;
      });
    });
    return byName;
  }
  const product_monthly_trend = {months: trendMonthLabels, ALL: monthlySeriesFor(valid)};
  REGIONS5.forEach(region=> product_monthly_trend[region] = monthlySeriesFor(valid.filter(v=>v.region===region)));

  // ---------- 10. monthly_by_region_category (YTD del año actual) ----------
  const year = TODAY.getFullYear();
  const monthLabels = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const monthsCount = TODAY.getMonth()+1; // meses transcurridos del año en curso
  const buildMonthlyRows = (rows)=>{
    const out = [];
    for(let m=0;m<monthsCount;m++){
      const start = new Date(year, m, 1);
      const end = m===TODAY.getMonth() ? TODAY : new Date(year, m+1, 0);
      const mdf = rows.filter(v=>v.date>=start && v.date<=end);
      const row = {month: `${monthLabels[m]} ${year}`};
      catsFound.forEach(cat=>{
        const cdf = mdf.filter(v=>v.category===cat);
        const sacosDf = cdf.filter(v=>v.size>24), cajasDf = cdf.filter(v=>v.size<=24);
        row[cat] = {kg: cdf.reduce((s,v)=>s+v.kg,0),
          bags_sacos: sacosDf.reduce((s,v)=>s+v.qty,0), bags_cajas: cajasDf.reduce((s,v)=>s+v.qty,0),
          kg_sacos: sacosDf.reduce((s,v)=>s+v.kg,0), kg_cajas: cajasDf.reduce((s,v)=>s+v.kg,0)};
      });
      out.push(row);
    }
    return out;
  };
  const monthly_by_region_category = {categories:catsFound, regions:{ALL:buildMonthlyRows(valid)}};
  REGIONS5.forEach(region=> monthly_by_region_category.regions[region] = buildMonthlyRows(valid.filter(v=>v.region===region)));

  // ---------- 10b. monthly_vejez_venta: vejez al vender por mes (YTD), KG-ponderada ----------
  const validWithEta = valid.filter(v=>v.eta);
  const buildMonthlyVejez = (rows)=>{
    const out = [];
    for(let m=0;m<monthsCount;m++){
      const start = new Date(year, m, 1);
      const end = m===TODAY.getMonth() ? TODAY : new Date(year, m+1, 0);
      const mdf = rows.filter(v=>v.date>=start && v.date<=end);
      const row = {month: `${monthLabels[m]} ${year}`};
      catsFound.forEach(cat=>{
        const cdf = mdf.filter(v=>v.category===cat);
        const kg = cdf.reduce((s,v)=>s+v.kg,0);
        const vw = cdf.reduce((s,v)=>s+((v.date-v.eta)/86400000)*v.kg, 0);
        row[cat] = kg>0 ? Math.round((vw/kg)*10)/10 : null;
      });
      out.push(row);
    }
    return out;
  };
  const monthly_vejez_venta = {categories:catsFound, regions:{ALL:buildMonthlyVejez(validWithEta)}};
  REGIONS5.forEach(region=> monthly_vejez_venta.regions[region] = buildMonthlyVejez(validWithEta.filter(v=>v.region===region)));

  // ---------- sales_vejez_by_region_category: qué tan viejo estaba el café AL VENDERSE (12m), KG-ponderado ----------
  const trailing12ForVejez = trailing12.filter(v=>v.eta);
  const sales_vejez_by_region_category = [];
  ['ALL', ...REGIONS5].forEach(region=>{
    const dfR = region==='ALL' ? trailing12ForVejez : trailing12ForVejez.filter(v=>v.region===region);
    catsFound.forEach(cat=>{
      const dfRC = dfR.filter(v=>v.category===cat);
      const kg = dfRC.reduce((s,v)=>s+v.kg,0);
      const vejezW = dfRC.reduce((s,v)=>s+((v.date-v.eta)/86400000)*v.kg, 0);
      sales_vejez_by_region_category.push({
        region, category:cat, kg: Math.round(kg*10)/10,
        vejez_venta_avg: kg>0 ? Math.round((vejezW/kg)*10)/10 : null,
      });
    });
  });

  // ---------- reservas_vencidas: posiciones abiertas cuya fecha de entrega comprometida ya pasó ----------
  const invIcosOnSpot = new Set(inv.filter(r=>r.status==='On Spot').map(r=>r.ico));
  const icoInfo = {};
  inv.forEach(r=>{ if(r.status==='On Spot') icoInfo[r.ico] = r; });
  const reservas_vencidas = [];
  drilldownRows.forEach(row=>{
    const estado = toStr(row['Estado']);
    if(estado!=='RESERVADO' && estado!=='FACTURADO SIN ROTAR') return;
    const ico = toStr(row['ICO']);
    if(!invIcosOnSpot.has(ico)) return;
    const lastDelivery = parseGSheetDate(row['Last Delivery']);
    if(!lastDelivery || lastDelivery >= TODAY) return;
    const info = icoInfo[ico];
    const diasVencida = Math.round((TODAY-lastDelivery)/86400000);
    const fechaReserva = parseGSheetDate(row['Fecha Reserva']);
    reservas_vencidas.push({
      ico, cliente: toStr(row['Cliente']),
      product: info?info.product:'', category: info?info.series:'', region: info?info.region:'',
      warehouse: info?info.warehouse:toStr(row['Bodega']),
      bag_size: info?info.bag_size:null,
      bolsas: toNum(row['Cantidad']),
      fecha_reserva: fechaReserva ? fechaReserva.toISOString().slice(0,10) : null,
      last_delivery: lastDelivery.toISOString().slice(0,10),
      dias_vencida: diasVencida,
    });
  });
  reservas_vencidas.sort((a,b)=>b.dias_vencida-a.dias_vencida);

  return {
    meta: {generated_for_date: TODAY.toISOString().slice(0,10), currency_note:'Amounts en USD donde aplica', source:'live-refresh'},
    top5_by_region, master_ico_full, warehouse_category_sales, monthly_by_region_category,
    sales_vejez_by_region_category, reservas_vencidas, product_monthly_trend, monthly_vejez_venta,
    leadtime_summary: [],
  };
}
