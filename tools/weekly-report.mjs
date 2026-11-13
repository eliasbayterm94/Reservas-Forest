#!/usr/bin/env node
// Reporte semanal Ventas & Margen por comercial (MTD / QTD / YTD) desde QuickBooks.
// Lee el Google Sheet "AR Consolidado" por gviz (export CSV) y aplica EXACTAMENTE
// las mismas reglas del dashboard (index.html): parser de ICO, costeo (BASE COST),
// override de contrato (CONTRACTS), exclusión de servicios, comercial (SALES REP +
// traspaso de Pablo), FX por mes. Imprime el mensaje listo para Slack en stdout.
//
// Uso:  node tools/weekly-report.mjs [YYYY-MM-DD]   (fecha de corte, por defecto hoy)

const SHEET = '19E-_Kj1DjS1q1pTG6MXkvzewRh6oyzIH5cEiyoNCPWg';
const gviz = (name) => `https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}&_=${Date.now()}`;
const REGIONS = [['USA','USA'],['EU','EU&UK'],['MENA','Dubai'],['AUSTRALIA','Australia']];
const AED = 0.2740, FX_DEFAULT = { EUR:1.13, GBP:1.30, AUD:0.69 };
const CATS = ['COMMUNITY','INNOVATION','MICROLOT','RESERVE','COMPETITION','RELATIONSHIP'];
const SERVICES = ['loadout','handling','certificate operation','documents and legal','legal service',
  'tariff overcost','overcost','freight','storage','re-bagging','rebagging','sampling fee','courier',
  'logistics','credit card','card fee','shipping','wire fee','bank fee','surcharge','exporting document',
  'phytosanitar','advance payment','export service','warehouse'];
const REGION_REP = { 'Dubai':'Ricardo', 'Australia':'Samuel' };
const ALIAS = {
  'sebastian':'Sebastian','sebastian c':'Sebastian','sebastian c.':'Sebastian','sebatian':'Sebastian','sebastian carrasquilla':'Sebastian',
  'juan david arango':'Juan David','juan david':'Juan David','santiago carvajal':'Santiago','santiago':'Santiago',
  'samuel janna':'Samuel','samuel':'Samuel','shady bayter':'Shady','shady':'Shady','ricardo matiz':'Ricardo','ricardo':'Ricardo',
  'isis couto':'Isis','isis':'Isis','andres gutierrez':'Andres','andres':'Andres','diego martinez':'Diego','diego':'Diego',
  'luis baquero':'Luis','luis':'Luis','luis alberto':'Luis','michal macovic':'Michal','michal':'Michal' };

const norm = c => { const s=String(c||'').trim(); return s ? (ALIAS[s.toLowerCase()]||s) : 'Sin asignar'; };
const titleCase = s => String(s||'').toLowerCase().replace(/\b\w/g,m=>m.toUpperCase());
const cleanNum = v => Number(String(v==null?'':v).replace(/[^0-9.\-]/g,'')) || 0;
function parseCSV(t){ const rows=[]; let f='',row=[],q=false;
  for(let i=0;i<t.length;i++){ const c=t[i];
    if(q){ if(c==='"'){ if(t[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else { if(c==='"')q=true; else if(c===','){row.push(f);f='';} else if(c==='\n'){row.push(f);rows.push(row);row=[];f='';} else if(c!=='\r')f+=c; } }
  if(f.length||row.length){row.push(f);rows.push(row);} return rows; }
function normalizeDate(v){ if(v==null||v==='')return ''; const s=String(v).trim(); let m;
  if(m=s.match(/^(\d{4})-(\d{2})-(\d{2})/)) return `${m[1]}-${m[2]}-${m[3]}`;
  if(m=s.match(/Date\((\d+),(\d+),(\d+)/)) return `${m[1]}-${String(+m[2]+1).padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  if(m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return s.slice(0,10); }
function pct(s){ if(s==null)return null; let t=String(s).trim(); if(t==='')return null; const hasP=t.includes('%');
  let n=Number(t.replace(/[^0-9.\-]/g,'')); if(!isFinite(n))return null; if(!hasP&&Math.abs(n)<=3)n*=100; return n; }
const icoNum = s => { const m=String(s||'').match(/\d{2}-\d{3,}/); return m?m[0]:''; };
function normCli(s){ let t=String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase();
  t=t.replace(/\([^)]*\)/g,''); t=t.replace(/[^A-Z0-9]+/g,'');
  return t.replace(/(LLC|LTD|LIMITED|INC|CORP|CORPORATION|SAS|SRL|GMBH|BV|PTY|PTE|SPZOO|CO)$/,''); }
function parseItem(item){ const s=String(item||''); const toks=s.split(':').map(t=>t.trim());
  let ico='', iconum=''; const ms=[...s.matchAll(/(RW[- ]?)?(\d{2}-\d{3,})/gi)];
  if(ms.length){ const m=ms[ms.length-1]; iconum=m[2]; ico=(m[1]?'RW-':'')+m[2]; }
  if(!ico){ const ms2=[...s.matchAll(/\b([A-Z]{1,3}\d{4,}[A-Z]?|\d{5,})\b/g)]; if(ms2.length) ico=ms2[ms2.length-1][1]; }
  if(!ico && /direct from colombia/i.test(s)){ ico='25-999'; iconum='25-999'; }
  let cat=''; for(const t of toks){ if(CATS.includes(t.toUpperCase())){ cat=t.toUpperCase(); break; } }
  if(!cat){ const up=s.toUpperCase(); for(const c of CATS){ if(new RegExp('\\b'+c+'\\b').test(up)){ cat=c; break; } } }
  let prod=toks.length?toks[toks.length-1]:''; if(ico) prod=prod.split(ico).join(' ');
  prod=prod.replace(/(RW[- ]?)?\d{2}-\d{3,}/g,' '); if(cat) prod=prod.replace(new RegExp('\\b'+cat+'\\b','i'),' ');
  return { ico, iconum, cat, prod: prod.replace(/\s{2,}/g,' ').trim() }; }
function parseDesc(desc){ const s=String(desc||''); let contract='';
  const fc=s.match(/\bFC-\d{2}-[A-Za-z]+-[A-Za-z0-9]+/i); if(fc) contract=fc[0].trim();
  else { const cm=s.match(/Contract:\s*([A-Za-z0-9\-]+)/i); if(cm) contract=cm[1].trim(); }
  const sm=s.match(/(\d+(?:\.\d+)?)\s*KG/i); return { contract, size: sm?+sm[1]:0 }; }
const isService = s => { const t=String(s||'').toLowerCase(); return SERVICES.some(k=>t.includes(k)); };
const normCoffee = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function hdrIdx(aoa, must){ for(let i=0;i<Math.min(aoa.length,8);i++){ const low=(aoa[i]||[]).map(c=>String(c||'').toLowerCase()); if(must.some(m=>low.some(c=>c.includes(m)))) return i; } return 0; }
function colAll(head,cands){ const out=[]; for(let i=0;i<head.length;i++){ if(cands.some(c=>head[i]===c)) out.push(i); } if(out.length)return out; for(let i=0;i<head.length;i++){ if(cands.some(c=>head[i].includes(c))) out.push(i); } return out; }
const col = (head,cands)=>{ const a=colAll(head,cands); return a.length?a[0]:-1; };
import { execFileSync } from 'node:child_process';
// Node fetch no usa el proxy del entorno; curl sí (y respeta el CA del proxy).
async function fetchCSV(name){
  const out = execFileSync('curl', ['-s','--fail','--max-time','60', gviz(name)], { maxBuffer:64*1024*1024, encoding:'utf8' });
  return parseCSV(out);
}

// Envío directo por la Web API de Slack (chat.postMessage) usando el bot token
// inyectado por el proxy del entorno en el header Authorization (host slack.com).
// No depende del conector MCP de Slack, así que funciona en sesiones programadas.
function slackPost(channel, text){
  const body = JSON.stringify({ channel, text, unfurl_links:false, unfurl_media:false });
  const out = execFileSync('curl', ['-s','--max-time','30','-X','POST',
    'https://slack.com/api/chat.postMessage',
    '-H','Content-Type: application/json; charset=utf-8',
    '-H','Authorization: Bearer proxy-injected',
    '--data', body], { maxBuffer:8*1024*1024, encoding:'utf8' });
  let r; try{ r=JSON.parse(out); }catch(e){ throw new Error('Slack respuesta no-JSON: '+String(out).slice(0,200)); }
  if(!r.ok) throw new Error('Slack error ('+channel+'): '+(r.error||JSON.stringify(r)));
  return r;
}

async function main(){
  const argv = process.argv.slice(2);
  const dateArg = argv.find(a=>!a.startsWith('--'));
  const SEND = argv.includes('--send');
  const TEST = argv.includes('--test'); // --test => solo DM a Elias
  const asOf = dateArg ? new Date(dateArg+'T12:00:00') : new Date();
  const Y = asOf.getFullYear(), M = asOf.getMonth()+1, Qt = Math.floor((M-1)/3);

  const FX={}, COST={}, CONTR={}, REP={};
  // FX
  try{ const fx=await fetchCSV('FX'); const hi=hdrIdx(fx,['month','mes']); const H=fx[hi].map(h=>String(h||'').trim().toLowerCase());
    const iM=col(H,['month','mes']),iY=col(H,['year','año','ano']),iE=col(H,['eur']),iG=col(H,['gbp']),iA=col(H,['aud']);
    for(let r=hi+1;r<fx.length;r++){ const row=fx[r]||[]; const m=Math.round(cleanNum(row[iM])),y=Math.round(cleanNum(row[iY])); if(!m||!y)continue;
      if(iE>=0&&cleanNum(row[iE]))FX[`${y}-${m}-EUR`]=cleanNum(row[iE]); if(iG>=0&&cleanNum(row[iG]))FX[`${y}-${m}-GBP`]=cleanNum(row[iG]); if(iA>=0&&cleanNum(row[iA]))FX[`${y}-${m}-AUD`]=cleanNum(row[iA]); } }catch(e){ console.error('FX',e.message); }
  // BASE COST
  try{ const bc=await fetchCSV('BASE COST'); const hi=hdrIdx(bc,['ico']); const H=bc[hi].map(h=>String(h||'').trim().toLowerCase());
    const iIco=col(H,['ico']),iCk=col(H,['costo kg (usd)','cost kg (usd)','costo kg usd']);
    for(let r=hi+1;r<bc.length;r++){ const row=bc[r]||[]; const ico=String(row[iIco]||'').trim().toUpperCase(); if(!ico)continue; const c=cleanNum(row[iCk]); if(!(c>0))continue;
      if(COST[ico]==null)COST[ico]=c; const n=icoNum(ico); if(n&&COST['#'+n]==null)COST['#'+n]=c; } }catch(e){ console.error('BASE COST',e.message); }
  // CONTRACTS
  try{ const ct=await fetchCSV('CONTRACTS'); const hi=hdrIdx(ct,['codigo contrato','contract padre','código contrato']); const H=ct[hi].map(h=>String(h||'').trim().toLowerCase());
    const iPad=col(H,['contract padre','contrato padre']),iCod=col(H,['codigo contrato','código contrato','contract code']),iMar=col(H,['margin closed']),iRef=col(H,['reference','referencia']),iCli=col(H,['client','cliente']),iRep=col(H,['sales rep','comercial','rep']);
    for(let r=hi+1;r<ct.length;r++){ const row=ct[r]||[]; const codigo=String(row[iCod]||'').trim().toUpperCase(),padre=String(iPad>=0?(row[iPad]||''):'').trim().toUpperCase(); if(!codigo&&!padre)continue;
      const cand={margin:pct(row[iMar]),coffee:String(iRef>=0?(row[iRef]||''):'').trim()};
      if(codigo)(CONTR[codigo]=CONTR[codigo]||[]).push(cand); if(padre&&padre!==codigo)(CONTR[padre]=CONTR[padre]||[]).push(cand);
      const cli=normCli(row[iCli]),rep=String(row[iRep]||'').trim(); if(cli&&rep&&!REP[cli])REP[cli]={rep,ho:''}; } }catch(e){ console.error('CONTRACTS',e.message); }
  // SALES REP
  try{ const sr=await fetchCSV('SALES REP'); const hi=hdrIdx(sr,['customer','cliente']); const H=sr[hi].map(h=>String(h||'').trim().toLowerCase());
    const iCli=col(H,['customer','cliente']),iRep=col(H,['comercial','sales rep','rep']),iHO=col(H,['hand over']);
    for(let r=hi+1;r<sr.length;r++){ const row=sr[r]||[]; const cli=normCli(row[iCli]),rep=String(row[iRep]||'').trim(),ho=String(iHO>=0?(row[iHO]||''):'').trim(); if(cli&&(rep||ho))REP[cli]={rep,ho}; } }catch(e){ console.error('SALES REP',e.message); }

  function contractMargin(code,product){ const arr=code?CONTR[String(code).toUpperCase()]:null; if(!arr||!arr.length)return null;
    const wm=arr.filter(c=>c.margin!=null); if(!wm.length)return null; if(wm.length===1)return wm[0].margin;
    const p=normCoffee(product); if(p){ const hit=wm.find(c=>{const cf=normCoffee(c.coffee); return cf&&(cf===p||cf.includes(p)||p.includes(cf));}); if(hit)return hit.margin; }
    const uniq=[...new Set(wm.map(c=>c.margin))]; return uniq.length===1?uniq[0]:wm[0].margin; }
  function lookupCost(ico,iconum){ const k=(ico||'').toUpperCase(); if(k&&COST[k]!=null)return COST[k]; if(iconum&&COST['#'+iconum]!=null)return COST['#'+iconum]; return null; }
  function resolveCom(cliente,region,year,month){
    // Regiones de un solo comercial: el rep de la región manda sobre SALES REP (Australia→Samuel, Dubai→Ricardo)
    if(REGION_REP[region]) return norm(REGION_REP[region]);
    const e=REP[normCli(cliente)]; const useHO=region==='USA'&&((year>2026)||(year===2026&&month>=8));
    let com=e?((useHO&&e.ho)?e.ho:(e.rep||e.ho||'')):''; return norm(com||'Sin asignar'); }

  // Parse region tabs → líneas 2026
  const lines=[];
  for(const [tab,region] of REGIONS){
    let aoa; try{ aoa=await fetchCSV(tab); }catch(e){ console.error(tab,e.message); continue; }
    const hi=hdrIdx(aoa,['item name','customer name']); const head=aoa[hi].map(h=>String(h||'').trim().toLowerCase());
    if(!head.some(h=>h.includes('item name'))) continue;
    const iCust=col(head,['customer']),iItem=col(head,['item name']),iDesc=col(head,['description']),iQty=col(head,['quantity','qty']),iAmt=col(head,['amount (line)','amount']),iCur=col(head,['currency']),iDate=col(head,['transaction date','date','fecha']);
    for(let r=hi+1;r<aoa.length;r++){ const row=aoa[r]||[]; const g=i=>(i>=0&&i<row.length)?String(row[i]||'').trim():'';
      const itemName=g(iItem),amt=cleanNum(g(iAmt)); if(!itemName||!(amt>0))continue; if(isService(itemName+' '+g(iDesc)))continue;
      const d=normalizeDate(g(iDate)); const year=+(d.slice(0,4))||0; if(year<2026)continue; const month=+(d.slice(5,7))||0;
      const P=parseItem(itemName),D=parseDesc(g(iDesc)); const cur=(g(iCur)||'USD').toUpperCase();
      const rate=cur==='USD'?1:cur==='AED'?AED:(FX[`${year}-${month}-${cur}`]||FX_DEFAULT[cur]||1);
      const usd=amt*rate, qty=cleanNum(g(iQty)), kg=D.size*qty, cat=P.cat, contract=D.contract;
      const costKg=lookupCost(P.ico,P.iconum), haveCost=costKg!=null&&costKg>0&&kg>0;
      const gmcReal=haveCost?usd-costKg*kg:null, marginReal=(haveCost&&usd>0)?gmcReal/usd*100:null;
      let marginFinal=marginReal, gmcFinal=gmcReal; const cM=(cat==='COMMUNITY'&&contract)?contractMargin(contract,P.prod):null;
      if(cM!=null){ marginFinal=cM; gmcFinal=usd*cM/100; }
      // On Float (café en tránsito): en community el margen viene SOLO del contrato. Si el contrato no
      // tiene margen cerrado, se marca "sin margen" (el margen real por costo es provisional/engañoso).
      else if(/on\s*float/i.test(itemName) && cat==='COMMUNITY'){ marginFinal=null; gmcFinal=0; }
      lines.push({ comercial:resolveCom(g(iCust),region,year,month), year, month, usd, marginFinal, gmcFinal:(gmcFinal==null?0:gmcFinal) });
    }
  }

  // Agregar por comercial × ventana
  const q = m => Math.floor((m-1)/3);
  const inWin = { ytd:l=>l.year===Y, qtd:l=>l.year===Y&&q(l.month)===Qt, mtd:l=>l.year===Y&&l.month===M };
  const wins=['mtd','qtd','ytd'];
  const agg={}; // com -> {mtd:{v,g,vc},...}
  for(const l of lines){ const a=agg[l.comercial]||(agg[l.comercial]={mtd:{v:0,g:0,vc:0},qtd:{v:0,g:0,vc:0},ytd:{v:0,g:0,vc:0}});
    for(const w of wins){ if(inWin[w](l)){ a[w].v+=l.usd; if(l.marginFinal!=null){a[w].g+=l.gmcFinal;a[w].vc+=l.usd;} } } }

  // Formato Slack (estilo del bot de Cartera: bullets por comercial)
  const MES=['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const fmtM = n => { const s=n<0?'-':''; n=Math.abs(Math.round(n)); return s+(n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+Math.round(n/1e3)+'k':'$'+n); };
  const mpOf = o => o.vc?o.g/o.vc*100:0;
  const dot = mp => mp<15?' 🔴':mp<22?' 🟡':'';
  // Comerciales "reales" vs facturación adicional (placeholders / sin asignar)
  const MAIN = new Set(['Santiago','Diego','Pablo','Michal','Juan David','Ricardo','Luis','Isis','Shady','Samuel','Sebastian','Andres']);
  const mains = Object.keys(agg).filter(c=>MAIN.has(c) && agg[c].ytd.v>0).sort((a,b)=>agg[b].ytd.v-agg[a].ytd.v);
  const otrosNames = Object.keys(agg).filter(c=>!MAIN.has(c) && agg[c].ytd.v>0);
  const otros={mtd:{v:0,g:0,vc:0},qtd:{v:0,g:0,vc:0},ytd:{v:0,g:0,vc:0}};
  otrosNames.forEach(c=>['mtd','qtd','ytd'].forEach(w=>{ otros[w].v+=agg[c][w].v; otros[w].g+=agg[c][w].g; otros[w].vc+=agg[c][w].vc; }));
  // totales
  const tot={mtd:{v:0,g:0,vc:0},qtd:{v:0,g:0,vc:0},ytd:{v:0,g:0,vc:0}};
  Object.keys(agg).forEach(c=>['mtd','qtd','ytd'].forEach(w=>{ tot[w].v+=agg[c][w].v; tot[w].g+=agg[c][w].g; tot[w].vc+=agg[c][w].vc; }));

  const line = (name,a) => `• **${name}** — YTD ${fmtM(a.ytd.v)} (${mpOf(a.ytd).toFixed(0)}%)${dot(mpOf(a.ytd))} · QTD ${fmtM(a.qtd.v)} · MTD ${fmtM(a.mtd.v)}`;
  const fecha = `${asOf.getDate()} ${MES[M]} ${Y}`;
  let msg = `📊 **Ventas & Márgenes por comercial** — ${fecha} (QuickBooks)\n`;
  msg += `YTD **${fmtM(tot.ytd.v)}** · margen **${fmtM(tot.ytd.g)} (${mpOf(tot.ytd).toFixed(0)}%)**  ·  QTD ${fmtM(tot.qtd.v)}  ·  MTD ${fmtM(tot.mtd.v)}\n`;
  msg += `_Por comercial, de mayor a menor venta YTD:_\n\n`;
  mains.forEach(c=>{ msg += line(c, agg[c]) + '\n'; });
  if(otros.ytd.v>0) msg += `• **Facturación adicional** — YTD ${fmtM(otros.ytd.v)} · QTD ${fmtM(otros.qtd.v)} · MTD ${fmtM(otros.mtd.v)}  _(${otrosNames.join(', ')})_\n`;
  msg += `— **TOTAL** — YTD ${fmtM(tot.ytd.v)} (${mpOf(tot.ytd).toFixed(0)}%) · QTD ${fmtM(tot.qtd.v)} · MTD ${fmtM(tot.mtd.v)}\n\n`;
  // destacados (sobre comerciales reales)
  if(mains.length){
    const topV = mains[0];
    const topM = mains.slice().filter(c=>agg[c].ytd.vc>0).sort((a,b)=>mpOf(agg[b].ytd)-mpOf(agg[a].ytd))[0];
    const lowM = mains.slice().filter(c=>agg[c].ytd.vc>0).sort((a,b)=>mpOf(agg[a].ytd)-mpOf(agg[b].ytd))[0];
    msg += `🥇 Mayor venta: **${topV}** ${fmtM(agg[topV].ytd.v)}\n`;
    if(topM) msg += `📈 Mejor margen: **${topM}** ${mpOf(agg[topM].ytd).toFixed(0)}%  ·  📉 Menor: **${lowM}** ${mpOf(agg[lowM].ytd).toFixed(0)}%\n`;
  }
  msg += `👉 https://reservasforest.netlify.app`;
  process.stdout.write(msg + '\n');

  if(SEND){
    // Slack usa mrkdwn: negrita es *texto* (no **texto**). La itálica _texto_ ya es válida.
    const slackText = msg.replace(/\*\*/g,'*');
    const ALL = [['Elias','U063KF99TV2'],['Andres Gutierrez','U063KFZM812'],['Shady','U063VMM4D89']];
    const recipients = TEST ? ALL.slice(0,1) : ALL;
    const results=[];
    for(const [name,uid] of recipients){
      try{ slackPost(uid, slackText); results.push('OK '+name); }
      catch(e){ results.push('FALLO '+name+': '+e.message); }
    }
    process.stderr.write('\n[SLACK] '+results.join(' | ')+'\n');
    if(results.some(r=>r.startsWith('FALLO'))) process.exit(2);
  }
}
main().catch(e=>{ console.error('ERROR', e); process.exit(1); });
