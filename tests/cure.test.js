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
const ctx=await loadCureContext();
const noSnap={snapshotPath:path.join(os.tmpdir(),'does-not-exist-cure.json')};

test('T1 BOR-09 2026-Q3: live plan is rounded up to the cent and verified by the exact engine',async()=>{
 const m=await mockSolver(async()=>fx('T1'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(r.code,200);const b=r.body;assert.equal(b.needed,true);assert.equal(b.source,'live');assert.equal(b.available,true);
  assert.equal(m.calls[0].path,'/solve');assert.equal(m.calls[0].body.D,1270000);assert.equal(m.calls[0].body.has_asset,true);assert.equal(m.calls[0].body.k,0.18);
  const c=b.options.find(o=>o.key==='cheapest');assert.equal(c.status,'plan');
  assert.equal(c.plan.equity_cure_usd,'68333.34');assert.equal(c.plan.paydown_usd,'0.00');assert.equal(c.plan.sell_asset,true);
  assert.equal(c.plan.total_cost_usd,'78333.34');assert.equal(c.plan.verified,true);
  assert.equal(c.plan.actions,'Sell Division A; sponsor contributes $68,333.34');
  assert.equal(c.plan.pro_forma.debt_usd,'1120000.00');assert.equal(c.plan.pro_forma.ttm_ebitda_usd,'373333.34');assert.equal(c.plan.pro_forma.ttm_debt_service_usd,'233000.00');
  assert.equal(c.plan.leverage,2.9999);
  assert.ok(c.plan.binding.some(x=>x.constraint==='C1'));
  for(const k of ['C1','C2','C3','C4','C5'])for(const ci of b.clauses[k].citations){const text=await fs.readFile(new URL('../data/'+ci.source_document,import.meta.url),'utf8');assert.ok(verifyCitation(text,ci),k);}
  assert.equal(b.options.find(o=>o.key==='no_asset_sale').plan.equity_cure_usd,'98333.34');
  assert.equal(b.terms.synthetic,true);assert.deepEqual(b.dropped,[]);assert.ok(b.assumptions.length>=5);
 }finally{await m.close();}
});

test('a plan one cent short is rejected by the exact re-check and never shown',async()=>{
 const res=await fx('T1');res.options.cheapest.plan.E=68333.32;
 const logs=[];const m=await mockSolver(async()=>res);
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3'},{optUrl:m.url,context:ctx,...noSnap,log:x=>logs.push(x)});
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'rejected');assert.equal(c.plan,undefined);
  assert.equal(r.body.dropped.length,1);assert.match(r.body.dropped[0].reason,/leverage breach/);assert.match(logs[0],/dropped BOR-09 2026-Q3 cheapest/);
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
  assert.equal(m.calls[0].body.has_asset,false);
 }finally{await m.close();}
});

test('infeasible (T4 terms) returns IIS with plain-English blocking clauses and a verified 3.14x waiver',async()=>{
 const m=await mockSolver(async()=>fx('T4'));
 try{
  const r=await curePlan({borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0,asset_sale_allowed:false}},{optUrl:m.url,context:ctx,...noSnap,...quiet});
  assert.equal(r.code,200);assert.equal(m.calls[0].body.cures_remaining,0);assert.equal(m.calls[0].body.has_asset,false);assert.equal(m.calls[0].body.case,'whatif');
  assert.deepEqual(r.body.terms.overridden,['cures_remaining_4q','asset_sale_allowed']);
  const c=r.body.options.find(o=>o.key==='cheapest');assert.equal(c.status,'no_cure');
  assert.deepEqual(c.iis.map(x=>x.constraint),['C1','C3','C4','C5']);
  assert.match(c.iis.find(x=>x.constraint==='C4').plain,/0 cures remaining/);assert.match(c.iis.find(x=>x.constraint==='C5').plain,/\$250,000\.00/);
  assert.ok(c.iis.every(x=>x.citations.length>=1));
  assert.equal(c.waiver.paydown_usd,'250000.00');assert.equal(c.waiver.max_leverage,'3.14');assert.equal(c.waiver.min_dscr,'1.20');
  assert.equal(c.waiver.leverage_waived,true);assert.equal(c.waiver.dscr_waived,false);assert.equal(c.waiver.dscr_after,1.3953);
  assert.equal(c.waiver.request,'Request a waiver to 3.14x maximum leverage for 2026-Q3');assert.equal(c.waiver.verified,true);
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
  assert.equal(p.status,200);assert.equal(m.calls.at(-1).body.cap,50000);
  const xo=await fetch(base+'/api/cure',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});assert.equal(xo.status,403);
  assert.equal((await fetch(base+'/api/cure',{method:'POST',headers:{'content-type':'application/json'},body:'[1]'})).status,400);
 }finally{s.close();await m.close();if(saved===undefined)delete process.env.OPT_URL;else process.env.OPT_URL=saved;}
});
