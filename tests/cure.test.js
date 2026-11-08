import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {curePlan,ceilCents,loadCureContext,usd} from '../lib/cure.js';import {evaluateRow} from '../lib/covenants.js';
import {verifyCitation} from '../lib/citations.js';import {createServer} from '../server.js';

const fx=async n=>JSON.parse(await fs.readFile(new URL(`./fixtures/solver-${n}.json`,import.meta.url),'utf8'));
// Tiny stand-in for opt/app.py: answers POST /solve with whatever `respond(body)` returns.
async function mockSolver(respond){
 const calls=[];const s=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const body=JSON.parse(b||'{}');calls.push({path:req.url,body});
  const out=await respond(body);if(out===undefined){res.writeHead(500);return res.end('boom');}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+s.address().port,calls,close:()=>new Promise(r=>s.close(r))};
}
const quiet={log:()=>{}};
// Picks the fixture the real solver produced for the request it receives (tests/fixtures, generated through curePlan).
const smart=b=>fx(b.borrower_id==='BOR-01'?'T5':b.borrower_id==='BOR-02'?(b.period==='2026-Q2'?'BOR02Q2':'BOR02Q3'):b.borrower_id==='BOR-07'?'BOR07Q3':
 b.cures_remaining===0?(b.has_asset?'T3':'T4')+(b.min_current_ratio?'':'-nocr'):'T1');
const ctx=await loadCureContext();
const noSnap={snapshotPath:path.join(os.tmpdir(),'does-not-exist-cure.json')};

test('T1 BOR-09 2026-Q3: live plan is rounded up to the cent and verified by the exact engine',async()=>{
 const m=await mockSolver(async()=>fx('T1'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(r.code,200);const b=r.body;assert.equal(b.needed,true);assert.equal(b.source,'live');assert.equal(b.available,true);
  assert.equal(m.calls[0].path,'/solve');assert.equal(m.calls[0].body.D,'1270000.00');assert.equal(m.calls[0].body.has_asset,true);assert.equal(m.calls[0].body.k,'0.1800');
  // current ratio is applied to BOR-09 2026-Q3, so the C6 inputs are sent as exact decimal strings
  assert.equal(m.calls[0].body.current_assets,'900000.00');assert.equal(m.calls[0].body.current_liabilities,'600000.00');assert.equal(m.calls[0].body.min_current_ratio,'1.25');
  // FCCR is springing but tested (no revolver data), so the C7 inputs are sent too
  assert.equal(m.calls[0].body.capex,'35000.00');assert.equal(m.calls[0].body.cash_taxes,'15000.00');assert.equal(m.calls[0].body.distributions,'0.00');assert.equal(m.calls[0].body.min_fccr,'1.10');
  const c=b.options.find(o=>o.key==='cheapest');assert.equal(c.status,'plan');
  assert.equal(c.plan.equity_cure_usd,'68333.34');assert.equal(c.plan.paydown_usd,'0.00');assert.equal(c.plan.sell_asset,true);
  assert.equal(c.plan.total_cost_usd,'78333.34');assert.equal(c.plan.verified,true);
  assert.equal(c.plan.actions,'Sell Division A; sponsor contributes $68,333.34');
  assert.equal(c.plan.pro_forma.debt_usd,'1120000.00');assert.equal(c.plan.pro_forma.ttm_ebitda_usd,'373333.34');assert.equal(c.plan.pro_forma.ttm_debt_service_usd,'233000.00');
  assert.equal(c.plan.leverage,2.9999);
  assert.ok(c.plan.binding.some(x=>x.constraint==='C1'));
  assert.equal(b.clauses.C6.citations.length,2);assert.match(b.clauses.C6.citations[1].quote,/^Cure cash: /);
  assert.match(b.clauses.C7.citations[0].quote,/^Fixed Charge Coverage Ratio is/);
  for(const k of ['C1','C2','C3','C4','C5','C6','C7'])for(const ci of b.clauses[k].citations){const text=await fs.readFile(new URL('../data/'+ci.source_document,import.meta.url),'utf8');assert.ok(verifyCitation(text,ci),k);}
  assert.equal(b.options.find(o=>o.key==='no_asset_sale').plan.equity_cure_usd,'98333.34');
  assert.equal(b.terms.synthetic,true);assert.deepEqual(b.dropped,[]);assert.ok(b.assumptions.length>=5);
  // every applied covenant is re-checked pro forma, not just leverage and DSCR
  assert.deepEqual(Object.keys(c.plan.covenants).sort(),['current_ratio','dscr','fccr','leverage']);
  assert.ok(Object.values(c.plan.covenants).every(x=>x.status==='pass'));
  assert.equal(c.plan.covenants.fccr.value,1.3876);   // (373,333.34 - 35,000 - 15,000) / 233,000
  assert.equal(c.plan.covenants.current_ratio.value,1.5);   // no repayment; sale cost is paid from gross proceeds
  assert.deepEqual(b.breach.failing.sort(),['dscr','fccr','leverage']);
 }finally{await m.close();}
});

test('a plan one cent short is rejected by the exact re-check and never shown',async()=>{
 const res=await fx('T1');res.options.cheapest.plan.E=68333.32;res.options.cheapest.plan.E_cents=6833332;
 const logs=[];const m=await mockSolver(async()=>res);
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,log:x=>logs.push(x)});
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'rejected');assert.equal(c.plan,undefined);
  assert.equal(r.body.dropped.length,1);assert.match(r.body.dropped[0].reason,/leverage 3\.0000x above the 3\.00x maximum \(\$0\.04 past the limit\)/);assert.deepEqual(r.body.dropped[0].failing,['leverage']);assert.match(logs[0],/dropped BOR-09 2026-Q3 cheapest/);
 }finally{await m.close();}
});

test('T5 BOR-01 2026-Q3: equity cure equals the engine\'s -12000.00 cash-flow headroom',async()=>{
 const m=await mockSolver(async()=>fx('T5'));
 try{
  const row=ctx.rows.find(x=>x.borrower_id==='BOR-01'&&x.period==='2026-Q3');const ev=evaluateRow(row);
  assert.equal(ev.dscr.cashflow_headroom_usd,'-12000.00');
  const r=await curePlan({borrower:'BOR-01',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  const p=r.body.options.find(o=>o.key==='cheapest').plan;
  assert.equal(p.equity_cure_usd,ev.dscr.cashflow_headroom_usd.replace('-',''));assert.equal(p.total_cost_usd,'12000.00');assert.equal(p.dscr,1.2);assert.equal(p.verified,true);
  assert.equal(m.calls[0].body.has_asset,false);assert.equal(m.calls[0].body.min_fccr,undefined);   // FCCR dormant: revolver 30% drawn
 }finally{await m.close();}
});

test('T4 (no cures, no asset): IIS includes C1, C3, C4, C6; verified 3.46x waiver, current ratio exactly 1.25x',async()=>{
 const m=await mockSolver(async b=>fx(b.min_current_ratio?'T4':'T4-nocr'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0,asset_sale_allowed:false}},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(r.code,200);assert.equal(m.calls[0].body.cures_remaining,0);assert.equal(m.calls[0].body.has_asset,false);assert.equal(m.calls[0].body.case,'whatif');
  assert.deepEqual(r.body.terms.overridden,['cures_remaining_4q','asset_sale_allowed']);
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'no_cure');
  for(const k of ['C1','C3','C4','C6'])assert.ok(c.iis.some(x=>x.constraint===k),k);
  assert.ok(c.iis.every(x=>/^C[1-6]$/.test(x.constraint)&&x.citations.length>=1));   // auxiliary PREMIUM row is not shown
  assert.match(c.iis.find(x=>x.constraint==='C4').plain,/0 cures remaining/);assert.match(c.iis.find(x=>x.constraint==='C6').plain,/1\.25x the \$600,000\.00 of current liabilities/);
  const w=c.waiver;assert.equal(w.verified,true);
  assert.equal(w.paydown_usd,'148514.85');assert.equal(w.max_leverage,'3.46');assert.equal(w.leverage_after,3.4507);assert.equal(w.min_dscr,'1.20');assert.equal(w.dscr_waived,false);
  assert.equal(w.pro_forma.debt_usd,'1121485.15');
  assert.equal(w.covenants.current_ratio.status,'pass');assert.equal(w.covenants.current_ratio.value,1.25);
  assert.equal(w.request,'Request a waiver to 3.46x maximum leverage for 2026-Q3');
 }finally{await m.close();}
});

test('the $148,514.85 paydown passes the current ratio at exactly 1.25x in the exact engine; one more cent fails',async()=>{
 const {proFormaRow}=await import('../lib/cure.js');
 const row=ctx.rows.find(x=>x.borrower_id==='BOR-09'&&x.period==='2026-Q3'),t=ctx.terms.get('BOR-09');
 const at=evaluateRow(proFormaRow(row,t,{E:0n,P:14851485n,s:0}));
 assert.equal(at.current_ratio.status,'pass');assert.equal(at.current_ratio.value,1.25);assert.equal(at.current_ratio.numerator_usd,'750000.00');
 assert.equal(at.current_ratio.numerator_headroom_usd,'0.00');
 const over=evaluateRow(proFormaRow(row,t,{E:0n,P:14851486n,s:0}));
 assert.equal(over.current_ratio.status,'breach');assert.equal(over.current_ratio.numerator_usd,'749999.99');
});

test('T4 with the current ratio not applied: C6 is not sent and the 3.14x waiver is verified',async()=>{
 const m=await mockSolver(async b=>fx(b.min_current_ratio?'T4':'T4-nocr'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0,asset_sale_allowed:false},settings:{modes:{current_ratio:'off'}}},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(m.calls[0].body.min_current_ratio,undefined);assert.equal(m.calls[0].body.current_assets,undefined);
  const w=r.body.options.find(o=>o.key==='cheapest').waiver;
  assert.equal(w.paydown_usd,'250000.00');assert.equal(w.max_leverage,'3.14');assert.equal(w.min_dscr,'1.20');
  assert.equal(w.leverage_waived,true);assert.equal(w.dscr_waived,false);assert.equal(w.dscr_after,1.3953);assert.equal(w.covenants.fccr.status,'pass');
  assert.equal(w.request,'Request a waiver to 3.14x maximum leverage for 2026-Q3');assert.equal(w.verified,true);
  assert.equal(r.body.settings.modes.current_ratio,'off');
 }finally{await m.close();}
});

test('T3 (no cures): infeasible with C6; waiver sells Division A, repays $148,514.85, 3.19x; without the current ratio the $205,000 plan is verified',async()=>{
 const m=await mockSolver(async b=>fx(b.min_current_ratio?'T3':'T3-nocr'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0}},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'no_cure');
  for(const k of ['C1','C3','C4','C6'])assert.ok(c.iis.some(x=>x.constraint===k),k);
  const w=c.waiver;assert.equal(w.verified,true);assert.equal(w.sell_asset,true);assert.equal(w.paydown_usd,'148514.85');
  assert.equal(w.max_leverage,'3.19');assert.equal(w.leverage_after,3.1851);   // 971,485.15 / 305,000 = 3.18519...
  assert.equal(w.covenants.current_ratio.value,1.25);assert.equal(w.covenants.current_ratio.status,'pass');
  assert.match(w.actions,/^Sell Division A; repay \$148,514\.85 of debt early \(prepayment premium \$1,485\.15\)$/);
  assert.equal(w.request,'Request a waiver to 3.19x maximum leverage for 2026-Q3');
  const off=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0},settings:{modes:{current_ratio:'off'}}},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  const p=off.body.options.find(o=>o.key==='cheapest').plan;
  assert.equal(p.paydown_usd,'205000.00');assert.equal(p.total_cost_usd,'217050.00');assert.equal(p.covenants.fccr.status,'pass');assert.equal(p.covenants.current_ratio,undefined);
 }finally{await m.close();}
});

test('a solver plan that fails FCCR pro forma (here: capex changed after solving) is reported and not shown',async()=>{
 // Same BOR-09 quarter with heavier capex: the T1 plan leaves FCCR at (373,333.34 - 150,000 - 15,000) / 233,000 = 0.8941x
 const rows=ctx.rows.map(r=>r.borrower_id==='BOR-09'&&r.period==='2026-Q3'?{...r,ttm_capex_usd:'150000.00'}:r);
 const m=await mockSolver(async()=>fx('T1'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:m.url,context:{...ctx,rows},...noSnap,...quiet});
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'rejected');assert.deepEqual(c.failing,['fccr']);assert.match(c.detail,/FCCR 0\.8941x below the 1\.10x minimum/);
  assert.ok(r.body.dropped.every(d=>d.failing.includes('fccr')));
 }finally{await m.close();}
});

test('cure uses the monitor\'s data and settings: same rows, same base statuses, FCCR-only breaches and untested leverage are not planned',async()=>{
 const {monitorCovenants}=await import('../lib/covenants.js');const {parseCSV}=await import('../lib/csv.js');
 const csv=await fs.readFile(new URL('../data/team/loan_covenants_extended.csv',import.meta.url),'utf8');
 assert.deepEqual(ctx.rows,parseCSV(csv));
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 try{
  const mon=await (await fetch(base+'/api/covenants')).json();
  for(const x of mon.results.filter(x=>x.period==='2026-Q3')){const r=await curePlan({borrower:x.borrower_id,period:x.period},{optUrl:undefined,context:ctx,...noSnap,...quiet});assert.equal(r.body.needed,x.status!=='pass',x.borrower_id);}
 }finally{s.close();}
 // An FCCR-only breach is planned through C7: BOR-02 2026-Q2 with FCCR on maintenance needs $6,000 (README v7 demo figure)
 const m2=await mockSolver(async b=>smart(b));
 try{const fo=await curePlan({borrower:'BOR-02',period:'2026-Q2',settings:{modes:{fccr:'maintenance'}}},{optUrl:m2.url,context:ctx,...noSnap,...quiet});
  assert.deepEqual(fo.body.breach.failing,['fccr']);assert.equal(m2.calls[0].body.min_fccr,'1.10');
  const p=fo.body.options[0].plan;assert.equal(p.equity_cure_usd,'6000.00');assert.equal(p.verified,true);assert.equal(p.covenants.fccr.value,1.1);assert.ok(p.binding.some(x=>x.constraint==='C7'));
 }finally{await m2.close();}
 const levOff=await curePlan({borrower:'BOR-09',period:'2026-Q3',settings:{modes:{leverage:'off'}}},{context:ctx,...noSnap,...quiet});
 assert.equal(levOff.body.available,false);assert.match(levOff.body.reason,/leverage and DSCR are both tested/);
 await assert.rejects(curePlan({borrower:'BOR-09',period:'2026-Q3',settings:{modes:{fccr:'sometimes'}}},{context:ctx}),/maintenance, springing or off/);
});

test('BOR-02 2026-Q3: C7 makes the cure $16,000 (a $12,000 DSCR cure would fail FCCR), verified',async()=>{
 const m=await mockSolver(async b=>smart(b));
 try{
  const r=await curePlan({borrower:'BOR-02',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(m.calls[0].body.min_fccr,'1.10');assert.deepEqual(r.body.breach.failing.sort(),['dscr','fccr']);
  const p=r.body.options[0].plan;assert.equal(p.actions,'Sponsor contributes $16,000.00');assert.equal(p.total_cost_usd,'16000.00');assert.equal(p.verified,true);
  assert.equal(p.covenants.fccr.value,1.1);assert.equal(p.covenants.fccr.status,'pass');assert.deepEqual(r.body.dropped,[]);
 }finally{await m.close();}
});

test('BOR-07 2026-Q3: current ratio fails before any cure, so no cure exists; verified waiver to 1.21x minimum current ratio',async()=>{
 const m=await mockSolver(async b=>smart(b));
 try{
  const r=await curePlan({borrower:'BOR-07',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.ok(r.body.breach.failing.includes('current_ratio'));
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'no_cure');assert.deepEqual(c.iis.map(x=>x.constraint),['C6']);
  const w=c.waiver;assert.equal(w.verified,true);assert.equal(w.current_ratio_waived,true);assert.equal(w.min_current_ratio,'1.21');
  assert.equal(w.leverage_waived,false);assert.equal(w.dscr_waived,false);assert.equal(w.fccr_waived,false);assert.equal(w.paydown_usd,'0.00');
  assert.equal(w.request,'Request a waiver to 1.21x minimum current ratio for 2026-Q3');assert.match(w.actions,/^Sponsor contributes \$/);
  assert.ok(Object.values(w.covenants).every(x=>x.status==='pass'));
 }finally{await m.close();}
});

test('solver down: GET serves the snapshot; no snapshot gives available:false; overrides need the live solver',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cure-'));const snapshotPath=path.join(dir,'snap.json');
 await fs.writeFile(snapshotPath,JSON.stringify({solved_at:'2026-11-07T20:00:00Z',gurobi_version:'13.0.3',params:{Threads:1,Seed:0,MIPGap:0},entries:{'BOR-09|2026-Q3':await fx('T1')}}));
 const down='http://127.0.0.1:9';// nothing listens on the discard port
 const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:down,context:ctx,snapshotPath,...quiet});
 assert.equal(r.body.source,'snapshot');assert.equal(r.body.solved_at,'2026-11-07T20:00:00Z');assert.equal(r.body.live_solver,false);
 assert.equal(r.body.options[0].plan.equity_cure_usd,'68333.34');assert.equal(r.body.options[0].plan.verified,true);
 const unset=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:undefined,context:ctx,snapshotPath,...quiet});assert.equal(unset.body.source,'snapshot');
 const none=await curePlan({borrower:'BOR-08',period:'2026-Q3'},{optUrl:undefined,context:ctx,snapshotPath,...quiet});
 assert.equal(none.body.available,false);assert.match(none.body.reason,/OPT_URL/);
 const ov=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0}},{optUrl:undefined,context:ctx,snapshotPath,...quiet});
 assert.equal(ov.code,503);assert.match(ov.body.reason,/live solver/);
 const bad=await mockSolver(async()=>undefined);
 try{const e=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:bad.url,context:ctx,snapshotPath,...quiet});assert.equal(e.body.source,'snapshot');assert.match(e.body.live_error,/HTTP 500/);}finally{await bad.close();}
});

test('solver timeout falls back after the timeout; passing rows say no cure needed; bad input is rejected',async()=>{
 const slow=await mockSolver(()=>new Promise(r=>setTimeout(()=>r({options:{}}),400)));
 try{const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:slow.url,context:ctx,timeoutMs:100,...noSnap,...quiet});assert.equal(r.body.available,false);assert.match(r.body.reason,/did not answer/);}finally{await slow.close();}
 const ok=await curePlan({borrower:'BOR-01',period:'2026-Q1'},{optUrl:undefined,context:ctx,...noSnap});assert.equal(ok.body.needed,false);
 await assert.rejects(curePlan({borrower:'x',period:'2026-Q3'},{context:ctx}),/borrower/);
 await assert.rejects(curePlan({borrower:'BOR-09',period:'Q3-2026'},{context:ctx}),/period/);
 assert.equal((await curePlan({borrower:'BOR-99',period:'2026-Q3'},{context:ctx})).code,404);
 const m=await mockSolver(async()=>fx('T1'));
 try{for(const o of [{cures_remaining_4q:-1},{cures_remaining_4q:1.5},{equity_cure_cap_usd:'1e5'},{asset_sale_allowed:'no'},{hack:1}])await assert.rejects(curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:o},{optUrl:m.url,context:ctx,...quiet}));}finally{await m.close();}
});

test('ceilCents rounds up to the cent but ignores float noise; usd formats',()=>{
 assert.equal(ceilCents(68333.33333333333),6833334n);assert.equal(ceilCents(12000.000000000002),1200000n);assert.equal(ceilCents(205000),20500000n);assert.equal(ceilCents(0.001),1n);
 assert.throws(()=>ceilCents(NaN));assert.equal(usd(6833334n),'$68,333.34');assert.equal(usd(-1200000n),'-$12,000.00');
});

test('GET and POST /api/cure through the server: same-origin check, validation, mocked OPT_URL',async()=>{
 const m=await mockSolver(async b=>b.borrower_id==='BOR-09'?fx('T1'):fx('T5'));const saved=process.env.OPT_URL;process.env.OPT_URL=m.url;
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 try{
  const g=await fetch(base+'/api/cure?borrower=BOR-09&period=2026-Q3');assert.equal(g.status,200);const j=await g.json();assert.equal(j.source,'live');assert.equal(j.options[0].plan.total_cost_usd,'78333.34');
  assert.equal((await fetch(base+'/api/cure?borrower=BOR-09&period=bad')).status,400);
  const p=await fetch(base+'/api/cure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({borrower:'BOR-09',period:'2026-Q3',overrides:{equity_cure_cap_usd:'50000.00'}})});
  assert.equal(p.status,200);assert.equal(m.calls.at(-1).body.cap,'50000.00');
  const xo=await fetch(base+'/api/cure',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});assert.equal(xo.status,403);
  assert.equal((await fetch(base+'/api/cure',{method:'POST',headers:{'content-type':'application/json'},body:'[1]'})).status,400);
 }finally{s.close();await m.close();if(saved===undefined)delete process.env.OPT_URL;else process.env.OPT_URL=saved;}
});
