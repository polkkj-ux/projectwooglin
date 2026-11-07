import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {minor} from '../lib/finance.js';import {covenantCheck} from '../lib/finance.js';
import {verifyCitation} from '../lib/citations.js';import {evaluateRow,monitorCovenants,policyEvidence,covenantColumnsError} from '../lib/covenants.js';import {readFileSync} from 'node:fs';import {extractParseText,startParse,getParse} from '../lib/documents.js';
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
const good={record_id:'T-1',borrower_id:'B',period:'2026-Q1',currency:'USD',debt_usd:'900.00',ttm_ebitda_usd:'400.00',ttm_debt_service_usd:'100.00',ttm_available_cashflow_usd:'150.00',max_leverage:'3.00',min_dscr:'1.20',source_document:'documents/loan-policy.txt'};

// Acceptance check 1: valid input
test('valid borrower-quarter passes with exact headroom',()=>{
 const r=evaluateRow(good);
 assert.equal(r.status,'pass');assert.equal(r.leverage.value,2.25);assert.equal(r.dscr.value,1.5);
 assert.equal(r.leverage.debt_headroom_usd,'300.00');   // 3.00*400 - 900
 assert.equal(r.leverage.ebitda_headroom_usd,'100.00'); // 400 - 900/3
 assert.equal(r.dscr.cashflow_headroom_usd,'30.00');    // 150 - 1.20*100
 assert.equal(evaluateRow({...good,debt_usd:'1200.00'}).status,'pass','exactly at 3.00x passes');
 const b=evaluateRow({...good,debt_usd:'1200.01'});assert.equal(b.status,'exception');assert.equal(b.leverage.status,'breach');assert.equal(b.leverage.debt_headroom_usd,'-0.01');
});

// Acceptance check 2: missing / invalid input becomes an explicit result, never a silent pass or crash
test('missing, invalid and undefined inputs are flagged not passed',()=>{
 assert.match(evaluateRow({...good,ttm_ebitda_usd:''}).error,/Missing field: ttm_ebitda_usd/);
 assert.equal(evaluateRow({...good,ttm_ebitda_usd:''}).status,'invalid');
 assert.match(evaluateRow({...good,currency:'EUR'}).error,/USD/);
 assert.match(evaluateRow({...good,period:'Q3 2026'}).error,/Period/);
 assert.equal(evaluateRow({...good,debt_usd:'12abc'}).status,'invalid');
 const z=evaluateRow({...good,ttm_ebitda_usd:'0.00'});assert.equal(z.status,'exception');assert.equal(z.leverage.status,'unevaluable');assert.equal(z.leverage.value,null);
 const n=evaluateRow({...good,ttm_ebitda_usd:'-5.00'});assert.equal(n.leverage.status,'unevaluable');
 const s=evaluateRow({...good,ttm_debt_service_usd:'0.00'});assert.equal(s.dscr.status,'unevaluable');
});

// Acceptance check 3: reconciliation with the dataset, the shared covenantCheck and the policy document
test('dataset results reconcile to source rows, covenantCheck and cited policy text',async()=>{
 const rows=parseCSV(await rd('loan_covenants.csv'));const policy=await rd('documents/loan-policy.txt');
 const out=monitorCovenants(rows,policy);
 assert.equal(out.results.length,36);
 assert.deepEqual(out.summary,{rows:36,pass:6,exceptions:30,invalid:0,leverage_breaches:27,dscr_breaches:18,fccr_breaches:0,current_ratio_breaches:0,unevaluable:0,dormant:0,untested:0});
 for(const [i,res] of out.results.entries()){
  const src=rows[i],ref=covenantCheck(src);
  assert.equal(res.record_id,src.record_id);assert.equal(res.period,src.period);
  assert.equal(res.leverage.status==='breach',ref.leverageBreach);assert.equal(res.dscr.status==='breach',ref.dscrBreach);
  // headroom reconciliation: capacity - debt, and needed cash + headroom = actual cash (within 1 cent rounding)
  const maxDebt=minor(src.max_leverage)*minor(src.ttm_ebitda_usd)/100n;
  assert.equal(minor(res.leverage.debt_headroom_usd,{signed:true}),maxDebt-minor(src.debt_usd));
  const need=(minor(src.min_dscr)*minor(src.ttm_debt_service_usd)+99n)/100n;
  assert.equal(minor(res.dscr.cashflow_headroom_usd,{signed:true}),minor(src.ttm_available_cashflow_usd)-need);
  assert.equal(res.source_document,src.source_document);
  for(const e of res.evidence)assert.ok(verifyCitation(policy,e.definition));
 }
 assert.ok(out.results.filter(r=>r.status==='exception').every(r=>r.evidence.length>0));
 const b1=out.borrowers.find(b=>b.borrower_id==='BOR-01');assert.equal(b1.first_exception_period,'2026-Q3');
 const ev=policyEvidence(policy);assert.ok(ev.definitions.leverage.quote.startsWith('Leverage is gross debt'));assert.ok(ev.definitions.leverage.quote.includes('maximum 3.00'));assert.deepEqual(ev.warnings,[]);
 assert.deepEqual(out.policy.warnings,[]);
});

// Uploaded / parsed agreements: different wording, missing definitions and conflicting thresholds
const parsed='# Credit Agreement\n\n## 6.1 Financial Covenants\n\n"Total Leverage Ratio" means, as of any date, the ratio of Funded Debt to trailing twelve-month EBITDA, which shall not exceed 3.50. The Debt Service Coverage Ratio is defined as cash flow available divided by debt service and shall be at least 1.25 at each quarter end.\n';
test('definitions are found in differently worded agreement text and cited exactly',()=>{
 const {definitions:d,warnings}=policyEvidence(parsed,'agreement.pdf');
 assert.ok(d.leverage&&d.dscr);assert.deepEqual(warnings,[]);
 for(const c of [d.leverage,d.dscr]){assert.ok(verifyCitation(parsed,c));assert.equal(c.source_document,'agreement.pdf');}
 assert.ok(d.leverage.quote.includes('shall not exceed 3.50'));assert.ok(!d.leverage.quote.includes('Debt Service Coverage'));
 assert.ok(d.dscr.quote.startsWith('The Debt Service Coverage Ratio'));
});
test('missing definition is reported, never invented; conflicting thresholds are flagged',async()=>{
 const rows=parseCSV(await rd('loan_covenants.csv'));
 const none=monitorCovenants(rows,'This agreement says nothing useful.');
 assert.equal(none.policy.definitions.leverage,null);assert.equal(none.policy.warnings.length,2);
 const ex=none.results.find(r=>r.status==='exception');assert.ok(ex.evidence.every(e=>e.definition===null&&e.note));
 assert.equal(none.summary.exceptions,30,'calculations do not depend on the policy text');
 const mis=monitorCovenants(rows,parsed,{sourceDocument:'agreement.pdf'});
 assert.ok(mis.policy.warnings.some(w=>/3\.00.*leverage/.test(w)));assert.ok(mis.policy.warnings.some(w=>/1\.20.*dscr/.test(w)));
});
test('parser output extraction handles known shapes and refuses to guess',()=>{
 assert.equal(extractParseText({markdown:{pages:[{markdown:'A'},{markdown:'B'}]}}),'A\n\nB');
 assert.equal(extractParseText({markdown_full:'Full'}),'Full');
 assert.equal(extractParseText({markdown:'Plain'}),'Plain');
 assert.equal(extractParseText({job:{status:'COMPLETED'}}),null);assert.equal(extractParseText(null),null);
});
test('LlamaParse wrappers use the key as a bearer header (mocked, not live)',async()=>{
 const calls=[];const fetcher=async(url,o)=>{calls.push({url,o});return new Response(JSON.stringify({job:{id:'abc-1',status:'PENDING'}}),{status:200,headers:{'content-type':'application/json'}});};
 await assert.rejects(()=>startParse(Buffer.from('%PDF-1.4 x'),'a.pdf',{key:'',fetcher}),/LLAMA_CLOUD_API_KEY required/);
 await startParse(Buffer.from('%PDF-1.4 x'),'a.pdf',{key:'k',fetcher});await getParse('abc-1',{key:'k',fetcher});
 assert.equal(calls[0].o.headers.Authorization,'Bearer k');assert.match(calls[1].url,/parse\/abc-1\?expand=markdown$/);
 assert.throws(()=>getParse('../x',{key:'k',fetcher}),/Valid job ID/);
});

test('each cited definition is exactly one sentence, even when it starts right after another sentence',async()=>{
 const policy=await rd('documents/loan-policy.txt');const {definitions:d}=policyEvidence(policy);
 assert.equal(d.leverage.quote,'Leverage is gross debt divided by trailing twelve-month EBITDA, maximum 3.00.');
 assert.equal(d.dscr.quote,'DSCR is trailing twelve-month available cash flow divided by trailing twelve-month debt service, minimum 1.20.');
 assert.ok(!d.dscr.quote.includes('Leverage'));assert.ok(verifyCitation(policy,d.dscr));
});

// The engine, not the UI, supplies every dollar figure shown in the borrower analysis view.
test('engine exposes required and limit amounts that reconcile with headroom',async()=>{
 const rows=parseCSV(await rd('loan_covenants.csv'));const out=monitorCovenants(rows,await rd('documents/loan-policy.txt'));
 for(const [i,res] of out.results.entries()){const src=rows[i];
  const cash=minor(src.ttm_available_cashflow_usd,{signed:true}),svc=minor(src.ttm_debt_service_usd),ebitda=minor(src.ttm_ebitda_usd,{signed:true}),debt=minor(src.debt_usd);
  assert.equal(minor(res.dscr.cashflow_required_usd)-0n,(minor(src.min_dscr)*svc+99n)/100n);
  assert.equal(cash-minor(res.dscr.cashflow_required_usd),minor(res.dscr.cashflow_headroom_usd,{signed:true}));
  assert.equal(ebitda-minor(res.leverage.ebitda_required_usd),minor(res.leverage.ebitda_headroom_usd,{signed:true}));
  assert.equal(minor(res.leverage.max_debt_usd)-debt,minor(res.leverage.debt_headroom_usd,{signed:true}));
  // the stated alternative really passes and one cent worse really fails
  const ms=minor(res.dscr.debt_service_max_usd);assert.ok(cash*100n>=minor(src.min_dscr)*ms);assert.ok(cash*100n<minor(src.min_dscr)*(ms+1n));
 }
});
test('BOR-01 Q2 to Q3 2026: figures shown in the demo come from the engine',async()=>{
 const out=monitorCovenants(parseCSV(await rd('loan_covenants.csv')),await rd('documents/loan-policy.txt'));
 const q=p=>out.results.find(r=>r.borrower_id==='BOR-01'&&r.period===p);const q2=q('2026-Q2'),q3=q('2026-Q3');
 assert.equal(q2.leverage.value,2.7466);assert.equal(q2.leverage.value.toFixed(2),'2.75');assert.equal(q3.dscr.value.toFixed(2),'1.15');assert.equal(q3.leverage.value,2.8219);assert.equal(q3.leverage.status,'pass');
 assert.equal(q2.dscr.value,1.2307);assert.equal(q3.dscr.value,1.1538);assert.equal(q2.dscr.status,'pass');assert.equal(q3.dscr.status,'breach');
 assert.equal(q3.inputs.ttm_available_cashflow_usd,'300000.00');assert.equal(q3.dscr.cashflow_required_usd,'312000.00');assert.equal(q3.dscr.cashflow_headroom_usd,'-12000.00');
 assert.equal(q3.dscr.debt_service_max_usd,'250000.00');assert.equal(q3.leverage.max_debt_usd,'1095000.00');assert.equal(q3.leverage.debt_headroom_usd,'65000.00');
 assert.equal(out.borrowers.find(b=>b.borrower_id==='BOR-01').first_exception_period,'2026-Q3');
});

test('duplicate borrower-quarter rows are both marked invalid, never silently collapsed',()=>{
 const H='record_id,borrower_id,period,currency,debt_usd,ttm_ebitda_usd,ttm_debt_service_usd,ttm_available_cashflow_usd,max_leverage,min_dscr\n';
 const csv=H+'D-1,BOR-E,2026-Q3,USD,1000000.00,400000.00,100000.00,150000.00,3.00,1.20\nD-2,BOR-E,2026-Q3,USD,900000.00,400000.00,100000.00,150000.00,3.00,1.20\nD-3,BOR-F,2026-Q3,USD,900000.00,400000.00,100000.00,150000.00,3.00,1.20\n';
 const out=monitorCovenants(parseCSV(csv),'Leverage is debt divided by EBITDA, maximum 3.00. DSCR is cash flow divided by debt service, minimum 1.20.');
 assert.equal(out.summary.invalid,2);assert.equal(out.summary.pass,1);
 for(const r of out.results.filter(r=>r.borrower_id==='BOR-E')){assert.equal(r.status,'invalid');assert.match(r.error,/Duplicate report: 2 rows for BOR-E 2026-Q3 \(D-1, D-2\)/);}
});
test('covenantColumnsError rejects empty and non-covenant files, accepts the sample header',()=>{
 assert.match(covenantColumnsError(''),/empty/);
 assert.match(covenantColumnsError('hello world\nnot a csv\n'),/Missing required columns: record_id, borrower_id/);
 assert.match(covenantColumnsError('record_id,borrower_id,period\nA,B,2026-Q1\n'),/currency/);
 assert.equal(covenantColumnsError(readFileSync(new URL('../data/loan_covenants.csv',import.meta.url),'utf8')),null);
});
