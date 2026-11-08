// Borrower compliance certificates (S6): LlamaExtract reads what the borrower certified; this file checks it.
// Money is BigInt cents and ratios are compared as scaled integers; nothing here trusts a float.
// The certificate's figures are the borrower's claims. The covenant result always comes from the engine
// (lib/covenants.js evaluateRow) on the CSV row, under the policy definitions, never from the certificate.
import fs from 'node:fs/promises';
import {minor,amount} from './finance.js';
import {money} from './recommend.js';
import {evaluateRow} from './covenants.js';
import {EXTRACT_CONFIG} from './statements.js';

export const CERT_MONEY=['statement_ebitda','cost_savings_addbacks','reported_ebitda','total_debt','statement_available_cash_flow','reported_available_cash_flow','debt_service'];
export const CERT_RATIOS=['reported_leverage','reported_dscr'];
export const CERT_TEXT=['borrower_id','period','certified_compliant','addback_cap'];
export const CERT_FIELDS=[...CERT_TEXT,...CERT_MONEY,...CERT_RATIOS];
// Exactly these columns, in this order, in data/statements/certificates.extracted.csv.
export const CERT_COLUMNS=['record_id','reported_ebitda_usd','cost_savings_addbacks_usd','reported_leverage','reported_dscr','certified_compliant','synthetic'];
export const CERT_CONFIG=Object.freeze({...EXTRACT_CONFIG,system_prompt:'This is a borrower compliance certificate. Copy every amount, ratio and answer exactly as printed, as text; never calculate, total or estimate a value. Leave a field empty if it is not printed.'});
export const loadCertificateSchema=async()=>JSON.parse(await fs.readFile(new URL('../data/statements/certificate-schema.json',import.meta.url),'utf8'));

const PATH_PLACEHOLDER=/^[A-Za-z_]\w*(?:(?:\.\d+|\[\d+\])?\.[A-Za-z_]\w*)*$/;
const blankValue=v=>v===undefined||v===null||(typeof v==='string'&&/^\s*(|-|—|–|n\/?a|null)\s*$/i.test(v));
// "2.92x" -> 29200n (four decimals). Ratios are printed text; they are never converted to floats.
const RATIO=/^\s*(\d{1,4}(?:\.\d{1,4})?)\s*[x×]?\s*$/i;
export const parseRatio=raw=>{const m=String(raw).match(RATIO);if(!m)throw Error(`"${raw}" is not a ratio like 2.92x`);return {text:m[1],scaled:minor(m[1],{scale:4})};};
export function parseYesNo(raw){
 const t=String(raw).trim().toLowerCase();
 if(/^(yes|y|true|x|☒|☑|✓|in compliance|compliant)$/.test(t))return true;
 if(/^(no|n|false|not in compliance|non-compliant|noncompliant)$/.test(t))return false;
 throw Error(`"${raw}" is not a yes or no answer`);
}

// Raw LlamaExtract job (per_doc, flat schema) -> {fields:{key:{raw,value,page,matching_text,bounding_box,citation_kind,confidence}}, problems}
export function normalizeCertificate(job){
 const res=job?.extract_result;const data=Array.isArray(res)?res[0]:res;
 const meta=job?.extract_metadata?.field_metadata?.document_metadata??job?.extract_metadata?.field_metadata??{};
 const fields={},problems=[];
 if(!data||typeof data!=='object')problems.push('The extraction returned no certificate fields.');
 for(const key of CERT_FIELDS){
  const raw=data?.[key];if(blankValue(raw))continue;
  const m=meta?.[key]||{};
  // Same rule as the statements: a field path (here often just the key) in place of text quotes nothing.
  const cits=(Array.isArray(m.citation)?m.citation:Array.isArray(m.citations)?m.citations:m.citation?[m.citation]:[])
   .filter(c=>Number.isInteger(c?.page)&&c.page>=1).map(c=>{const t=typeof c.matching_text==='string'?c.matching_text.trim():'';
    return {page:c.page,matching_text:t&&t!==key&&!(PATH_PLACEHOLDER.test(t)&&/[._\[]/.test(t))?t:null,bounding_box:Array.isArray(c.bounding_boxes)&&c.bounding_boxes[0]?c.bounding_boxes[0]:null};});
  const quoted=cits.filter(c=>c.matching_text),best=quoted[0]??cits[0];
  const f={key,raw:String(raw),value:null,page:best?.page??null,matching_text:best?.matching_text??null,bounding_box:best?.bounding_box??null,
   citation_kind:quoted.length?'text':cits.length?'location_only':'none',confidence:typeof m.confidence==='number'&&m.confidence>=0&&m.confidence<=1?m.confidence:null,notes:[]};
  try{
   if(CERT_MONEY.includes(key))f.value=amount(money(String(raw)));
   else if(CERT_RATIOS.includes(key))f.value=parseRatio(raw).text;
   else if(key==='certified_compliant')f.value=parseYesNo(raw);
   else f.value=String(raw).trim();
  }catch(e){f.notes.push(e.message);problems.push(`${key}: ${e.message}`);}
  if(f.citation_kind==='none')problems.push(`${key}: no citation (page), so it is left out of the CSV.`);
  fields[key]=f;
 }
 return {fields,problems};
}

const cents=f=>f&&f.value!==null&&CERT_MONEY.includes(f.key)?minor(f.value,{signed:true}):null;
// n/d rounded half up to two decimals, scaled by 10000 (2.92 -> 29200n), for comparing with a printed ratio.
const round2=(n,d)=>{if(d<=0n||n<0n)return null;return ((n*200n+d)/(2n*d))*100n;};
const fmtRatio=s=>s===null?'n/a':`${amount(s/100n)}x`;
const pct=(n,d)=>d>0n?`${amount((n*10000n+d/2n)/d)}%`:'n/a';

// One row with exactly CERT_COLUMNS. A value with no citation at all is left blank.
export function certificateRow(norm,{csvRows=[],synthetic='unknown',borrower_id,period}={}){
 const F=norm.fields,cited=k=>F[k]&&F[k].value!==null&&F[k].citation_kind!=='none'?F[k].value:null;
 const b=borrower_id||F.borrower_id?.value,p=period||F.period?.value;
 const csv=csvRows.find(r=>r.borrower_id===b&&r.period===p);
 const cc=cited('certified_compliant');
 return {record_id:csv?.record_id??'',reported_ebitda_usd:cited('reported_ebitda')??'',cost_savings_addbacks_usd:cited('cost_savings_addbacks')??'',
  reported_leverage:cited('reported_leverage')??'',reported_dscr:cited('reported_dscr')??'',certified_compliant:cc===null?'':String(cc),synthetic:String(synthetic)};
}
const q=v=>`"${String(v).replace(/"/g,'""')}"`;
export const certificatesCSV=rows=>[CERT_COLUMNS.map(q).join(','),...rows.map(r=>CERT_COLUMNS.map(c=>q(r[c]??'')).join(','))].join('\n')+'\n';

// Check the certificate against its own arithmetic, the CSV row (which ties to the statements) and the engine.
// status: 'pass' | 'fail' | 'missing'. Findings are statements of fact; the analyst decides what to do.
export function checkCertificate(norm,{csvRow,settings}={}){
 const F=norm.fields,checks=[];
 const add=(id,label,status,detail,uses)=>checks.push({id,label,status,detail,uses});
 const v=k=>cents(F[k]);
 const se=v('statement_ebitda'),ad=v('cost_savings_addbacks'),re=v('reported_ebitda'),debt=v('total_debt');
 const sa=v('statement_available_cash_flow'),ra=v('reported_available_cash_flow'),ds=v('debt_service');
 const lev=F.reported_leverage?.value!=null?parseRatio(F.reported_leverage.value).scaled:null;
 const dscr=F.reported_dscr?.value!=null?parseRatio(F.reported_dscr.value).scaled:null;
 const usd=n=>{const [w,f]=amount(n).split('.');return `${w.startsWith('-')?'-':''}$${w.replace('-','').replace(/\B(?=(\d{3})+$)/g,',')}.${f}`;};
 const list=a=>a.length<2?a.join(''):`${a.slice(0,-1).join(', ')} and ${a.at(-1)}`;
 const eq=(id,label,a,b,detail,uses)=>add(id,label,a===null||b===null?'missing':a===b?'pass':'fail',a===null||b===null?'A value is missing.':detail(a,b),uses);
 // Internal arithmetic, all on printed figures.
 eq('ebitda_sum','EBITDA per statements + add-backs = adjusted EBITDA',se!==null&&ad!==null?se+ad:null,re,(a,b)=>`${usd(se)} + ${usd(ad)} = ${usd(a)}; certificate prints ${usd(b)}.`,['statement_ebitda','cost_savings_addbacks','reported_ebitda']);
 eq('acf_sum','Cash flow per statements + add-backs = adjusted cash flow',sa!==null&&ad!==null?sa+ad:null,ra,(a,b)=>`${usd(sa)} + ${usd(ad)} = ${usd(a)}; certificate prints ${usd(b)}.`,['statement_available_cash_flow','cost_savings_addbacks','reported_available_cash_flow']);
 eq('leverage_math','Printed leverage = total debt / adjusted EBITDA',debt!==null&&re?round2(debt,re):null,lev,(a,b)=>`${usd(debt)} / ${usd(re)} = ${fmtRatio(a)}; certificate prints ${fmtRatio(b)}.`,['total_debt','reported_ebitda','reported_leverage']);
 eq('dscr_math','Printed DSCR = adjusted cash flow / debt service',ra!==null&&ds?round2(ra,ds):null,dscr,(a,b)=>`${usd(ra)} / ${usd(ds)} = ${fmtRatio(a)}; certificate prints ${fmtRatio(b)}.`,['reported_available_cash_flow','debt_service','reported_dscr']);
 // Against the CSV row (which the statements tie to).
 if(!csvRow)add('csv','Matches loan_covenants_extended.csv','missing','No CSV row for this borrower and quarter.',[]);
 else{
  const c=k=>minor(csvRow[k],{signed:true});
  eq('csv_ebitda','EBITDA per statements = CSV TTM EBITDA',se,c('ttm_ebitda_usd'),(a,b)=>`Certificate ${usd(a)}; CSV ${usd(b)}.`,['statement_ebitda']);
  eq('csv_debt','Total funded debt = CSV gross debt',debt,c('debt_usd'),(a,b)=>`Certificate ${usd(a)}; CSV ${usd(b)}.`,['total_debt']);
  eq('csv_acf','Cash flow per statements = CSV TTM available cash flow',sa,c('ttm_available_cashflow_usd'),(a,b)=>`Certificate ${usd(a)}; CSV ${usd(b)}.`,['statement_available_cash_flow']);
  eq('csv_service','Debt service = CSV TTM debt service',ds,c('ttm_debt_service_usd'),(a,b)=>`Certificate ${usd(a)}; CSV ${usd(b)}.`,['debt_service']);
 }
 // Add-backs: the fictional policy defines EBITDA with no add-back for projected cost savings, and sets no cap.
 if(ad!==null&&ad!==0n){
  const cap=F.addback_cap?.value;const uncapped=!cap||/^(none|no|n\/?a|uncapped|no cap)\b/i.test(cap);
  add('addbacks','Cost-savings add-backs','fail',`The certificate adds back ${usd(ad)} of projected cost savings (${se?pct(ad,se):'n/a'} of EBITDA per the statements)${uncapped?' with no cap':`, cap printed as "${cap}"`}. The loan policy defines leverage on trailing twelve-month EBITDA and DSCR on available cash flow, with no add-back for projected savings, so they are excluded from the covenant test.`,['cost_savings_addbacks','addback_cap']);
 }
 // The engine's result under the policy definitions, against what was certified.
 let engine=null;
 if(csvRow){
  engine=evaluateRow(csvRow,settings);
  const cov=engine.covenants||{};const fails=['leverage','dscr','fccr','current_ratio'].filter(k=>cov[k]?.status==='breach');
  const certified=F.certified_compliant?.value;
  const desc=k=>{const e=cov[k];return `${k==='leverage'?'leverage':k==='dscr'?'DSCR':k==='fccr'?'FCCR':'current ratio'} ${e.value===null?'n/a':e.value.toFixed(2)+'x'} (${e.max?'maximum '+e.max:'minimum '+e.min}x)`;};
  if(engine.error)add('engine','Certified compliance vs the covenant engine','missing',`Engine could not evaluate the row: ${engine.error}`,['certified_compliant']);
  else if(certified===undefined||certified===null)add('engine','Certified compliance vs the covenant engine','missing','The certificate’s compliance answer was not extracted.',['certified_compliant']);
  else add('engine','Certified compliance vs the covenant engine',certified===true&&fails.length?'fail':certified===false&&!fails.length?'fail':'pass',
   certified===true&&fails.length?`The certificate says "in compliance", but under the policy definitions ${list(fails.map(desc))} ${fails.length>1?'fail':'fails'}. With add-backs the certificate reports ${fmtRatio(lev)} leverage and ${fmtRatio(dscr)} DSCR.`
   :certified===false&&!fails.length?'The certificate reports non-compliance, but every applicable covenant passes under the policy definitions.'
   :`The certificate's answer (${certified?'in compliance':'not in compliance'}) agrees with the engine.`,['certified_compliant']);
 }
 return {checks,failed:checks.filter(c=>c.status==='fail').length,engine,
  citation_summary:(()=>{const fs=Object.values(F);const n=k=>fs.filter(f=>f.citation_kind===k).length;return {values:fs.length,quoted:n('text'),location_only:n('location_only'),none:n('none'),message:`${n('location_only')} of ${fs.length} values have a page location but no quoted text`};})()};
}
