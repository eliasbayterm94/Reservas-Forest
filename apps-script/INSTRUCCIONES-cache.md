# Control de Inventario — hacer que abra rápido

Hoy cada visita al `/exec` relee las tres hojas y recalcula el payload entero:
~40 s de espera, cada vez, aunque nadie haya tocado los datos.

Se ataca por dos lados:

| | Qué hace | Efecto |
|---|---|---|
| **1. Caché + trigger** | Guarda el payload ya calculado y lo renueva solo cada 4 h | La espera al abrir la pestaña pasa de ~40 s a un par de segundos |
| **2. Un bucle menos** | Corrige la parte más pesada del cálculo | Abarata el recálculo (el que corre el trigger) |

El paso 1 es el que se nota. El 2 es opcional, pero conviene: mientras más
barato el recálculo, menos riesgo de topar el límite de 6 min de Apps Script.

---

## Paso 1 — Añadir el archivo de caché

En el proyecto de Apps Script: **Archivos → + → Secuencia de comandos**,
nómbralo `CacheDashboard` y pega dentro todo el contenido de
[`control-inventario-cache.gs`](control-inventario-cache.gs).

Es un archivo nuevo, no sobrescribe nada. Sus nombres llevan prefijo `ci`/`CI_`
para no chocar con lo que ya existe.

## Paso 2 — Reemplazar el `doGet`

Queda así (cambia el cuerpo del `try`; el `catch` solo suma la línea del
iframe que ya pusiste):

```js
function doGet(e){
  try {
    const forzar = !!(e && e.parameter && e.parameter.refresh === '1');
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
```

Dos cosas cambiaron: ahora recibe `e` (para poder leer `?refresh=1`) y pide el
HTML a `ciDashboardHtml_` en vez de a `construirDashboardHtml_`.

**`construirDashboardHtml_` y el menú dentro de Sheets no se tocan.** Siguen
generando todo fresco, como hasta hoy.

## Paso 3 — Dejar el caché siempre caliente

En el editor, elige la función `crearTriggerCacheControlInv` en el selector de
arriba y pulsa **Ejecutar**. Una sola vez. Eso deja programado el recálculo
cada 4 h, así el equipo casi nunca cae en el camino lento.

Verás el trigger en **⏰ Activadores**. Para quitarlo, se borra desde ahí.

## Paso 4 — Redesplegar

**Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar.**

Como antes: por ahí, no por "Nueva implementación", para conservar la URL.

## Paso 5 — Comprobar

1. Abre el `/exec`. La primera vez puede tardar lo de siempre (está calculando
   y guardando).
2. Recárgalo. Debería abrir en un par de segundos.
3. En el editor, **Ejecuciones**, verás los `calentarCacheControlInv` del
   trigger y cuánto tardó cada uno.

El botón **Actualizar** de la pestaña en la app manda `?refresh=1`, que salta el
caché y recalcula: ahí sí espera los ~40 s, pero solo cuando tú lo pides.

---

## Paso 6 (opcional) — El bucle pesado

Dentro de `buildDataFromRaw`, en la sección `9b. product_monthly_trend`, está
esta función:

```js
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
```

Recorre la tabla de ventas **entera una vez por producto**, y otra vez por cada
mes de cada producto. Con ~11.600 ventas y cientos de productos son millones de
comparaciones, repetidas 6 veces (total + 5 regiones).

Reemplázala por esto — mismo resultado, mismos bordes de mes, un solo recorrido:

```js
  const trendMonthEnds = trendMonthStarts.map(ms=>{
    const me = new Date(ms.getFullYear(), ms.getMonth()+1, 0);
    return me > TODAY ? TODAY : me;
  });
  function monthlySeriesFor(rows){
    const byName = {};
    rows.forEach(v=>{
      let serie = byName[v.name];
      if(!serie) serie = byName[v.name] = trendMonthStarts.map(()=>0);
      for(let i=0;i<trendMonthStarts.length;i++){
        if(v.date>=trendMonthStarts[i] && v.date<=trendMonthEnds[i]){ serie[i]+=v.kg; break; }
      }
    });
    Object.keys(byName).forEach(name=>{
      byName[name] = byName[name].map(kg=>Math.round(kg*10)/10);
    });
    return byName;
  }
```

Cómo comprobar que no cambió ningún número: en el dashboard, la gráfica de
tendencia mensual por producto (Módulo 2) debe verse idéntica antes y después.
