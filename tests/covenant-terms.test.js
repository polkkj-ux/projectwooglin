// FCCR, current ratio, springing covenants and the Covenant Designer.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {minor} from '../lib/finance.js';import {verifyCitation} from '../lib/citations.js';
import {evaluateRow,monitorCovenants,normalizeSettings} from '../lib/covenants.js';
import {recommendCovenants,readStatements} from '../lib/recommend.js';
import {createServer} from '../server.js';
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
const row={record_id:'T-1',borrower_id:'B',period:'2026-Q1',currency:'USD',debt_usd:'900.00',ttm_ebitda_usd:'400.00',ttm_debt_service_usd:'100.00',ttm_available_cashflow_usd:'150.00',max_leverage:'3.00',min_dscr:'1.20',
 ttm_capex_usd:'50.00',ttm_cash_taxes_usd:'20.00',ttm_distributions_usd:'10.00',current_assets_usd:'300.00',current_liabilities_usd:'200.00',revolver_commitment_usd:'1000.00',revolver_drawn_usd:'300.00',min_fccr:'1.10',min_current_ratio:'1.25'};
const maint={modes:{fccr:'maintenance'}};
const loadExtended=async settings=>monitorCovenants(parseCSV(await rd('team/loan_covenants_extended.csv')),await rd('documents/loan-policy.txt'),{supplements:[{name:'team/covenant-policy-addendum.txt',text:await rd('team/covenant-policy-addendum.txt')}],settings});

// Acceptance check 1 (valid input): exact FCCR and current ratio math with headroom.
test('FCCR and current ratio are exact, and a ratio exactly at the minimum passes',()=>{
 const r=evaluateRow(row,maint);
 assert.equal(r.fccr.value,3.2);assert.equal(r.fccr.status,'pass');          // (400-50-20-10)/100
 assert.equal(r.fccr.numerator_usd,'320.00');assert.equal(r.fccr.numerator_limit_usd,'110.00');assert.equal(r.fccr.numerator_headroom_usd,'210.00');
 assert.equal(r.fccr.denominator_limit_usd,'290.90');                          // largest fixed charges that pass, rounded down
 assert.equal(r.current_ratio.value,1.5);assert.equal(r.current_ratio.numerator_headroom_usd,'50.00'); // 300 - 1.25*200
 assert.equal(evaluateRow({...row,current_assets_usd:'250.00'},maint).current_ratio.status,'pass','exactly 1.25x passes');
 const b=evaluateRow({...row,current_assets_usd:'249.99'},maint);assert.equal(b.current_ratio.status,'breach');assert.equal(b.status,'exception');
 assert.equal(evaluateRow({...row,ttm_capex_usd:'260.01'},maint).fccr.status,'breach'); // 109.99 < 110
 // Generic fields reconcile with the original leverage/DSCR fields.
 assert.equal(r.leverage.numerator_headroom_usd,r.leverage.debt_headroom_usd);assert.equal(r.dscr.numerator_headroom_usd,r.dscr.cashflow_headroom_usd);
});

// Acceptance check 2 (missing/invalid input): the covenant is not tested and never silently passes.
test('missing FCCR inputs make that covenant unevaluable; rows without the columns are unaffected',()=>{
 const m=evaluateRow({...row,ttm_capex_usd:''},maint);
 assert.equal(m.fccr.status,'unevaluable');assert.match(m.fccr.reason,/Missing field: ttm_capex_usd/);assert.equal(m.status,'exception');
 assert.equal(evaluateRow({...row,current_liabilities_usd:'0.00'}).current_ratio.status,'unevaluable');
 assert.equal(evaluateRow({...row,min_fccr:'abc'},maint).fccr.status,'unevaluable');
 const plain=evaluateRow({...row,min_fccr:'',min_current_ratio:''});assert.equal(plain.fccr,undefined);assert.deepEqual(Object.keys(plain.covenants),['leverage','dscr']);
});

test('springing covenants are tested only at or above the utilization trigger',()=>{
 const low=evaluateRow({...row,ttm_capex_usd:'300.00'});                     // FCCR would fail; 30% drawn, default springing at 35%
 assert.equal(low.fccr.status,'dormant');assert.equal(low.fccr.would_status,'breach');assert.equal(low.fccr.springing.utilization,0.3);assert.equal(low.status,'pass');
 const at=evaluateRow({...row,ttm_capex_usd:'300.00',revolver_drawn_usd:'350.00'});assert.equal(at.fccr.status,'breach','exactly 35% springs');
 const unk=evaluateRow({...row,ttm_capex_usd:'300.00',revolver_drawn_usd:''});assert.equal(unk.fccr.status,'breach');assert.equal(unk.fccr.springing.triggered,null);assert.match(unk.fccr.springing.note,/tested anyway/);
 const lev=evaluateRow({...row,debt_usd:'1300.00'},{modes:{leverage:'springing'}});assert.equal(lev.leverage.status,'dormant');assert.equal(lev.status,'pass');
 const off=evaluateRow({...row,current_assets_usd:'1.00'},{modes:{current_ratio:'off'}});assert.equal(off.covenants.current_ratio,undefined);assert.deepEqual(off.not_applied,['current_ratio']);assert.equal(off.status,'pass');
 const all=evaluateRow(row,{modes:{leverage:'off',dscr:'off',fccr:'off',current_ratio:'off'}});assert.equal(all.status,'untested');
 const per=evaluateRow({...row,ttm_capex_usd:'300.00'},{borrowers:{B:{modes:{fccr:'maintenance'}}}});assert.equal(per.fccr.status,'breach','per-borrower override wins');
 assert.equal(evaluateRow({...row,ttm_capex_usd:'300.00'},{trigger_pct:'25'}).fccr.status,'breach');
});
test('lender settings are validated',()=>{
 assert.throws(()=>normalizeSettings({trigger_pct:'101'}),/between 0% and 100%/);
 assert.throws(()=>normalizeSettings({trigger_pct:'abc'}),/percentage/);
 assert.throws(()=>normalizeSettings({modes:{fccr:'sometimes'}}),/maintenance, springing or off/);
 assert.throws(()=>normalizeSettings({modes:{ebitda:'off'}}),/Unknown covenant/);
 assert.equal(normalizeSettings({}).trigger_pct,'35.00');
});

// Acceptance check 3 (reconciliation): the extended fixture keeps the organizer's figures, cites the addendum,
// and the springing toggle changes only which tests count.
test('extended fixture reconciles with the organizer data and cites every definition',async()=>{
 const base=monitorCovenants(parseCSV(await rd('loan_covenants.csv')),await rd('documents/loan-policy.txt'));
 const out=await loadExtended();
 assert.deepEqual(out.policy.warnings,[]);assert.deepEqual(out.covenant_keys,['leverage','dscr','fccr','current_ratio']);
 assert.equal(out.summary.pass,6);assert.equal(out.summary.exceptions,30);assert.equal(out.summary.current_ratio_breaches,2);
 for(const [i,r] of out.results.entries()){const o=base.results[i];
  for(const f of ['value','status','debt_headroom_usd','max_debt_usd'])assert.equal(r.leverage[f],o.leverage[f]);
  for(const f of ['value','status','cashflow_headroom_usd','cashflow_required_usd'])assert.equal(r.dscr[f],o.dscr[f]);}
 const add=await rd('team/covenant-policy-addendum.txt');
 for(const k of ['fccr','current_ratio','springing']){const d=out.policy.definitions[k];assert.equal(d.source_document,'team/covenant-policy-addendum.txt');assert.ok(verifyCitation(add,d));}
 const q=(o,b,p)=>o.results.find(r=>r.borrower_id===b&&r.period===p);
 assert.equal(q(out,'BOR-02','2026-Q2').fccr.status,'dormant');assert.equal(q(out,'BOR-02','2026-Q2').fccr.would_status,'breach');
 assert.equal(q(out,'BOR-02','2026-Q2').status,'pass');
 const m=await loadExtended(maint);
 assert.equal(q(m,'BOR-02','2026-Q2').status,'exception','turning springing off reveals the dormant breach');
 assert.equal(m.summary.dormant,0);assert.ok(m.summary.fccr_breaches>out.summary.fccr_breaches);
 const fc=q(m,'BOR-06','2026-Q3').fccr;const src=parseCSV(await rd('team/loan_covenants_extended.csv')).find(r=>r.record_id==='COV-06-3');
 assert.equal(minor(fc.numerator_usd,{signed:true}),minor(src.ttm_ebitda_usd)-minor(src.ttm_capex_usd)-minor(src.ttm_cash_taxes_usd)-minor(src.ttm_distributions_usd));
 const t40=await loadExtended({trigger_pct:'40'});assert.ok(t40.policy.warnings.some(w=>/40% revolver utilization/.test(w)),'trigger not in the cited provision is flagged');
});

test('Covenant Designer recommends a package from the sample statements',async()=>{
 const r=recommendCovenants(await rd('team/sample-statements.csv'));
 const by=Object.fromEntries(r.recommendations.map(x=>[x.key,x]));
 assert.equal(r.metrics.leverage.value,2.8571);assert.equal(r.metrics.fccr.value,1.5192);
 assert.equal(by.leverage.threshold,'4.00');assert.equal(by.leverage.decision,'recommended');   // 2.0M/(700K*0.75)=3.81 -> 4.00
 assert.equal(by.fccr.threshold,'1.10');assert.equal(by.fccr.mode,'springing');assert.equal(by.fccr.currently_triggered,false);
 assert.equal(by.dscr.decision,'optional');assert.equal(by.dscr.threshold,'1.70');
 assert.equal(by.current_ratio.threshold,'1.20');assert.equal(by.current_ratio.decision,'recommended');
 // Each recommended level passes today with at least the requested cushion (exact check).
 assert.ok(r.recommendations.filter(x=>x.threshold).every(x=>x.implied_cushion_pct>=25));
 assert.equal(recommendCovenants(await rd('team/sample-statements.csv'),{cushion_pct:10}).recommendations.find(x=>x.key==='leverage').threshold,'3.25');
});
test('Covenant Designer refuses to guess on missing, duplicate or malformed statements',()=>{
 const H='line_item,amount_usd\n';
 assert.throws(()=>recommendCovenants('a,b\n1,2\n'),/line_item and amount_usd/);
 assert.throws(()=>recommendCovenants(H+'EBITDA,100\nAdjusted EBITDA,120\n'),/EBITDA appears twice/);
 assert.throws(()=>recommendCovenants(H+'EBITDA,1.234\n'),/at most two decimals/);
 assert.throws(()=>recommendCovenants(H+'EBITDA,100\n',{cushion_pct:90}),/Cushion/);
 const thin=recommendCovenants(H+'EBITDA,500000\nTotal debt,1000000\n');
 assert.equal(thin.recommendations.find(x=>x.key==='leverage').threshold,'2.75');
 assert.equal(thin.recommendations.find(x=>x.key==='fccr').decision,'insufficient_data');
 const weak=recommendCovenants(H+'EBITDA,100000\nInterest expense,80000\nScheduled principal,20000\nIncome taxes paid,0\n');
 assert.equal(weak.recommendations.find(x=>x.key==='dscr').decision,'fails_at_signing','1.00x today is below the 1.10x floor');
 const neg=recommendCovenants(H+'EBITDA,(50000)\nTotal debt,100000\n');assert.equal(neg.recommendations.find(x=>x.key==='leverage').decision,'not_recommended');
 assert.equal(readStatements(H+'Capital expenditures,(1000)\n').facts.capex.cents,100000n);
});

test('API: lender terms on /api/covenants and the recommender routes',async()=>{
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 try{
  const g=await (await fetch(base+'/api/covenants')).json();assert.equal(g.settings.modes.fccr,'springing');assert.deepEqual(g.policy.warnings,[]);
  const m=await (await post('/api/covenants',{settings:maint})).json();assert.equal(m.settings.modes.fccr,'maintenance');assert.equal(m.summary.dormant,0);
  assert.equal((await post('/api/covenants',{settings:{trigger_pct:'500'}})).status,400);
  const sample=await (await fetch(base+'/api/recommend/sample')).json();assert.match(sample.csv,/line_item,amount_usd/);
  const r=await post('/api/recommend',{csv:sample.csv,cushion_pct:25});assert.equal(r.status,200);assert.equal((await r.json()).recommendations.length,4);
  assert.equal((await post('/api/recommend',{csv:'nope'})).status,400);
 }finally{s.close();}
});
