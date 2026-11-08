// The live-extraction script and the offline comparison, against a mocked LlamaCloud (no live calls).
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {parseCSV} from '../lib/csv.js';import {loadDefinitions,EXTRACT_CONFIG} from '../lib/statements.js';
import {extractToFile} from '../scripts/extract-statement.mjs';import {compareSaved} from '../scripts/compare-extraction.mjs';
import {mockJob,fixtures,printed} from './statement-mocks.js';
const rd=n=>fs.readFile(new URL('../'+n,import.meta.url),'utf8');
const ctx={csvRows:parseCSV(await rd('data/team/loan_covenants_extended.csv')),definitionsText:await loadDefinitions(),policyText:await rd('data/documents/loan-policy.txt'),addendumText:await rd('data/team/covenant-policy-addendum.txt')};
const KEY='test-key-must-not-be-saved';
const fetcherFor=job=>{let polls=0;return async(url)=>{const u=new URL(url);const json=b=>({ok:true,json:async()=>b});
 if(u.pathname==='/api/v1/beta/files')return json({id:'dfl-9'});if(u.pathname==='/api/v2/extract')return json({id:job.id,status:'PENDING'});
 return json(polls++<1?{id:job.id,status:'RUNNING'}:job);};};

test('extract-statement writes the raw result with SHA-256, configuration, version and timestamp, and never the key',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stmt-x-'));
 try{
  const job=mockJob('BOR-09');const logs=[];
  const {file,out}=await extractToFile(new URL('../data/statements/BOR-09_2026-Q3.pdf',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),{outDir:dir,key:KEY,fetcher:fetcherFor(job),sleep:async()=>{},now:()=>new Date('2026-11-08T10:00:00Z'),log:m=>logs.push(m)});
  assert.equal(path.basename(file),'BOR-09_2026-Q3.extracted.json');
  const saved=await fs.readFile(file,'utf8');const j=JSON.parse(saved);
  assert.match(j.pdf_sha256,/^[0-9a-f]{64}$/);assert.equal(j.extracted_at,'2026-11-08T10:00:00.000Z');
  assert.deepEqual(j.configuration,{...EXTRACT_CONFIG});assert.equal(j.version,EXTRACT_CONFIG.version);
  assert.equal(j.synthetic,true);assert.equal(j.status,'COMPLETED');
  assert.deepEqual(j.extract_metadata,job.extract_metadata);assert.deepEqual(j.extract_result,job.extract_result);
  assert.ok(!saved.includes(KEY));assert.ok(!logs.join('\n').includes(KEY));
  assert.match(logs.at(-1),/4 quarters, 96 values; 0 of 96 values have a page location but no quoted text/);assert.equal(j.citation_summary.location_only,0);assert.match(j.citation_summary.known_limitation,/bounding box/);
  // Offline comparison: a perfect extraction matches every generator number and builds the CSV row.
  const r=await compareSaved(out,fixtures,ctx);
  assert.equal(r.exact,r.expected);assert.equal(r.expected,96);assert.equal(r.row_blocked,false);assert.deepEqual(r.csv_flags,[]);
  // One wrong figure is counted and reported.
  const bad=structuredClone(out);bad.extract_result.quarters[3].revenue=printed(BigInt(fixtures.borrowers['BOR-09'].quarters['2026-Q3'].revenue)+1n);
  const rb=await compareSaved(bad,fixtures,ctx);assert.equal(rb.exact,95);assert.equal(rb.wrong.length,1);assert.match(rb.wrong[0],/2026-Q3:revenue/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
