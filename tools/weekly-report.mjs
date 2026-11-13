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

async function main(){
  const asOf = process.argv[2] ? new Date(process.argv[2]+'T12:00:00') : new Date();
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
  function resolveCom(cliente,region,year,month){ const e=REP[normCli(cliente)]; const useHO=region==='USA'&&((year>2026)||(year===2026&&month>=8));
    let com=e?((useHO&&e.ho)?e.ho:(e.rep||e.ho||'')):''; if(!com&&REGION_REP[region])com=REGION_REP[region]; return norm(com||'Sin asignar'); }

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

  // Formato Slack
  const MES=['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const fmtM = n => { n=Math.round(n); return n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+Math.round(n/1e3)+'K':'$'+n; };
  const pad = (s,n)=>String(s).length>=n?String(s).slice(0,n):String(s)+' '.repeat(n-String(s).length);
  const padL = (s,n)=>String(s).length>=n?String(s):' '.repeat(n-String(s).length)+String(s);
  const coms = Object.keys(agg).filter(c=>c!=='Sin asignar').sort((a,b)=>agg[b].ytd.v-agg[a].ytd.v);
  if(agg['Sin asignar']) coms.push('Sin asignar');
  function section(w,title){
    let out='**'+title+'**\n```\n'+pad('Comercial',16)+padL('Ventas',9)+padL('Margen$',10)+padL('Mg%',7)+'\n';
    let tv=0,tg=0,tvc=0;
    for(const c of coms){ const o=agg[c][w]; if(o.v<=0)continue; const mp=o.vc?o.g/o.vc*100:0;
      out+=pad(c,16)+padL(fmtM(o.v),9)+padL(fmtM(o.g),10)+padL(mp.toFixed(1)+'%',7)+'\n'; tv+=o.v;tg+=o.g;tvc+=o.vc; }
    out+=pad('TOTAL',16)+padL(fmtM(tv),9)+padL(fmtM(tg),10)+padL((tvc?tg/tvc*100:0).toFixed(1)+'%',7)+'\n```\n';
    return out;
  }
  const fecha = `${asOf.getDate()} ${MES[M]} ${Y}`;
  let msg = `📊 **Ventas & Margen por comercial** — QuickBooks\nCorte: viernes ${fecha}\n\n`;
  msg += section('mtd', `MTD · ${MES[M]} ${Y}`);
  msg += section('qtd', `QTD · Q${Qt+1} ${Y}`);
  msg += section('ytd', `YTD · ${Y}`);
  msg += `\n_Ventas facturadas y margen Final (contrato prima en Community). Servicios excluidos._`;
  process.stdout.write(msg);
}
main().catch(e=>{ console.error('ERROR', e); process.exit(1); });
