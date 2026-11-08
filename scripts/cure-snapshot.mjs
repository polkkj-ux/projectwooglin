// Offline cure snapshot for deployments without a live solver (Vercel).
//   OPT_URL=http://127.0.0.1:8000 npm run cure:snapshot            -> writes data/cure_snapshot.json
//   OPT_URL=... node scripts/cure-snapshot.mjs --out other.json      -> writes elsewhere (dry runs)
// Solves every exception row of the monitor's default data under the default covenant terms, through the
// same curePlan() path as GET /api/cure, so every plan gets the same exact re-check. The raw solver
// results are stored and re-checked again each time they are served. Exits non-zero if any plan the
// solver proposed failed the exact re-check, or if any solve failed.
import fs from 'node:fs/promises';
import {curePlan,loadCureContext} from '../lib/cure.js';
import {evaluateRow,normalizeSettings} from '../lib/covenants.js';

const optUrl=process.env.OPT_URL;
if(!optUrl){console.error('Set OPT_URL to the licensed solver, e.g. OPT_URL=http://127.0.0.1:8000 npm run cure:snapshot');process.exit(2);}
const i=process.argv.indexOf('--out');const out=i>0?process.argv[i+1]:new URL('../data/cure_snapshot.json',import.meta.url);
const health=await fetch(optUrl.replace(/\/+$/,'')+'/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).catch(e=>({ok:false,error:e.message}));
if(!health.ok){console.error('Solver health check failed:',health.error||JSON.stringify(health));process.exit(2);}

const ctx=await loadCureContext();const settings=normalizeSettings();
const rows=ctx.rows.filter(r=>evaluateRow(r,settings).status==='exception');
const entries={},report=[];let unverified=0,failures=0,params=null,version=null;
for(const r of rows){
 let raw=null;const logs=[];
 const res=await curePlan({borrower:r.borrower_id,period:r.period},{optUrl,context:ctx,snapshotPath:'/nonexistent',timeoutMs:30000,log:m=>logs.push(m),onRaw:x=>{raw=x;}});
 const b=res.body,key=`${r.borrower_id}|${r.period}`;
 if(b.available===false){
  // Not plannable by design (e.g. fails FCCR only); a failed live solve is an error.
  if(/Live solver failed|did not answer/.test(b.reason||'')){failures++;report.push([key,'SOLVE FAILED',b.reason]);}
  else report.push([key,'not planned',b.reason]);continue;}
 if(b.source!=='live'||!raw){failures++;report.push([key,'SOLVE FAILED','no live result']);continue;}
 entries[key]=raw;version??=raw.gurobi_version;params??=raw.params;
 const summary=b.options.map(o=>{
  if(o.status==='plan')return `${o.key}: ${o.plan.actions}, ${o.plan.total_cost_usd} (verified)`;
  if(o.status==='rejected'){unverified++;return `${o.key}: REJECTED, ${o.detail}`;}
  if(o.status==='no_cure')return `${o.key}: no cure; ${o.waiver?o.waiver.request:'waiver not verified: '+o.waiver_error}`;
  failures++;return `${o.key}: ERROR ${o.error}`;});
 report.push([key,'solved',summary.join(' | ')]);
}
const snapshot={synthetic:true,note:'Raw Gurobi results for the bundled synthetic data under the default covenant terms. Served only when no live solver is reachable, and re-checked by the exact engine every time it is served.',
 solved_at:new Date().toISOString(),gurobi_version:version,params,data:'data/team/loan_covenants_extended.csv',terms:'data/cure_terms.csv',settings:{trigger_pct:settings.trigger_pct,modes:settings.modes},
 models:Object.fromEntries(Object.entries(entries).map(([k,v])=>[k,Object.fromEntries(Object.entries(v.options).map(([o,x])=>[o,{lp_file:x.artifacts?.lp_file??null,lp_sha256:x.artifacts?.lp_sha256??null,fixed_lp_sha256:x.artifacts?.fixed_lp_sha256??null}]))])),
 entries};
for(const [k,st,msg] of report)console.log(`${st==='solved'?'OK  ':st==='not planned'?'SKIP':'FAIL'} ${k}  ${msg}`);
if(unverified||failures){console.error(`\n${unverified} plan(s) failed the exact re-check, ${failures} solve error(s); snapshot NOT written.`);process.exit(1);}
await fs.writeFile(out,JSON.stringify(snapshot,null,1)+'\n');
console.log(`\nWrote ${Object.keys(entries).length} solved rows (${report.filter(x=>x[1]==='not planned').length} not plannable) with Gurobi ${version} to ${out instanceof URL?'data/cure_snapshot.json':out}.`);
