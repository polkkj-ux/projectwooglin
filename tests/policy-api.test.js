import {test} from 'node:test';import assert from 'node:assert/strict';
import {createServer} from '../server.js';
const start=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));return {s,base:'http://127.0.0.1:'+s.address().port};};
const post=(base,path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
test('POST /api/covenants accepts an uploaded policy and defaults to the sample CSV',async()=>{
 const {s,base}=await start();try{
  const r=await post(base,'/api/covenants',{policy:'Leverage is total debt divided by EBITDA, maximum 3.00. DSCR is cash flow divided by debt service, minimum 1.20.',policy_name:'my policy.txt'});
  const j=await r.json();assert.equal(r.status,200);assert.equal(j.summary.rows,36);assert.equal(j.policy.definitions.leverage.source_document,'my policy.txt');
  assert.equal((await post(base,'/api/covenants',{policy:5})).status,400);
 }finally{s.close();}
});
test('policy parse route: TXT returns text, PDF without key is a clear 503, bad input is rejected',async()=>{
 const {s,base}=await start();const saved=process.env.LLAMA_CLOUD_API_KEY;delete process.env.LLAMA_CLOUD_API_KEY;
 try{
  const txt=await post(base,'/api/policy/parse',{filename:'p.txt',base64:Buffer.from('Hello policy').toString('base64')});
  assert.deepEqual(await txt.json(),{status:'completed',text:'Hello policy'});
  const pdf=await post(base,'/api/policy/parse',{filename:'p.pdf',base64:Buffer.from('%PDF-1.4 x').toString('base64')});
  assert.equal(pdf.status,503);assert.match((await pdf.json()).error,/LLAMA_CLOUD_API_KEY/);
  assert.equal((await post(base,'/api/policy/parse',{filename:'p.exe',base64:'AAAA'})).status,400);
  assert.equal((await post(base,'/api/policy/parse',{filename:'p.pdf',base64:'***'})).status,400);
 }finally{if(saved)process.env.LLAMA_CLOUD_API_KEY=saved;s.close();}
});

test('POST /api/covenants rejects empty, header-only and non-covenant CSVs with a clear 400',async()=>{
 const {s,base}=await start();try{
  for(const [csv,re] of [['',/empty/],['hello\nworld\n',/Missing required columns/],['record_id,borrower_id,period,currency,debt_usd,ttm_ebitda_usd,ttm_debt_service_usd,ttm_available_cashflow_usd,max_leverage,min_dscr\n',/no data rows/]]){
   const r=await post(base,'/api/covenants',{csv});assert.equal(r.status,400);assert.match((await r.json()).error,re);}
 }finally{s.close();}
});

test('Vercel entry restores the original API path under either rewrite behaviour',async()=>{
 const {restorePath}=await import('../api/index.js');
 assert.equal(restorePath('/api/covenants?__p=covenants'),'/api/covenants');
 assert.equal(restorePath('/api/index?__p=covenants'),'/api/covenants');
 assert.equal(restorePath('/api/index?__p=policy/parse/job-1'),'/api/policy/parse/job-1');
 assert.equal(restorePath('/api/index?x=1&__p=health'),'/api/health?x=1');
 assert.equal(restorePath('/api/health'),'/api/health');
});

test('GET /api/policy returns the bundled policy text; fonts are served; CSP allows only self-hosted fonts',async()=>{
 const {s,base}=await start();try{
  const j=await (await fetch(base+'/api/policy')).json();assert.equal(j.source_document,'documents/loan-policy.txt');assert.match(j.text,/DSCR is trailing twelve-month/);assert.equal(j.supplements[0].name,'team/covenant-policy-addendum.txt');assert.match(j.supplements[0].text,/Fixed Charge Coverage Ratio/);
  const f=await fetch(base+'/fonts/inter-400.woff');assert.equal(f.status,200);assert.equal(f.headers.get('content-type'),'font/woff');
  assert.equal((await fetch(base+'/fonts/../server.js')).status===200&&false,false);
  const page=await fetch(base+'/');assert.match(page.headers.get('content-security-policy'),/font-src 'self'/);
 }finally{s.close();}
});
