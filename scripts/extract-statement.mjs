// Run one live LlamaExtract extraction of a statements PDF and save the raw result for offline review.
//   node --env-file=.env scripts/extract-statement.mjs data/statements/BOR-09_2026-Q3.pdf
// Writes data/statements/<name>.extracted.json with the PDF's SHA-256, the configuration and version used,
// extracted_at, and the raw extract_result and extract_metadata (citations and confidence scores).
// LlamaExtract only reads; lib/statements.js does every calculation. The API key is never printed or saved.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from '../lib/citations.js';
import {startExtract,pollExtract,loadSchema,EXTRACT_CONFIG,normalizeExtraction,reviewItems,citationSummary,LOCATION_ONLY_LIMITATION} from '../lib/statements.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));

export async function extractToFile(pdfPath,{outDir=path.join(ROOT,'data','statements'),now=()=>new Date(),log=console.log,...opts}={}){
 const bytes=await fs.readFile(pdfPath);const pdf=path.basename(pdfPath);
 const name=pdf.replace(/\.pdf$/i,'');
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(name))throw Error('Use a PDF named like BOR-09_2026-Q3.pdf');
 const schema=await loadSchema();
 // Synthetic if this is one of the team's generated fixtures (scripts/make-statement-fixtures.py).
 let synthetic=false;
 try{const fx=JSON.parse(await fs.readFile(path.join(ROOT,'data','statements','fixtures.json'),'utf8'));synthetic=Object.values(fx.borrowers).some(b=>b.pdf===pdf);}catch{}
 log(`Uploading ${pdf} (${bytes.length} bytes, sha256 ${sha256(bytes).slice(0,12)}…) to LlamaExtract (tier ${EXTRACT_CONFIG.tier}, version ${EXTRACT_CONFIG.version})`);
 const started=await startExtract(bytes,pdf,{...opts,schema});
 log(`Extract job ${started.job_id} created; polling…`);
 const job=await pollExtract(started.job_id,{...opts});
 const out={pdf,pdf_sha256:sha256(bytes),synthetic,extracted_at:now().toISOString(),
  configuration:{...EXTRACT_CONFIG},version:EXTRACT_CONFIG.version,schema_sha256:sha256(JSON.stringify(schema)),
  job_id:job.id??started.job_id,file_id:started.file_id,status:job.status,
  extract_result:job.extract_result??null,extract_metadata:job.extract_metadata??null,
  note:'Raw LlamaExtract output. Values are not confirmed; confirm each one on /statements before it is used.'};
 // Record how many values were only located (page + bounding box, no quoted text): a known limitation.
 out.citation_summary={...citationSummary(reviewItems(normalizeExtraction(out))),known_limitation:LOCATION_ONLY_LIMITATION};
 const file=path.join(outDir,`${name}.extracted.json`);
 await fs.writeFile(file,JSON.stringify(out,null,1)+'\n');
 const n=normalizeExtraction(out),items=reviewItems(n);
 log(`Saved ${path.relative(ROOT,file)}: ${Object.keys(n.quarters).length} quarters, ${items.length} values; ${out.citation_summary.message}.`);
 for(const p of n.problems)log(`  note: ${p}`);
 return {file,out};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pdf=process.argv[2];
 if(!pdf){console.error('Usage: node --env-file=.env scripts/extract-statement.mjs data/statements/BOR-09_2026-Q3.pdf');process.exit(2);}
 if(!process.env.LLAMA_CLOUD_API_KEY){console.error('LLAMA_CLOUD_API_KEY is not set. Run with --env-file=.env from the repository folder.');process.exit(2);}
 extractToFile(pdf).catch(e=>{console.error('Extraction failed:',e.message);process.exit(1);});
}
