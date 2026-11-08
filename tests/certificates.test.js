// Compliance certificates (S6): synthetic fixture, normalization, checks, CSV output and the extraction
// script, all against mocked LlamaCloud responses (no live calls).
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {parseCSV} from '../lib/csv.js';import {evaluateRow} from '../lib/covenants.js';
import {normalizeCertificate,checkCertificate,certificateRow,certificatesCSV,parseRatio,parseYesNo,CERT_COLUMNS,CERT_CONFIG,CERT_FIELDS,CERT_MONEY,loadCertificateSchema} from '../lib/certificates.js';
import {extractCertificateToFile,buildCertificatesCSV} from '../scripts/extract-certificate.mjs';

const ROOT=new URL('../',import.meta.url);
const rd=(n,enc='utf8')=>fs.readFile(new URL(n,ROOT),enc);
const fx=JSON.parse(await rd('data/statements/certificates/certificate-fixture.json'));
const rows=parseCSV(await rd('data/team/loan_covenants_extended.csv'));
const csvRow=rows.find(r=>r.record_id==='COV-09-3');
const usd=c=>{const n=BigInt(c);return `${(n/100n).toString().replace(/\B(?=(\d{3})+$)/g,',')}.${String(n%100n).padStart(2,'0')}`;};
const RATIOS=new Set(['reported_leverage','reported_dscr']);
// What the PDF prints for each field.
const printedValue=k=>CERT_MONEY.includes(k)?usd(fx.values[k]):RATIOS.has(k)?fx.values[k]+'x':fx.values[k];
// A completed LlamaExtract job for the fixture. mutate(result, metadata) adjusts it.
function mockCertJob({mutate}={}){
 const result={},meta={};
 for(const k of CERT_FIELDS){result[k]=printedValue(k);meta[k]={citation:[{page:1,matching_text:printedValue(k),bounding_boxes:[{x:56,y:200,w:480,h:12}]}],confidence:0.93};}
 mutate?.(result,meta);
 return {id:'ext-cert-1',status:'COMPLETED',extract_result:result,extract_metadata:{field_metadata:{document_metadata:meta}}};
}
const KEY='test-key-must-not-be-saved';
const fetcherFor=(job,seen=[])=>{let polls=0;return async(url,init)=>{const u=new URL(url);seen.push({path:u.pathname,init});const json=b=>({ok:true,json:async()=>b});
 if(u.pathname==='/api/v1/beta/files')return json({id:'dfl-c1'});if(u.pathname==='/api/v2/extract')return json({id:job.id,status:'PENDING'});
 return json(polls++<1?{id:job.id,status:'RUNNING'}:job);};};
const pdfPath=fileURL=>decodeURIComponent(fileURL.pathname).replace(/^\/([A-Za-z]:)/,'$1');
const CERT_PDF=pdfPath(new URL('data/statements/certificates/BOR-09_2026-Q3_certificate.pdf',ROOT));

test('certificate fixture: synthetic, prints every value, and its unadjusted figures equal CSV row COV-09-3',async()=>{
 const pdf=(await rd('data/statements/certificates/BOR-09_2026-Q3_certificate.pdf',null)).toString('latin1');
 assert.ok(pdf.startsWith('%PDF-'));assert.equal((pdf.match(/\/Type \/Page\b/g)||[]).length,1);
 assert.match(pdf,/\(SYNTHETIC TEST DOCUMENT - fictional borrower/);assert.ok(pdf.includes('(Quarterly Compliance Certificate \\(SYNTHETIC\\))'));
 for(const k of CERT_FIELDS.filter(k=>k!=='borrower_id'&&k!=='period'))assert.ok(pdf.includes('('+printedValue(k)+')'),`${k} printed`);
 assert.equal(fx.synthetic,true);assert.equal(fx.record_id,'COV-09-3');
 const c=k=>BigInt(Math.round(Number(csvRow[k])*100));
 assert.equal(BigInt(fx.values.statement_ebitda),c('ttm_ebitda_usd'));assert.equal(BigInt(fx.values.total_debt),c('debt_usd'));
 assert.equal(BigInt(fx.values.statement_available_cash_flow),c('ttm_available_cashflow_usd'));assert.equal(BigInt(fx.values.debt_service),c('ttm_debt_service_usd'));
 assert.ok(BigInt(fx.values.cost_savings_addbacks)>0n);assert.equal(fx.values.addback_cap,'None');assert.equal(fx.values.certified_compliant,'Yes');
 // Without add-backs the engine fails leverage and DSCR; with them the borrower's own figures would pass.
 const e=evaluateRow(csvRow);assert.equal(e.covenants.leverage.status,'breach');assert.equal(e.covenants.dscr.status,'breach');
 assert.equal(evaluateRow({...csvRow,ttm_ebitda_usd:'435000.00',ttm_available_cashflow_usd:'410000.00'}).covenants.leverage.status,'pass');
 // The schema asks for exactly the fields the code reads, all as printed text.
 const schema=await loadCertificateSchema();assert.deepEqual(Object.keys(schema.properties).sort(),[...CERT_FIELDS].sort());
 assert.ok(Object.values(schema.properties).every(p=>p.type==='string'));
});

test('checks: arithmetic and CSV ties pass; uncapped add-backs and certified compliance fail against the engine',()=>{
 const norm=normalizeCertificate(mockCertJob());assert.deepEqual(norm.problems,[]);
 const r=checkCertificate(norm,{csvRow});const by=Object.fromEntries(r.checks.map(c=>[c.id,c]));
 for(const id of ['ebitda_sum','acf_sum','leverage_math','dscr_math','csv_ebitda','csv_debt','csv_acf','csv_service'])assert.equal(by[id].status,'pass',id);
 assert.equal(by.addbacks.status,'fail');assert.match(by.addbacks.detail,/\$110,000\.00 of projected cost savings \(33\.85% of EBITDA per the statements\) with no cap/);
 assert.equal(by.engine.status,'fail');
 assert.match(by.engine.detail,/says "in compliance", but under the policy definitions leverage 3\.91x \(maximum 3\.00x\), DSCR 1\.15x \(minimum 1\.20x\)/);
 assert.match(by.engine.detail,/certificate reports 2\.92x leverage and 1\.58x DSCR/);
 assert.equal(r.failed,2);assert.equal(r.engine.status,'exception');
 assert.equal(r.citation_summary.message,'0 of 13 values have a page location but no quoted text');
});

test('checks name a misprinted ratio, a figure that does not tie to the CSV, and agree when the borrower reports non-compliance',()=>{
 const norm=normalizeCertificate(mockCertJob({mutate:r=>{r.reported_leverage='2.50x';r.statement_ebitda='330,000.00';r.certified_compliant='No';}}));
 const by=Object.fromEntries(checkCertificate(norm,{csvRow}).checks.map(c=>[c.id,c]));
 assert.equal(by.leverage_math.status,'fail');assert.match(by.leverage_math.detail,/= 2\.92x; certificate prints 2\.50x/);
 assert.equal(by.csv_ebitda.status,'fail');assert.match(by.csv_ebitda.detail,/Certificate \$330,000\.00; CSV \$325,000\.00/);
 assert.equal(by.ebitda_sum.status,'fail');
 assert.equal(by.engine.status,'pass');assert.match(by.engine.detail,/agrees with the engine/);
 // No CSV row: the CSV ties and the engine check are reported missing, never passed.
 const none=checkCertificate(normalizeCertificate(mockCertJob()),{});
 assert.equal(none.checks.find(c=>c.id==='csv').status,'missing');assert.ok(!none.checks.some(c=>c.id==='engine'));
});

test('CSV has exactly the required columns; a value with no citation is left blank; a field-path citation is location-only',()=>{
 const job=mockCertJob({mutate:(r,m)=>{m.reported_dscr={confidence:0.4};m.total_debt.citation[0].matching_text='total_debt';m.reported_ebitda.citation[0].matching_text='document_metadata.reported_ebitda';}});
 const norm=normalizeCertificate(job);
 assert.equal(norm.fields.reported_dscr.citation_kind,'none');assert.match(norm.problems.join('\n'),/reported_dscr: no citation \(page\), so it is left out of the CSV/);
 assert.equal(norm.fields.total_debt.citation_kind,'location_only');assert.equal(norm.fields.total_debt.matching_text,null);
 assert.equal(norm.fields.reported_ebitda.citation_kind,'location_only');
 assert.equal(norm.fields.certified_compliant.citation_kind,'text');assert.equal(norm.fields.certified_compliant.matching_text,'Yes');
 const row=certificateRow(norm,{csvRows:rows,synthetic:'true'});
 assert.deepEqual(Object.keys(row),CERT_COLUMNS);
 assert.deepEqual(row,{record_id:'COV-09-3',reported_ebitda_usd:'435000.00',cost_savings_addbacks_usd:'110000.00',reported_leverage:'2.92',reported_dscr:'',certified_compliant:'true',synthetic:'true'});
 const csv=certificatesCSV([row]);
 assert.equal(csv.split('\n')[0],'"record_id","reported_ebitda_usd","cost_savings_addbacks_usd","reported_leverage","reported_dscr","certified_compliant","synthetic"');
 assert.deepEqual(parseCSV(csv)[0],row);
});

test('ratio and yes/no parsing never use floats and reject anything unclear',()=>{
 assert.equal(parseRatio('2.92x').scaled,29200n);assert.equal(parseRatio(' 1.58 ').text,'1.58');assert.equal(parseRatio('3×').scaled,30000n);
 assert.throws(()=>parseRatio('about 3'));assert.throws(()=>parseRatio('2.92%'));
 assert.equal(parseYesNo('Yes'),true);assert.equal(parseYesNo('no'),false);assert.throws(()=>parseYesNo('Partially'));
 const n=normalizeCertificate(mockCertJob({mutate:r=>{r.certified_compliant='See note 4';}}));
 assert.equal(n.fields.certified_compliant.value,null);assert.match(n.problems.join(),/not a yes or no answer/);
 assert.equal(certificateRow(n,{csvRows:rows}).certified_compliant,'');
});

test('extract-certificate saves the raw result with the certificate configuration, never the key, and rebuilds the CSV',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cert-x-'));
 try{
  const job=mockCertJob({mutate:(r,m)=>{m.total_debt.citation[0].matching_text='total_debt';}});const logs=[],seen=[];
  const {file}=await extractCertificateToFile(CERT_PDF,{outDir:dir,key:KEY,fetcher:fetcherFor(job,seen),sleep:async()=>{},now:()=>new Date('2026-11-08T12:00:00Z'),log:m=>logs.push(m)});
  assert.equal(path.basename(file),'BOR-09_2026-Q3_certificate.extracted.json');
  const saved=await fs.readFile(file,'utf8');const j=JSON.parse(saved);
  assert.equal(j.synthetic,true);assert.equal(j.kind,'compliance_certificate');assert.equal(j.extracted_at,'2026-11-08T12:00:00.000Z');
  assert.deepEqual(j.configuration,{...CERT_CONFIG});assert.match(j.pdf_sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(j.extract_metadata,job.extract_metadata);assert.equal(j.citation_summary.location_only,1);
  assert.ok(!saved.includes(KEY));assert.ok(!logs.join('\n').includes(KEY));
  const create=JSON.parse(seen.find(s=>s.path==='/api/v2/extract'&&s.init?.method==='POST').init.body);
  assert.deepEqual(Object.keys(create.configuration.data_schema.properties).sort(),[...CERT_FIELDS].sort());
  assert.match(create.configuration.system_prompt,/compliance certificate/);assert.equal(create.configuration.cite_sources,true);
  const csvOut=path.join(dir,'certificates.extracted.csv');
  const {reports}=await buildCertificatesCSV({dir,csvOut,rows});
  const text=await fs.readFile(csvOut,'utf8');const parsed=parseCSV(text);
  assert.deepEqual(Object.keys(parsed[0]),CERT_COLUMNS);assert.equal(parsed.length,1);
  assert.deepEqual(parsed[0],{record_id:'COV-09-3',reported_ebitda_usd:'435000.00',cost_savings_addbacks_usd:'110000.00',reported_leverage:'2.92',reported_dscr:'1.58',certified_compliant:'true',synthetic:'true'});
  assert.equal(reports[0].failed,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a certificate is never listed as a saved statement extraction',async()=>{
 // Certificates live in data/statements/certificates/, which /api/statements/saved does not read.
 const top=await fs.readdir(new URL('data/statements/',ROOT));
 assert.ok(!top.some(f=>/certificate.*\.extracted\.json$/.test(f)));
});
