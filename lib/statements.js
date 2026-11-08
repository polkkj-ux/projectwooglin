// Borrower statements: LlamaExtract reads a financial-statements PDF into quarterly line items with page
// citations and confidence scores; this module does every calculation. LlamaExtract never computes a
// covenant figure, and nothing is auto-accepted: an analyst confirms each value, and a value without a
// citation cannot be confirmed. Money is BigInt cents throughout (lib/finance.js).
import fs from 'node:fs/promises';
import {amount,minor} from './finance.js';
import {sha256} from './citations.js';
import {validateDocument} from './documents.js';
import {ITEMS,LABEL,OUTFLOWS,money,recommendCovenants,readStatements} from './recommend.js';
import {evaluateRow} from './covenants.js';

// ---------------------------------------------------------------------------------------------------
// (a) LlamaExtract v2 REST client. Endpoints and field names from developers.llamaindex.ai
// (llamaparse/extract/api and guides/response-format); exercised only against mocked responses here.
// ---------------------------------------------------------------------------------------------------
export const LLAMA_BASE='https://api.cloud.llamaindex.ai';
// Pinned extraction configuration. cite_sources and confidence_scores default to false in the API.
export const EXTRACT_CONFIG=Object.freeze({tier:'agentic',version:'2.5',extraction_target:'per_doc',cite_sources:true,confidence_scores:true,
 system_prompt:'These are quarterly financial statements with one column per quarter. Return one entry in quarters per quarterly column. Copy every amount exactly as printed; never calculate, total or estimate a value.'});
const TERMINAL=new Set(['COMPLETED','FAILED','CANCELLED']);
const JOB_ID=/^[A-Za-z0-9_-]{1,100}$/;

async function llama(path,{key,fetcher=fetch,project=process.env.LLAMA_CLOUD_PROJECT_ID,...init}){
 if(!key)throw Error('LLAMA_CLOUD_API_KEY is not set');
 const url=new URL(path,LLAMA_BASE);if(project)url.searchParams.set('project_id',project);
 const r=await fetcher(url,{...init,headers:{Authorization:`Bearer ${key}`,accept:'application/json',...init.headers},signal:init.signal||AbortSignal.timeout(60000)});
 if(!r.ok){let detail='';try{detail=(await r.text()).slice(0,500);}catch{}throw Error(`LlamaCloud HTTP ${r.status} on ${url.pathname}${detail?`: ${detail}`:''}`);}
 return r.json();
}
export async function uploadFile(bytes,filename,{key=process.env.LLAMA_CLOUD_API_KEY,fetcher,project}={}){
 if(validateDocument(bytes,filename)!=='application/pdf')throw Error('Statements must be a PDF');
 const form=new FormData();form.append('file',new Blob([bytes],{type:'application/pdf'}),filename);form.append('purpose','extract');
 const r=await llama('/api/v1/beta/files',{key,fetcher,project,method:'POST',body:form});
 if(typeof r?.id!=='string')throw Error('LlamaCloud upload did not return a file id');return r.id;
}
export async function createExtractJob(fileId,schema,{key=process.env.LLAMA_CLOUD_API_KEY,fetcher,project,config=EXTRACT_CONFIG}={}){
 if(typeof fileId!=='string'||!JOB_ID.test(fileId))throw Error('Invalid file id');
 const r=await llama('/api/v2/extract',{key,fetcher,project,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_input:fileId,configuration:{...config,data_schema:schema}})});
 if(typeof r?.id!=='string')throw Error('LlamaCloud did not return an extract job id');return r;
}
export function getExtractJob(jobId,{key=process.env.LLAMA_CLOUD_API_KEY,fetcher,project}={}){
 if(typeof jobId!=='string'||!JOB_ID.test(jobId))throw Error('Invalid job id');
 return llama(`/api/v2/extract/${jobId}?expand=extract_metadata`,{key,fetcher,project});
}
export const loadSchema=async()=>JSON.parse(await fs.readFile(new URL('../data/statements/schema.json',import.meta.url),'utf8'));
// Upload + create job. Returns the job id; the caller polls.
export async function startExtract(bytes,filename,opts={}){
 const fileId=await uploadFile(bytes,filename,opts);
 const job=await createExtractJob(fileId,opts.schema||await loadSchema(),opts);
 return {job_id:job.id,file_id:fileId,status:job.status||'PENDING'};
}
export async function pollExtract(jobId,{interval=3000,timeout=600000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),...opts}={}){
 const t0=Date.now();
 for(;;){const job=await getExtractJob(jobId,opts);const st=String(job?.status||'').toUpperCase();
  if(TERMINAL.has(st)){if(st!=='COMPLETED')throw Error(`Extract job ${jobId} ${st}${job.error_message?`: ${job.error_message}`:''}`);return job;}
  if(Date.now()-t0>timeout)throw Error(`Extract job ${jobId} still ${st||'unknown'} after ${Math.round(timeout/1000)} s`);
  await sleep(interval);}
}
export const jobStatus=job=>{const st=String(job?.status||'UNKNOWN').toUpperCase();return st==='COMPLETED'?'completed':/FAIL|CANCEL/.test(st)?'failed':'pending';};

// ---------------------------------------------------------------------------------------------------
// (b) Schema fields: exactly the Covenant Designer's ITEMS keys, plus fields used only for tie-outs.
// ---------------------------------------------------------------------------------------------------
export const ITEM_KEYS=Object.keys(ITEMS);
export const TIEOUT_KEYS=['operating_expenses','total_liabilities','total_equity','total_liabilities_and_equity','term_loan','finance_lease','change_in_working_capital'];
const TIEOUT_LABEL={operating_expenses:'Total operating expenses',total_liabilities:'Total liabilities',total_equity:'Total equity',total_liabilities_and_equity:'Total liabilities and equity',term_loan:'Term loan',finance_lease:'Finance lease liabilities',change_in_working_capital:'Decrease (increase) in operating working capital'};
export const labelOf=k=>LABEL[k]||TIEOUT_LABEL[k]||k;
// Flow items are summed over four quarters; the rest are period-end balances.
const FLOWS=new Set(['revenue','ebitda','operating_income','depreciation_amortization','net_income','income_tax_expense','interest_expense','scheduled_principal','capex','cash_taxes','distributions','operating_expenses','change_in_working_capital']);

// ---------------------------------------------------------------------------------------------------
// (c) Pure functions.
// ---------------------------------------------------------------------------------------------------
const PERIOD=/^(\d{4})-Q([1-4])$/;
export function normalizePeriod(p){
 const t=String(p??'').trim().toUpperCase();let m;
 if((m=t.match(/^(\d{4})\s*-?\s*Q([1-4])$/)))return `${m[1]}-Q${m[2]}`;
 if((m=t.match(/^Q([1-4])\s*[-\s]?\s*(?:FY)?\s*(\d{4})$/)))return `${m[2]}-Q${m[1]}`;
 return null;
}
const prevPeriod=p=>{const [,y,q]=p.match(PERIOD);return q==='1'?`${Number(y)-1}-Q4`:`${y}-Q${Number(q)-1}`;};
export const trailingPeriods=p=>{const out=[p];while(out.length<4)out.unshift(prevPeriod(out[0]));return out;};

// Metadata mirrors the data; arrays have been documented as nested arrays and as "quarters[0]" keys,
// so accept both rather than guess.
function fieldMeta(doc,i,key){
 const q=doc?.quarters;
 return (Array.isArray(q)?q[i]?.[key]:q?.[i]?.[key]??q?.[String(i)]?.[key])??doc?.[`quarters[${i}]`]?.[key]??doc?.[`quarters[${i}].${key}`]??doc?.[`quarters.${i}.${key}`]??null;
}
const blankValue=v=>v===undefined||v===null||(typeof v==='string'&&/^\s*(|-|—|–|n\/?a|null)\s*$/i.test(v));
function toCents(raw,key){
 if(typeof raw==='number'){if(!Number.isFinite(raw)||Math.abs(raw)>=1e13)throw Error('number out of range');raw=String(raw);}
 let v=money(raw);const notes=[];
 if(OUTFLOWS.has(key)&&v<0n){v=-v;notes.push('printed as an outflow; its size is used');}
 return {cents:v,notes};
}

// Raw LlamaExtract job -> per-quarter line items, each {value, page, matching_text, confidence}.
export function normalizeExtraction(job){
 const res=job?.extract_result;const data=Array.isArray(res)?res[0]:res;
 const doc=job?.extract_metadata?.field_metadata?.document_metadata??job?.extract_metadata?.field_metadata??{};
 const problems=[],quarters={};
 const rows=Array.isArray(data?.quarters)?data.quarters:[];
 if(!rows.length)problems.push('The extraction returned no quarterly columns.');
 rows.forEach((q,i)=>{
  const period=normalizePeriod(q?.period);
  if(!period){problems.push(`Column ${i+1}: period "${q?.period??''}" is not a quarter like 2026-Q3; column ignored.`);return;}
  if(quarters[period]){problems.push(`${period} appears twice; the second column is ignored so the tool does not have to guess.`);return;}
  const items={};
  for(const key of [...ITEM_KEYS,...TIEOUT_KEYS]){
   const raw=q?.[key];if(blankValue(raw))continue;
   const meta=fieldMeta(doc,i,key)||{};
   const cits=(Array.isArray(meta.citation)?meta.citation:Array.isArray(meta.citations)?meta.citations:meta.citation?[meta.citation]:[])
    .filter(c=>Number.isInteger(c?.page)&&c.page>=1&&typeof c?.matching_text==='string'&&c.matching_text.trim());
   const conf=typeof meta.confidence==='number'&&meta.confidence>=0&&meta.confidence<=1?meta.confidence:null;
   const item={period,key,label:labelOf(key),raw:String(raw),value:null,page:cits[0]?.page??null,matching_text:cits[0]?.matching_text??null,confidence:conf,citations:cits.map(c=>({page:c.page,matching_text:c.matching_text})),notes:[]};
   try{const {cents,notes}=toCents(raw,key);item.value=amount(cents);item.notes.push(...notes);}catch(e){item.notes.push(`Not an amount: ${e.message}`);}
   items[key]=item;
  }
  quarters[period]={period,column:i+1,items};
 });
 return {quarters,problems};
}

const idOf=(period,key)=>`${period}:${key}`;
export const confirmable=it=>it.value!==null&&Number.isInteger(it.page)&&typeof it.matching_text==='string'&&it.matching_text.trim()!=='';
// Flat review list. Confidence only orders it (lowest and unknown first); nothing is auto-accepted.
export function reviewItems(norm){
 const items=Object.values(norm.quarters).flatMap(q=>Object.values(q.items)).map(it=>({id:idOf(it.period,it.key),...it,
  confirmable:confirmable(it),reason:it.value===null?'The printed text is not an amount.':!confirmable(it)?'No citation (page and matching text), so this value cannot be confirmed.':null}));
 const c=x=>x.confidence??-1;
 return items.sort((a,b)=>c(a)-c(b)||a.period.localeCompare(b.period)||a.key.localeCompare(b.key));
}

// Definitions the calculations rely on, cited by exact character offsets in data/statements/definitions.txt.
export const DEFINITIONS_DOC='statements/definitions.txt';
const DEF_START={ebitda:'EBITDA means',debt:'Gross debt means',debt_service:'Debt service means',available_cash_flow:'Available cash flow means',ttm:'Trailing twelve-month amounts are'};
export function definitionCitations(text){
 const out={};
 for(const [k,start] of Object.entries(DEF_START)){
  const s=text.indexOf(start);if(s<0){out[k]=null;continue;}
  const dot=text.indexOf('.',s);const end=dot<0?text.length:dot+1; // definition sentences contain no decimals
  const quote=text.slice(s,end);out[k]={source_document:DEFINITIONS_DOC,start:s,end,quote,sha256:sha256(quote)};
 }
 return out;
}
export const loadDefinitions=async()=>fs.readFile(new URL('../data/'+DEFINITIONS_DOC,import.meta.url),'utf8');

// Thresholds: from the borrower's CSV row when one exists, otherwise from the policy text.
export function policyThresholds(policyText,addendumText=''){
 const t=`${policyText}\n${addendumText}`;const g=re=>t.match(re)?.[1]??'';
 return {max_leverage:g(/Leverage[^.]*?maximum (\d+\.\d{2})/),min_dscr:g(/DSCR[^.]*?minimum (\d+\.\d{2})/),min_fccr:g(/Fixed Charge Coverage Ratio[^.]*?minimum (\d+\.\d{2})/),min_current_ratio:g(/Current Ratio[^.]*?minimum (\d+\.\d{2})/)};
}

export const CSV_COLUMNS=['record_id','borrower_id','period','currency','debt_usd','ttm_ebitda_usd','ttm_debt_service_usd','ttm_available_cashflow_usd','max_leverage','min_dscr','source_document','synthetic','ttm_capex_usd','ttm_cash_taxes_usd','ttm_distributions_usd','current_assets_usd','current_liabilities_usd','revolver_commitment_usd','revolver_drawn_usd','min_fccr','min_current_ratio'];
const NUMERIC_COLUMNS=['debt_usd','ttm_ebitda_usd','ttm_debt_service_usd','ttm_available_cashflow_usd','ttm_capex_usd','ttm_cash_taxes_usd','ttm_distributions_usd','current_assets_usd','current_liabilities_usd','revolver_commitment_usd','revolver_drawn_usd'];
const BALANCE_TOLERANCE=100n; // $1.00

// The line_item,amount_usd CSV that the Covenant Designer (readStatements) accepts: flow items summed over
// the four quarters, balance items at period end. Only lines whose every value passes `use` are written.
// EBITDA and total debt are not copied from the page: readStatements derives EBITDA from operating income
// + D&A, and total debt is gross debt under the definitions.
export function statementsCSV(norm,periods,{use=()=>true,grossDebt=null}={}){
 const last=periods.at(-1),lines=[];
 for(const key of ITEM_KEYS){
  if(key==='ebitda'||key==='total_debt')continue;
  const its=FLOWS.has(key)?periods.map(p=>norm.quarters[p]?.items[key]):[norm.quarters[last]?.items[key]];
  if(its.some(it=>!it||it.value===null||!use(it)))continue;
  lines.push([LABEL[key],amount(its.reduce((a,it)=>a+minor(it.value,{signed:true}),0n))]);
 }
 if(grossDebt!==null)lines.push([LABEL.total_debt,amount(grossDebt)]);
 return 'line_item,amount_usd\n'+lines.map(([l,v])=>`"${l}",${v}`).join('\n')+'\n';
}

// Compute the covenant inputs and tie-outs, and (when nothing blocks it) the covenant row and engine result.
//   norm:       normalizeExtraction(job)
//   confirmed:  ids ("2026-Q3:capex") the analyst confirmed
//   csvRows:    data/team/loan_covenants_extended.csv rows (for the match tie-out and thresholds)
export function computeStatement(norm,{borrower_id,period,source_document,confirmed=[],csvRows=[],definitionsText,policyText='',addendumText='',synthetic='true',settings}={}){
 if(!/^[A-Za-z0-9_-]{1,40}$/.test(String(borrower_id||'')))throw Error('borrower_id required');
 if(!PERIOD.test(String(period||'')))throw Error('period like 2026-Q3 required');
 const ok=new Set(confirmed);const periods=trailingPeriods(period),last=period;
 const items=reviewItems(norm);const byId=new Map(items.map(i=>[i.id,i]));
 const get=(p,k)=>byId.get(idOf(p,k))??null;
 const val=it=>it&&it.value!==null?minor(it.value,{signed:true}):null;
 const defs=definitionCitations(definitionsText??'');
 const blockers=[...norm.problems.filter(p=>/no quarterly columns/.test(p))],tieouts=[],used=new Set();
 const need=(p,k,why)=>{const it=get(p,k);used.add(idOf(p,k));if(!it){blockers.push(`${labelOf(k)} for ${p} was not extracted (${why}).`);return null;}
  if(it.value===null){blockers.push(`${labelOf(k)} for ${p} is not a readable amount ("${it.raw}").`);return null;}return val(it);};
 const sumFlow=(k,why)=>{let s=0n,missing=false;for(const p of periods){const v=need(p,k,why);if(v===null)missing=true;else s+=v;}return missing?null:s;};
 const missingQ=periods.filter(p=>!norm.quarters[p]);
 if(missingQ.length)blockers.push(`Four consecutive quarters ending ${period} are needed; missing ${missingQ.join(', ')}.`);

 // Inputs under data/statements/definitions.txt.
 const oi=sumFlow('operating_income','EBITDA'),da=sumFlow('depreciation_amortization','EBITDA');
 const interest=sumFlow('interest_expense','debt service'),principal=sumFlow('scheduled_principal','debt service');
 const taxes=sumFlow('cash_taxes','available cash flow and FCCR'),capex=sumFlow('capex','available cash flow and FCCR');
 const wc=sumFlow('change_in_working_capital','available cash flow'),dist=sumFlow('distributions','FCCR');
 const debtParts=['revolver_drawn','term_loan','finance_lease'].filter(k=>get(last,k));
 if(!debtParts.length)blockers.push(`No revolving loan, term loan or finance lease balance was extracted for ${last}, so gross debt cannot be computed.`);
 const partVals=debtParts.map(k=>need(last,k,'gross debt'));
 const debt=debtParts.length&&partVals.every(v=>v!==null)?partVals.reduce((a,v)=>a+v,0n):null;
 const ca=need(last,'current_assets','current ratio'),cl=need(last,'current_liabilities','current ratio');
 const rc=get(last,'revolver_commitment')?need(last,'revolver_commitment','springing trigger'):null;
 const rd=get(last,'revolver_drawn')?val(get(last,'revolver_drawn')):null;

 // EBITDA and debt service come from the Covenant Designer's own derivation (recommend.js) on the TTM
 // line items; the "TTM equals the sum of four quarters" tie-out checks them against the quarterly sums.
 const csvAll=statementsCSV(norm,periods,{grossDebt:debt});
 let designer=null;try{designer=recommendCovenants(csvAll);}catch(e){blockers.push(`The Covenant Designer could not read the TTM line items: ${e.message}`);}
 const fig=k=>{const f=designer?.figures.find(x=>x.key===k);return f?minor(f.amount_usd,{signed:true}):null;};
 const ebitda=fig('ebitda'),service=fig('debt_service');
 const acf=ebitda!==null&&taxes!==null&&capex!==null&&wc!==null?ebitda-taxes-capex+wc:null;

 const tie=(id,label,expected,actual,{blocking=true,tolerance=0n,detail=''}={})=>{
  if(expected===null||actual===null){tieouts.push({id,label,status:'not_available',blocking:false,expected:expected===null?null:amount(expected),actual:actual===null?null:amount(actual),difference:null,detail:detail||'A value needed for this check was not extracted.'});return;}
  const d=actual-expected,pass=(d<0n?-d:d)<=tolerance;
  tieouts.push({id,label,status:pass?'pass':'fail',blocking,expected:amount(expected),actual:amount(actual),difference:amount(d),detail});
  if(!pass&&blocking)blockers.push(`Tie-out failed: ${label} (off by ${amount(d<0n?-d:d)}).`);
 };
 for(const p of periods){const q=k=>val(get(p,k));
  if(!norm.quarters[p])continue;
  tie(`${p}:balance_sheet`,`${p} balance sheet balances (total assets = total liabilities and equity, within $1.00)`,q('total_assets'),q('total_liabilities_and_equity'),{tolerance:BALANCE_TOLERANCE});
  if(q('total_liabilities')!==null&&q('total_equity')!==null)tie(`${p}:liabilities_equity`,`${p} total liabilities + total equity = total liabilities and equity (within $1.00)`,q('total_liabilities')+q('total_equity'),q('total_liabilities_and_equity'),{tolerance:BALANCE_TOLERANCE});
  tie(`${p}:operating_income`,`${p} operating income = revenue − total operating expenses`,q('revenue')!==null&&q('operating_expenses')!==null?q('revenue')-q('operating_expenses'):null,q('operating_income'));
  const parts=['revolver_drawn','term_loan','finance_lease'].map(q).filter(v=>v!==null);
  if(q('total_debt')!==null)tie(`${p}:total_debt`,`${p} printed total debt = revolving loan + term loan + finance leases`,parts.length?parts.reduce((a,v)=>a+v,0n):null,q('total_debt'));
  if(q('ebitda')!==null)tie(`${p}:ebitda`,`${p} printed EBITDA = operating income + D&A`,q('operating_income')!==null&&q('depreciation_amortization')!==null?q('operating_income')+q('depreciation_amortization'):null,q('ebitda'));
 }
 tie('ttm:ebitda','TTM EBITDA (Covenant Designer) = sum of four quarters of operating income + D&A',oi!==null&&da!==null?oi+da:null,ebitda);
 tie('ttm:debt_service','TTM debt service (Covenant Designer) = sum of four quarters of interest + scheduled principal',interest!==null&&principal!==null?interest+principal:null,service);

 // Covenant row in the format of data/team/loan_covenants_extended.csv.
 const existing=csvRows.find(r=>r.borrower_id===borrower_id&&r.period===period);
 const ref=existing||csvRows.filter(r=>r.borrower_id===borrower_id).at(-1);
 const pol=policyThresholds(policyText,addendumText);
 const th=k=>ref?.[k]||pol[k]||'';
 const a=v=>v===null?null:amount(v);
 const candidate={record_id:existing?.record_id||`STM-${borrower_id}-${period}`,borrower_id,period,currency:'USD',
  debt_usd:a(debt),ttm_ebitda_usd:a(ebitda),ttm_debt_service_usd:a(service),ttm_available_cashflow_usd:a(acf),
  max_leverage:th('max_leverage'),min_dscr:th('min_dscr'),source_document:source_document||'',synthetic:String(synthetic),
  ttm_capex_usd:a(capex),ttm_cash_taxes_usd:a(taxes),ttm_distributions_usd:a(dist),current_assets_usd:a(ca),current_liabilities_usd:a(cl),
  revolver_commitment_usd:rc===null?'':amount(rc),revolver_drawn_usd:rd===null?'':amount(rd),min_fccr:th('min_fccr'),min_current_ratio:th('min_current_ratio')};
 // Match against the CSV row when one exists: differences are flagged for the analyst, not blocking.
 if(existing)for(const k of NUMERIC_COLUMNS){const x=candidate[k]??'',y=existing[k]??'';
  if(x===''&&y==='')continue;
  const ex=y===''?null:minor(y,{signed:true}),ac=x===''||x===null?null:minor(x,{signed:true});
  if(ex===null||ac===null){tieouts.push({id:`csv:${k}`,label:`${k} matches the CSV row ${existing.record_id}`,status:'fail',blocking:false,expected:y||null,actual:x||null,difference:null,detail:'Present in one source only.'});continue;}
  tie(`csv:${k}`,`${k} matches the CSV row ${existing.record_id}`,ex,ac,{blocking:false});
 }

 // Confirmation: every value the row uses must be confirmed by the analyst, and must carry a citation.
 const unconfirmed=[...used].filter(id=>byId.has(id)&&!(ok.has(id)&&byId.get(id).confirmable));
 for(const id of unconfirmed){const it=byId.get(id);blockers.push(it.confirmable?`${it.label} for ${it.period} is not confirmed yet.`:`${it.label} for ${it.period} has no citation, so it cannot be confirmed.`);}
 for(const id of ok)if(byId.has(id)&&!byId.get(id).confirmable)blockers.push(`${byId.get(id).label} for ${byId.get(id).period} was marked confirmed but has no citation; confirmation ignored.`);

 const inputs={
  ttm_ebitda_usd:{value:a(ebitda),formula:'Σ four quarters (operating income + depreciation and amortization)',definition:defs.ebitda,via:'lib/recommend.js (Covenant Designer derivation)'},
  debt_usd:{value:a(debt),formula:`${last} ${debtParts.map(labelOf).join(' + ')||'(no debt lines)'}`,definition:defs.debt},
  ttm_debt_service_usd:{value:a(service),formula:'Σ four quarters (interest expense + scheduled principal)',definition:defs.debt_service,via:'lib/recommend.js (Covenant Designer derivation)'},
  ttm_available_cashflow_usd:{value:a(acf),formula:'TTM EBITDA − cash taxes paid − unfinanced capex + decrease in operating working capital',definition:defs.available_cash_flow},
 };
 for(const v of Object.values(inputs))v.ttm_definition=defs.ttm;
 const blocked=blockers.length>0;
 const row=blocked?null:Object.fromEntries(CSV_COLUMNS.map(k=>[k,candidate[k]??'']));
 const statements_csv=blocked?null:statementsCSV(norm,periods,{use:it=>ok.has(idOf(it.period,it.key))&&confirmable(it),grossDebt:debt});
 if(statements_csv)readStatements(statements_csv); // must be accepted by the Covenant Designer as-is
 return {borrower_id,period,periods,source_document:source_document||null,blocked,blockers:[...new Set(blockers)],
  items,used:[...used],inputs,tieouts,csv_match:existing?{record_id:existing.record_id,flags:tieouts.filter(t=>t.id.startsWith('csv:')&&t.status==='fail').map(t=>t.id.slice(4))}:null,
  candidate,row,engine:row?evaluateRow(row,settings):null,statements_csv,problems:norm.problems};
}

// "BOR-09_2026-Q3.pdf" -> {borrower_id:'BOR-09', period:'2026-Q3'}
export function parseStatementName(name){const m=String(name||'').match(/^([A-Za-z]+-\d+)_(\d{4}-Q[1-4])(?:\.|$)/);return m?{borrower_id:m[1],period:m[2]}:null;}
