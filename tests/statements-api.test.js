// Statements API routes. LlamaCloud is mocked by intercepting fetch to api.cloud.llamaindex.ai; no live calls.
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createServer,CSP} from '../server.js';import {parseCSV} from '../lib/csv.js';import {evaluateRow} from '../lib/covenants.js';
import {CSV_COLUMNS,reviewItems,normalizeExtraction} from '../lib/statements.js';import {mockJob,fixtures} from './statement-mocks.js';

const realFetch=globalThis.fetch;
let llama=[];          // recorded LlamaCloud calls
let jobs=new Map();    // job id -> sequence of responses
function mockLlama(){
 globalThis.fetch=async(url,init={})=>{const u=new URL(url);
  if(u.host!=='api.cloud.llamaindex.ai')return realFetch(url,init);
  llama.push({url:String(url),method:init.method||'GET',auth:init.headers?.Authorization});
  const json=b=>({ok:true,status:200,json:async()=>b,text:async()=>JSON.stringify(b)});
  if(u.pathname==='/api/v1/beta/files')return json({id:'dfl-1'});
  if(u.pathname==='/api/v2/extract')return json({id:'ext-1',status:'PENDING'});
  const m=u.pathname.match(/^\/api\/v2\/extract\/(.+)$/);
  if(m){const seq=jobs.get(m[1]);if(!seq)return {ok:false,status:404,text:async()=>'{"detail":"Job not found"}'};return json(seq.length>1?seq.shift():seq[0]);}
  return {ok:false,status:500,text:async()=>'unexpected'};};
}
const start=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));return {s,base:'http://127.0.0.1:'+s.address().port};};
const post=(base,p,b,h={})=>realFetch(base+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)});
async function withEnv(env,f){const old={};for(const k of Object.keys(env)){old[k]=process.env[k];if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}
 try{return await f();}finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
const pdf=Buffer.from('%PDF-1.4 synthetic test').toString('base64');
const csvRows=parseCSV(await fs.readFile(new URL('../data/team/loan_covenants_extended.csv',import.meta.url),'utf8'));
const FIN_COLS=CSV_COLUMNS.filter(k=>!['record_id','source_document','synthetic'].includes(k));
const pick=(o,ks)=>Object.fromEntries(ks.map(k=>[k,o[k]??'']));
const allIds=items=>items.filter(i=>i.confirmable).map(i=>i.id);

test('POST /api/statements/extract: 503 without a key, same input checks as /api/policy/parse, 202 with a job id',async()=>{
 mockLlama();const {s,base}=await start();
 try{
  await withEnv({LLAMA_CLOUD_API_KEY:undefined},async()=>{
   const r=await post(base,'/api/statements/extract',{filename:'BOR-09_2026-Q3.pdf',base64:pdf});
   assert.equal(r.status,503);assert.match((await r.json()).error,/LLAMA_CLOUD_API_KEY is not set/);
   assert.equal((await post(base,'/api/statements/extract',{filename:'a.pdf',base64:'***'})).status,400);
   assert.equal((await post(base,'/api/statements/extract',{base64:pdf})).status,400);
   const txt=await post(base,'/api/statements/extract',{filename:'a.txt',base64:pdf});assert.equal(txt.status,400);assert.match((await txt.json()).error,/must be a PDF/);
  });
  llama=[];
  await withEnv({LLAMA_CLOUD_API_KEY:'test-key-not-real'},async()=>{
   for(const [filename,base64] of [['../x.pdf',pdf],['BOR-09_2026-Q3.pdf',Buffer.from('not a pdf').toString('base64')],['big.pdf',Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(5_300_000)]).toString('base64')]]){
    const r=await post(base,'/api/statements/extract',{filename,base64});assert.equal(r.status,400,filename);}
   assert.equal(llama.length,0,'invalid files never reach LlamaCloud');
   const r=await post(base,'/api/statements/extract',{filename:'BOR-09_2026-Q3.pdf',base64:pdf});
   assert.equal(r.status,202);assert.deepEqual(await r.json(),{status:'pending',job_id:'ext-1',name:'BOR-09_2026-Q3.pdf',borrower_id:'BOR-09',period:'2026-Q3'});
   assert.deepEqual(llama.map(c=>[c.method,new URL(c.url).pathname]),[['POST','/api/v1/beta/files'],['POST','/api/v2/extract']]);
   assert.ok(llama.every(c=>c.auth==='Bearer test-key-not-real'));
  });
  // Same origin check as the existing POST routes.
  const x=await post(base,'/api/statements/extract',{filename:'a.pdf',base64:pdf},{Origin:'https://evil.example'});assert.equal(x.status,403);
 }finally{globalThis.fetch=realFetch;s.close();}
});

test('GET /api/statements/job: pending, failed, and completed with the review list, inputs and tie-outs',async()=>{
 mockLlama();const {s,base}=await start();
 jobs=new Map([['ext-p',[{id:'ext-p',status:'RUNNING'}]],['ext-f',[{id:'ext-f',status:'FAILED',error_message:'bad pdf'}]],['ext-c',[mockJob('BOR-09')]]]);
 try{await withEnv({LLAMA_CLOUD_API_KEY:'test-key-not-real'},async()=>{
  assert.deepEqual(await (await realFetch(base+'/api/statements/job?id=ext-p')).json(),{status:'pending',job_id:'ext-p'});
  assert.deepEqual(await (await realFetch(base+'/api/statements/job?id=ext-f')).json(),{status:'failed',job_id:'ext-f',error:'bad pdf'});
  const j=await (await realFetch(base+'/api/statements/job?id=ext-c&name=BOR-09_2026-Q3.pdf')).json();
  assert.equal(j.status,'completed');assert.equal(j.borrower_id,'BOR-09');assert.equal(j.blocked,true);assert.equal(j.row,null);
  assert.equal(j.items.length,reviewItems(normalizeExtraction(mockJob('BOR-09'))).length);assert.equal(j.items.length,96);assert.ok(j.items.every(i=>'page' in i&&'matching_text' in i&&'confidence' in i));
  assert.equal(j.inputs.ttm_ebitda_usd.value,'325000.00');assert.equal(j.inputs.ttm_ebitda_usd.definition.source_document,'statements/definitions.txt');
  assert.ok(j.tieouts.length>0);assert.ok(j.blockers.some(b=>/not confirmed/.test(b)));
  assert.ok(llama.at(-1).url.includes('expand=extract_metadata'));
  assert.equal((await realFetch(base+'/api/statements/job?id=../x')).status,400);
  assert.equal((await realFetch(base+'/api/statements/job?id=missing')).status,502);
 });
 await withEnv({LLAMA_CLOUD_API_KEY:undefined},async()=>{assert.equal((await realFetch(base+'/api/statements/job?id=ext-c')).status,503);});
 }finally{globalThis.fetch=realFetch;s.close();}
});

test('POST /api/statements/confirm (live job): server reloads the job; returns covenant row, tie-outs and engine result',async()=>{
 mockLlama();const {s,base}=await start();jobs=new Map([['ext-c',[mockJob('BOR-01')]]]);
 try{await withEnv({LLAMA_CLOUD_API_KEY:'test-key-not-real'},async()=>{
  const prev=await (await realFetch(base+'/api/statements/job?id=ext-c&name=BOR-01_2026-Q3.pdf')).json();
  const r=await post(base,'/api/statements/confirm',{job_id:'ext-c',name:'BOR-01_2026-Q3.pdf',confirmed:allIds(prev.items)});
  assert.equal(r.status,200);const j=await r.json();
  assert.equal(j.blocked,false,j.blockers.join(' | '));
  const csvRow=csvRows.find(x=>x.borrower_id==='BOR-01'&&x.period==='2026-Q3');
  assert.deepEqual(pick(j.row,FIN_COLS),pick(csvRow,FIN_COLS));assert.equal(j.row.source_document,'BOR-01_2026-Q3.pdf');
  assert.equal(j.engine.status,evaluateRow(pick(csvRow,CSV_COLUMNS)).status);assert.equal(j.engine.dscr.value,evaluateRow(pick(csvRow,CSV_COLUMNS)).dscr.value);
  assert.match(j.statements_csv,/^line_item,amount_usd\n/);
  // Nothing confirmed -> blocked; bad confirmation ids are rejected.
  assert.equal((await (await post(base,'/api/statements/confirm',{job_id:'ext-c',name:'BOR-01_2026-Q3.pdf',confirmed:[]})).json()).blocked,true);
  assert.equal((await post(base,'/api/statements/confirm',{job_id:'ext-c',name:'BOR-01_2026-Q3.pdf',confirmed:['DROP TABLE']})).status,400);
  assert.equal((await post(base,'/api/statements/confirm',{confirmed:[]})).status,400);
  // Without a borrower in the name or parameters, the server asks for one rather than guessing.
  const anon=await post(base,'/api/statements/confirm',{job_id:'ext-c',name:'statements.pdf',confirmed:[]});assert.equal(anon.status,400);assert.match((await anon.json()).error,/BOR-09_2026-Q3\.pdf/);
 });}finally{globalThis.fetch=realFetch;s.close();}
});

test('GET /api/statements/saved and confirm from a saved extraction work with no key configured',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stmt-saved-'));
 const job=mockJob('BOR-09');
 await fs.writeFile(path.join(dir,'BOR-09_2026-Q3.extracted.json'),JSON.stringify({pdf:'BOR-09_2026-Q3.pdf',pdf_sha256:'ab'.repeat(32),configuration:{tier:'agentic',version:'2.5',cite_sources:true,confidence_scores:true},extracted_at:'2026-11-08T12:00:00Z',synthetic:true,job_id:job.id,status:job.status,extract_result:job.extract_result,extract_metadata:job.extract_metadata}));
 await fs.writeFile(path.join(dir,'notes.txt'),'ignored');
 const {s,base}=await start();
 try{await withEnv({LLAMA_CLOUD_API_KEY:undefined,STATEMENTS_SAVED_DIR:dir},async()=>{
  const list=await (await realFetch(base+'/api/statements/saved')).json();
  assert.equal(list.llama_configured,false);assert.equal(list.saved.length,1);
  assert.deepEqual(list.saved[0],{name:'BOR-09_2026-Q3',pdf:'BOR-09_2026-Q3.pdf',pdf_sha256:'ab'.repeat(32),extracted_at:'2026-11-08T12:00:00Z',configuration:{tier:'agentic',version:'2.5',cite_sources:true,confidence_scores:true},synthetic:true,citation_summary:null,borrower_id:'BOR-09',period:'2026-Q3'});
  const one=await (await realFetch(base+'/api/statements/saved?name=BOR-09_2026-Q3')).json();
  assert.equal(one.saved.name,'BOR-09_2026-Q3');assert.equal(one.blocked,true);
  const c=await (await post(base,'/api/statements/confirm',{saved:'BOR-09_2026-Q3',confirmed:allIds(one.items)})).json();
  assert.equal(c.blocked,false,c.blockers.join(' | '));assert.equal(c.row.synthetic,'true');assert.equal(c.row.debt_usd,'1270000.00');
  assert.equal(c.engine.record_id,'COV-09-3');
  assert.equal((await realFetch(base+'/api/statements/saved?name=nope')).status,404);
  assert.equal((await realFetch(base+'/api/statements/saved?name=..%2F..%2Fpackage')).status,400);
  assert.equal((await post(base,'/api/statements/confirm',{saved:'../x',confirmed:[]})).status,400);
 });
 // The default saved directory is data/statements (empty of extractions until the live run).
 await withEnv({STATEMENTS_SAVED_DIR:undefined},async()=>{const r=await realFetch(base+'/api/statements/saved');assert.equal(r.status,200);assert.ok(Array.isArray((await r.json()).saved));});
 }finally{s.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('the statements page is served with the same headers and CSP as /app; unknown statements routes 404; existing routes unchanged',async()=>{
 const {s,base}=await start();try{
  const app=await realFetch(base+'/app');
  for(const p of ['/statements','/statements/','/statements.html']){const r=await realFetch(base+p);assert.equal(r.status,200,p);
   for(const h of ['content-type','cache-control','x-content-type-options','content-security-policy'])assert.equal(r.headers.get(h),app.headers.get(h),`${p} ${h}`);
   assert.equal(r.headers.get('content-security-policy'),CSP);}
  assert.equal((await realFetch(base+'/api/statements/nope')).status,404);
  assert.equal((await realFetch(base+'/api/health')).status,200);
  assert.equal((await (await realFetch(base+'/api/covenants')).json()).summary.rows,36);
 }finally{s.close();}
});

test('vercel.json serves /statements like /app and bundles the page',async()=>{
 const v=JSON.parse(await fs.readFile(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.ok(v.rewrites.some(r=>r.source==='/statements'&&r.destination==='/statements.html'));
 assert.ok(v.rewrites.some(r=>r.source==='/app'&&r.destination==='/app.html'));
 assert.match(v.functions['api/index.js'].includeFiles,/public\/statements\.html/);
 assert.equal(v.headers[0].source,'/(.*)');
 assert.ok(fixtures.borrowers['BOR-09']);
});
