// ═══════════════════════════════════════════════════════════════
// TRAER LA COLUMNA "Container" AL DASHBOARD
//
// El payload no llevaba el contenedor: master_ico_full solo traía ico, product,
// series, region, warehouse, bag_size, price, vejez_dias, vejez_grupo, status,
// total_bags, total_kg, free_bags, reserved_* y clients. Sin ese dato, el
// dashboard no puede mostrar la columna por más que se la agreguemos.
//
// Son dos bloques dentro de buildDataFromRaw, en tu archivo principal (el que
// tiene construirDashboardHtml_). Cada uno se reemplaza completo.
//
// Después de pegar: guardar y redesplegar (✏️ → Nueva versión). El caché guarda
// el payload ya calculado, así que la columna aparecerá cuando el activador
// recalcule (cada 4 h) o cuando pulses Actualizar en la app, que manda refresh=1.
// ═══════════════════════════════════════════════════════════════


// ───────────────────────────────────────────────────────────────
// BLOQUE 1 de 2 — dentro de buildDataFromRaw, sección
// "1. Inventory (CONSOLIDADO)".
// Busca "const inv = [];" y reemplaza hasta el cierre "});" del forEach.
// Único cambio: la línea marcada.
// ───────────────────────────────────────────────────────────────
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
      container: toStr(row['Container']),                          // ← NUEVA
      bag_size: bagSize, price: toNum(row['Price']),
      vejez_dias: toNum(row['Vejes']), vejez_grupo: toStr(row['Group Of Days Vejes']),
      total_bags: totalBags, total_kg: totalKg,
      free_bags: freeBags, free_kg: freeBags*bagSize,
      reserved_orders_bags: resOrders, reserved_contracts_bags: resContracts,
      reserved_kg: (resOrders+resContracts)*bagSize,
    });
  });


// ───────────────────────────────────────────────────────────────
// BLOQUE 2 de 2 — más abajo, donde se arma master_ico_full.
// Busca "const master_ico_full = inv.map(r=>{" y reemplaza hasta su "});".
// Único cambio: la línea marcada. Sin esto, el contenedor se lee de la hoja
// pero no llega al dashboard.
// ───────────────────────────────────────────────────────────────
  const master_ico_full = inv.map(r=>{
    const clients = clientListByIco[r.ico] || [];
    return {
      ico:r.ico, status:r.status, region:r.region, warehouse:r.warehouse, product:r.product, series:r.series,
      container:r.container,                                        // ← NUEVA
      bag_size:r.bag_size, price:r.price, vejez_dias:r.vejez_dias, vejez_grupo:r.vejez_grupo,
      total_bags:r.total_bags, total_kg:r.total_kg, free_bags:r.free_bags,
      reserved_orders_bags:r.reserved_orders_bags, reserved_contracts_bags:r.reserved_contracts_bags,
      clients, n_clients:clients.length,
    };
  });
