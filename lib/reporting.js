// Reporting compliance tracker (lower-middle-market lending). Pure functions only: calendar dates, document
// statuses and settings validation. No I/O, no LLM, no Date time zones (dates are parsed as YYYY-MM-DD and
// compared as day numbers). Reporting status is a separate signal: it never changes a covenant result.
//
// Two different dates are used in this app and must never be mixed:
//  - the covenant monitor's data date (2026-09-30) belongs to the monitor and is untouched here;
//  - the document review date (reporting setting review_date) is the day on which we check what has arrived.

export const DOCS=['financials','compliance_cert','annual_statements'];
export const DOC_COLUMNS={financials:'financials_received_date',compliance_cert:'compliance_cert_received_date',annual_statements:'annual_statements_received_date'};
export const QUALITY_COLUMN='statement_quality';
export const REPORTING_COLUMNS=[...Object.values(DOC_COLUMNS),QUALITY_COLUMN];
export const DOC_LABELS={financials:'Quarterly financial statements',compliance_cert:'Compliance certificate',annual_statements:'Annual financial statements'};
export const DOC_SHORT={financials:'financials',compliance_cert:'compliance certificate',annual_statements:'annual statements'};
export const QUALITY_ORDER=['audited','reviewed','compiled','internal']; // best first
export const STATUSES=['missing','late','invalid','not_yet_due','on_time'];  // worst first
const DUE_KEYS={financials:'financials',compliance_cert:'compliance_cert',annual_statements:'annual_statements'};

// Tool defaults the lender can change; not market data. review_date is synthetic (see README).
export const DEFAULT_REPORTING_SETTINGS=Object.freeze({
 review_date:'2026-12-01',
 due_days:Object.freeze({financials:45,compliance_cert:45,annual_statements:120}),
 min_statement_quality:'reviewed',
 borrowers:Object.freeze({})});

// ---- calendar dates (proleptic Gregorian, no time zones) ---------------------------------------
const leap=y=>y%4===0&&(y%100!==0||y%400===0);
const dim=(y,m)=>[31,leap(y)?29:28,31,30,31,30,31,31,30,31,30,31][m-1];
// Returns {y,m,d} or null. Only YYYY-MM-DD with a real calendar day is accepted.
export function parseDate(s){
 if(typeof s!=='string')return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());if(!m)return null;
 const y=+m[1],mo=+m[2],d=+m[3];
 if(mo<1||mo>12||d<1||d>dim(y,mo))return null;
 return {y,m:mo,d};
}
// Days since 1970-01-01 (Hinnant's civil-from-days algorithm), integers only.
export function dayNumber({y,m,d}){
 y-=m<=2?1:0;const era=Math.floor(y/400),yoe=y-era*400,mp=(m+9)%12;
 const doy=Math.floor((153*mp+2)/5)+d-1,doe=yoe*365+Math.floor(yoe/4)-Math.floor(yoe/100)+doy;
 return era*146097+doe-719468;
}
export function fromDayNumber(z){
 z+=719468;const era=Math.floor(z/146097),doe=z-era*146097;
 const yoe=Math.floor((doe-Math.floor(doe/1460)+Math.floor(doe/36524)-Math.floor(doe/146096))/365);
 const doy=doe-(365*yoe+Math.floor(yoe/4)-Math.floor(yoe/100)),mp=Math.floor((5*doy+2)/153);
 const d=doy-Math.floor((153*mp+2)/5)+1,m=mp<10?mp+3:mp-9;
 return {y:yoe+era*400+(m<=2?1:0),m,d};
}
export const formatDate=({y,m,d})=>`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
export const addDays=(iso,n)=>formatDate(fromDayNumber(dayNumber(parseDate(iso))+n));
export const daysBetween=(a,b)=>dayNumber(parseDate(b))-dayNumber(parseDate(a)); // b - a
const PERIOD=/^(\d{4})-Q([1-4])$/;
export function quarterEnd(period){const m=PERIOD.exec(period||'');if(!m)return null;return `${m[1]}-${['03-31','06-30','09-30','12-31'][+m[2]-1]}`;}
// The quarter immediately before (2026-Q1 -> 2025-Q4).
export function prevQuarter(period){const m=PERIOD.exec(period||'');if(!m)return null;const y=+m[1],q=+m[2];return q===1?`${y-1}-Q4`:`${y}-Q${q-1}`;}

// ---- settings ----------------------------------------------------------------------------------
function dueDays(v,label){
 if(!Number.isInteger(v)||v<0||v>365)throw Error(`${label} must be a whole number of days from 0 to 365`);
 return v;
}
function dueObj(o,base,where){
 const out={...base};if(o==null)return out;
 if(typeof o!=='object'||Array.isArray(o))throw Error(`${where}due_days must be an object`);
 for(const [k,v] of Object.entries(o)){if(!DUE_KEYS[k])throw Error(`Unknown document in ${where}due_days: ${k}`);out[k]=dueDays(v,`${where}${DOC_LABELS[k]} due days`);}
 return out;
}
function quality(v,where){
 if(typeof v!=='string'||!QUALITY_ORDER.includes(v))throw Error(`${where}min_statement_quality must be audited, reviewed, compiled or internal`);
 return v;
}
// Validate reporting settings from the API. Same shape idea as covenant settings: a portfolio level plus
// per-borrower overrides (due days and minimum quality). The document review date is portfolio-wide.
export function normalizeReportingSettings(s){
 if(s==null)s={};
 if(typeof s!=='object'||Array.isArray(s))throw Error('reporting_settings must be an object');
 for(const k of Object.keys(s))if(!['review_date','due_days','min_statement_quality','borrowers'].includes(k))throw Error(`Unknown reporting setting: ${k}`);
 const rd=s.review_date??DEFAULT_REPORTING_SETTINGS.review_date;
 if(!parseDate(rd)||String(rd).trim()!==rd)throw Error('Document review date must be a real date written YYYY-MM-DD');
 const due=dueObj(s.due_days,DEFAULT_REPORTING_SETTINGS.due_days,'');
 const minQ=s.min_statement_quality==null?DEFAULT_REPORTING_SETTINGS.min_statement_quality:quality(s.min_statement_quality,'');
 const borrowers={};
 if(s.borrowers!=null){
  if(typeof s.borrowers!=='object'||Array.isArray(s.borrowers))throw Error('reporting_settings.borrowers must be an object');
  const ids=Object.keys(s.borrowers);if(ids.length>1000)throw Error('Too many borrower overrides');
  for(const id of ids){
   if(id.length>100)throw Error('Borrower id too long');
   const o=s.borrowers[id];if(o==null)continue;
   if(typeof o!=='object'||Array.isArray(o))throw Error(`Reporting override for ${id} must be an object`);
   for(const k of Object.keys(o))if(!['due_days','min_statement_quality'].includes(k))throw Error(`Unknown reporting override for ${id}: ${k}`);
   const x={};
   if(o.due_days!=null){const d=dueObj(o.due_days,{},`${id} `);if(Object.keys(d).length)x.due_days=d;}
   if(o.min_statement_quality!=null)x.min_statement_quality=quality(o.min_statement_quality,`${id} `);
   if(Object.keys(x).length)borrowers[id]=x;
  }
 }
 return {review_date:rd,due_days:due,min_statement_quality:minQ,borrowers};
}
const dueFor=(s,b,k)=>s.borrowers[b]?.due_days?.[k]??s.due_days[k];
const minQualityFor=(s,b)=>s.borrowers[b]?.min_statement_quality??s.min_statement_quality;

// ---- statuses ----------------------------------------------------------------------------------
const blank=v=>v===undefined||v===null||String(v).trim()==='';
// One document: due date from the reference date plus allowance; status as of the document review date.
export function documentStatus(raw,referenceEnd,allowanceDays,reviewDate){
 const due=addDays(referenceEnd,allowanceDays);
 const base={due_date:due,received_date:null,status:null,days_late:null,days_overdue:null,reason:null};
 if(blank(raw)){
  const over=daysBetween(due,reviewDate);
  return over>0?{...base,status:'missing',days_overdue:over}:{...base,status:'not_yet_due'};
 }
 const d=parseDate(String(raw));
 if(!d||String(raw).trim()!==String(raw))return {...base,status:'invalid',reason:`The received date "${String(raw).slice(0,40)}" could not be read; use YYYY-MM-DD.`};
 const rec=formatDate(d);
 if(daysBetween(rec,reviewDate)<0)return {...base,received_date:rec,status:'invalid',reason:`The received date ${rec} is after the ${reviewDate} document review date.`};
 const late=daysBetween(due,rec);
 return late>0?{...base,received_date:rec,status:'late',days_late:late}:{...base,received_date:rec,status:'on_time'};
}
export const worstStatus=list=>{let w=null;for(const s of list)if(w===null||STATUSES.indexOf(s)<STATUSES.indexOf(w))w=s;return w;};

// Which reporting columns does this data have? Absent columns are not tracked (never "missing").
export function reportingColumns(rows){
 const have=new Set(rows.length?Object.keys(rows[0]):[]);
 return Object.fromEntries(REPORTING_COLUMNS.map(c=>[c,have.has(c)]));
}

// Evaluate every borrower-quarter row. Rows without a borrower or a readable period cannot be checked.
export function evaluateReporting(rows,rawSettings){
 const s=normalizeReportingSettings(rawSettings); // idempotent, so already-normalized settings pass through unchanged
 const cols=reportingColumns(rows);
 const tracked=DOCS.filter(k=>cols[DOC_COLUMNS[k]]);
 const supplied=REPORTING_COLUMNS.some(c=>cols[c]);
 const notes=[];
 const seen=new Map();
 rows.forEach((r,i)=>{if(r.borrower_id&&PERIOD.test(r.period||'')){const k=r.borrower_id+'|'+r.period;seen.set(k,(seen.get(k)||0)+1);}});
 const results=rows.map((r,i)=>{
  const base={record_id:r.record_id??null,borrower_id:r.borrower_id||null,period:r.period??null,period_end:quarterEnd(r.period)};
  if(!supplied)return {...base,reporting:null};
  if(!r.borrower_id)return {...base,reporting:{status:'invalid',reason:'Missing borrower_id; reporting cannot be checked.',documents:{},quality:null}};
  if(!base.period_end)return {...base,reporting:{status:'invalid',reason:'Period must look like 2026-Q3; reporting cannot be checked.',documents:{},quality:null}};
  if(seen.get(r.borrower_id+'|'+r.period)>1)return {...base,reporting:{status:'invalid',reason:`Duplicate report: more than one row for ${r.borrower_id} ${r.period}; the tool cannot tell which one governs.`,documents:{},quality:null}};
  const q1=/-Q1$/.test(r.period),fy=Number(r.period.slice(0,4))-1;
  const documents={};
  for(const k of tracked){
   if(k==='annual_statements'&&!q1)continue;
   const ref=k==='annual_statements'?`${fy}-12-31`:base.period_end;
   documents[k]={...documentStatus(r[DOC_COLUMNS[k]],ref,dueFor(s,r.borrower_id,k),s.review_date),allowance_days:dueFor(s,r.borrower_id,k),...(k==='annual_statements'?{fiscal_year:fy,fiscal_year_end:`${fy}-12-31`}:{})};
  }
  if(!q1)for(const c of [DOC_COLUMNS.annual_statements,QUALITY_COLUMN])if(cols[c]&&!blank(r[c]))notes.push(`${r.record_id||'Row '+(i+2)} (${r.borrower_id} ${r.period}): ${c} is filled on a non-Q1 row and is ignored; annual statements are read on Q1 rows only.`);
  // Statement quality: Q1 rows only, for the fiscal year that ended just before.
  let quality=null;
  if(q1&&cols[QUALITY_COLUMN]){
   const min=minQualityFor(s,r.borrower_id),raw=r[QUALITY_COLUMN];
   if(blank(raw)){
    if(documents.annual_statements?.received_date)quality={fiscal_year:fy,value:null,minimum:min,status:'not_stated',below_minimum:null,reason:'Annual statements were received but their quality is not stated.'};
   }else{
    const v=String(raw).trim().toLowerCase();
    if(!QUALITY_ORDER.includes(v))quality={fiscal_year:fy,value:String(raw).slice(0,40),minimum:min,status:'invalid',below_minimum:null,reason:`Statement quality "${String(raw).slice(0,40)}" is not one of audited, reviewed, compiled or internal.`};
    else{const below=QUALITY_ORDER.indexOf(v)>QUALITY_ORDER.indexOf(min);quality={fiscal_year:fy,value:v,minimum:min,status:below?'below_minimum':'meets_minimum',below_minimum:below,reason:null};}
   }
  }
  const sts=Object.values(documents).map(d=>d.status);
  const late_or_missing=Object.entries(documents).filter(([,d])=>d.status==='late'||d.status==='missing').map(([k,d])=>({document:k,status:d.status,days_late:d.days_late,days_overdue:d.days_overdue,due_date:d.due_date}));
  // Largest days late or overdue on any document this quarter (sort key for "most overdue first").
  const days_past_due=late_or_missing.reduce((m,i)=>Math.max(m,i.days_late??i.days_overdue??0),0);
  return {...base,reporting:{status:sts.length?worstStatus(sts):null,documents,quality,late_or_missing,days_past_due}};
 });
 // On Q2-Q4 rows, point to the same year's Q1 result for the annual statements (display only: it never
 // changes the quarter's status, and the flag itself stays on the Q1 row).
 const q1Of=new Map();for(const x of results)if(x.reporting?.documents&&/-Q1$/.test(x.period||''))q1Of.set(x.borrower_id+'|'+x.period.slice(0,4),x);
 for(const x of results){
  if(!x.reporting?.documents||/-Q1$/.test(x.period||''))continue;
  const q=q1Of.get(x.borrower_id+'|'+String(x.period).slice(0,4));
  x.reporting.annual_reference=q&&(q.reporting.documents.annual_statements||q.reporting.quality)?{from_period:q.period,record_id:q.record_id,document:q.reporting.documents.annual_statements??null,quality:q.reporting.quality}:null;
 }
 // Consecutive quarters with a late or missing item, ending at each row's quarter (calendar-adjacent quarters only).
 const idx=new Map();for(const x of results)if(x.reporting&&x.borrower_id&&x.period_end)idx.set(x.borrower_id+'|'+x.period,x);
 const lm=x=>!!x&&(x.reporting?.status==='late'||x.reporting?.status==='missing');
 for(const x of results){
  if(!x.reporting||!x.period_end)continue;
  let n=0,p=x.period;while(lm(idx.get(x.borrower_id+'|'+p))){n++;p=prevQuarter(p);}
  x.reporting.consecutive_late_or_missing=n;
 }
 // Portfolio summary per quarter.
 const allBorrowers=[...new Set(rows.map(r=>r.borrower_id).filter(Boolean))].sort();
 const periods=[...new Set(results.map(x=>x.period).filter(p=>PERIOD.test(p||'')))].sort();
 const summary=supplied?periods.map(p=>{
  const xs=results.filter(x=>x.period===p&&x.reporting);
  const counts=Object.fromEntries(STATUSES.map(k=>[k,xs.filter(x=>x.reporting.status===k).length]));
  const lmList=xs.filter(lm).map(x=>({borrower_id:x.borrower_id,status:x.reporting.status,items:x.reporting.late_or_missing,consecutive_late_or_missing:x.reporting.consecutive_late_or_missing})).sort((a,b)=>a.borrower_id.localeCompare(b.borrower_id));
  const qf=xs.filter(x=>x.reporting.quality?.below_minimum).map(x=>({borrower_id:x.borrower_id,fiscal_year:x.reporting.quality.fiscal_year,value:x.reporting.quality.value,minimum:x.reporting.quality.minimum}));
  return {period:p,period_end:quarterEnd(p),borrowers:allBorrowers.length,rows:xs.length,counts,late_or_missing:{count:lmList.length,borrowers:lmList},quality_flags:qf};
 }):[];
 return {supplied,columns:cols,tracked_documents:tracked,settings:s,results,summary,data_quality:notes};
}

export function reportingAssumptions(s,{supplied=true,sample=true}={}){
 const out=[];
 if(!supplied)out.push('No reporting data was supplied: the CSV has none of the columns financials_received_date, compliance_cert_received_date, annual_statements_received_date or statement_quality. Reporting compliance is not checked, and covenant results are unaffected.');
 out.push(`Documents are checked as of the document review date, ${s.review_date}, a reporting setting the lender can change (the default 2026-12-01 is synthetic). It is a different date from the data date used by the covenant monitor.`,
  `Due date = quarter end + allowance: quarterly financials ${s.due_days.financials} days, compliance certificate ${s.due_days.compliance_cert} days; annual statements = fiscal year end + ${s.due_days.annual_statements} days. These are tool defaults the lender can change per portfolio and per borrower, not market data.`,
  'Annual statements and statement quality are read on Q1 rows only and refer to the fiscal year that ended just before (calendar fiscal years assumed): the 2026-Q1 row covers FY2025, due 2025-12-31 plus the annual allowance. On other rows these two columns are ignored and reported as a data-quality note.',
  'A blank received date means not received. Status: on time (received on or before the due date), late (received after it), missing (not received and the due date has passed by the document review date), not yet due (not received, due date not yet passed), invalid (date unreadable or after the document review date).',
  'Dates are compared as calendar dates (YYYY-MM-DD), without time zones. Missing or unreadable dates are reported, never guessed, and never counted as on time.',
  'A borrower\'s reporting status for a quarter is its worst document status: missing, then late, then invalid, then not yet due, then on time.',
  `Minimum annual statement quality is ${s.min_statement_quality} (order: audited, reviewed, compiled, internal); lower quality is flagged separately and does not change the reporting status.`,
  'Consecutive quarters with a late or missing item count back from the selected quarter through calendar-adjacent quarters only.',
  'Reporting status is a separate signal from covenant compliance: it never changes a covenant pass or fail. Late or missing reporting may itself be a default under the agreement; that is for the credit reviewer, not this tool, to decide.');
 if(supplied&&sample)out.push('Received dates and statement quality in the bundled sample are synthetic, added by scripts/make-extended-fixture.js.');
 else if(supplied)out.push('Received dates and statement quality are taken from the uploaded CSV as supplied; this tool does not verify them.');
 return out;
}

// The /api/reporting response: per borrower-quarter results, a per-quarter summary, the settings used and
// the assumptions. `sample` says whether the rows are the bundled synthetic sample (labelled as such).
export function reportingReport(rows,rawSettings,{sample=true,dataSource=null}={}){
 const r=evaluateReporting(rows,rawSettings);
 return {supplied:r.supplied,
  message:r.supplied?null:'No reporting data was supplied: this CSV has no received-date or statement-quality columns, so reporting compliance is not checked.',
  data_source:dataSource,document_review_date:r.settings.review_date,
  columns:r.columns,tracked_documents:r.tracked_documents,settings:r.settings,summary:r.summary,results:r.results,data_quality:r.data_quality,
  assumptions:reportingAssumptions(r.settings,{supplied:r.supplied,sample})};
}
