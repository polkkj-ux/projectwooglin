// Cure planner bridge. Gurobi (opt/, reached via OPT_URL) proposes cures; this module re-checks every
// plan with the exact BigInt-cents engine (evaluateRow) before it can be shown. No LLM; no floats
// decide pass/fail. Amounts from the solver are rounded UP to the cent before the re-check.
import fs from 'node:fs/promises';
import {parseCSV} from './csv.js';
import {minor,amount} from './finance.js';
import {evaluateRow,policyEvidence} from './covenants.js';
import {parseCureTerms,cureClauseCitations} from './cure-terms.js';

const DATA=new URL('../data/',import.meta.url);
const rd=n=>fs.readFile(new URL(n,DATA),'utf8');
export const OPTION_KEYS=['cheapest','no_asset_sale','equity_cure_only'];
const OPTION_LABELS={cheapest:'Cheapest cure',no_asset_sale:'Without an asset sale',equity_cure_only:'Equity cure only'};
const CLAUSE_TITLES={C1:'Maximum leverage after cure',C2:'Minimum DSCR after cure',C3:'Equity cure cap',C4:'Cure frequency',C5:'Minimum liquidity after prepayment'};
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
 const [cov,terms,loan,cure]=await Promise.all([rd('loan_covenants.csv'),rd('cure_terms.csv'),rd('documents/loan-policy.txt'),rd('documents/cure-policy.txt')]);
 return {rows:parseCSV(cov),terms:parseCureTerms(parseCSV(terms)),citations:clauseCitations(loan,cure)};
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
function solverRequest(row,t,c){
 const num=cents=>Number(amount(cents));const has=Boolean(t.asset_name);
 return {borrower_id:row.borrower_id,period:row.period,case:c,D:Number(row.debt_usd),EBITDA:Number(row.ttm_ebitda_usd),DS:Number(row.ttm_debt_service_usd),CF:Number(row.ttm_available_cashflow_usd),
  Lmax:Number(row.max_leverage),Dmin:Number(row.min_dscr),cap:num(t.equity_cure_cap),cures_remaining:t.cures_remaining,cash:num(t.cash),min_liquidity:num(t.min_liquidity),
  k:Number(t.ds_reduction_per_usd_e4)/10000,premium_bps:t.prepay_premium_bps,has_asset:has,proceeds:has?num(t.asset_proceeds):0,asset_ebitda:has?num(t.asset_ebitda):0,asset_cf:has?num(t.asset_cashflow):0,sale_cost:has?num(t.sale_cost):0};
}
async function callSolver(url,body,timeoutMs=SOLVER_TIMEOUT_MS){
 const r=await fetch(url.replace(/\/+$/,'')+'/solve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw Error(`Solver returned HTTP ${r.status}`);
 const j=await r.json();if(!j||typeof j!=='object'||!j.options)throw Error('Solver response has no options');return j;
}

// ---- exact re-check ----------------------------------------------------------------------------
// Pro-forma row in exact cents. Debt-service relief k*repaid is rounded DOWN (less relief = more
// conservative DSCR). Returns the row as decimal strings so evaluateRow parses it like any CSV row.
export function proFormaRow(row,t,{E,P,s}){
 const sold=s===1&&Boolean(t.asset_name);
 const repaid=P+(sold?t.asset_proceeds:0n);
 const relief=t.ds_reduction_per_usd_e4*repaid/10000n;
 return {...row,record_id:row.record_id+'-PF',
  debt_usd:amount(minor(row.debt_usd)-repaid),
  ttm_ebitda_usd:amount(minor(row.ttm_ebitda_usd,{signed:true})+E-(sold?t.asset_ebitda:0n)),
  ttm_available_cashflow_usd:amount(minor(row.ttm_available_cashflow_usd,{signed:true})+E-(sold?t.asset_cashflow:0n)),
  ttm_debt_service_usd:amount(minor(row.ttm_debt_service_usd)-relief)};
}
const cite=(cits,names)=>names.filter(n=>cits[n]).map(n=>({constraint:n,title:CLAUSE_TITLES[n],citations:cits[n]}));
function actionsText(t,E,P,sold){
 const a=[];
 if(sold)a.push(`Sell ${t.asset_name}`);
 if(P>0n)a.push(`repay ${usd(P)} of debt early (prepayment premium ${usd(ceilDiv(P*BigInt(t.prepay_premium_bps),10000n))})`);
 if(E>0n)a.push(`sponsor contributes ${usd(E)}`);
 if(!a.length)return 'No action needed';
 const s=a.join('; ');return s[0].toUpperCase()+s.slice(1);
}
export function verifyPlan(row,t,plan,cits){
 const E=ceilCents(plan.E),P=ceilCents(plan.P),s=plan.s===1?1:0;
 if(s===1&&!t.asset_name)return {ok:false,reason:'Plan sells an asset the borrower does not have'};
 if(E>0n&&t.cures_remaining<1)return {ok:false,reason:'Plan uses an equity cure with no cures remaining'};
 if(E>t.equity_cure_cap)return {ok:false,reason:`Equity cure ${usd(E)} exceeds the cap ${usd(t.equity_cure_cap)}`};
 if(P>t.cash-t.min_liquidity)return {ok:false,reason:`Paydown ${usd(P)} breaks minimum liquidity`};
 const pf=proFormaRow(row,t,{E,P,s});const ev=evaluateRow(pf);
 if(ev.status!=='pass')return {ok:false,reason:`Exact engine: leverage ${ev.leverage?.status??'invalid'}, DSCR ${ev.dscr?.status??'invalid'}`,pro_forma:pf};
 const premium=ceilDiv(P*BigInt(t.prepay_premium_bps),10000n),saleCost=s?t.sale_cost:0n;
 const binding=Array.isArray(plan.binding)?plan.binding.filter(n=>/^C[1-5]$/.test(n)):[];
 return {ok:true,plan:{actions:actionsText(t,E,P,s===1),equity_cure_usd:amount(E),paydown_usd:amount(P),prepayment_premium_usd:amount(premium),
  sell_asset:s===1,asset_name:s===1?t.asset_name:null,sale_cost_usd:amount(saleCost),total_cost_usd:amount(E+P+premium+saleCost),
  pro_forma:{debt_usd:pf.debt_usd,ttm_ebitda_usd:pf.ttm_ebitda_usd,ttm_available_cashflow_usd:pf.ttm_available_cashflow_usd,ttm_debt_service_usd:pf.ttm_debt_service_usd},
  leverage:ev.leverage.value,dscr:ev.dscr.value,leverage_headroom_usd:ev.leverage.debt_headroom_usd,cashflow_headroom_usd:ev.dscr.cashflow_headroom_usd,
  verified:true,verified_by:'lib/covenants.js evaluateRow (BigInt cents)',binding:cite(cits,binding)}};
}
function blockingText(n,row,t){
 const cash=t.cash-t.min_liquidity;
 return {C1:`Leverage must be at or below ${row.max_leverage}x after any cure.`,C2:`DSCR must be at least ${row.min_dscr}x after any cure.`,
  C3:`An equity cure is capped at ${usd(t.equity_cure_cap)}.`,C4:`No equity cure is available: ${t.cures_remaining} cure${t.cures_remaining===1?'':'s'} remaining in the last four quarters.`,
  C5:`Early repayment is limited to ${usd(cash<0n?0n:cash)} so cash stays at or above the ${usd(t.min_liquidity)} minimum liquidity.`}[n];
}
export function verifyWaiver(row,t,w){
 const E=ceilCents(w.E),P=ceilCents(w.P),s=w.s===1&&t.asset_name?1:0;
 const pf=proFormaRow(row,t,{E,P,s});
 const debt=minor(pf.debt_usd,{signed:true}),eb=minor(pf.ttm_ebitda_usd,{signed:true}),cf=minor(pf.ttm_available_cashflow_usd,{signed:true}),ds=minor(pf.ttm_debt_service_usd,{signed:true});
 if(eb<=0n||ds<=0n||debt<0n)return {ok:false,reason:'Waiver pro-forma has non-positive EBITDA or debt service'};
 const Lmax=minor(row.max_leverage),Dmin=minor(row.min_dscr);
 const levUp=ceilDiv(debt*100n,eb),dscrDown=floorDiv(cf*100n,ds);   // round leverage UP, DSCR DOWN, to 0.01x
 const maxLev=levUp>Lmax?levUp:Lmax,minDscr=dscrDown<Dmin?dscrDown:Dmin;
 const ev=evaluateRow({...pf,max_leverage:x100(maxLev),min_dscr:x100(minDscr)});
 if(ev.status!=='pass')return {ok:false,reason:'Waiver thresholds failed the exact re-check'};
 const parts=[];if(maxLev>Lmax)parts.push(`${x100(maxLev)}x maximum leverage`);if(minDscr<Dmin)parts.push(`${x100(minDscr)}x minimum DSCR`);
 const after=evaluateRow(pf);
 return {ok:true,waiver:{paydown_usd:amount(P),equity_cure_usd:amount(E),sell_asset:s===1,actions:actionsText(t,E,P,s===1),
  max_leverage:x100(maxLev),min_dscr:x100(minDscr),leverage_waived:maxLev>Lmax,dscr_waived:minDscr<Dmin,
  leverage_after:after.leverage.value,dscr_after:after.dscr.value,pro_forma:{debt_usd:pf.debt_usd,ttm_ebitda_usd:pf.ttm_ebitda_usd,ttm_available_cashflow_usd:pf.ttm_available_cashflow_usd,ttm_debt_service_usd:pf.ttm_debt_service_usd},
  request:parts.length?`Request a waiver to ${parts.join(' and ')} for ${row.period}`:null,verified:true}};
}
// Turn a raw solver result into the API shape, re-checking every plan. Unverified plans are dropped and logged.
export function processSolverResult(row,t,result,cits,{log=console.warn}={}){
 const options=[],dropped=[];
 for(const key of OPTION_KEYS){
  const o=result.options?.[key];const base={key,label:OPTION_LABELS[key]};
  const model={lp_file:o?.artifacts?.lp_file??null,lp_sha256:o?.artifacts?.lp_sha256??null,fixed_lp_file:o?.artifacts?.fixed_lp_file??null,fixed_lp_sha256:o?.artifacts?.fixed_lp_sha256??null,status:o?.status??null};
  if(!o){options.push({...base,status:'error',error:'Solver returned no result for this option',model});continue;}
  if(o.plan){
   let v;try{v=verifyPlan(row,t,o.plan,cits);}catch(e){v={ok:false,reason:e.message};}
   if(v.ok)options.push({...base,status:'plan',plan:v.plan,model});
   else{dropped.push({key,reason:v.reason});log(`[cure] dropped ${row.borrower_id} ${row.period} ${key}: ${v.reason}`);options.push({...base,status:'rejected',reason:'The solver plan failed the exact re-check and is not shown.',model});}
  }else if(o.infeasibility){
   const iis=(o.infeasibility.iis||[]).filter(n=>/^C[1-5]$/.test(n));
   let waiver=null,waiver_error=o.infeasibility.waiver_error??null;
   if(o.infeasibility.waiver){let w;try{w=verifyWaiver(row,t,o.infeasibility.waiver);}catch(e){w={ok:false,reason:e.message};}if(w.ok)waiver=w.waiver;else{waiver_error=w.reason;log(`[cure] waiver rejected ${row.borrower_id} ${row.period} ${key}: ${w.reason}`);}}
   options.push({...base,status:'no_cure',iis:iis.map(n=>({constraint:n,title:CLAUSE_TITLES[n],plain:blockingText(n,row,t),citations:cits[n]||[]})),waiver,waiver_error,model});
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
 'A waiver is sized by minimising the total violation of the leverage and DSCR limits only; cure cap, cure frequency and minimum liquidity are treated as facts. Waiver leverage is rounded up and waiver DSCR down to 0.01x.',
 'Cure costs are cash outlays (equity, repayment plus premium, sale cost); they ignore tax, fees not in cure_terms.csv and the time value of money.',
 'A cure plan is decision support for a credit reviewer, not legal advice or a determination of default or cure.'];

// Main entry: GET (no overrides) may fall back to the snapshot; overrides require the live solver.
export async function curePlan({borrower,period,overrides}={},{optUrl=process.env.OPT_URL,snapshotPath=new URL('cure_snapshot.json',DATA),context,timeoutMs,log}={}){
 if(typeof borrower!=='string'||!/^BOR-\d{1,4}$/.test(borrower))throw Error('borrower must look like BOR-09');
 if(typeof period!=='string'||!/^\d{4}-Q[1-4]$/.test(period))throw Error('period must look like 2026-Q3');
 const ctx=context||await loadCureContext();
 const row=ctx.rows.find(r=>r.borrower_id===borrower&&r.period===period);
 if(!row)return {code:404,body:{error:`No covenant row for ${borrower} ${period}`}};
 const ev=evaluateRow(row);
 const head={borrower_id:borrower,period,record_id:row.record_id,synthetic:true};
 if(ev.status==='pass')return {code:200,body:{...head,needed:false,note:'Both covenant tests pass; no cure is needed.'}};
 if(ev.status==='invalid'||ev.leverage.status==='unevaluable'||ev.dscr.status==='unevaluable')return {code:200,body:{...head,needed:true,available:false,reason:'The covenant row cannot be evaluated exactly, so no cure can be planned.'}};
 const base=ctx.terms.get(borrower);
 if(!base)return {code:200,body:{...head,needed:true,available:false,reason:`No cure terms for ${borrower} in cure_terms.csv.`}};
 const hasOverrides=overrides!==undefined&&overrides!==null&&Object.keys(overrides).length>0;
 const t=hasOverrides?applyOverrides(base,overrides):{...base,overridden:[]};
 const breach={leverage:{status:ev.leverage.status,value:ev.leverage.value,max:row.max_leverage},dscr:{status:ev.dscr.status,value:ev.dscr.value,min:row.min_dscr}};
 const terms={equity_cure_cap_usd:amount(t.equity_cure_cap),cures_remaining_4q:t.cures_remaining,cash_usd:amount(t.cash),min_liquidity_usd:amount(t.min_liquidity),
  ds_reduction_per_usd:t.raw.ds_reduction_per_usd,prepay_premium_bps:t.prepay_premium_bps,asset_name:t.asset_name,asset_sale_available:Boolean(t.asset_name),
  asset_proceeds_usd:t.asset_name?amount(t.asset_proceeds):null,sale_cost_usd:t.asset_name?amount(t.sale_cost):null,overridden:t.overridden,synthetic:base.synthetic,source_document:'cure_terms.csv'};
 const common={...head,needed:true,breach,terms,clauses:Object.fromEntries(Object.entries(ctx.citations).map(([k,v])=>[k,{title:CLAUSE_TITLES[k],citations:v}])),assumptions:ASSUMPTIONS};
 let liveError=null;
 if(optUrl){
  try{
   const res=await callSolver(optUrl,solverRequest(row,t,hasOverrides?'whatif':'live'),timeoutMs);
   const {options,dropped}=processSolverResult(row,t,res,ctx.citations,{log});
   return {code:200,body:{...common,available:true,source:'live',solved_at:new Date().toISOString(),gurobi_version:res.gurobi_version??null,params:res.params??null,live_solver:true,options,dropped}};
  }catch(e){liveError=e.name==='TimeoutError'?'Solver did not answer within 5 seconds':e.message;(log||console.warn)(`[cure] live solver failed: ${liveError}`);}
 }
 if(hasOverrides)return {code:503,body:{...head,needed:true,available:false,reason:optUrl?`Changing cure terms needs the live solver, which failed: ${liveError}`:'Changing cure terms needs the live solver; OPT_URL is not set on this server.'}};
 const snap=await loadSnapshot(snapshotPath);const entry=snap?.entries?.[`${borrower}|${period}`];
 if(entry){
  const {options,dropped}=processSolverResult(row,t,entry,ctx.citations,{log});
  return {code:200,body:{...common,available:true,source:'snapshot',solved_at:snap.solved_at??null,gurobi_version:snap.gurobi_version??entry.gurobi_version??null,params:snap.params??entry.params??null,live_solver:false,live_error:liveError,options,dropped}};
 }
 return {code:200,body:{...head,needed:true,available:false,reason:liveError?`Live solver failed (${liveError}) and no offline solution is stored for ${borrower} ${period}.`:`No live solver is configured (OPT_URL) and no offline solution is stored for ${borrower} ${period}.`}};
}
