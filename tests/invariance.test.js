// Integration rule 1: the reporting tracker and call-prep features must not change the engine's outputs.
// The three responses below were saved from a local server running main at 171a3e3, before any change,
// with OPT_URL unset (snapshot-served cure plans). This test proves they are byte-identical now.
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import crypto from 'node:crypto';
import {createServer} from '../server.js';
import {parseCSV,toCSV} from '../lib/csv.js';
import {REPORTING_COLUMNS} from '../lib/reporting.js';

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
// Citation offsets depend on the line endings of the checked-out policy documents (a Windows checkout with
// core.autocrlf=true has CRLF; the committed files and Vercel have LF), so a baseline was saved for each.
const BASELINE={
 lf:{covenants:'fcfe2cafa61ff16a9e62ed445e79673ddba8224c7b9f0c9e494e12ffc728437d',
  'cure BOR-09 2026-Q3':'05703171064670640832c78193a6e116f4e7012382684ada867ce45cf022e86e',
  'cure BOR-01 2026-Q3':'a87bbafb6cec5d2b5c8b1c55825d4a35eea11747aeaf8ac86eba1f71d01c7d52'},
 crlf:{covenants:'be752dadb734fa42a884042b7be81ac165758791c0d513af7f55d26ba035d470',
  'cure BOR-09 2026-Q3':'a6f820be14807cc9043a187ff32a9e244295c4330bf6f104766a8daad5e36e13',
  'cure BOR-01 2026-Q3':'992bd7ad5d47eb2e7a5ec3f7a056ea8eba9da6e1156504f7be46a3d856e0861c'}};
// SHA-256 of data/team/loan_covenants_extended.csv at 171a3e3 (before the reporting columns were added).
const CSV_171A3E3='97fd98a62977e5f6304a3fb59d5da133bfdb474271346b7cc02bdf14f3390652';

async function checkoutStyle(){
 const docs=await Promise.all(['team/covenant-policy-addendum.txt','documents/cure-policy.txt'].map(rd));
 const cr=docs.map(t=>t.includes('\r\n'));
 assert.equal(cr[0],cr[1],'Policy documents have mixed line endings; re-checkout data/ before comparing with the baseline');
 return cr[0]?'crlf':'lf';
}

test('GET /api/covenants and GET /api/cure (BOR-09, BOR-01 2026-Q3) are byte-identical to main at 171a3e3',async()=>{
 const saved=process.env.OPT_URL;delete process.env.OPT_URL; // compare the snapshot-served response only
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 try{
  const want=BASELINE[await checkoutStyle()];
  const got={covenants:await (await fetch(base+'/api/covenants')).text(),
   'cure BOR-09 2026-Q3':await (await fetch(base+'/api/cure?borrower=BOR-09&period=2026-Q3')).text(),
   'cure BOR-01 2026-Q3':await (await fetch(base+'/api/cure?borrower=BOR-01&period=2026-Q3')).text()};
  for(const [k,body] of Object.entries(got))assert.equal(sha(body),want[k],`${k} response changed`);
 }finally{s.close();if(saved!==undefined)process.env.OPT_URL=saved;}
});

test('the four reporting columns are the only change to the bundled CSV, and the engine ignores them',async()=>{
 const rows=parseCSV(await rd('team/loan_covenants_extended.csv'));
 assert.deepEqual(Object.keys(rows[0]).slice(-4),REPORTING_COLUMNS);
 const strip=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!REPORTING_COLUMNS.includes(k)));
 const before=toCSV(rows.map(strip));
 assert.equal(sha(before),CSV_171A3E3,'every pre-existing column and value is byte-identical to 171a3e3');
 // The same rows with and without the new columns give identical /api/covenants results.
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 const post=csv=>fetch(base+'/api/covenants',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({csv})}).then(r=>r.text());
 try{assert.equal(await post(toCSV(rows)),await post(before));}finally{s.close();}
});
