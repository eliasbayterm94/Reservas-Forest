// =============================================================================
// generarDrilldownPosiciones — v6 (sobre v4)
//
// CAMBIOS RESPECTO A v4:
//   - T (Price Per KG) y U/V (First/Last Delivery) se buscan en CONSOLIDADO
//     CONTRATOS por codigo padre + cafe (col H, Reference). Antes se buscaba
//     solo por contrato y la ultima linea del contrato pisaba a las demas: en
//     contratos con varios cafes todos quedaban con el precio del ultimo, y un
//     cafe que no es del contrato (p. ej. un Black Condor en una factura de
//     contrato) heredaba un precio ajeno.
//   - Si el cafe no esta en su contrato, T queda vacio; U/V se toman del
//     contrato solo si todas sus lineas tienen las mismas fechas (si no, vacias).
//     Esas filas se listan en el registro y el status lo avisa.
//   - Cafes equivalentes (DRILL_EQUIVALENCIAS_): Black Condor, Huila Condor y
//     Reforest Washed cuentan como la misma referencia al buscar en el contrato.
//   - Reservas sin contrato ("Not Assigned", "Spot Contract": codigos sin
//     numeros) no se cruzan con CONSOLIDADO: T/U/V quedan vacios.
//   - El registro tambien lista los contratos que no aparecen en CONSOLIDADO.
//
// CAMBIOS DE v4 RESPECTO A v3:
//   - Se agrega el campo "Container" en la columna AB (28).
//     Se detecta automaticamente en la hoja de origen (igual que Serie,
//     Pallet Price, Bag Size) y se escribe/limpia igual que esas columnas.
//   - La remocion del filtro activo se movio al INICIO de la funcion,
//     antes de escribir "Actualizando..." en el status y antes de leer
//     configs. Asi ninguna lectura/escritura posterior choca con un
//     filtro activo. Se envolvio en try/catch para que un fallo al
//     remover el filtro no tumbe el resto del script.
//
// FIXES HEREDADOS DE v3:
//   1. Columna K (Estado) tiene formulas propias → NO se borra con clearContent.
//      Se reescriben las formulas al final sobre el rango exacto de filas con datos.
//   2. Si contractData viene vacio (error en trigger), T/U/V NO se tocan.
//   3. Filtro se remueve antes de operar y se recrea al final.
//   4. Status cell muestra error exacto cuando algo falla.
// =============================================================================

function generarDrilldownPosiciones() {
  const ss = SpreadsheetApp.getActive();
  const offeringSS = SpreadsheetApp.openById(OFFERING_LISTS_SPREADSHEET_ID);

  let out = ss.getSheetByName(DRILL_OUTPUT_SHEET);
  if (!out) out = ss.insertSheet(DRILL_OUTPUT_SHEET);

  // ── REMOVER FILTRO ACTIVO — LO PRIMERO QUE HACE EL SCRIPT ────────────────
  // Movido al inicio para que ninguna operacion posterior (limpiar, escribir,
  // recrear filtro) choque con un filtro activo. try/catch para que un
  // fallo aca (filtro ya eliminado, problema de estado, etc.) no impida que
  // el resto del script corra.
  try {
    const existingFilter = out.getFilter();
    if (existingFilter) existingFilter.remove();
  } catch (e) {
    Logger.log("No se pudo remover el filtro existente: " + e.message);
  }

  ss.getRange(DRILL_STATUS_CELL).setValue("Actualizando...");

  const configs = DRILL_getSheetConfigsFromMapping_(ss);
  if (!Object.keys(configs).length) {
    ss.getRange(DRILL_STATUS_CELL).setValue("Error: sin config");
    return;
  }

  // ── ENCABEZADOS BASE ──────────────────────────────────────────────────────
  if (out.getLastRow() === 0) {
    out.getRange(1, 1, 1, 13).setValues([[
      "Bodega", "Cliente", "Cafe", "ICO", "Cantidad",
      "Tiene factura", "Tiene DO", "Spot/Contrato?",
      "Columna", "ICO ETA", "Estado",
      "Contrato", "Comercial"
    ]]);
  }

  // ── COLUMNAS COMPLEMENTARIAS ──────────────────────────────────────────────
  out.getRange(1, 15, 1, 5).setValues([[
    "Factura #", "Serie", "Fecha Reserva", "Pallet Price", "Bag Size"
  ]]);
  out.getRange(1, 20, 1, 1).setValue("Price Per KG");
  out.getRange(1, 21, 1, 1).setValue("First Delivery");
  out.getRange(1, 22, 1, 1).setValue("Last Delivery");
  out.getRange(1, 28, 1, 1).setValue("Container"); // AB
  // Formato de texto para toda la columna AB, asi Sheets nunca la
  // reinterpreta como fecha/numero (incluye filas ya existentes).
  if (out.getMaxRows() > 1) {
    out.getRange(2, 28, out.getMaxRows() - 1, 1).setNumberFormat("@");
  }

  // ── LIMPIAR DATOS ANTERIORES ──────────────────────────────────────────────
  // Col K (11) = Estado tiene formulas propias → se salta.
  // Se limpia A-J (1-10) y L-M (12-13) por separado.
  // T-V (20-22) solo se limpian si contractData carga OK (ver mas abajo).
  // AB (28) = Container se limpia junto con O-S ya que no tiene formulas propias.
  const maxRows = out.getMaxRows();
  if (maxRows > 1) {
    out.getRange(2, 1,  maxRows - 1, 10).clearContent(); // A-J  (cols  1-10)
    out.getRange(2, 12, maxRows - 1,  2).clearContent(); // L-M  (cols 12-13)
    out.getRange(2, 15, maxRows - 1,  5).clearContent(); // O-S  (cols 15-19)
    out.getRange(2, 28, maxRows - 1,  1).clearContent(); // AB   (col  28)
  }

  let drillAvisoContratos = ""; // v6: aviso de cafes que no estan en su contrato
  const events = [];
  const clientsByRegion = {};

  for (const k in configs) {
    const cfg   = configs[k];
    const sheet = DRILL_getSheetById_(offeringSS, cfg.sheetId);
    if (!sheet) continue;

    const cols = DRILL_detectarICOyNombre_(sheet);
    if (!cols.icoCol || !cols.nameCol) continue;

    const etaCol         = DRILL_detectarETACol_(sheet);
    const serieCol       = DRILL_detectarSerieCol_(sheet);
    const palletPriceCol = DRILL_detectarPalletPriceCol_(sheet);
    const bagSizeCol     = DRILL_detectarBagSizeCol_(sheet);
    const containerCol   = DRILL_detectarContainerCol_(sheet);

    const lastRow = sheet.getLastRow();
    if (lastRow < DATA_START_ROW) continue;

    const lastCol  = sheet.getLastColumn();
    const rowCount = lastRow - DATA_START_ROW + 1;

    const headersRow      = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
    const facturaRow      = DRILL_safeGetRow_(sheet, DRILL_FACTURA_ROW,   lastCol);
    const doRow           = DRILL_safeGetRow_(sheet, DRILL_DO_ROW,        lastCol);
    const contratoRow     = DRILL_safeGetRow_(sheet, DRILL_CONTRATO_ROW,  lastCol);
    const comercialRow    = DRILL_safeGetRow_(sheet, DRILL_COMERCIAL_ROW, lastCol);
    const fechaReservaRow = DRILL_safeGetRow_(sheet, 5, lastCol);

    const icoVals  = sheet.getRange(DATA_START_ROW, cols.icoCol,  rowCount, 1).getValues();
    const nameVals = sheet.getRange(DATA_START_ROW, cols.nameCol, rowCount, 1).getValues();

    const etaVals         = etaCol         ? sheet.getRange(DATA_START_ROW, etaCol,         rowCount, 1).getValues() : [];
    const serieVals       = serieCol       ? sheet.getRange(DATA_START_ROW, serieCol,       rowCount, 1).getValues() : [];
    const palletPriceVals = palletPriceCol ? sheet.getRange(DATA_START_ROW, palletPriceCol, rowCount, 1).getValues() : [];
    const bagSizeVals     = bagSizeCol     ? sheet.getRange(DATA_START_ROW, bagSizeCol,     rowCount, 1).getValues() : [];
    const containerVals   = containerCol   ? sheet.getRange(DATA_START_ROW, containerCol,   rowCount, 1).getValues() : [];

    const oS = cfg.primeraOrders;
    const oE = cfg.ultimaOrders;
    const cS = cfg.primeraContracts;
    const cE = cfg.ultimaContracts;

    const oW = oS && oE && oE >= oS ? oE - oS + 1 : 0;
    const cW = cS && cE && cE >= cS ? cE - cS + 1 : 0;

    const oVals = oW ? sheet.getRange(DATA_START_ROW, oS, rowCount, oW).getValues() : [];
    const cVals = cW ? sheet.getRange(DATA_START_ROW, cS, rowCount, cW).getValues() : [];

    for (let r = 0; r < rowCount; r++) {
      const ico         = DRILL_cleanIcoValue_(icoVals[r][0]);
      const cafe        = nameVals[r][0] ? nameVals[r][0].toString() : "";
      const eta         = etaVals.length         ? etaVals[r][0]         : "";
      const serie       = serieVals.length       ? serieVals[r][0]       : "";
      const palletPrice = palletPriceVals.length ? palletPriceVals[r][0] : "";
      const bagSize     = bagSizeVals.length     ? bagSizeVals[r][0]     : "";
      const container   = containerVals.length   ? containerVals[r][0]   : "";

      if (!ico && !cafe) continue;

      // ── SPOT / ORDERS ────────────────────────────────────────────────────
      if (oW) {
        for (let c = 0; c < oW; c++) {
          const qty = DRILL_toNumberSafe_(oVals[r][c]);
          if (!qty) continue;

          const colIndex     = oS + c;
          const clientRaw    = (headersRow[colIndex - 1] ?? "").toString().trim();
          if (!clientRaw) continue;

          const contratoVal  = DRILL_isNonEmpty_(contratoRow[colIndex - 1])     ? contratoRow[colIndex - 1]                   : "Not Assigned";
          const comercialVal = DRILL_isNonEmpty_(comercialRow[colIndex - 1])    ? comercialRow[colIndex - 1]                  : "Not Assigned";
          const facturaRaw   = DRILL_isNonEmpty_(facturaRow[colIndex - 1])      ? facturaRow[colIndex - 1].toString().trim()  : "";
          const fechaReserva = DRILL_isNonEmpty_(fechaReservaRow[colIndex - 1]) ? fechaReservaRow[colIndex - 1]               : "";

          events.push([
            cfg.region,                                    // 0  A  Bodega
            clientRaw,                                     // 1  B  Cliente
            cafe,                                          // 2  C  Cafe
            ico,                                           // 3  D  ICO
            qty,                                           // 4  E  Cantidad
            DRILL_hasMinText3_(facturaRow[colIndex - 1]), // 5  F  Tiene factura
            DRILL_hasMinText3_(doRow[colIndex - 1]),      // 6  G  Tiene DO
            "SPOT",                                        // 7  H  Spot/Contrato?
            DRILL_colIndexToLetter_(colIndex),             // 8  I  Columna
            eta,                                           // 9  J  ICO ETA
            // col K (11) = Estado → formula propia, NO se escribe aqui
            contratoVal,                                   // 10 L  Contrato
            comercialVal,                                  // 11 M  Comercial
            facturaRaw,                                    // 12 O  Factura #
            serie,                                         // 13 P  Serie
            fechaReserva,                                  // 14 Q  Fecha Reserva
            palletPrice,                                   // 15 R  Pallet Price
            bagSize,                                       // 16 S  Bag Size
            container,                                     // 17 AB Container
            // 18 T Price Per KG   → se rellena despues si contractData OK
            // 19 U First Delivery → se rellena despues si contractData OK
            // 20 V Last Delivery  → se rellena despues si contractData OK
          ]);

          clientsByRegion[cfg.region] = clientsByRegion[cfg.region] || new Set();
          clientsByRegion[cfg.region].add(clientRaw);
        }
      }

      // ── CONTRACTS ────────────────────────────────────────────────────────
      if (cW) {
        for (let c = 0; c < cW; c++) {
          const qty = DRILL_toNumberSafe_(cVals[r][c]);
          if (!qty) continue;

          const colIndex     = cS + c;
          const clientRaw    = (headersRow[colIndex - 1] ?? "").toString().trim();
          if (!clientRaw) continue;

          const contratoVal  = DRILL_isNonEmpty_(contratoRow[colIndex - 1])     ? contratoRow[colIndex - 1]                   : "Not Assigned";
          const comercialVal = DRILL_isNonEmpty_(comercialRow[colIndex - 1])    ? comercialRow[colIndex - 1]                  : "Not Assigned";
          const facturaRaw   = DRILL_isNonEmpty_(facturaRow[colIndex - 1])      ? facturaRow[colIndex - 1].toString().trim()  : "";
          const fechaReserva = DRILL_isNonEmpty_(fechaReservaRow[colIndex - 1]) ? fechaReservaRow[colIndex - 1]               : "";

          events.push([
            cfg.region,
            clientRaw,
            cafe,
            ico,
            qty,
            DRILL_hasMinText3_(facturaRow[colIndex - 1]),
            DRILL_hasMinText3_(doRow[colIndex - 1]),
            "CONTRACT",
            DRILL_colIndexToLetter_(colIndex),
            eta,
            contratoVal,
            comercialVal,
            facturaRaw,
            serie,
            fechaReserva,
            palletPrice,
            bagSize,
            container,
          ]);

          clientsByRegion[cfg.region] = clientsByRegion[cfg.region] || new Set();
          clientsByRegion[cfg.region].add(clientRaw);
        }
      }
    }
  }

  // ── CONSTRUIR MAPA desde CONSOLIDADO CONTRATOS ────────────────────────────
  const { map: contractData, error: contractError } = DRILL_buildContractDataMap_();
  const contractsLoaded = Object.keys(contractData).length > 0;
  Logger.log("Contratos cargados: " + contractsLoaded + " (" + Object.keys(contractData).length + ")");
  if (contractError) Logger.log("Error contratos: " + contractError);

  const canon     = DRILL_buildPrefixCanonicalClientMap_(clientsByRegion);
  const finalRows = events.map(r => {
    r[1] = canon[r[0]]?.[r[1]] || r[1];
    return r;
  });

  // ── ESCRITURA FINAL ───────────────────────────────────────────────────────
  if (finalRows.length) {
    const left  = finalRows.map(r => r.slice(0, 10));       // A-J  cols 1-10
    const right = finalRows.map(r => [r[10], r[11]]);       // L-M  cols 12-13
    const extra = finalRows.map(r => [
      r[12] ?? "", // O - Factura #
      r[13] ?? "", // P - Serie
      r[14] ?? "", // Q - Fecha Reserva
      r[15] ?? "", // R - Pallet Price
      r[16] ?? ""  // S - Bag Size
    ]);
    // Se fuerza a texto explicitamente para que Sheets no interprete el
    // valor de Container como fecha/numero (ej. "10/12" o numeros largos).
    const containerCol = finalRows.map(r => [DRILL_asText_(r[17])]); // AB - Container

    out.getRange(2, 1,  left.length,  10).setValues(left);
    out.getRange(2, 12, right.length,  2).setValues(right);
    out.getRange(2, 15, extra.length,  5).setValues(extra);

    // Formato de texto plano ANTES de escribir los valores, si no Sheets
    // puede re-interpretar el valor recien puesto segun su formato previo.
    out.getRange(2, 28, containerCol.length, 1).setNumberFormat("@");
    out.getRange(2, 28, containerCol.length, 1).setValues(containerCol);

    // ── FORMULAS COLUMNA K (Estado) ──────────────────────────────────────
    // Se reescribe la formula en cada fila del rango actual.
    // Filas sobrantes del rango anterior se limpian.
    const formulaK = finalRows.map((_, i) => {
      const row = i + 2;
      return [
        '=IF(OR(D' + row + '="",AND(F' + row + '="",G' + row + '="")),"",IF(AND(F' + row + '=FALSE,G' + row + '=FALSE),"RESERVADO",IF(AND(F' + row + '=TRUE,G' + row + '=FALSE),"FACTURADO SIN ROTAR",IF(AND(F' + row + '=TRUE,G' + row + '=TRUE),"DESPACHADO","INCONSISTENTE"))))'
      ];
    });
    out.getRange(2, 11, formulaK.length, 1).setFormulas(formulaK);

    // Limpiar filas de K que quedaron fuera del rango actual
    const filasFinal = finalRows.length + 1; // +1 encabezado
    if (maxRows > filasFinal) {
      out.getRange(filasFinal + 1, 11, maxRows - filasFinal, 1).clearContent();
      out.getRange(filasFinal + 1, 28, maxRows - filasFinal, 1).clearContent(); // AB
    }

    // ── T/U/V: SOLO SE ESCRIBEN SI EL MAPA DE CONTRATOS CARGO BIEN ───────
    // Si contractData vino vacio (timeout/permisos en trigger automatico),
    // NO se tocan T/U/V para preservar los valores anteriores.
    if (contractsLoaded) {
      if (maxRows > 1) out.getRange(2, 20, maxRows - 1, 3).clearContent(); // limpiar T-V primero

      // v6: se busca por codigo padre + cafe. El precio (T) solo sale de la
      // linea del mismo cafe: si el cafe no esta en el contrato queda vacio,
      // en vez de heredar el precio de otro cafe. Las fechas (U, V) son del
      // contrato: si no aparece el cafe, se toman de la primera linea del
      // contrato que las tenga.
      const sinCafe = [], sinContrato = [];
      const matches = finalRows.map((r, i) => {
        const res = DRILL_buscarLineaContrato_(contractData, r[10], r[2]);
        if (res.motivo === "sin cafe")     sinCafe.push(`fila ${i + 2}: ${r[10]} · ${r[2]} (${r[1]})`);
        if (res.motivo === "sin contrato") sinContrato.push(`fila ${i + 2}: ${r[10]} · ${r[2]} (${r[1]})`);
        return res;
      });
      if (sinCafe.length)     Logger.log("Cafe que no esta en su contrato (" + sinCafe.length + "):\n" + sinCafe.join("\n"));
      if (sinContrato.length) Logger.log("Contrato no encontrado en CONSOLIDADO (" + sinContrato.length + "):\n" + sinContrato.join("\n"));
      drillAvisoContratos = sinCafe.length ? ` · ${sinCafe.length} reservas con un cafe que no esta en su contrato (ver registro)` : "";

      const priceCol    = matches.map(m => [m.linea  ? (m.linea.pricePerKg ?? "") : ""]);
      const firstDelCol = matches.map(m => [m.fechas ? DRILL_formatDate_(m.fechas.firstDelivery) : ""]);
      const lastDelCol  = matches.map(m => [m.fechas ? DRILL_formatDate_(m.fechas.lastDelivery)  : ""]);

      out.getRange(2, 20, priceCol.length,    1).setValues(priceCol);
      out.getRange(2, 21, firstDelCol.length, 1).setValues(firstDelCol);
      out.getRange(2, 22, lastDelCol.length,  1).setValues(lastDelCol);

    } else {
      Logger.log("ADVERTENCIA: contractData vacio — columnas T/U/V no modificadas.");
    }

  } else {
    // Sin datos: limpiar K y AB completas
    if (maxRows > 1) {
      out.getRange(2, 11, maxRows - 1, 1).clearContent();
      out.getRange(2, 28, maxRows - 1, 1).clearContent();
    }
  }

  // ── RESTAURAR FILTRO ──────────────────────────────────────────────────────
  // Se vuelve a chequear y remover el filtro justo antes de crearlo, porque
  // entre la remocion inicial y este punto pueden pasar varios minutos
  // (DRILL_buildContractDataMap_ con reintentos), tiempo suficiente para que:
  //   - alguien cree un filtro manualmente desde el menu mientras corre el script
  //   - la remocion inicial haya fallado silenciosamente (catch la trago)
  //   - haya corrido una ejecucion en paralelo que ya recreo el filtro
  // Sin este chequeo, createFilter() revienta con
  // "No puedes crear un filtro en una hoja que ya tenga uno."
  const filterRows = (finalRows.length || 0) + 1;
  if (filterRows > 1) {
    try {
      const filterAntesDeCrear = out.getFilter();
      if (filterAntesDeCrear) filterAntesDeCrear.remove();
      out.getRange(1, 1, filterRows, 28).createFilter(); // ampliado hasta AB (28)
    } catch (e) {
      Logger.log("No se pudo recrear el filtro: " + e.message);
    }
  }

  // ── STATUS FINAL ──────────────────────────────────────────────────────────
  if (!contractsLoaded && contractError) {
    ss.getRange(DRILL_STATUS_CELL).setValue("OK (advertencia: contratos no actualizados — " + contractError + ")");
  } else if (!contractsLoaded) {
    ss.getRange(DRILL_STATUS_CELL).setValue("OK (advertencia: contratos vacios, T/U/V sin cambios)");
  } else {
    ss.getRange(DRILL_STATUS_CELL).setValue("OK" + drillAvisoContratos);
  }
}

// =============================================================================
// Helper: extrae clave normalizada del campo Contrato (codigo padre)
// =============================================================================
function DRILL_contratoKey_(contratoVal) {
  const raw = contratoVal ? contratoVal.toString() : "";
  return (raw.includes("||") ? raw.split("||")[0] : raw).trim().toUpperCase();
}

// =============================================================================
// DRILL_buscarLineaContrato_ — v6
// Busca la linea de CONSOLIDADO CONTRATOS por codigo padre + cafe.
// Devuelve { linea, fechas, motivo }:
//   linea  → linea del mismo cafe (de aqui sale el precio) o null
//   fechas → la misma linea; si no aparece el cafe, las del contrato solo
//            cuando todas sus lineas tienen las mismas fechas (si no, null)
//   motivo → "" | "sin cafe" (el contrato existe pero no tiene ese cafe)
//            | "sin contrato" (el codigo no esta en CONSOLIDADO)
// =============================================================================
// Cafes que cuentan como la misma referencia al cruzar con el contrato: si la
// reserva dice uno y el contrato otro del mismo grupo, se toma esa linea.
// Nombres en minuscula, sin tildes ni signos (como los deja DRILL_norm_).
const DRILL_EQUIVALENCIAS_ = [
  ["black condor", "huila condor", "reforest washed"],
];

function DRILL_buscarLineaContrato_(contractData, contratoVal, cafe) {
  const key = DRILL_contratoKey_(contratoVal);
  // Solo codigos de contrato reales (llevan numeros). "Not Assigned" o
  // "Spot Contract" no son contratos: si CONSOLIDADO tuviera lineas con ese
  // texto, todas las reservas sin contrato heredarian sus fechas y precio.
  if (!key || !/\d/.test(key)) return { linea: null, fechas: null, motivo: "" };
  const lineas = contractData[key];
  if (!lineas) return { linea: null, fechas: null, motivo: "sin contrato" };

  const ref = DRILL_norm_(cafe);
  let cand  = ref ? lineas.filter(l => l.ref === ref) : [];
  // Si no esta con su nombre exacto, se acepta un cafe equivalente del contrato
  if (!cand.length && ref) {
    const grupo = DRILL_EQUIVALENCIAS_.find(g => g.includes(ref));
    if (grupo) cand = lineas.filter(l => grupo.includes(l.ref));
  }
  if (cand.length) {
    // El mismo cafe puede estar en varias lineas (p. ej. entregas parciales):
    // se prefiere la que tenga precio y fechas, y las fechas de cualquiera
    // de sus lineas que las tenga.
    const tieneFechas = l => l.firstDelivery || l.lastDelivery;
    const tienePrecio = l => l.pricePerKg !== "" && l.pricePerKg != null;
    const linea  = cand.find(l => tienePrecio(l) && tieneFechas(l)) || cand.find(tienePrecio) || cand[0];
    const fechas = tieneFechas(linea) ? linea : cand.find(tieneFechas) || null;
    if (!fechas) Logger.log(`Sin First/Last Delivery en CONSOLIDADO: ${DRILL_contratoKey_(contratoVal)} · ${cafe}`);
    return { linea, fechas, motivo: "" };
  }

  // Sin el cafe, las fechas del contrato solo sirven si todas sus lineas
  // tienen las mismas; si no, se tomarian las de otro cafe.
  const conFechas = lineas.filter(l => l.firstDelivery || l.lastDelivery);
  const firma     = l => DRILL_formatDate_(l.firstDelivery) + "|" + DRILL_formatDate_(l.lastDelivery);
  const unicas    = conFechas.length && conFechas.every(l => firma(l) === firma(conFechas[0]));
  return { linea: null, fechas: unicas ? conFechas[0] : null, motivo: "sin cafe" };
}

// =============================================================================
// DRILL_buildContractDataMap_
// Devuelve { map, error } en lugar de solo el mapa para poder distinguir
// fallo real de hoja vacia y NO borrar T/U/V si no hay datos.
// v6: el mapa guarda TODAS las lineas de cada contrato (una por cafe):
//     { "FC-26-NJ-9660": [ { ref, pricePerKg, firstDelivery, lastDelivery }, … ] }
// =============================================================================
function DRILL_buildContractDataMap_() {
  const MAX_RETRIES = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const contractsSS = SpreadsheetApp.openById(CONTRACTS_SPREADSHEET_ID);
      const sheet = contractsSS.getSheetByName("CONSOLIDADO CONTRATOS");

      if (!sheet) {
        Logger.log("DRILL_buildContractDataMap_: hoja no encontrada");
        return { map: {}, error: "Hoja CONSOLIDADO CONTRATOS no encontrada" };
      }

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return { map: {}, error: null };

      const data = sheet.getRange(2, 1, lastRow - 1, 16).getValues();
      const map  = {};

      data.forEach(row => {
        const rawId         = row[0]  ? row[0].toString().trim() : "";
        const reference     = row[7];  // col H - Reference (cafe)
        const pricePerKg    = row[11]; // col L
        const firstDelivery = row[14]; // col O
        const lastDelivery  = row[15]; // col P

        if (!rawId) return;

        const key = DRILL_contratoKey_(rawId);
        if (!key) return;
        (map[key] = map[key] || []).push({
          ref: DRILL_norm_(reference), pricePerKg, firstDelivery, lastDelivery
        });
      });

      Logger.log("DRILL_buildContractDataMap_: OK, " + Object.keys(map).length + " contratos (intento " + attempt + ")");
      return { map, error: null };

    } catch(e) {
      lastError = e;
      Logger.log("DRILL_buildContractDataMap_ ERROR intento " + attempt + ": " + e.message);
      if (attempt < MAX_RETRIES) Utilities.sleep(2000);
    }
  }

  return { map: {}, error: lastError ? lastError.message : "Error desconocido" };
}

// =============================================================================
// FUNCIONES AUXILIARES
// =============================================================================

function DRILL_hasMinText3_(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (v instanceof Date) return false;
  const s = v.toString().trim();
  if (!s) return false;
  const n = DRILL_norm_(s);
  if (n === "false" || n === "no" || n === "0" || n === "na" || n === "n a" || n === "none") return false;
  return s.length >= 1;
}

function DRILL_forwardFillRow_(row) {
  const out = row.slice();
  let last = "";
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    const isEmpty = v == null || (typeof v === "string" && v.trim() === "");
    if (!isEmpty) last = v;
    else if (last !== "") out[i] = last;
  }
  return out;
}

function DRILL_detectarETACol_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h === "eta" || h.includes("eta") || h.includes("arrival")) return i + 1;
  }
  return null;
}

function DRILL_detectarSerieCol_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h === "serie" || h === "series") return i + 1;
  }
  return null;
}

function DRILL_detectarPalletPriceCol_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h === "pallet price" || h === "palletprice" || h === "price" || (h.includes("pallet") && h.includes("price"))) return i + 1;
  }
  return null;
}

function DRILL_detectarBagSizeCol_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h === "bag size" || h === "bagsize" || h === "size" || h === "pack size" || h === "packsize") return i + 1;
  }
  return null;
}

// =============================================================================
// DRILL_detectarContainerCol_
// Detecta la columna "Container" en la hoja de origen (Offering Lists).
// Cubre variantes comunes de nombre de header.
// =============================================================================
function DRILL_detectarContainerCol_(sheet) {
  const headers = sheet.getRange(HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];

  // PASO 1: coincidencia EXACTA primero. Esto evita que una columna como
  // "Container ETA" o "Container Date" (que SI contiene fechas) sea
  // capturada antes de llegar a la columna real "Container".
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h === "container" || h === "contenedor" || h === "container #" ||
        h === "container number" || h === "no container") {
      return i + 1;
    }
  }

  // PASO 2: fallback solo si no hubo coincidencia exacta en toda la fila.
  for (let i = 0; i < headers.length; i++) {
    const h = DRILL_norm_(headers[i]);
    if (h.includes("container")) return i + 1;
  }

  return null;
}

function DRILL_getSheetConfigsFromMapping_(ss) {
  const sh = ss.getSheetByName(MAPPING_SHEET);
  if (!sh) return {};
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const cfgs = {};
  rows.forEach(r => {
    const [sheetId, region, type, ref] = r;
    if (!sheetId || !region || !type || !ref) return;
    const k = String(sheetId);
    cfgs[k] = cfgs[k] || { sheetId, region };
    const idx = DRILL_letterToColIndex_(ref);
    const t   = DRILL_norm_(type);
    if (t === "primera orders bags") cfgs[k].primeraOrders    = idx;
    if (t === "ultima orders bags")  cfgs[k].ultimaOrders     = idx;
    if (t === "primera contracts")   cfgs[k].primeraContracts = idx;
    if (t === "ultima contracts")    cfgs[k].ultimaContracts  = idx;
  });
  return cfgs;
}

function DRILL_buildPrefixCanonicalClientMap_(byRegion) {
  const out = {};
  for (const r in byRegion) {
    out[r] = {};
    const names = Array.from(byRegion[r]);
    const norm  = names.map(n => ({ raw: n, n: DRILL_normClient_(n) }));
    norm.forEach(a => {
      let best = a;
      norm.forEach(b => {
        if (a.n.startsWith(b.n) && b.n.length < best.n.length) best = b;
      });
      out[r][a.raw] = best.raw;
    });
  }
  return out;
}

function DRILL_detectarICOyNombre_(s) {
  const h = s.getRange(HEADER_ROW, 1, 1, s.getLastColumn()).getValues()[0];
  let ico = null, name = null;
  h.forEach((v, i) => {
    const n = DRILL_norm_(v);
    if (!ico  && n === "ico") ico = i + 1;
    if (!name && (n === "name" || n === "nombre" || n === "coffee name")) name = i + 1;
  });
  return { icoCol: ico, nameCol: name };
}

function DRILL_getSheetById_(ss, id) {
  const byName = ss.getSheetByName(String(id));
  if (byName) return byName;
  return ss.getSheets().find(s => String(s.getSheetId()) === String(id)) || null;
}

function DRILL_safeGetRow_(s, r, c) {
  if (r < 1 || r > s.getLastRow()) return new Array(c).fill("");
  return s.getRange(r, 1, 1, c).getValues()[0];
}

function DRILL_cleanIcoValue_(v) {
  if (!v) return "";
  const m = v.toString().match(/[0-9][0-9\-\/]*/);
  return m ? m[0] : v.toString().trim();
}

function DRILL_toNumberSafe_(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const m = v.toString().replace(",", ".").match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : 0;
}

function DRILL_isNonEmpty_(v) {
  if (v == null) return false;
  const s = v.toString().trim();
  if (!s) return false;
  const n = DRILL_norm_(s);
  if (n === "contrato" || n === "contratos") return false;
  return true;
}

function DRILL_normClient_(s) {
  return s.toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function DRILL_norm_(s) {
  return s ? DRILL_normClient_(s) : "";
}

function DRILL_letterToColIndex_(l) {
  let n = 0;
  l = l.toUpperCase();
  for (let i = 0; i < l.length; i++) n = n * 26 + (l.charCodeAt(i) - 64);
  return n;
}

function DRILL_colIndexToLetter_(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1) / 26 | 0;
  }
  return s;
}

// =============================================================================
// DRILL_asText_
// Convierte cualquier valor a texto plano seguro, evitando que Sheets lo
// reinterprete como fecha o numero (util para Container: "10/12", "0412", etc).
// =============================================================================
function DRILL_asText_(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    // Si por algun motivo llega como Date, se reconstruye el texto original
    // en formato dd/mm/yyyy en vez de dejar que Sheets la re-serialice.
    return DRILL_formatDate_(v);
  }
  return v.toString().trim();
}

function DRILL_formatDate_(v) {
  if (!v || v === "") return "";
  if (!(v instanceof Date)) return v.toString().trim();
  const d = String(v.getUTCDate()).padStart(2, "0");
  const m = String(v.getUTCMonth() + 1).padStart(2, "0");
  const y = v.getUTCFullYear();
  return d + "/" + m + "/" + y;
}
