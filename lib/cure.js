// Cure planner bridge. Gurobi (opt/, reached via OPT_URL) proposes cures; this module re-checks every
// plan with the exact BigInt-cents engine (evaluateRow) before it can be shown. No LLM; no floats
// decide pass/fail. Amounts from the solver are rounded UP to the cent before the re-check.
import fs from 'node:fs/promises';
import {parseCSV} from './csv.js';
import {minor,amount} from './finance.js';
import {evaluateRow,policyEvidence,normalizeSettings} from './covenants.js';
import {parseCureTerms,cureClauseCitations} from './cure-terms.js';

const DATA=new URL('../data/',import.meta.url);
const rd=n=>fs.readFile(new URL(n,DATA),'utf8');
export const OPTION_KEYS=['cheapest','no_asset_sale','equity_cure_only'];
// Same default dataset and policy documents as GET /api/covenants (server.js DEFAULT_CSV and ADDENDUM).
export const MONITOR_CSV='team/loan_covenants_extended.csv',ADDENDUM='team/covenant-policy-addendum.txt';
const COV_NAMES={leverage:'leverage',dscr:'DSCR',fccr:'FCCR',current_ratio:'current ratio'};
const OPTION_LABELS={cheapest:'Cheapest cure',no_asset_sale:'Without an asset sale',equity_cure_only:'Equity cure only'};
const CLAUSE_TITLES={C1:'Maximum leverage after cure',C2:'Minimum DSCR after cure',C3:'Equity cure cap',C4:'Cure frequency',C5:'Minimum liquidity after prepayment',C6:'Minimum current ratio after cure',C7:'Minimum fixed-charge coverage after cure'};
const CNAME=/^C[1-7]$/;
export const SOLVER_TIMEOUT_MS=5000;

// ---- exact helpers -----------------------------------------------------------------------------
const ceilDiv=(n,d)=>n<=0n?-((-n)/d):(n+d-1n)/d;
const floorDiv=(n,d)=>n>=0n?n/d:-((-n+d-1n)/d);
// Solver amount (float USD) -> BigInt cents rounded UP. Values within 1e-6 cent of a whole cent are
// treated as that cent so solver noise (12000.0000000001) does not add a spurious cent.
export function ceilCents(x){
 if(typeof x!=='number'||!Number.isFinite(x))throw Error('Solver returned a non-numeric amount');
 const c=x*100,r=Math.round(c);return BigInt(Math.max(0,Math.abs(c-r)<1e-6?r:Math.ceil(c)));
}
const x100=n=>{const s=n<0n?'-':'';n=n<0n?-n:n;return s+(n/100n)+'.'+String(n%100n).padStart(2,'0');};
export const usd=c=>{const s=amount(c);const neg=s.startsWith('-');const [w,f]=s.replace('-','').split('.');return (neg?'-':'')+'$'+w.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+f;};

// ---- data --------------------------------------------------------------------------------------
export async function loadCureContext(){
 const [cov,terms,loan,cure,add]=await Promise.all([rd(MONITOR_CSV),rd('cure_terms.csv'),rd('documents/loan-policy.txt'),rd('documents/cure-policy.txt'),rd(ADDENDUM)]);
 const {definitions:extra}=policyEvidence(loan,'documents/loan-policy.txt',{need:[],supplements:[{name:ADDENDUM,text:add}]});
 const citations=clauseCitations(loan,cure);const cc=cureClauseCitations(cure,'documents/cure-policy.txt').clauses;citations.C6=[extra.current_ratio,cc.cure_cash].filter(Boolean);citations.C7=[extra.fccr,cc.equity_cure].filter(Boolean);
 return {rows:parseCSV(cov),terms:parseCureTerms(parseCSV(terms)),citations,checks:{fccr:extra.fccr,current_ratio:extra.current_ratio,springing:extra.springing}};
}
export function clauseCitations(loanText,cureText){
 const {definitions:l}=policyEvidence(loanText,'documents/loan-policy.txt');const {clauses:c}=cureClauseCitations(cureText,'documents/cure-policy.txt');
 const pick=(...xs)=>xs.filter(Boolean);
 return {C1:pick(l.leverage,c.asset_sale),C2:pick(l.dscr,c.prepayment),C3:pick(c.equity_cure),C4:pick(c.cure_frequency),C5:pick(c.minimum_liquidity)};
}
async function loadSnapshot(path){try{return JSON.parse(await fs.readFile(path,'utf8'));}catch{return null;}}

// ---- overrides ---------------------------------------------------------------------------------
export function applyOverrides(t,o={}){
 if(o===null||typeof o!=='object'||Array.isArray(o))throw Error('overrides must be an object');
 const allowed=['equity_cure_cap_usd','cures_remaining_4q','asset_sale_allowed'];
 for(const k of Object.keys(o))if(!allowed.includes(k))throw Error(`Unknown override: ${k}`);
 const n={...t,overridden:[]};
 if(o.equity_cure_cap_usd!==undefined){if(typeof o.equity_cure_cap_usd!=='string'&&typeof o.equity_cure_cap_usd!=='number')throw Error('equity_cure_cap_usd must be a decimal amount');const v=minor(String(o.equity_cure_cap_usd));if(v>100000000000n)throw Error('equity_cure_cap_usd is implausibly large');n.equity_cure_cap=v;n.overridden.push('equity_cure_cap_usd');}
 if(o.cures_remaining_4q!==undefined){if(!Number.isInteger(o.cures_remaining_4q)||o.cures_remaining_4q<0||o.cures_remaining_4q>4)throw Error('cures_remaining_4q must be a whole number 0-4');n.cures_remaining=o.cures_remaining_4q;n.overridden.push('cures_remaining_4q');}
 if(o.asset_sale_allowed!==undefined){if(typeof o.asset_sale_allowed!=='boolean')throw Error('asset_sale_allowed must be true or false');if(!o.asset_sale_allowed)n.asset_name=null;n.overridden.push('asset_sale_allowed');}
 return n;
}
// Exact decimal strings (the solver converts them to integer cents). C6 (current ratio) and C7 (FCCR) inputs
// are sent only when the monitor's engine applies that test to this borrower and quarter (not off, not dormant).
function solverRequest(row,t,c,crApplied,fccrApplied){
 const has=Boolean(t.asset_name),k4=t.ds_reduction_per_usd_e4;
 const req={borrower_id:row.borrower_id,period:row.period,case:c,D:row.debt_usd,EBITDA:row.ttm_ebitda_usd,DS:row.ttm_debt_service_usd,CF:row.ttm_available_cashflow_usd,
  Lmax:row.max_leverage,Dmin:row.min_dscr,cap:amount(t.equity_cure_cap),cures_remaining:t.cures_remaining,cash:amount(t.cash),min_liquidity:amount(t.min_liquidity),
  k:amount(k4,4),premium_bps:t.prepay_premium_bps,has_asset:has,proceeds:has?amount(t.asset_proceeds):'0.00',asset_ebitda:has?amount(t.asset_ebitda):'0.00',asset_cf:has?amount(t.asset_cashflow):'0.00',sale_cost:has?amount(t.sale_cost):'0.00'};
 if(crApplied){req.current_assets=row.current_assets_usd;req.current_liabilities=row.current_liabilities_usd;req.min_current_ratio=row.min_current_ratio;}
 if(fccrApplied){req.capex=row.ttm_capex_usd;req.cash_taxes=row.ttm_cash_taxes_usd;req.distributions=row.ttm_distributions_usd;req.min_fccr=row.min_fccr;}
 return req;
}
const solverCents=(cents,usdv)=>{if(cents!==undefined&&cents!==null){if(!Number.isSafeInteger(cents)||cents<0)throw Error('Solver returned an invalid cent amount');return BigInt(cents);}return ceilCents(usdv);};
async function callSolver(url,body,timeoutMs=SOLVER_TIMEOUT_MS){
 const r=await fetch(url.replace(/\/+$/,'')+'/solve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw Error(`Solver returned HTTP ${r.status}`);
 const j=await r.json();if(!j||typeof j!=='object'||!j.options)throw Error('Solver response has no options');return j;
}

// ---- exact re-check ----------------------------------------------------------------------------
// Pro-forma row in exact cents. Debt-service relief k*repaid is rounded DOWN (less relief = more
// conservative DSCR). Returns the row as decimal strings so evaluateRow parses it like any CSV row.
// FCCR uses the same pro-forma EBITDA and debt service; capex, cash taxes and distributions are unchanged.
// Current ratio (cure-policy.txt, "Cure cash"): repayment and its premium leave current assets; equity cure
// cash is not added; the sale cost is paid from gross proceeds; current liabilities and revolver are unchanged.
export function proFormaRow(row,t,{E,P,s}){
 const sold=s===1&&Boolean(t.asset_name);
 const repaid=P+(sold?t.asset_proceeds:0n);
 const relief=t.ds_reduction_per_usd_e4*repaid/10000n;
 const cashOut=P+ceilDiv(P*BigInt(t.prepay_premium_bps),10000n);
 const ca=row.current_assets_usd!=null&&String(row.current_assets_usd).trim()!==''?{current_assets_usd:amount(minor(row.current_assets_usd)-cashOut)}:{};
 return {...row,...ca,record_id:row.record_id+'-PF',
  debt_usd:amount(minor(row.debt_usd)-repaid),
  ttm_ebitda_usd:amount(minor(row.ttm_ebitda_usd,{signed:true})+E-(sold?t.asset_ebitda:0n)),
  ttm_available_cashflow_usd:amount(minor(row.ttm_available_cashflow_usd,{signed:true})+E-(sold?t.asset_cashflow:0n)),
  ttm_debt_service_usd:amount(minor(row.ttm_debt_service_usd)-relief)};
}
// Per-covenant pro-forma summary from the engine; failing = tested and not passing.
function covSummary(ev){
 const out={},failing=[];
 for(const [k,c] of Object.entries(ev.covenants||{})){
  out[k]={status:c.status,value:c.value??null,limit:c.limit??c.max??c.min??null,direction:c.direction??(k==='leverage'?'max':'min'),mode:c.mode??null,numerator_headroom_usd:c.numerator_headroom_usd??null};
  if(c.status!=='pass'&&c.status!=='dormant')failing.push(k);
 }
 return {covenants:out,failing};
}
const failText=(sum)=>sum.failing.map(k=>{const c=sum.covenants[k];if(c.value==null)return `${COV_NAMES[k]} cannot be calculated`;const past=c.numerator_headroom_usd!=null&&c.numerator_headroom_usd.startsWith('-')?` (${usd(minor(c.numerator_headroom_usd.slice(1)))} past the limit)`:'';return `${COV_NAMES[k]} ${c.value.toFixed(4)}x ${c.direction==='max'?'above the':'below the'} ${Number(c.limit).toFixed(2)}x ${c.direction==='max'?'maximum':'minimum'}${past}`;}).join('; ');
const cite=(cits,names)=>names.filter(n=>cits[n]).map(n=>({constraint:n,title:CLAUSE_TITLES[n],citations:cits[n]}));
function actionsText(t,E,P,sold){
 const a=[];
 if(sold)a.push(`Sell ${t.asset_name}`);
 if(P>0n)a.push(`repay ${usd(P)} of debt early (prepayment premium ${usd(ceilDiv(P*BigInt(t.prepay_premium_bps),10000n))})`);
 if(E>0n)a.push(`sponsor contributes ${usd(E)}`);
 if(!a.length)return 'No action needed';
 const s=a.join('; ');return s[0].toUpperCase()+s.slice(1);
}
export function verifyPlan(row,t,plan,cits,settings){
 const E=solverCents(plan.E_cents,plan.E),P=solverCents(plan.P_cents,plan.P),s=plan.s===1?1:0;
 if(s===1&&!t.asset_name)return {ok:false,reason:'Plan sells an asset the borrower does not have'};
 if(E>0n&&t.cures_remaining<1)return {ok:false,reason:'Plan uses an equity cure with no cures remaining'};
 if(E>t.equity_cure_cap)return {ok:false,reason:`Equity cure ${usd(E)} exceeds the cap ${usd(t.equity_cure_cap)}`};
 if(P>t.cash-t.min_liquidity)return {ok:false,reason:`Paydown ${usd(P)} breaks minimum liquidity`};
 const pf=proFormaRow(row,t,{E,P,s});const ev=evaluateRow(pf,settings);
 if(ev.status==='invalid')return {ok:false,reason:`Exact engine could not evaluate the pro-forma row: ${ev.error}`,failing:[]};
 const sum=covSummary(ev);
 if(ev.status!=='pass')return {ok:false,reason:`Exact engine, pro forma: ${failText(sum)||'no covenant was tested'}`,failing:sum.failing,covenants:sum.covenants};
 const premium=ceilDiv(P*BigInt(t.prepay_premium_bps),10000n),saleCost=s?t.sale_cost:0n;
 const binding=Array.isArray(plan.binding)?plan.binding.filter(n=>CNAME.test(n)):[];
 return {ok:true,plan:{actions:actionsText(t,E,P,s===1),equity_cure_usd:amount(E),paydown_usd:amount(P),prepayment_premium_usd:amount(premium),
  sell_asset:s===1,asset_name:s===1?t.asset_name:null,sale_cost_usd:amount(saleCost),total_cost_usd:amount(E+P+premium+saleCost),
  pro_forma:{debt_usd:pf.debt_usd,ttm_ebitda_usd:pf.ttm_ebitda_usd,ttm_available_cashflow_usd:pf.ttm_available_cashflow_usd,ttm_debt_service_usd:pf.ttm_debt_service_usd},
  leverage:ev.leverage.value,dscr:ev.dscr.value,leverage_headroom_usd:ev.leverage.debt_headroom_usd,cashflow_headroom_usd:ev.dscr.cashflow_headroom_usd,
  covenants:sum.covenants,verified:true,verified_by:'lib/covenants.js evaluateRow (BigInt cents), every applied covenant',binding:cite(cits,binding)}};
}
function blockingText(n,row,t){
 const cash=t.cash-t.min_liquidity;
 return {C1:`Leverage must be at or below ${row.max_leverage}x after any cure.`,C2:`DSCR must be at least ${row.min_dscr}x after any cure.`,
  C3:`An equity cure is capped at ${usd(t.equity_cure_cap)}.`,C4:`No equity cure is available: ${t.cures_remaining} cure${t.cures_remaining===1?'':'s'} remaining in the last four quarters.`,
  C5:`Early repayment is limited to ${usd(cash<0n?0n:cash)} so cash stays at or above the ${usd(t.min_liquidity)} minimum liquidity.`,
  C7:`Fixed-charge coverage must be at least ${row.min_fccr}x after any cure: EBITDA less capex, cash taxes and distributions, over debt service.`,
  C6:`Repayment and its premium come out of current assets, which must stay at least ${row.min_current_ratio}x the ${usd(minor(row.current_liabilities_usd||'0'))} of current liabilities (current assets today ${usd(minor(row.current_assets_usd||'0'))}).`}[n];
}
// A waiver may lower only the thresholds of covenants that fail before any cure (baseFailing); every
// other applied covenant must pass at its normal limit. Leverage is rounded UP, minimums DOWN, to 0.01x.
export function verifyWaiver(row,t,w,settings,baseFailing=['leverage','dscr']){
 const E=solverCents(w.E_cents,w.E),P=solverCents(w.P_cents,w.P),s=w.s===1&&t.asset_name?1:0;
 const pf=proFormaRow(row,t,{E,P,s});
 const debt=minor(pf.debt_usd,{signed:true}),eb=minor(pf.ttm_ebitda_usd,{signed:true}),cf=minor(pf.ttm_available_cashflow_usd,{signed:true}),ds=minor(pf.ttm_debt_service_usd,{signed:true});
 if(eb<=0n||ds<=0n||debt<0n)return {ok:false,reason:'Waiver pro-forma has non-positive EBITDA or debt service'};
 const may=new Set(baseFailing);
 const spec={
  leverage:{col:'max_leverage',dir:'max',need:()=>ceilDiv(debt*100n,eb),label:'maximum leverage'},
  dscr:{col:'min_dscr',dir:'min',need:()=>floorDiv(cf*100n,ds),label:'minimum DSCR'},
  fccr:{col:'min_fccr',dir:'min',need:()=>floorDiv((eb-minor(pf.ttm_capex_usd)-minor(pf.ttm_cash_taxes_usd)-minor(pf.ttm_distributions_usd))*100n,ds),label:'minimum FCCR'},
  current_ratio:{col:'min_current_ratio',dir:'min',need:()=>floorDiv(minor(pf.current_assets_usd,{signed:true})*100n,minor(pf.current_liabilities_usd)),label:'minimum current ratio'}};
 const waived={},thresholds={},parts=[],rowW={...pf};
 for(const [k,sp] of Object.entries(spec)){
  if(String(row[sp.col]??'').trim()==='')continue;
  const cur=minor(row[sp.col]);let lim=cur;
  if(may.has(k)){const n=sp.need();lim=sp.dir==='max'?(n>cur?n:cur):(n<cur?n:cur);}
  waived[k]=lim!==cur;thresholds[k]=x100(lim);rowW[sp.col]=x100(lim);
  if(waived[k])parts.push(`${x100(lim)}x ${sp.label}`);
 }
 const ev=evaluateRow(rowW,settings);
 const wsum=covSummary(ev);
 if(ev.status!=='pass')return {ok:false,reason:`The waiver is not enough: with it applied, pro forma ${failText(wsum)||'no covenant was tested'}`,failing:wsum.failing,covenants:wsum.covenants};
 const after=evaluateRow(pf,settings);
 return {ok:true,waiver:{paydown_usd:amount(P),equity_cure_usd:amount(E),sell_asset:s===1,actions:actionsText(t,E,P,s===1),
  max_leverage:thresholds.leverage,min_dscr:thresholds.dscr,min_fccr:thresholds.fccr??null,min_current_ratio:thresholds.current_ratio??null,
  leverage_waived:!!waived.leverage,dscr_waived:!!waived.dscr,fccr_waived:!!waived.fccr,current_ratio_waived:!!waived.current_ratio,waivable:[...may],
  leverage_after:after.leverage.value,dscr_after:after.dscr.value,pro_forma:{debt_usd:pf.debt_usd,ttm_ebitda_usd:pf.ttm_ebitda_usd,ttm_available_cashflow_usd:pf.ttm_available_cashflow_usd,ttm_debt_service_usd:pf.ttm_debt_service_usd,current_assets_usd:pf.current_assets_usd??null},
  covenants:wsum.covenants,request:parts.length?`Request a waiver to ${listAnd(parts)} for ${row.period}`:null,verified:true}};
}
const listAnd=a=>a.length<3?a.join(' and '):a.slice(0,-1).join(', ')+' and '+a.at(-1);
// Turn a raw solver result into the API shape, re-checking every plan. Unverified plans are dropped and logged.
export function processSolverResult(row,t,result,cits,{log=console.warn,settings,baseFailing}={}){
 const options=[],dropped=[];
 for(const key of OPTION_KEYS){
  const o=result.options?.[key];const base={key,label:OPTION_LABELS[key]};
  const model={lp_file:o?.artifacts?.lp_file??null,lp_sha256:o?.artifacts?.lp_sha256??null,fixed_lp_file:o?.artifacts?.fixed_lp_file??null,fixed_lp_sha256:o?.artifacts?.fixed_lp_sha256??null,status:o?.status??null};
  if(!o){options.push({...base,status:'error',error:'Solver returned no result for this option',model});continue;}
  if(o.plan){
   let v;try{v=verifyPlan(row,t,o.plan,cits,settings);}catch(e){v={ok:false,reason:e.message};}
   if(v.ok)options.push({...base,status:'plan',plan:v.plan,model});
   else{dropped.push({key,reason:v.reason,failing:v.failing||[]});log(`[cure] dropped ${row.borrower_id} ${row.period} ${key}: ${v.reason}`);options.push({...base,status:'rejected',reason:'The solver plan failed the exact re-check and is not shown.',detail:v.reason,failing:v.failing||[],model});}
  }else if(o.infeasibility){
   const iis=(o.infeasibility.iis||[]).filter(n=>CNAME.test(n));
   let waiver=null,waiver_error=o.infeasibility.waiver_error??null,waiver_failing=[];
   if(o.infeasibility.waiver){let w;try{w=verifyWaiver(row,t,o.infeasibility.waiver,settings,baseFailing);}catch(e){w={ok:false,reason:e.message};}if(w.ok)waiver=w.waiver;else{waiver_error=w.reason;waiver_failing=w.failing||[];log(`[cure] waiver rejected ${row.borrower_id} ${row.period} ${key}: ${w.reason}`);}}
   options.push({...base,status:'no_cure',iis:iis.map(n=>({constraint:n,title:CLAUSE_TITLES[n],plain:blockingText(n,row,t),citations:cits[n]||[]})),waiver,waiver_error,waiver_failing,model});
  }else options.push({...base,status:'error',error:String(o.error||'Solver returned neither a plan nor an infeasibility proof'),model});
 }
 return {options,dropped};
}

const ASSUMPTIONS=[
 'Cure terms (cap, cures remaining, cash, minimum liquidity, prepayment premium, debt-service relief, asset figures) are synthetic, from data/cure_terms.csv.',
 'Gurobi proposes each plan; every plan is re-checked by the exact covenant engine in integer cents and only verified plans are shown.',
 'Equity cure and paydown amounts from the solver are rounded up to the cent before the re-check.',
 'Debt-service relief from a repayment (amount per dollar repaid) is rounded down to the cent, the conservative direction for DSCR.',
 'Asset sale proceeds repay debt; the sold asset\'s EBITDA and cash flow are removed from the trailing twelve-month figures (cure-policy.txt).',
 'A waiver is sized by minimising the total violation of the covenants that fail before any cure. Waiver leverage is rounded up and waiver minimums down to 0.01x.',
 'Cure costs are cash outlays (equity, repayment plus premium, sale cost); they ignore tax, fees not in cure_terms.csv and the time value of money.',
 'A plan is verified only if every covenant the monitor applies (leverage, DSCR, FCCR, current ratio, with the same maintenance/springing/off settings and trigger) passes on the pro-forma figures.',
 'Pro-forma FCCR uses the cured EBITDA and debt service; capex, cash taxes and distributions are unchanged, including after an asset sale.',
 'Pro-forma current ratio (cure-policy.txt, "Cure cash"): repayment and its premium reduce current assets; equity cure cash is not added; the asset sale cost is paid from gross proceeds; current liabilities are unchanged.',
 'The model works in integer cents with the same rounding as the exact engine (premium rounded up, debt-service relief rounded down), so no rounding can push a binding limit past its threshold.',
 'The current-ratio (C6) and FCCR (C7) limits are part of the model only when the monitor applies those tests that quarter. A waiver relaxes only covenants that fail before any cure (leverage, DSCR, FCCR, current ratio); cure cap, cure frequency and minimum liquidity are never relaxed.',
 'Revolver drawn and commitment are unchanged by a cure, so a springing covenant keeps the trigger state of the reported quarter; repayment is applied to term debt.',
 'A cure plan is decision support for a credit reviewer, not legal advice or a determination of default or cure.'];

// Main entry: GET (no overrides) may fall back to the snapshot; overrides require the live solver.
export async function curePlan({borrower,period,overrides,settings:rawSettings}={},{optUrl=process.env.OPT_URL,snapshotPath=new URL('cure_snapshot.json',DATA),context,timeoutMs,log,onRaw}={}){
 if(typeof borrower!=='string'||!/^BOR-\d{1,4}$/.test(borrower))throw Error('borrower must look like BOR-09');
 if(typeof period!=='string'||!/^\d{4}-Q[1-4]$/.test(period))throw Error('period must look like 2026-Q3');
 const settings=normalizeSettings(rawSettings);
 const ctx=context||await loadCureContext();
 const row=ctx.rows.find(r=>r.borrower_id===borrower&&r.period===period);
 if(!row)return {code:404,body:{error:`No covenant row for ${borrower} ${period}`}};
 const ev=evaluateRow(row,settings);
 const head={borrower_id:borrower,period,record_id:row.record_id,synthetic:true,settings:{trigger_pct:settings.trigger_pct,modes:settings.modes,borrower_modes:settings.borrowers[borrower]??null}};
 if(ev.status==='pass')return {code:200,body:{...head,needed:false,note:'Every applied covenant passes; no cure is needed.'}};
 if(ev.status==='untested')return {code:200,body:{...head,needed:false,note:'No covenant is tested this quarter under the current terms; no cure is needed.'}};
 if(ev.status==='invalid')return {code:200,body:{...head,needed:true,available:false,reason:'The covenant row cannot be evaluated exactly, so no cure can be planned.'}};
 const base0=covSummary(ev);
 const tested=k=>ev.covenants[k]&&ev.covenants[k].status!=='dormant';
 if(!tested('leverage')||!tested('dscr'))return {code:200,body:{...head,needed:true,available:false,failing:base0.failing,reason:'The cure model assumes leverage and DSCR are both tested this quarter; under the current covenant terms at least one is not applied or is dormant, so no cure is planned.'}};
 // Breaches of FCCR or the current ratio alone are planned too: C7 and C6 are in the model when those tests apply.
 if(base0.failing.some(k=>ev.covenants[k].status==='unevaluable'))return {code:200,body:{...head,needed:true,available:false,failing:base0.failing,reason:'At least one applied covenant cannot be calculated exactly this quarter, so no cure can be verified.'}};
 const base=ctx.terms.get(borrower);
 if(!base)return {code:200,body:{...head,needed:true,available:false,reason:`No cure terms for ${borrower} in cure_terms.csv.`}};
 const hasOverrides=overrides!==undefined&&overrides!==null&&Object.keys(overrides).length>0;
 const t=hasOverrides?applyOverrides(base,overrides):{...base,overridden:[]};
 const applied=k=>Boolean(ev.covenants[k]&&ev.covenants[k].status!=='dormant');const crApplied=applied('current_ratio'),fccrApplied=applied('fccr');
 const breach={leverage:{status:ev.leverage.status,value:ev.leverage.value,max:row.max_leverage},dscr:{status:ev.dscr.status,value:ev.dscr.value,min:row.min_dscr},covenants:base0.covenants,failing:base0.failing};
 const terms={equity_cure_cap_usd:amount(t.equity_cure_cap),cures_remaining_4q:t.cures_remaining,cash_usd:amount(t.cash),min_liquidity_usd:amount(t.min_liquidity),
  ds_reduction_per_usd:t.raw.ds_reduction_per_usd,prepay_premium_bps:t.prepay_premium_bps,asset_name:t.asset_name,asset_sale_available:Boolean(t.asset_name),
  asset_proceeds_usd:t.asset_name?amount(t.asset_proceeds):null,sale_cost_usd:t.asset_name?amount(t.sale_cost):null,overridden:t.overridden,synthetic:base.synthetic,source_document:'cure_terms.csv'};
 const common={...head,needed:true,breach,terms,clauses:Object.fromEntries(Object.entries(ctx.citations).map(([k,v])=>[k,{title:CLAUSE_TITLES[k],citations:v}])),pro_forma_checks:ctx.checks||null,assumptions:ASSUMPTIONS};
 let liveError=null;
 if(optUrl){
  try{
   const res=await callSolver(optUrl,solverRequest(row,t,hasOverrides?'whatif':'live',crApplied,fccrApplied),timeoutMs);
   const {options,dropped}=processSolverResult(row,t,res,ctx.citations,{log,settings,baseFailing:base0.failing});
   if(onRaw)onRaw(res); // scripts/cure-snapshot.mjs stores the raw solver result; it is re-checked again when served
   return {code:200,body:{...common,available:true,source:'live',solved_at:new Date().toISOString(),gurobi_version:res.gurobi_version??null,params:res.params??null,live_solver:true,options,dropped}};
  }catch(e){liveError=e.name==='TimeoutError'?'Solver did not answer within 5 seconds':e.message;(log||console.warn)(`[cure] live solver failed: ${liveError}`);}
 }
 if(hasOverrides)return {code:503,body:{...head,needed:true,available:false,reason:optUrl?`Changing cure terms needs the live solver, which failed: ${liveError}`:'Changing cure terms needs the live solver; OPT_URL is not set on this server.'}};
 const snap=await loadSnapshot(snapshotPath);const entry=snap?.entries?.[`${borrower}|${period}`];
 if(entry){
  const {options,dropped}=processSolverResult(row,t,entry,ctx.citations,{log,settings,baseFailing:base0.failing});
  return {code:200,body:{...common,available:true,source:'snapshot',solved_at:snap.solved_at??null,gurobi_version:snap.gurobi_version??entry.gurobi_version??null,params:snap.params??entry.params??null,live_solver:false,live_error:liveError,options,dropped}};
 }
 return {code:200,body:{...head,needed:true,available:false,reason:liveError?`Live solver failed (${liveError}) and no offline solution is stored for ${borrower} ${period}.`:`No live solver is configured (OPT_URL) and no offline solution is stored for ${borrower} ${period}.`}};
}
