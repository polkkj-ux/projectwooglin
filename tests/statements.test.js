// Statements extraction: LlamaExtract client (mocked HTTP only), normalization, calculations and tie-outs.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {verifyCitation} from '../lib/citations.js';
import {ITEMS,readStatements,recommendCovenants} from '../lib/recommend.js';import {evaluateRow} from '../lib/covenants.js';
import {EXTRACT_CONFIG,ITEM_KEYS,TIEOUT_KEYS,uploadFile,createExtractJob,getExtractJob,startExtract,pollExtract,normalizeExtraction,reviewItems,computeStatement,definitionCitations,loadDefinitions,parseStatementName,trailingPeriods,normalizePeriod,CSV_COLUMNS} from '../lib/statements.js';
import {mockJob,allConfirmable,fixtures,printed} from './statement-mocks.js';
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
const csvRows=parseCSV(await rd('team/loan_covenants_extended.csv'));
const ctx={csvRows,definitionsText:await loadDefinitions(),policyText:await rd('documents/loan-policy.txt'),addendumText:await rd('team/covenant-policy-addendum.txt')};
const run=(id,job,opts={})=>{const norm=normalizeExtraction(job);const items=reviewItems(norm);
 return computeStatement(norm,{borrower_id:id,period:'2026-Q3',source_document:`${id}_2026-Q3.pdf`,confirmed:opts.confirmed??allConfirmable(items),...ctx});};
const without=(o,...ks)=>{const c=structuredClone(o);for(const k of ks)delete c[k];return c;};
// Compare only the financial and covenant columns: other branches add reporting columns (received dates,
// statement quality) to loan_covenants_extended.csv, which statements extraction does not produce.
const FIN_COLS=CSV_COLUMNS.filter(k=>!['record_id','source_document','synthetic'].includes(k));
const pick=(o,ks)=>Object.fromEntries(ks.map(k=>[k,o[k]??'']));

test('schema fields are exactly the Covenant Designer ITEMS keys per quarter, plus tie-out-only fields',async()=>{
 const s=JSON.parse(await rd('statements/schema.json'));
 const props=Object.keys(s.properties.quarters.items.properties);
 assert.deepEqual(props,['period',...Object.keys(ITEMS),...TIEOUT_KEYS]);
 assert.deepEqual(ITEM_KEYS,Object.keys(ITEMS));
 for(const k of props.slice(1))assert.equal(s.properties.quarters.items.properties[k].type,'string',k);
});

test('LlamaExtract client: upload, create job with pinned config and schema, get with expand=extract_metadata',async()=>{
 const calls=[];const fetcher=async(url,init)=>{calls.push({url:String(url),init});const u=new URL(url);
  return {ok:true,json:async()=>u.pathname.endsWith('/files')?{id:'dfl-1'}:u.pathname==='/api/v2/extract'?{id:'ext-1',status:'PENDING'}:{id:'ext-1',status:'COMPLETED'}};};
 const pdf=Buffer.from('%PDF-1.4 test');
 const r=await startExtract(pdf,'BOR-09_2026-Q3.pdf',{key:'k-test',fetcher,project:'proj-1',schema:{type:'object'}});
 assert.deepEqual(r,{job_id:'ext-1',file_id:'dfl-1',status:'PENDING'});
 assert.equal(calls[0].url,'https://api.cloud.llamaindex.ai/api/v1/beta/files?project_id=proj-1');assert.equal(calls[0].init.method,'POST');
 assert.equal(calls[0].init.body.get('purpose'),'extract');assert.equal(calls[0].init.body.get('file').name,'BOR-09_2026-Q3.pdf');
 assert.equal(calls[0].init.headers.Authorization,'Bearer k-test');
 assert.equal(calls[1].url,'https://api.cloud.llamaindex.ai/api/v2/extract?project_id=proj-1');
 const body=JSON.parse(calls[1].init.body);assert.equal(body.file_input,'dfl-1');
 assert.deepEqual(body.configuration,{...EXTRACT_CONFIG,data_schema:{type:'object'}});
 assert.equal(body.configuration.cite_sources,true);assert.equal(body.configuration.confidence_scores,true);assert.equal(body.configuration.version,'2.5');
 await getExtractJob('ext-1',{key:'k-test',fetcher});
 assert.equal(calls.at(-1).url,'https://api.cloud.llamaindex.ai/api/v2/extract/ext-1?expand=extract_metadata');
 await assert.rejects(startExtract(Buffer.from('hello'),'x.txt',{key:'k',fetcher}),/PDF/);
 await assert.rejects(startExtract(pdf,'x.pdf',{key:'',fetcher}),/LLAMA_CLOUD_API_KEY/);
 assert.throws(()=>getExtractJob('../x',{key:'k',fetcher}),/Invalid job id/);
 await assert.rejects(uploadFile(pdf,'x.pdf',{key:'k',fetcher:async()=>({ok:false,status:422,text:async()=>'{"detail":"bad schema"}'})}),/HTTP 422.*bad schema/);
});

test('pollExtract waits through PENDING/RUNNING and surfaces FAILED with the provider message',async()=>{
 const seq=['PENDING','RUNNING','COMPLETED'];let i=0,slept=0;
 const job=await pollExtract('ext-1',{key:'k',sleep:async()=>{slept++;},fetcher:async()=>({ok:true,json:async()=>({id:'ext-1',status:seq[i++]})})});
 assert.equal(job.status,'COMPLETED');assert.equal(slept,2);
 await assert.rejects(pollExtract('ext-2',{key:'k',sleep:async()=>{},fetcher:async()=>({ok:true,json:async()=>({status:'FAILED',error_message:'parse error'})})}),/FAILED: parse error/);
});

test('normalize: per-quarter items keep value (cents), page, matching_text and confidence; outflows use their size',()=>{
 const n=normalizeExtraction(mockJob('BOR-09'));
 assert.deepEqual(Object.keys(n.quarters),['2025-Q4','2026-Q1','2026-Q2','2026-Q3']);
 const capex=n.quarters['2026-Q3'].items.capex;
 assert.equal(capex.raw,'(8,500.00)');assert.equal(capex.value,'8500.00');assert.equal(capex.page,3);assert.match(capex.matching_text,/Capital expenditures/);
 assert.equal(typeof capex.confidence,'number');
 assert.equal(n.quarters['2025-Q4'].items.change_in_working_capital.value,'10000.00');
 assert.equal(n.quarters['2026-Q3'].items.revolver_drawn,undefined); // BOR-09 prints no revolver
 assert.equal(normalizePeriod('Q3 2026'),'2026-Q3');assert.equal(normalizePeriod('Sep 30, 2026'),null);
 assert.deepEqual(trailingPeriods('2026-Q1'),['2025-Q2','2025-Q3','2025-Q4','2026-Q1']);
 assert.deepEqual(parseStatementName('BOR-09_2026-Q3.pdf'),{borrower_id:'BOR-09',period:'2026-Q3'});
});

for(const id of ['BOR-09','BOR-01'])test(`clean ${id} extraction yields exactly the CSV row and the engine's result for it`,()=>{
 const r=run(id,mockJob(id));
 assert.equal(r.blocked,false,r.blockers.join(' | '));
 const csvRow=csvRows.find(x=>x.borrower_id===id&&x.period==='2026-Q3');
 assert.deepEqual(Object.keys(r.row),CSV_COLUMNS);
 assert.deepEqual(pick(r.row,FIN_COLS),pick(csvRow,FIN_COLS));
 assert.equal(r.row.source_document,`${id}_2026-Q3.pdf`);assert.equal(r.row.record_id,csvRow.record_id);
 assert.deepEqual(without(r.engine,'source_document'),without(evaluateRow(pick(csvRow,CSV_COLUMNS)),'source_document'));
 assert.deepEqual(r.csv_match.flags,[]);
 assert.ok(r.tieouts.filter(t=>t.blocking).every(t=>t.status==='pass'));
 assert.equal(r.tieouts.filter(t=>t.id.endsWith(':balance_sheet')).length,4);
 // The TTM line items are a statements CSV the Covenant Designer accepts as-is.
 const {facts}=readStatements(r.statements_csv);
 assert.equal(facts.total_debt.cents,BigInt(Math.round(Number(csvRow.debt_usd)*100)));
 const rec=recommendCovenants(r.statements_csv);
 assert.equal(rec.figures.find(f=>f.key==='ebitda').amount_usd,csvRow.ttm_ebitda_usd);
 assert.equal(rec.figures.find(f=>f.key==='debt_service').amount_usd,csvRow.ttm_debt_service_usd);
 // Every computed input cites its definitions.txt sentence by exact offsets.
 for(const v of Object.values(r.inputs)){assert.ok(verifyCitation(ctx.definitionsText,v.definition));assert.equal(v.definition.source_document,'statements/definitions.txt');}
});

test('a value without a citation cannot be confirmed and blocks the row',()=>{
 const job=mockJob('BOR-09',{mutate:(j,{m})=>{m('2026-Q3').capex.citation=[];}});
 const items=reviewItems(normalizeExtraction(job));const capex=items.find(i=>i.id==='2026-Q3:capex');
 assert.equal(capex.confirmable,false);assert.match(capex.reason,/cannot be confirmed/);
 // Even if the client claims it was confirmed, the row stays blocked.
 const r=run('BOR-09',job,{confirmed:[...allConfirmable(items),'2026-Q3:capex']});
 assert.equal(r.blocked,true);assert.equal(r.row,null);assert.equal(r.engine,null);
 assert.ok(r.blockers.some(b=>/Capital expenditures for 2026-Q3 has no citation/.test(b)));
});

test('an unconfirmed value blocks the row until the analyst confirms it',()=>{
 const items=reviewItems(normalizeExtraction(mockJob('BOR-09')));
 const r=run('BOR-09',mockJob('BOR-09'),{confirmed:allConfirmable(items).filter(x=>x!=='2026-Q1:interest_expense')});
 assert.equal(r.blocked,true);assert.ok(r.blockers.some(b=>/Interest expense for 2026-Q1 is not confirmed/.test(b)));
});

const fq=(id,q,k)=>BigInt(fixtures.borrowers[id].quarters[q][k]);
test('a balance sheet off by $5.00 blocks the row; within $1.00 passes',()=>{
 const tle=fq('BOR-09','2026-Q2','total_liabilities_and_equity');
 const r=run('BOR-09',mockJob('BOR-09',{mutate:(j,{q})=>{q('2026-Q2').total_assets=printed(tle+500n);}}));
 const t=r.tieouts.find(x=>x.id==='2026-Q2:balance_sheet');
 assert.equal(t.status,'fail');assert.equal(t.difference,'-5.00');assert.equal(r.blocked,true);assert.equal(r.row,null);assert.equal(r.engine,null);
 assert.ok(r.blockers.some(b=>/balance sheet balances.*off by 5\.00/.test(b)));
 const ok=run('BOR-09',mockJob('BOR-09',{mutate:(j,{q})=>{q('2026-Q2').total_assets=printed(tle+100n);}}));
 assert.equal(ok.tieouts.find(x=>x.id==='2026-Q2:balance_sheet').status,'pass');assert.equal(ok.blocked,false);
});

test('a TTM value that differs from the CSV is flagged (not silently accepted) while tie-outs still pass',()=>{
 // Operating income +1,000.00 in 2026-Q1 with operating expenses -1,000.00, so the income statement still ties.
 const job=mockJob('BOR-09',{mutate:(j,{q})=>{q('2026-Q1').operating_income=printed(fq('BOR-09','2026-Q1','operating_income')+100000n);q('2026-Q1').operating_expenses=printed(fq('BOR-09','2026-Q1','operating_expenses')-100000n);}});
 const r=run('BOR-09',job);
 assert.equal(r.blocked,false,r.blockers.join(' | '));
 assert.deepEqual(r.csv_match.flags.sort(),['ttm_available_cashflow_usd','ttm_ebitda_usd']);
 const t=r.tieouts.find(x=>x.id==='csv:ttm_ebitda_usd');assert.equal(t.status,'fail');assert.equal(t.expected,'325000.00');assert.equal(t.actual,'326000.00');assert.equal(t.blocking,false);
 assert.equal(r.row.ttm_ebitda_usd,'326000.00');
});

test('review list: lowest confidence first; confidence never auto-accepts',()=>{
 const job=mockJob('BOR-01',{mutate:(j,{m})=>{m('2026-Q2').revenue.confidence=0.12;m('2025-Q4').capex.confidence=0.31;delete m('2026-Q3').cash.confidence;}});
 const items=reviewItems(normalizeExtraction(job));
 assert.deepEqual(items.slice(0,3).map(i=>i.id),['2026-Q3:cash','2026-Q2:revenue','2025-Q4:capex']);
 for(let i=1;i<items.length;i++)assert.ok((items[i-1].confidence??-1)<=(items[i].confidence??-1));
 const r=run('BOR-01',job,{confirmed:[]});assert.equal(r.blocked,true);assert.equal(r.row,null);
});

test('missing quarters and unreadable amounts block with clear reasons',()=>{
 const job=mockJob('BOR-09',{mutate:(j)=>{j.extract_result.quarters.shift();j.extract_metadata.field_metadata.document_metadata.quarters.shift();j.extract_result.quarters[0].capex='see note';}});
 const r=run('BOR-09',job);assert.equal(r.blocked,true);
 assert.ok(r.blockers.some(b=>/missing 2025-Q4/.test(b)));assert.ok(r.blockers.some(b=>/not a readable amount/.test(b)));
 const empty=normalizeExtraction({status:'COMPLETED',extract_result:{}});assert.match(empty.problems[0],/no quarterly columns/);
});

test('definition citations point at exact sentences in definitions.txt',()=>{
 const d=definitionCitations(ctx.definitionsText);
 assert.equal(d.ebitda.quote,'EBITDA means operating income plus depreciation and amortization.');
 assert.match(d.debt.quote,/^Gross debt means .*period end\.$/);
 for(const v of Object.values(d))assert.ok(verifyCitation(ctx.definitionsText,v));
});
