// Challenge 5 / MVP 1: leverage + DSCR covenant monitoring with exact headroom and
// source-linked definitions. Deterministic code only; no LLM. All money is BigInt cents.
import {minor,amount,ratio} from './finance.js';
import {sha256,verifyCitation} from './citations.js';

const PERIOD=/^\d{4}-Q[1-4]$/;
const FIELDS=['record_id','borrower_id','period','currency','debt_usd','ttm_ebitda_usd','ttm_debt_service_usd','ttm_available_cashflow_usd','max_leverage','min_dscr'];
const ceilDiv=(n,d)=>(n+d-1n)/d; // n>=0, d>0

// Find the sentence defining each covenant and cite it by exact UTF-16 offsets. Works on the sample
// policy and on parsed agreement text. If no definition is found, say so; never invent a citation.
const SENT_END=/[.!?](?=\s+[A-Z(]|\s*$)|\n/g;
function sentenceAround(text,i){
 let start=0;for(const m of text.matchAll(/[.!?]\s+(?=[A-Z(])|\n/g)){const e=m.index+m[0].length;if(e<=i)start=e;else break;} // scan the full text so the capital after the period is visible
 SENT_END.lastIndex=i;const m=SENT_END.exec(text);
 let end=m?(m[0]==='\n'?m.index:m.index+1):text.length;
 while(start<end&&/\s/.test(text[start]))start++;
 return {start,end};
}
const DEFS={leverage:/\bleverage\b[^.\n]*?(divided by|ratio of|means|is defined|shall mean|equal to)/i,
 dscr:/(\bDSCR\b|debt[- ]service coverage)[^.\n]*?(divided by|ratio of|means|is defined|shall mean|equal to)/i};
export function policyEvidence(policyText,sourceDocument='documents/loan-policy.txt'){
 const out={},warnings=[];
 for(const [k,re] of Object.entries(DEFS)){
  const m=re.exec(policyText);
  if(!m){out[k]=null;warnings.push(`No ${k} definition found in the supplied policy text; breaches cannot be linked to an agreement definition.`);continue;}
  const {start,end}=sentenceAround(policyText,m.index);const quote=policyText.slice(start,end);
  const c={source_document:sourceDocument,start,end,quote,sha256:sha256(quote)};
  if(!verifyCitation(policyText,c))throw Error('Citation failed verification');
  out[k]=c;
 }
 return {definitions:out,warnings};
}
const numbersIn=t=>(t.match(/\d+(?:\.\d+)?/g)||[]).map(n=>Number(n));

// File-level check: a CSV missing required columns is rejected as a whole with a clear message,
// rather than being turned into a single unreadable row.
export function covenantColumnsError(csvText){
 if(typeof csvText!=='string'||!csvText.trim())return 'The CSV file is empty.';
 const first=csvText.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0];
 const headers=first.split(',').map(h=>h.trim().replace(/^"(.*)"$/,'$1'));
 const missing=FIELDS.filter(f=>!headers.includes(f));
 return missing.length?`This does not look like a covenant CSV. Missing required column${missing.length>1?'s':''}: ${missing.join(', ')}.`:null;
}

// Evaluate one borrower-quarter. Never throws: bad input becomes an explicit 'invalid' result.
export function evaluateRow(r){
 const base={record_id:r.record_id??null,borrower_id:r.borrower_id??null,period:r.period??null};
 try{
  for(const f of FIELDS)if(r[f]===undefined||r[f]===null||String(r[f]).trim()==='')throw Error(`Missing field: ${f}`);
  if(r.currency!=='USD')throw Error('Only USD is supported; no conversion rule is defined');
  if(!PERIOD.test(r.period))throw Error('Period must look like 2026-Q3');
  const debt=minor(r.debt_usd),ebitda=minor(r.ttm_ebitda_usd,{signed:true}),service=minor(r.ttm_debt_service_usd),cash=minor(r.ttm_available_cashflow_usd,{signed:true});
  const maxLev=minor(r.max_leverage),minDscr=minor(r.min_dscr); // x100 integers (3.00 -> 300n)
  if(maxLev<=0n||minDscr<=0n)throw Error('Thresholds must be positive');
  // Leverage = debt/EBITDA <= max  <=>  debt*100 <= max*EBITDA (EBITDA>0)
  const levOk=ebitda>0n;
  const maxDebt=levOk?maxLev*ebitda/100n:null;                 // floor: conservative debt capacity
  const minEbitda=levOk||debt>0n?ceilDiv(debt*100n,maxLev):0n;   // EBITDA needed to comply, rounded up
  const leverage={
   value:levOk?ratio(debt,ebitda):null,max:r.max_leverage,
   status:!levOk?'unevaluable':debt*100n>maxLev*ebitda?'breach':'pass',
   debt_headroom_usd:levOk?amount(maxDebt-debt):null,          // negative = over the limit
   ebitda_headroom_usd:amount(ebitda-minEbitda),               // negative = EBITDA shortfall
   max_debt_usd:levOk?amount(maxDebt):null,                     // largest debt the limit allows at this EBITDA (rounded down)
   ebitda_required_usd:amount(minEbitda),                      // smallest EBITDA that passes at this debt (rounded up)
   reason:levOk?null:'TTM EBITDA is zero or negative; leverage is not meaningful, escalate to reviewer'};
  // DSCR = cash/service >= min  <=>  cash*100 >= min*service (service>0)
  const dscrOk=service>0n;
  const needCash=ceilDiv(minDscr*service,100n);
  const dscr={
   value:dscrOk?ratio(cash,service):null,min:r.min_dscr,
   status:!dscrOk?'unevaluable':cash*100n<minDscr*service?'breach':'pass',
   cashflow_headroom_usd:dscrOk?amount(cash-needCash):null,    // negative = cash-flow shortfall
   cashflow_required_usd:amount(needCash),                     // cash flow needed to meet the minimum at this debt service (rounded up)
   debt_service_max_usd:cash>0n?amount(cash*100n/minDscr):null, // highest debt service that passes at this cash flow (rounded down)
   reason:dscrOk?null:'TTM debt service is zero; DSCR is undefined, escalate to reviewer'};
  const exception=[leverage.status,dscr.status].some(s=>s!=='pass');
  return {...base,status:exception?'exception':'pass',leverage,dscr,inputs:{debt_usd:r.debt_usd,ttm_ebitda_usd:r.ttm_ebitda_usd,ttm_debt_service_usd:r.ttm_debt_service_usd,ttm_available_cashflow_usd:r.ttm_available_cashflow_usd},source_document:r.source_document||null};
 }catch(e){return {...base,status:'invalid',error:e.message};}
}

export function monitorCovenants(rows,policyText,{sourceDocument}={}){
 const {definitions:evidence,warnings}=policyEvidence(policyText,sourceDocument);
 const thr={leverage:new Set(rows.map(r=>Number(r.max_leverage)).filter(Number.isFinite)),dscr:new Set(rows.map(r=>Number(r.min_dscr)).filter(Number.isFinite))};
 for(const k of ['leverage','dscr'])if(evidence[k]){const nums=numbersIn(evidence[k].quote);for(const v of thr[k])if(!nums.includes(v))warnings.push(`Row threshold ${v.toFixed(2)} for ${k} does not appear in the cited policy sentence; confirm which value governs.`);}
 const evaluated=rows.map(evaluateRow);
 const groups=new Map();
 evaluated.forEach((x,i)=>{if(x.borrower_id&&x.period){const k=x.borrower_id+'|'+x.period;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}});
 for(const idx of groups.values())if(idx.length>1){
  const ids=idx.map(i=>evaluated[i].record_id||`row ${i+2}`).join(', ');
  for(const i of idx){const x=evaluated[i];evaluated[i]={record_id:x.record_id,borrower_id:x.borrower_id,period:x.period,status:'invalid',error:`Duplicate report: ${idx.length} rows for ${x.borrower_id} ${x.period} (${ids}); the tool cannot tell which one governs`};}
 }
 const results=evaluated.map(x=>{
  if(x.status==='invalid')return x;
  const ev=[];
  if(x.leverage.status!=='pass')ev.push({covenant:'leverage',definition:evidence.leverage,...(evidence.leverage?{}:{note:'No definition found in policy text'})});
  if(x.dscr.status!=='pass')ev.push({covenant:'dscr',definition:evidence.dscr,...(evidence.dscr?{}:{note:'No definition found in policy text'})});
  return {...x,evidence:ev};
 });
 const byBorrower={};
 for(const x of results){const k=x.borrower_id??'(missing)';(byBorrower[k]??=[]).push(x);}
 const borrowers=Object.entries(byBorrower).map(([id,list])=>{
  list.sort((a,b)=>String(a.period).localeCompare(String(b.period)));
  const first=list.find(x=>x.status!=='pass');
  return {borrower_id:id,periods:list.length,first_exception_period:first?first.period:null,
   latest:list.at(-1).period,latest_status:list.at(-1).status,
   trend:list.filter(x=>x.status!=='invalid').map(x=>({period:x.period,status:x.status,leverage:x.leverage.value,dscr:x.dscr.value,debt_headroom_usd:x.leverage.debt_headroom_usd,cashflow_headroom_usd:x.dscr.cashflow_headroom_usd}))};
 });
 const count=f=>results.filter(f).length;
 return {
  summary:{rows:results.length,pass:count(x=>x.status==='pass'),exceptions:count(x=>x.status==='exception'),invalid:count(x=>x.status==='invalid'),
   leverage_breaches:count(x=>x.leverage?.status==='breach'),dscr_breaches:count(x=>x.dscr?.status==='breach'),unevaluable:count(x=>x.leverage?.status==='unevaluable'||x.dscr?.status==='unevaluable')},
  borrowers,results,policy:{definitions:evidence,warnings},
  assumptions:[sourceDocument?`Definitions come only from the uploaded policy text "${sourceDocument}", as reviewed by the user; it is not independently verified.`:'Definitions come only from the fictional documents/loan-policy.txt and apply to this synthetic exercise.',
   'Amounts are USD decimal strings converted to integer cents; ratios are rounded down to 4 decimals for display only, pass/fail uses exact integer comparison.',
   'A ratio exactly at its threshold passes. Headroom is in USD; negative means breach. Debt capacity is rounded down, required EBITDA/cash flow rounded up (conservative).',
   'Inputs are taken as supplied TTM figures; this tool does not verify them against borrower statements.',
   'Periods labelled 2026-Q4 end after the 2026-09-30 dataset as-of date; treat them as projected or mislabelled until confirmed.',
   'Exceptions are signals for a human credit reviewer, not legal determinations of default.']};
}
