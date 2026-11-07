import http from 'node:http';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseCSV} from './lib/csv.js';
import {analyzeInvoices,runway} from './lib/finance.js';
import {authenticate,checked,importRows} from './lib/supabase.js';
import {validateDocument,uploadDocument,startParse,getParse,saveText,extractParseText} from './lib/documents.js';
import {searchEvidence} from './lib/citations.js';
import {monitorCovenants,covenantColumnsError} from './lib/covenants.js';
import {recommendCovenants} from './lib/recommend.js';
// Default monitoring data: the organizer's loan_covenants.csv values plus team-made synthetic FCCR, current ratio
// and revolver columns (scripts/make-extended-fixture.js). Definitions missing from the organizer policy come
// from a team-written synthetic addendum, cited separately.
const DEFAULT_CSV='./data/team/loan_covenants_extended.csv',ADDENDUM='team/covenant-policy-addendum.txt',SAMPLE_STATEMENTS='./data/team/sample-statements.csv';
const rdData=n=>fs.readFile(new URL(n,import.meta.url),'utf8');
const addendum=async()=>[{name:ADDENDUM,text:await rdData('./data/'+ADDENDUM)}];
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>7_100_000)throw Error('Request exceeds 7 MB');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
// One request handler shared by the local server (createServer) and the Vercel function (api/index.js).
export async function handleRequest(req,res){
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 try{
  // Local backend only. Reject browser cross-origin calls; no wildcard CORS.
  if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(403,{error:'Cross-origin requests disabled'});
  const url=new URL(req.url,'http://localhost');const p=url.pathname;
  if(req.method==='GET'&&p==='/api/health')return send(200,{ok:true,mode:'backend-only',supabaseConfigured:Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_PUBLISHABLE_KEY),llamaParseConfigured:Boolean(process.env.LLAMA_CLOUD_API_KEY),note:'Configured does not mean connection verified.'});
  if(req.method==='GET'&&p==='/api/sample')return send(200,analyzeInvoices(parseCSV(await fs.readFile(new URL('./data/invoices.csv',import.meta.url),'utf8'))));
  if(req.method==='POST'&&p==='/api/analyze'){const b=await body(req);return send(200,analyzeInvoices(parseCSV(b.csv),{asOf:b.asOf||'2026-09-30'}));}
  if(req.method==='GET'&&p==='/api/covenants')return send(200,monitorCovenants(parseCSV(await rdData(DEFAULT_CSV)),await rdData('./data/documents/loan-policy.txt'),{supplements:await addendum()}));
  if(req.method==='POST'&&p==='/api/covenants'){const b=await body(req);const rd=n=>fs.readFile(new URL(n,import.meta.url),'utf8');if(b.csv!==undefined&&typeof b.csv!=='string')throw Error('csv must be a string');if(b.policy!==undefined&&(typeof b.policy!=='string'||b.policy.length>2_000_000))throw Error('policy must be text under 2 million characters');if(b.csv!==undefined){const e=covenantColumnsError(b.csv);if(e)return send(400,{error:e});}const csv=b.csv??await rd(DEFAULT_CSV);const rows=parseCSV(csv);if(!rows.length)return send(400,{error:'The CSV has a header row but no data rows.'});const custom=typeof b.policy==='string';return send(200,monitorCovenants(rows,custom?b.policy:await rd('./data/documents/loan-policy.txt'),{sourceDocument:custom?(typeof b.policy_name==='string'&&/^[A-Za-z0-9_. -]{1,100}$/.test(b.policy_name)?b.policy_name:'uploaded-policy'):undefined,supplements:custom?[]:await addendum(),settings:b.settings}));}
  // Covenant Designer: statements CSV in, recommended covenant package out. Stateless; nothing is stored.
  if(req.method==='GET'&&p==='/api/recommend/sample')return send(200,{name:'sample-statements.csv',csv:await rdData(SAMPLE_STATEMENTS)});
  if(req.method==='POST'&&p==='/api/recommend'){const b=await body(req);if(typeof b.csv!=='string')throw Error('csv (the statements file as text) is required');return send(200,recommendCovenants(b.csv,{cushion_pct:b.cushion_pct??undefined,company:b.company??null}));}
  // Stateless policy parsing (no database). PDF goes to LlamaParse and may incur account usage; TXT is returned as-is.
  if(req.method==='POST'&&p==='/api/policy/parse'){const b=await body(req);if(typeof b.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)||typeof b.filename!=='string')throw Error('filename and base64 file required');const bytes=Buffer.from(b.base64,'base64');if(/\.txt$/i.test(b.filename)){validateDocument(bytes,b.filename);return send(200,{status:'completed',text:bytes.toString('utf8')});}if(!/\.pdf$/i.test(b.filename))throw Error('Use a PDF or TXT policy');if(!process.env.LLAMA_CLOUD_API_KEY)return send(503,{error:'PDF parsing is not enabled on this server (LLAMA_CLOUD_API_KEY is not set). Upload the policy as a .txt file instead, or add the key to the server environment.'});const r=await startParse(bytes,b.filename);const id=r?.job?.id||r?.id||r?.job_id;if(!id)return send(502,{error:'Parser did not return a job id',providerResult:r});return send(202,{status:'pending',job_id:id});}
  const pm=p.match(/^\/api\/policy\/parse\/([A-Za-z0-9-]+)$/);
  if(req.method==='GET'&&pm){const r=await getParse(pm[1]);const st=String(r?.job?.status||r?.status||'unknown').toLowerCase();if(/fail|error|cancel/.test(st))return send(200,{status:'failed',providerResult:r});if(!/complete|success/.test(st))return send(200,{status:'pending'});const text=extractParseText(r);if(!text)return send(200,{status:'failed',error:'Parser finished but no text was found in the response; review providerResult.',providerResult:r});return send(200,{status:'completed',text});}
  if(req.method==='POST'&&p==='/api/runway')return send(200,runway(await body(req)));
  if(req.method==='GET'&&(p==='/'||p==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"});return res.end(await fs.readFile(new URL('./public/index.html',import.meta.url)));}
  if(!p.startsWith('/api/'))return send(404,{error:'Not found. UI is at /, API under /api/. See README.txt.'});
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)return send(401,{error:'Signed-in Supabase user token required'});
  let db;try{db=await authenticate(token);}catch{return send(401,{error:'Supabase configuration or user authentication failed'});}
  if(p==='/api/teams'&&req.method==='GET')return send(200,checked(await db.from('rhb_teams').select('*')));
  if(p==='/api/teams'&&req.method==='POST'){const b=await body(req);if(typeof b.name!=='string'||!b.name.trim())throw Error('Team name required');return send(201,checked(await db.from('rhb_teams').insert({name:b.name}).select().single()));}
  if(p==='/api/members'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||!uuid(b.user_id))throw Error('Valid team and signed-up user UUIDs required');return send(201,checked(await db.from('rhb_members').insert({team_id:b.team_id,user_id:b.user_id}).select()));}
  if(p==='/api/datasets/import'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.name!=='string'||b.name.length>100)throw Error('Valid team ID and dataset name required');return send(200,await importRows(db,b.team_id,b.name,parseCSV(b.csv)));}
  if(p==='/api/documents'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64))throw Error('Team ID and base64 file required');return send(201,await uploadDocument(db,b.team_id,Buffer.from(b.base64,'base64'),b.filename));}
  const match=p.match(/^\/api\/documents\/([0-9a-f-]+)\/(parse|result)$/i);
  if(match){const doc=checked(await db.from('rhb_documents').select('*').eq('id',match[1]).single());
   if(req.method==='POST'&&match[2]==='parse'){
    if(doc.status==='parsed'||doc.status==='parsing')return send(200,{status:doc.status,job_id:doc.parser_job_id});
    const claimed=checked(await db.from('rhb_documents').update({status:'parsing'}).eq('id',doc.id).eq('status',doc.status).select());if(!claimed.length)return send(409,{error:'Another parse is in progress'});
    try{const blob=checked(await db.storage.from('rhb-documents').download(doc.storage_path));
     if(doc.media_type!=='application/pdf')return send(200,await saveText(db,doc,await blob.text()));
     const job=await startParse(Buffer.from(await blob.arrayBuffer()),doc.filename);if(!job.id)throw Error('Parser did not return a job ID');
     checked(await db.from('rhb_documents').update({parser_job_id:job.id}).eq('id',doc.id));return send(202,{status:job.status,job_id:job.id});
    }catch(e){await db.from('rhb_documents').update({status:'failed'}).eq('id',doc.id);throw e;}
   }
   if(req.method==='GET'&&match[2]==='result'){
    if(doc.status==='parsed')return send(200,{status:'parsed',text:doc.parsed_text});
    if(!doc.parser_job_id)return send(200,{status:doc.status});
    const result=await getParse(doc.parser_job_id);
    // Return provider result for explicit schema review; persistence accepts reviewed text via /api/documents/text.
    return send(200,{status:result.job?.status||'unknown',providerResult:result,next:'Review extracted markdown, then POST /api/documents/text with document_id and text.'});
   }
  }
  if(p==='/api/documents/text'&&req.method==='POST'){const b=await body(req);const doc=checked(await db.from('rhb_documents').select('*').eq('id',b.document_id).single());return send(200,await saveText(db,doc,b.text));}
  if(p==='/api/evidence/search'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id)||typeof b.query!=='string')throw Error('Team and query required');const records=checked(await db.from('rhb_evidence').select('*').eq('team_id',b.team_id).limit(1000));return send(200,{method:'keyword search; no LLM',searched:records.length,limit:1000,results:searchEvidence(records,b.query)});}
  if(p==='/api/findings'&&req.method==='POST'){const b=await body(req);if(!uuid(b.team_id))throw Error('Team required');return send(201,checked(await db.from('rhb_findings').insert({team_id:b.team_id,title:b.title,detail:b.detail,severity:b.severity,method:b.method,rule:b.rule}).select().single()));}
  return send(404,{error:'Route not found'});
 }catch(error){send(400,{error:error.message});}
}
export function createServer(){return http.createServer(handleRequest);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){createServer().listen(Number(process.env.PORT)||4180,'127.0.0.1',()=>console.log('Redhawk backend: http://127.0.0.1:'+(process.env.PORT||4180)+'/api/health'));}
