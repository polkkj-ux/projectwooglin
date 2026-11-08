// Compare saved LlamaExtract output with the generator's numbers (offline; no API calls).
//   node scripts/compare-extraction.mjs            (all data/statements/*.extracted.json)
// Reports, per PDF, how many extracted fields equal the fixture value to the cent, which differ, which are
// missing or uncited, and whether the confirmed row would tie to the CSV.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseCSV} from '../lib/csv.js';
import {amount} from '../lib/finance.js';
import {normalizeExtraction,reviewItems,computeStatement,loadDefinitions,parseStatementName,ITEM_KEYS,TIEOUT_KEYS} from '../lib/statements.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const rd=n=>fs.readFile(path.join(ROOT,n),'utf8');
const OUTFLOW_PRINTED=new Set(['capex','distributions']); // printed in parentheses; normalization uses their size

export async function compareSaved(saved,fx,ctx){
 const b=Object.values(fx.borrowers).find(x=>x.pdf===saved.pdf);if(!b)return null;
 const norm=normalizeExtraction(saved),items=reviewItems(norm);
 const res={pdf:saved.pdf,expected:0,exact:0,wrong:[],missing:[],unexpected:[],uncited:items.filter(i=>!i.confirmable).map(i=>i.id),
  citations:{text:items.filter(i=>i.citation_kind==='text').length,location_only:items.filter(i=>i.citation_kind==='location_only').length,none:items.filter(i=>i.citation_kind==='none').length}};
 for(const q of fx.quarters)for(const k of [...ITEM_KEYS,...TIEOUT_KEYS]){
  const want=b.quarters[q][k];const got=norm.quarters[q]?.items[k];
  if(want===undefined){if(got)res.unexpected.push(`${q}:${k}=${got.raw}`);continue;}
  res.expected++;
  let w=BigInt(want);if(OUTFLOW_PRINTED.has(k)&&w<0n)w=-w;
  const ws=amount(w);
  if(!got||got.value===null)res.missing.push(`${q}:${k}`);
  else if(got.value===ws)res.exact++;
  else res.wrong.push(`${q}:${k} extracted ${got.raw} expected ${ws}`);
 }
 const id=parseStatementName(saved.pdf);
 // Two passes, like the review screen: find which values are confirmable (after tie-outs), then confirm all of them.
 const base={...id,source_document:saved.pdf,...ctx};
 const first=computeStatement(norm,{...base,confirmed:[]});
 const r=computeStatement(norm,{...base,confirmed:first.items.filter(i=>i.confirmable).map(i=>i.id)});
 res.location_confirmable=first.items.filter(i=>i.citation_kind==='location_only'&&i.confirmable).length;
 res.location_unconfirmable=first.items.filter(i=>i.citation_kind==='location_only'&&!i.confirmable).map(i=>i.id);
 res.summary=first.citation_summary;
 res.row_blocked=r.blocked;res.blockers=r.blockers;res.csv_flags=r.csv_match?.flags??null;
 res.tieouts_failed=r.tieouts.filter(t=>t.status==='fail').map(t=>`${t.label}: expected ${t.expected}, got ${t.actual}`);
 return res;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const fx=JSON.parse(await rd('data/statements/fixtures.json'));
 const ctx={csvRows:parseCSV(await rd('data/team/loan_covenants_extended.csv')),definitionsText:await loadDefinitions(),policyText:await rd('data/documents/loan-policy.txt'),addendumText:await rd('data/team/covenant-policy-addendum.txt')};
 const files=(await fs.readdir(path.join(ROOT,'data','statements'))).filter(f=>f.endsWith('.extracted.json')).sort();
 if(!files.length){console.log('No data/statements/*.extracted.json yet.');process.exit(0);}
 for(const f of files){
  const r=await compareSaved(JSON.parse(await rd(path.join('data','statements',f))),fx,ctx);
  if(!r){console.log(`${f}: not a generated fixture; skipped.`);continue;}
  console.log(`\n${r.pdf}: ${r.exact} of ${r.expected} fields exactly equal the generator (${(100*r.exact/r.expected).toFixed(1)}%)`);
  console.log(`  wrong ${r.wrong.length}, missing ${r.missing.length}, unexpected ${r.unexpected.length}`);
  console.log(`  ${r.summary.message}; ${r.location_confirmable} of them pass a tie-out and can be confirmed, ${r.location_unconfirmable.length} cannot`);
  if(r.location_unconfirmable.length)console.log('    unconfirmable (no passing tie-out):',r.location_unconfirmable.join(', '));
  for(const x of [...r.wrong,...r.missing.map(m=>m+' missing'),...r.unexpected.map(u=>u+' (not printed on the PDF)')].slice(0,40))console.log('   ',x);
  console.log(`  row with every confirmable value confirmed: ${r.row_blocked?'BLOCKED':'builds'}; CSV mismatches: ${r.csv_flags?.length?r.csv_flags.join(', '):'none'}`);
  for(const t of r.tieouts_failed)console.log('   tie-out failed:',t);
  if(r.row_blocked)for(const b of r.blockers.slice(0,10))console.log('   blocker:',b);
 }
}
