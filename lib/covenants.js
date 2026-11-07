// Challenge 5: covenant monitoring with exact headroom and source-linked definitions.
// Covenants: leverage (max), DSCR (min), fixed-charge coverage (min) and current ratio (min).
// Each covenant can be maintenance (tested every quarter), springing (tested only when revolver
// utilization reaches a trigger) or off (not applied by the lender). Deterministic code only; no LLM.
// All money is BigInt cents; ratio thresholds are x100 integers (3.00 -> 300n).
import {minor,amount,ratio} from './finance.js';
import {sha256,verifyCitation} from './citations.js';

const PERIOD=/^\d{4}-Q[1-4]$/;
const FIELDS=['record_id','borrower_id','period','currency','debt_usd','ttm_ebitda_usd','ttm_debt_service_usd','ttm_available_cashflow_usd','max_leverage','min_dscr'];
const ceilDiv=(n,d)=>(n+d-1n)/d; // n>=0, d>0
export const COVENANTS=['leverage','dscr','fccr','current_ratio'];
export const MODES=['maintenance','springing','off'];
// Optional covenants are present in a row only when their threshold column has a value.
const OPTIONAL={
 fccr:{threshold:'min_fccr',fields:['ttm_ebitda_usd','ttm_capex_usd','ttm_cash_taxes_usd','ttm_distributions_usd','ttm_debt_service_usd']},
 current_ratio:{threshold:'min_current_ratio',fields:['current_assets_usd','current_liabilities_usd']}};
const EXTRA_INPUTS=['ttm_capex_usd','ttm_cash_taxes_usd','ttm_distributions_usd','current_assets_usd','current_liabilities_usd','revolver_commitment_usd','revolver_drawn_usd','min_fccr','min_current_ratio'];
// Lender-chosen covenant terms. FCCR is springing by default because that is how it is most often
// written for revolving facilities; the lender can change any covenant in the UI.
export const DEFAULT_SETTINGS=Object.freeze({trigger_pct:'35.00',modes:Object.freeze({leverage:'maintenance',dscr:'maintenance',fccr:'springing',current_ratio:'maintenance'}),borrowers:Object.freeze({})});

// Validate lender settings from the API. Throws a readable error on anything unexpected.
export function normalizeSettings(s){
 if(s==null)s={};
 if(typeof s!=='object'||Array.isArray(s))throw Error('settings must be an object');
 const pct=s.trigger_pct??DEFAULT_SETTINGS.trigger_pct;
 if(!/^\d{1,3}(\.\d{1,2})?$/.test(String(pct)))throw Error('Springing trigger must be a percentage such as 35 or 35.5');
 const bps=minor(String(pct)); // percent x100 = basis points
 if(bps>10000n)throw Error('Springing trigger must be between 0% and 100%');
 const modes=(m,base)=>{const out={...base};if(m==null)return out;if(typeof m!=='object'||Array.isArray(m))throw Error('modes must be an object');
  for(const [k,v] of Object.entries(m)){if(!COVENANTS.includes(k))throw Error(`Unknown covenant: ${k}`);if(!MODES.includes(v))throw Error(`Mode for ${k} must be maintenance, springing or off`);out[k]=v;}return out;};
 const portfolio=modes(s.modes,DEFAULT_SETTINGS.modes);
 const borrowers={};
 if(s.borrowers!=null){if(typeof s.borrowers!=='object'||Array.isArray(s.borrowers))throw Error('borrowers must be an object');
  const ids=Object.keys(s.borrowers);if(ids.length>1000)throw Error('Too many borrower overrides');
  for(const id of ids){if(id.length>100)throw Error('Borrower id too long');const o=s.borrowers[id]?.modes;if(o&&Object.keys(o).length)borrowers[id]=modes(o,{});}}
 return {trigger_pct:amount(bps),trigger_bps:bps,modes:portfolio,borrowers};
}
const modeFor=(s,b,k)=>s.borrowers[b]?.[k]??s.modes[k];

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
 dscr:/(\bDSCR\b|debt[- ]service coverage)[^.\n]*?(divided by|ratio of|means|is defined|shall mean|equal to)/i,
 fccr:/(\bFCCR\b|fixed[- ]charge coverage)[^.\n]*?(divided by|ratio of|means|is defined|shall mean|equal to|less)/i,
 current_ratio:/\bcurrent ratio\b[^.\n]*?(divided by|ratio of|means|is defined|shall mean|equal to)/i,
 springing:/\bspring(?:ing|s)\b[^.\n]*?(tested|test|appl(?:y|ies)|only)/i};
const NAMES={leverage:'leverage',dscr:'dscr',fccr:'fixed-charge coverage (FCCR)',current_ratio:'current ratio',springing:'springing-covenant'};
function cite(text,re,sourceDocument){
 const m=re.exec(text);if(!m)return null;
 const {start,end}=sentenceAround(text,m.index);const quote=text.slice(start,end);
 const c={source_document:sourceDocument,start,end,quote,sha256:sha256(quote)};
 if(!verifyCitation(text,c))throw Error('Citation failed verification');
 return c;
}
// need: covenants whose missing definition should be reported. supplements: extra documents searched
// (in order) when the main policy text has no definition, each cited against its own text.
export function policyEvidence(policyText,sourceDocument='documents/loan-policy.txt',{need=['leverage','dscr'],supplements=[]}={}){
 const out={},warnings=[];
 for(const [k,re] of Object.entries(DEFS)){
  let c=cite(policyText,re,sourceDocument);
  for(const s of supplements){if(c)break;c=cite(s.text,re,s.name);}
  out[k]=c;
  if(!c&&need.includes(k))warnings.push(k==='springing'?'No springing-covenant provision found in the supplied policy text; the springing trigger cannot be linked to agreement language.':`No ${NAMES[k]} definition found in the supplied policy text; breaches cannot be linked to an agreement definition.`);
 }
 return {definitions:out,warnings};
}
const numbersIn=t=>(t.match(/\d+(?:\.\d+)?/g)||[]).map(n=>Number(n));

// File-level check: a CSV missing required columns is rejected as a whole with a clear message,
// rather than being turned into a single unreadable row.
export function covenantColumnsError(csvText){
 if(typeof csvText!=='string'||!csvText.trim())return 'The CSV file is empty.';
 const first=csvText.replace(/^﻿/,'').split(/\r?\n/,1)[0];
 const headers=first.split(',').map(h=>h.trim().replace(/^"(.*)"$/,'$1'));
 const missing=FIELDS.filter(f=>!headers.includes(f));
 return missing.length?`This does not look like a covenant CSV. Missing required column${missing.length>1?'s':''}: ${missing.join(', ')}.`:null;
}

const blank=v=>v===undefined||v===null||String(v).trim()==='';
// Shared fields every covenant result carries so the UI can render any covenant the same way.
// "headroom" is always oriented so positive = room before the limit, negative = past it.
function generic(key,dir,limit,num,den,numLimit,denLimit){
 const pos=v=>v==null?null:amount(v);
 return {key,direction:dir,limit,
  numerator_usd:amount(num),denominator_usd:amount(den),
  numerator_limit_usd:pos(numLimit),numerator_headroom_usd:numLimit==null?null:amount(dir==='max'?numLimit-num:num-numLimit),
  denominator_limit_usd:pos(denLimit),denominator_headroom_usd:denLimit==null?null:amount(dir==='max'?den-denLimit:denLimit-den)};
}
// Ratio test for a "minimum" covenant: pass when num/den >= lim (compared exactly as num*100 >= lim*den).
function minTest(key,num,den,lim,limStr,undefinedReason){
 if(den<=0n)return {...generic(key,'min',limStr,num,den,null,null),value:null,status:'unevaluable',reason:undefinedReason};
 const need=ceilDiv(lim*den,100n);                  // smallest numerator that passes, rounded up
 const denMax=num>0n?num*100n/lim:null;             // largest denominator that passes, rounded down
 return {...generic(key,'min',limStr,num,den,need,denMax),value:ratio(num,den),status:num*100n<lim*den?'breach':'pass',reason:null};
}

// Revolver utilization decides whether a springing covenant is tested this quarter.
function utilization(r,s){
 if(blank(r.revolver_commitment_usd)||blank(r.revolver_drawn_usd))return {utilization:null,triggered:null,note:'Revolver commitment or drawn amount not supplied, so the springing trigger cannot be checked. The covenant is tested anyway (conservative).'};
 try{const c=minor(r.revolver_commitment_usd),d=minor(r.revolver_drawn_usd);
  if(c===0n)return {utilization:null,triggered:null,note:'Revolver commitment is zero, so utilization is undefined. The covenant is tested anyway (conservative).'};
  return {utilization:ratio(d,c),triggered:d*10000n>=s.trigger_bps*c,note:null,revolver_drawn_usd:amount(d),revolver_commitment_usd:amount(c)};
 }catch(e){return {utilization:null,triggered:null,note:`Revolver figures could not be read (${e.message}). The covenant is tested anyway (conservative).`};}
}
function applyMode(c,mode,trig,s){
 c.mode=mode;c.springing=null;
 if(mode!=='springing')return c;
 c.springing={trigger_pct:s.trigger_pct,utilization:trig.utilization,triggered:trig.triggered,note:trig.note};
 if(trig.triggered===false){c.would_status=c.status;c.status='dormant';}
 return c;
}

// Evaluate one borrower-quarter. Never throws: bad input becomes an explicit 'invalid' result.
export function evaluateRow(r,settings){
 const s=settings?.trigger_bps!==undefined?settings:normalizeSettings(settings);
 const base={record_id:r.record_id??null,borrower_id:r.borrower_id??null,period:r.period??null};
 try{
  for(const f of FIELDS)if(blank(r[f]))throw Error(`Missing field: ${f}`);
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
   reason:levOk?null:'TTM EBITDA is zero or negative; leverage is not meaningful, escalate to reviewer',
   ...generic('leverage','max',r.max_leverage,debt,ebitda,maxDebt,minEbitda)};
  // DSCR = cash/service >= min  <=>  cash*100 >= min*service (service>0)
  const dscrOk=service>0n;
  const needCash=ceilDiv(minDscr*service,100n);
  const svcMax=cash>0n?cash*100n/minDscr:null;
  const dscr={
   value:dscrOk?ratio(cash,service):null,min:r.min_dscr,
   status:!dscrOk?'unevaluable':cash*100n<minDscr*service?'breach':'pass',
   cashflow_headroom_usd:dscrOk?amount(cash-needCash):null,    // negative = cash-flow shortfall
   cashflow_required_usd:amount(needCash),                     // cash flow needed to meet the minimum at this debt service (rounded up)
   debt_service_max_usd:svcMax==null?null:amount(svcMax),      // highest debt service that passes at this cash flow (rounded down)
   reason:dscrOk?null:'TTM debt service is zero; DSCR is undefined, escalate to reviewer',
   ...generic('dscr','min',r.min_dscr,cash,service,dscrOk?needCash:null,svcMax)};
  const out={leverage,dscr};
  // Optional covenants: present only when the row supplies a threshold.
  for(const [k,def] of Object.entries(OPTIONAL)){
   if(blank(r[def.threshold]))continue;
   const lim=r[def.threshold];
   try{
    const l=minor(lim);if(l<=0n)throw Error(`${def.threshold} must be positive`);
    for(const f of def.fields)if(blank(r[f]))throw Error(`Missing field: ${f}`);
    if(k==='fccr'){
     const capex=minor(r.ttm_capex_usd),tax=minor(r.ttm_cash_taxes_usd),dist=minor(r.ttm_distributions_usd);
     const num=ebitda-capex-tax-dist; // cash flow after unfinanced capex, cash taxes and distributions
     out.fccr={...minTest('fccr',num,service,l,lim,'TTM fixed charges are zero; FCCR is undefined, escalate to reviewer'),min:lim,
      components:{ttm_ebitda_usd:amount(ebitda),ttm_capex_usd:amount(capex),ttm_cash_taxes_usd:amount(tax),ttm_distributions_usd:amount(dist),fixed_charges_usd:amount(service)}};
    }else{
     const ca=minor(r.current_assets_usd),cl=minor(r.current_liabilities_usd);
     out.current_ratio={...minTest('current_ratio',ca,cl,l,lim,'Current liabilities are zero; the current ratio is undefined, escalate to reviewer'),min:lim};
    }
   }catch(e){out[k]={key:k,direction:'min',limit:lim,min:lim,value:null,status:'unevaluable',reason:`${e.message}; this covenant could not be tested`};}
  }
  // Lender terms: maintenance, springing or off.
  const modes=Object.fromEntries(Object.keys(out).map(k=>[k,modeFor(s,r.borrower_id,k)]));
  const trig=Object.values(modes).includes('springing')?utilization(r,s):null;
  const covenants={},notApplied=[];
  for(const [k,c] of Object.entries(out)){
   if(modes[k]==='off'){c.mode='off';c.status='off';notApplied.push(k);continue;}
   covenants[k]=applyMode(c,modes[k],trig,s);
  }
  const tested=Object.values(covenants).filter(c=>c.status!=='dormant');
  const status=!tested.length?'untested':tested.some(c=>c.status!=='pass')?'exception':'pass';
  const inputs={debt_usd:r.debt_usd,ttm_ebitda_usd:r.ttm_ebitda_usd,ttm_debt_service_usd:r.ttm_debt_service_usd,ttm_available_cashflow_usd:r.ttm_available_cashflow_usd};
  for(const f of EXTRA_INPUTS)if(!blank(r[f]))inputs[f]=r[f];
  return {...base,status,...out,covenants,not_applied:notApplied,revolver:trig,inputs,source_document:r.source_document||null};
 }catch(e){return {...base,status:'invalid',error:e.message};}
}

export function monitorCovenants(rows,policyText,{sourceDocument,supplements=[],settings}={}){
 const s=normalizeSettings(settings);
 const evaluated=rows.map(r=>evaluateRow(r,s));
 const inData=COVENANTS.filter(k=>k==='leverage'||k==='dscr'||evaluated.some(x=>x[k]));
 const applied=COVENANTS.filter(k=>evaluated.some(x=>x.covenants?.[k]));
 const springingUsed=evaluated.some(x=>x.covenants&&Object.values(x.covenants).some(c=>c.mode==='springing'));
 const need=['leverage','dscr',...applied.filter(k=>k==='fccr'||k==='current_ratio'),...(springingUsed?['springing']:[])];
 const {definitions:evidence,warnings}=policyEvidence(policyText,sourceDocument,{need,supplements});
 const thrCol={leverage:'max_leverage',dscr:'min_dscr',fccr:'min_fccr',current_ratio:'min_current_ratio'};
 for(const k of COVENANTS){
  if(!evidence[k]||!(k==='leverage'||k==='dscr'||applied.includes(k)))continue;
  const vals=new Set(rows.map(r=>r[thrCol[k]]).filter(v=>!blank(v)).map(Number).filter(Number.isFinite));
  const nums=numbersIn(evidence[k].quote);
  for(const v of vals)if(!nums.includes(v))warnings.push(`Row threshold ${v.toFixed(2)} for ${k} does not appear in the cited policy sentence; confirm which value governs.`);
 }
 if(springingUsed&&evidence.springing&&!numbersIn(evidence.springing.quote).includes(Number(s.trigger_pct)))
  warnings.push(`The springing trigger set in Covenant terms (${Number(s.trigger_pct)}% revolver utilization) does not appear in the cited springing provision; confirm which trigger governs.`);
 const groups=new Map();
 evaluated.forEach((x,i)=>{if(x.borrower_id&&x.period){const k=x.borrower_id+'|'+x.period;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);}});
 for(const idx of groups.values())if(idx.length>1){
  const ids=idx.map(i=>evaluated[i].record_id||`row ${i+2}`).join(', ');
  for(const i of idx){const x=evaluated[i];evaluated[i]={record_id:x.record_id,borrower_id:x.borrower_id,period:x.period,status:'invalid',error:`Duplicate report: ${idx.length} rows for ${x.borrower_id} ${x.period} (${ids}); the tool cannot tell which one governs`};}
 }
 const results=evaluated.map(x=>{
  if(x.status==='invalid')return x;
  const ev=[];
  for(const [k,c] of Object.entries(x.covenants))if(c.status!=='pass'&&c.status!=='dormant')ev.push({covenant:k,definition:evidence[k],...(evidence[k]?{}:{note:'No definition found in policy text'})});
  return {...x,evidence:ev};
 });
 const byBorrower={};
 for(const x of results){const k=x.borrower_id??'(missing)';(byBorrower[k]??=[]).push(x);}
 const borrowers=Object.entries(byBorrower).map(([id,list])=>{
  list.sort((a,b)=>String(a.period).localeCompare(String(b.period)));
  const first=list.find(x=>x.status==='exception'||x.status==='invalid');
  return {borrower_id:id,periods:list.length,first_exception_period:first?first.period:null,
   latest:list.at(-1).period,latest_status:list.at(-1).status,
   trend:list.filter(x=>x.status!=='invalid').map(x=>({period:x.period,status:x.status,leverage:x.leverage.value,dscr:x.dscr.value,fccr:x.fccr?.value??null,current_ratio:x.current_ratio?.value??null,debt_headroom_usd:x.leverage.debt_headroom_usd,cashflow_headroom_usd:x.dscr.cashflow_headroom_usd}))};
 });
 const count=f=>results.filter(f).length;
 const cov=(x,k)=>x.covenants?.[k];
 const assumptions=[sourceDocument?`Definitions come only from the uploaded policy text "${sourceDocument}", as reviewed by the user; it is not independently verified.`:'Definitions come only from the fictional documents/loan-policy.txt and apply to this synthetic exercise.',
   'Amounts are USD decimal strings converted to integer cents; ratios are rounded down to 4 decimals for display only, pass/fail uses exact integer comparison.',
   'A ratio exactly at its threshold passes. Headroom is in USD; negative means breach. Debt capacity is rounded down, required EBITDA/cash flow rounded up (conservative).',
   'Inputs are taken as supplied TTM figures; this tool does not verify them against borrower statements.',
   'Periods labelled 2026-Q4 end after the 2026-09-30 dataset as-of date; treat them as projected or mislabelled until confirmed.',
   'Exceptions are signals for a human credit reviewer, not legal determinations of default.'];
 if(supplements.length)assumptions.push(`Definitions not found in the main policy are taken from ${supplements.map(x=>x.name).join(', ')}, a team-written synthetic addendum, not organizer-supplied text.`);
 if(inData.includes('fccr'))assumptions.push('FCCR = (TTM EBITDA − unfinanced capex − cash taxes − distributions) ÷ TTM fixed charges, where fixed charges are the scheduled interest and principal in ttm_debt_service_usd.');
 if(inData.includes('current_ratio'))assumptions.push('Current ratio = quarter-end current assets ÷ current liabilities.');
 if(springingUsed)assumptions.push(`A springing covenant is tested only when revolver drawn ÷ commitment is at or above ${Number(s.trigger_pct)}% at quarter end. When revolver data is missing the covenant is tested anyway. Dormant covenants are not counted as passing or failing.`);
 return {
  summary:{rows:results.length,pass:count(x=>x.status==='pass'),exceptions:count(x=>x.status==='exception'),invalid:count(x=>x.status==='invalid'),
   leverage_breaches:count(x=>cov(x,'leverage')?.status==='breach'),dscr_breaches:count(x=>cov(x,'dscr')?.status==='breach'),
   fccr_breaches:count(x=>cov(x,'fccr')?.status==='breach'),current_ratio_breaches:count(x=>cov(x,'current_ratio')?.status==='breach'),
   unevaluable:count(x=>x.covenants&&Object.values(x.covenants).some(c=>c.status==='unevaluable')),
   dormant:count(x=>x.covenants&&Object.values(x.covenants).some(c=>c.status==='dormant')),untested:count(x=>x.status==='untested')},
  covenant_keys:inData,applied_covenants:applied,
  settings:{trigger_pct:s.trigger_pct,modes:s.modes,borrowers:s.borrowers},
  borrowers,results,policy:{definitions:evidence,warnings},assumptions};
}
