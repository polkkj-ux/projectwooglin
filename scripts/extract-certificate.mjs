// Run one live LlamaExtract extraction of a compliance certificate, save the raw result, and rebuild
// data/statements/certificates.extracted.csv from every saved certificate.
//   node --env-file=.env scripts/extract-certificate.mjs data/statements/certificates/BOR-09_2026-Q3_certificate.pdf
//   node scripts/extract-certificate.mjs --csv      (rebuild the CSV and print the checks; no network, no key)
// The raw extraction (with every citation and confidence score) goes to
// data/statements/certificates/<name>.extracted.json. The API key is never printed or saved.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from '../lib/citations.js';
import {parseCSV} from '../lib/csv.js';
import {startExtract,pollExtract} from '../lib/statements.js';
import {CERT_CONFIG,loadCertificateSchema,normalizeCertificate,certificateRow,certificatesCSV,checkCertificate} from '../lib/certificates.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const CERT_DIR=path.join(ROOT,'data','statements','certificates');
const CSV_OUT=path.join(ROOT,'data','statements','certificates.extracted.csv');
const NAME=/^[A-Za-z0-9_-]{1,80}$/;
const csvRows=async()=>parseCSV(await fs.readFile(path.join(ROOT,'data','team','loan_covenants_extended.csv'),'utf8'));
const idFromName=n=>{const m=String(n).match(/^([A-Za-z]+-\d+)_(\d{4}-Q[1-4])_certificate/);return m?{borrower_id:m[1],period:m[2]}:{};};

export async function extractCertificateToFile(pdfPath,{outDir=CERT_DIR,now=()=>new Date(),log=console.log,...opts}={}){
 const bytes=await fs.readFile(pdfPath);const pdf=path.basename(pdfPath);const name=pdf.replace(/\.pdf$/i,'');
 if(!NAME.test(name))throw Error('Use a PDF named like BOR-09_2026-Q3_certificate.pdf');
 const schema=await loadCertificateSchema();
 let synthetic=false;
 try{synthetic=JSON.parse(await fs.readFile(path.join(CERT_DIR,'certificate-fixture.json'),'utf8')).pdf===pdf;}catch{}
 log(`Uploading ${pdf} (${bytes.length} bytes, sha256 ${sha256(bytes).slice(0,12)}…) to LlamaExtract (tier ${CERT_CONFIG.tier}, version ${CERT_CONFIG.version})`);
 const started=await startExtract(bytes,pdf,{...opts,schema,config:CERT_CONFIG});
 log(`Extract job ${started.job_id} created; polling…`);
 const job=await pollExtract(started.job_id,{...opts});
 const out={pdf,pdf_sha256:sha256(bytes),synthetic,extracted_at:now().toISOString(),kind:'compliance_certificate',
  configuration:{...CERT_CONFIG},version:CERT_CONFIG.version,schema_sha256:sha256(JSON.stringify(schema)),
  job_id:job.id??started.job_id,file_id:started.file_id,status:job.status,
  extract_result:job.extract_result??null,extract_metadata:job.extract_metadata??null,
  note:'Raw LlamaExtract output of a borrower compliance certificate. These are the borrower’s claims, not confirmed values.'};
 out.citation_summary=checkCertificate(normalizeCertificate(out)).citation_summary;
 await fs.mkdir(outDir,{recursive:true});
 const file=path.join(outDir,`${name}.extracted.json`);
 await fs.writeFile(file,JSON.stringify(out,null,1)+'\n');
 log(`Saved ${path.relative(ROOT,file)}; ${out.citation_summary.message}.`);
 return {file,out};
}

// Rebuild the CSV (exactly CERT_COLUMNS) from every saved certificate extraction, and return the checks.
export async function buildCertificatesCSV({dir=CERT_DIR,csvOut=CSV_OUT,rows,settings}={}){
 rows??=await csvRows();
 let files=[];try{files=(await fs.readdir(dir)).filter(f=>/^[A-Za-z0-9_-]{1,80}\.extracted\.json$/.test(f)).sort();}catch{}
 const out=[],reports=[];
 for(const f of files){
  const saved=JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));
  const norm=normalizeCertificate(saved);const id=idFromName(saved.pdf||f);
  const row=certificateRow(norm,{csvRows:rows,synthetic:saved.synthetic===true?'true':'unknown',...id});
  const csvRow=rows.find(r=>r.record_id===row.record_id);
  out.push(row);reports.push({file:f,row,problems:norm.problems,...checkCertificate(norm,{csvRow,settings})});
 }
 if(csvOut)await fs.writeFile(csvOut,certificatesCSV(out));
 return {rows:out,reports};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const arg=process.argv[2];
 const report=async()=>{const {reports}=await buildCertificatesCSV();
  console.log(`Wrote ${path.relative(ROOT,CSV_OUT)} (${reports.length} certificate${reports.length===1?'':'s'}).`);
  for(const r of reports){console.log(`\n${r.file}: ${r.citation_summary.message}`);for(const p of r.problems)console.log(`  note: ${p}`);
   for(const c of r.checks)console.log(`  ${c.status.toUpperCase().padEnd(7)} ${c.label}: ${c.detail}`);}};
 if(arg==='--csv')report().catch(e=>{console.error('Failed:',e.message);process.exit(1);});
 else if(!arg){console.error('Usage: node --env-file=.env scripts/extract-certificate.mjs data/statements/certificates/BOR-09_2026-Q3_certificate.pdf');process.exit(2);}
 else if(!process.env.LLAMA_CLOUD_API_KEY){console.error('LLAMA_CLOUD_API_KEY is not set. Run with --env-file=.env from the repository folder.');process.exit(2);}
 else extractCertificateToFile(arg).then(report).catch(e=>{console.error('Extraction failed:',e.message);process.exit(1);});
}
