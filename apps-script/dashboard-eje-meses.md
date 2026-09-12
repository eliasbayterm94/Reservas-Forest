# Módulo 3 — poner el eje de meses (con año) en las mini-gráficas

## Qué pasa hoy

Revisado el dashboard desplegado, los meses aparecen así:

| Dónde | Estado |
|---|---|
| **Módulo 2 · Movimiento Mensual** (tabla) | Ya trae el año: `ene 2026`, `feb 2026`… |
| **Módulo 3 · Tendencia Mensual** (20 mini-gráficas) | **Sin eje.** Ninguna etiqueta de mes |

En el Módulo 3, cada café se dibuja como una línea de 180×70 px sin una sola
etiqueta. Los meses solo se mencionan una vez, en la nota al pie de toda la
cuadrícula: *"Cada mini-gráfica muestra los últimos 12 meses (Oct 2025 → Sep
2026)"*. Mirando una gráfica suelta no hay forma de saber dónde empieza, dónde
termina, ni dónde cambia el año.

## Qué cambia

1. Debajo de cada mini-gráfica, el mes inicial y el final **con año**: `oct '25` … `sep '26`.
2. Una línea punteada vertical en cada **enero**, que marca el cambio de año.
3. Los meses pasan a español, como en el Módulo 2 (hoy la serie viene en inglés).

Todo es del lado del cliente: solo se toca el archivo `Dashboard` del proyecto
de Apps Script. No cambia ningún dato ni ningún cálculo.

---

## Paso 1 — Una línea de CSS

En el archivo `Dashboard`, busca este bloque de estilos (está junto a las demás
reglas de `.trend-card`):

```css
  .trend-card .tc-foot{display:flex;justify-content:space-between;align-items:baseline;margin-top:2px;font-size:12.5px;}
```

Y **encima** de esa línea, agrega esta:

```css
  .trend-card .tc-axis{display:flex;justify-content:space-between;font-family:'Oswald';font-size:9.5px;letter-spacing:.04em;color:var(--ink-faint);margin-top:1px;}
```

## Paso 2 — Reemplazar `renderTrendChart`

Busca `function renderTrendChart(){` y reemplaza la función completa
(hasta su `}` de cierre) por esta:

```js
function renderTrendChart(){
  const byCat = DATA.top5_by_region[top5Region][top5Period];
  const d = byCat[top5Category] || byCat['ALL'];
  const items = d.top5;
  const trendEl = document.getElementById('trendChart');
  const legendEl = document.getElementById('trendLegend');
  legendEl.innerHTML = '';
  if(items.length===0){
    trendEl.innerHTML = '<div class="empty-note">Sin datos para graficar.</div>';
    return;
  }
  const allMonths = DATA.product_monthly_trend.months;
  const periodN = Math.min(parseInt(top5Period,10), allMonths.length);
  const months = allMonths.slice(allMonths.length-periodN);
  const seriesData = DATA.product_monthly_trend[top5Region] || {};

  // La serie viene en inglés ("Oct 2025"); se muestra como en el Módulo 2.
  const MES_ES = {Jan:'ene',Feb:'feb',Mar:'mar',Apr:'abr',May:'may',Jun:'jun',
                  Jul:'jul',Aug:'ago',Sep:'sep',Oct:'oct',Nov:'nov',Dec:'dic'};
  const mesCorto = m => {
    const p = String(m).split(' ');
    const mm = MES_ES[p[0]] || p[0];
    return p.length>1 ? mm + " '" + p[1].slice(-2) : mm;
  };

  const cardW=180, cardH=70, padL=4, padR=4, padT=6, padB=4;
  const plotW = cardW-padL-padR, plotH = cardH-padT-padB;
  const xPos = i => padL + (months.length>1 ? i*(plotW/(months.length-1)) : plotW/2);

  // Línea punteada donde cambia el año. Se calcula una vez: es igual en las 20.
  const lineasAno = months
    .map((m,i)=> String(m).slice(0,3)==='Jan' ? i : -1)
    .filter(i=>i>0)
    .map(i=>`<line x1="${xPos(i).toFixed(1)}" y1="${padT}" x2="${xPos(i).toFixed(1)}" y2="${(padT+plotH).toFixed(1)}" stroke="var(--ink-faint)" stroke-width="0.6" stroke-dasharray="2 2" opacity="0.55"/>`)
    .join('');

  const cards = items.map((item,idx)=>{
    const full = seriesData[item.name] || allMonths.map(()=>0);
    const values = full.slice(allMonths.length-periodN);
    const maxV = Math.max(1, ...values);
    const yPos = v => padT + plotH - (v/maxV)*plotH;
    const pts = values.map((v,i)=>`${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ');
    const last = values[values.length-1], prev = values.length>1 ? values[values.length-2] : last;
    const up = last>=prev;
    const areaPts = `${xPos(0).toFixed(1)},${(padT+plotH).toFixed(1)} ${pts} ${xPos(values.length-1).toFixed(1)},${(padT+plotH).toFixed(1)}`;
    const color = up ? 'var(--age-1)' : 'var(--stamp)';
    return `
    <div class="trend-card">
      <div class="tc-head"><span class="tc-rank">#${idx+1}</span><span class="tc-name" title="${item.name}">${item.name}</span></div>
      <svg viewBox="0 0 ${cardW} ${cardH}" width="100%" height="${cardH}" preserveAspectRatio="none">
        ${lineasAno}
        <polygon points="${areaPts}" fill="${up?'rgba(76,122,61,.14)':'rgba(178,58,34,.14)'}"/>
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
        <circle cx="${xPos(values.length-1).toFixed(1)}" cy="${yPos(last).toFixed(1)}" r="2.6" fill="${color}"/>
      </svg>
      <div class="tc-axis"><span>${mesCorto(months[0])}</span><span>${mesCorto(months[months.length-1])}</span></div>
      <div class="tc-foot"><b>${fmtKg(item.kg)}</b><span class="tc-arrow" style="color:${color}">${up?'▲':'▼'}</span></div>
    </div>`;
  }).join('');

  trendEl.innerHTML = `<div class="trend-grid">${cards}</div>
    <div class="trend-note">Cada mini-gráfica muestra los últimos ${months.length} meses (${mesCorto(months[0])} → ${mesCorto(months[months.length-1])}) de ese café. La línea punteada marca el cambio de año. Flecha: sube o baja vs. el mes anterior.</div>`;
}
```

## Paso 3 — Guardar y redesplegar

`Ctrl + S`, y luego
**Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar.**

Igual que siempre: por ahí, no por "Nueva implementación".

> El caché guarda los **datos**, no la página. El HTML se arma en cada visita, así
> que este cambio se ve apenas redespliegas, sin tocar ni vaciar el caché.

## Qué deberías ver

Debajo de cada mini-gráfica, dos etiquetas: la del mes inicial a la izquierda y
la del final a la derecha, ambas con el año — `oct '25` y `sep '26` con la
ventana de 12 meses. Y una línea punteada vertical donde arranca enero.

Al cambiar el periodo con los chips (3 / 6 / 9 / 12 meses) las etiquetas se
ajustan solas. En ventanas que no incluyen enero, simplemente no aparece la
línea punteada.

---

## Lo que no toqué, y por qué

**El Módulo 2 ya tiene el año** en cada fila (`ene 2026`), y además solo muestra
el año en curso, así que no hay ambigüedad posible. Lo dejé igual.

**Las demás gráficas no son de meses**: las de vejez (Módulo 1 y 3) reparten por
rangos de días y categorías, no por tiempo. Ahí no hay eje de meses que
etiquetar.
