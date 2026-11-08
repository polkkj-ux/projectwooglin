// Test helper (not a test file): builds a mocked LlamaExtract v2 job result from the synthetic fixture
// numbers in data/statements/fixtures.json, shaped like GET /api/v2/extract/{id}?expand=extract_metadata.
import fs from 'node:fs/promises';
import {amount} from '../lib/finance.js';
import {ITEM_KEYS,TIEOUT_KEYS,labelOf} from '../lib/statements.js';
export const fixtures=JSON.parse(await fs.readFile(new URL('../data/statements/fixtures.json',import.meta.url),'utf8'));
// Lines the PDF prints as outflows (in parentheses).
const PRINTED_NEGATIVE=new Set(['capex','distributions']);
export const printed=cents=>{const n=BigInt(cents),neg=n<0n,s=amount(neg?-n:n).replace(/\B(?=(\d{3})+(?!\d))(?=.*\.)/g,',');return neg?`(${s})`:s;};
// Deterministic pseudo-confidence in [0.80, 0.99].
const conf=(q,k)=>{let h=0;for(const ch of q+k)h=(h*31+ch.charCodeAt(0))>>>0;return 0.8+(h%20)/100;};
export function mockJob(id,{mutate}={}){
 const b=fixtures.borrowers[id];const quarters=[],meta=[];
 for(const q of fixtures.quarters){const src=b.quarters[q],row={period:q},m={period:{citation:[{page:1,matching_text:q}],confidence:0.99}};
  for(const k of [...ITEM_KEYS,...TIEOUT_KEYS]){if(src[k]===undefined)continue;
   const v=PRINTED_NEGATIVE.has(k)?-BigInt(src[k]):BigInt(src[k]);row[k]=printed(v);
   m[k]={citation:[{page:b.pages[k],matching_text:`${labelOf(k)} ${printed(v)}`,bounding_boxes:[{x:0,y:0,w:1,h:1}]}],confidence:conf(q,k)};}
  quarters.push(row);meta.push(m);}
 const job={id:'ext-mock-'+id,status:'COMPLETED',file_input:'dfl-mock',extract_result:{quarters},extract_metadata:{field_metadata:{document_metadata:{quarters:meta}},parse_job_id:'pjb-mock'},error_message:null};
 if(mutate)mutate(job,{q:p=>quarters[fixtures.quarters.indexOf(p)],m:p=>meta[fixtures.quarters.indexOf(p)]});
 return job;
}
export const allConfirmable=items=>items.filter(i=>i.confirmable).map(i=>i.id);
