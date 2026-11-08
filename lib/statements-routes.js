// HTTP routes for borrower-statement extraction (server.js delegates /api/statements/* and /statements here).
// LlamaExtract only reads the PDF; every figure returned below is computed by lib/statements.js on the server.
// The browser sends which values the analyst confirmed, never the numbers themselves.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseCSV} from './csv.js';
import {validateDocument} from './documents.js';
import {startExtract,getExtractJob,jobStatus,normalizeExtraction,computeStatement,loadDefinitions,parseStatementName,EXTRACT_CONFIG} from './statements.js';

const ROOT=new URL('../',import.meta.url);
const rd=n=>fs.readFile(new URL(n,ROOT),'utf8');
const savedDir=()=>process.env.STATEMENTS_SAVED_DIR||fileURLToPath(new URL('data/statements/',ROOT));
const SAVED_NAME=/^[A-Za-z0-9_-]{1,80}$/;
const ITEM_ID=/^\d{4}-Q[1-4]:[a-z_]{1,40}$/;
const keySet=()=>Boolean(process.env.LLAMA_CLOUD_API_KEY);
const NO_KEY='Statement extraction is not enabled on this server (LLAMA_CLOUD_API_KEY is not set). Saved extractions are still available under GET /api/statements/saved.';

async function context(){
 return {csvRows:parseCSV(await rd('data/team/loan_covenants_extended.csv')),definitionsText:await loadDefinitions(),
  policyText:await rd('data/documents/loan-policy.txt'),addendumText:await rd('data/team/covenant-policy-addendum.txt')};
}
// Which borrower and quarter: explicit parameters first, then the PDF name (BOR-09_2026-Q3.pdf).
function identify({name,borrower_id,period}){
 const fromName=parseStatementName(name)||{};
 const b=borrower_id||fromName.borrower_id,p=period||fromName.period;
 if(!b||!p)throw Error('Name the PDF like BOR-09_2026-Q3.pdf, or pass borrower_id and period (for example 2026-Q3).');
 return {borrower_id:b,period:p};
}
async function review(job,{name,borrower_id,period,confirmed=[],synthetic,settings}){
 const id=identify({name,borrower_id,period});
 const r=computeStatement(normalizeExtraction(job),{...id,source_document:name||'',confirmed,synthetic,settings,...await context()});
 return r;
}
async function readSaved(name){
 if(typeof name!=='string'||!SAVED_NAME.test(name))throw Error('Saved extraction name must be letters, digits, - or _');
 let j;try{j=JSON.parse(await fs.readFile(path.join(savedDir(),name+'.extracted.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('Saved extraction could not be read');}
 return j;
}
const savedSummary=(name,j)=>({name,pdf:j.pdf??null,pdf_sha256:j.pdf_sha256??null,extracted_at:j.extracted_at??null,
 configuration:j.configuration?{tier:j.configuration.tier??null,version:j.configuration.version??null,cite_sources:j.configuration.cite_sources??null,confidence_scores:j.configuration.confidence_scores??null}:null,
 synthetic:j.synthetic===true,...(parseStatementName(j.pdf||name)||{})});
const confirmedList=c=>{
 if(c===undefined)return [];
 if(!Array.isArray(c)||c.length>5000||!c.every(x=>typeof x==='string'&&ITEM_ID.test(x)))throw Error('confirmed must be a list of item ids like "2026-Q3:capex"');
 return c;
};

export async function handleStatements(req,res,{url,send,body,CSP}){
 const p=url.pathname;
 // Review screen, served with the same headers and CSP as /app.
 if(req.method==='GET'&&['/statements','/statements/','/statements.html'].includes(p)){
  let html;try{html=await fs.readFile(new URL('public/statements.html',ROOT));}catch{return send(404,{error:'Not found'});}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':CSP});return res.end(html);
 }
 const upstream=async f=>{try{return await f();}catch(e){return {__error:e.message};}};

 // Start a live extraction. Same size, filename and base64 checks as /api/policy/parse.
 if(req.method==='POST'&&p==='/api/statements/extract'){
  const b=await body(req);
  if(typeof b.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)||typeof b.filename!=='string')throw Error('filename and base64 file required');
  if(!/\.pdf$/i.test(b.filename))throw Error('Statements must be a PDF');
  if(!keySet())return send(503,{error:NO_KEY});
  const bytes=Buffer.from(b.base64,'base64');validateDocument(bytes,b.filename);
  const r=await upstream(()=>startExtract(bytes,b.filename));
  if(r.__error)return send(502,{error:r.__error});
  return send(202,{status:'pending',job_id:r.job_id,name:b.filename,...(parseStatementName(b.filename)||{})});
 }
 // Poll a live job. When complete, returns the review list, computed inputs and tie-outs (nothing confirmed yet).
 if(req.method==='GET'&&p==='/api/statements/job'){
  const id=url.searchParams.get('id');if(!id||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw Error('id (extract job id) required');
  if(!keySet())return send(503,{error:NO_KEY});
  const job=await upstream(()=>getExtractJob(id));if(job.__error)return send(502,{error:job.__error});
  const status=jobStatus(job);
  if(status==='pending')return send(200,{status,job_id:id});
  if(status==='failed')return send(200,{status,job_id:id,error:job.error_message||'Extraction failed'});
  const q=k=>url.searchParams.get(k)||undefined;
  return send(200,{status,job_id:id,...await review(job,{name:q('name'),borrower_id:q('borrower_id'),period:q('period'),synthetic:'unknown'})});
 }
 // Analyst confirmation: the server reloads the extraction itself and computes the row, tie-outs and engine result.
 if(req.method==='POST'&&p==='/api/statements/confirm'){
  const b=await body(req);const confirmed=confirmedList(b.confirmed);
  const opt={borrower_id:b.borrower_id,period:b.period,confirmed,settings:b.settings};
  if(typeof b.saved==='string'){
   const j=await readSaved(b.saved);if(!j)return send(404,{error:`No saved extraction named ${b.saved}`});
   return send(200,await review(j,{...opt,name:j.pdf||b.saved,synthetic:j.synthetic===true?'true':'unknown'}));
  }
  if(typeof b.job_id==='string'){
   if(!/^[A-Za-z0-9_-]{1,100}$/.test(b.job_id))throw Error('Invalid job id');
   if(!keySet())return send(503,{error:NO_KEY});
   const job=await upstream(()=>getExtractJob(b.job_id));if(job.__error)return send(502,{error:job.__error});
   if(jobStatus(job)!=='completed')return send(409,{error:'The extraction has not completed yet.'});
   return send(200,await review(job,{...opt,name:typeof b.name==='string'?b.name:undefined,synthetic:'unknown'}));
  }
  throw Error('Pass saved (a saved extraction name) or job_id');
 }
 // Saved extractions (data/statements/*.extracted.json), for when no key is configured.
 if(req.method==='GET'&&p==='/api/statements/saved'){
  const name=url.searchParams.get('name');
  if(name){const j=await readSaved(name);if(!j)return send(404,{error:`No saved extraction named ${name}`});
   return send(200,{saved:savedSummary(name,j),...await review(j,{name:j.pdf||name,synthetic:j.synthetic===true?'true':'unknown'})});}
  let files=[];try{files=(await fs.readdir(savedDir())).filter(f=>/^[A-Za-z0-9_-]{1,80}\.extracted\.json$/.test(f)).sort();}catch{}
  const saved=[];for(const f of files){const n=f.replace(/\.extracted\.json$/,'');try{saved.push(savedSummary(n,await readSaved(n)));}catch{saved.push({name:n,error:'unreadable'});}}
  return send(200,{llama_configured:keySet(),configuration:{tier:EXTRACT_CONFIG.tier,version:EXTRACT_CONFIG.version},saved});
 }
 return send(404,{error:'Statements route not found'});
}
