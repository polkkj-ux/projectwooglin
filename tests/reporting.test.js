// Reporting compliance tracker (Part 1): exact results on the synthetic sample, missing and invalid input,
// reconciliation with the source rows, settings and calendar arithmetic.
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from '../server.js';
import {parseCSV,toCSV} from '../lib/csv.js';
import {evaluateReporting,normalizeReportingSettings,reportingReport,documentStatus,addDays,daysBetween,quarterEnd,prevQuarter,parseDate,dayNumber,fromDayNumber,formatDate,REPORTING_COLUMNS,DEFAULT_REPORTING_SETTINGS} from '../lib/reporting.js';

const csvText=await fs.readFile(new URL('../data/team/loan_covenants_extended.csv',import.meta.url),'utf8');
const rows=parseCSV(csvText);
const start=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));return {s,base:'http://127.0.0.1:'+s.address().port};};
const post=(base,body,headers={})=>fetch(base+'/api/reporting',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const row=(R,b,p)=>R.results.find(x=>x.borrower_id===b&&x.period===p).reporting;
const lm=(R,p)=>R.summary.find(s=>s.period===p).late_or_missing;

test('GET /api/reporting: exact late and missing items per quarter on the synthetic sample',async()=>{
 const {s,base}=await start();try{
  const res=await fetch(base+'/api/reporting');assert.equal(res.status,200);const R=await res.json();
  assert.equal(R.supplied,true);assert.equal(R.document_review_date,'2026-12-01');
  assert.deepEqual(R.settings,{review_date:'2026-12-01',due_days:{financials:45,compliance_cert:45,annual_statements:120},min_statement_quality:'reviewed',borrowers:{}});
  const brief=p=>lm(R,p).borrowers.map(b=>[b.borrower_id,b.items.map(i=>`${i.document} ${i.status} ${i.days_late??i.days_overdue}`)]);
  assert.equal(lm(R,'2026-Q1').count,1);assert.deepEqual(brief('2026-Q1'),[['BOR-03',['financials late 14','compliance_cert late 14']]]);
  assert.equal(lm(R,'2026-Q2').count,1);assert.deepEqual(brief('2026-Q2'),[['BOR-03',['financials late 12','compliance_cert late 12']]]);
  assert.equal(lm(R,'2026-Q3').count,2);assert.deepEqual(brief('2026-Q3'),[['BOR-03',['financials late 14','compliance_cert late 14']],['BOR-07',['compliance_cert missing 17']]]);
  assert.equal(lm(R,'2026-Q4').count,0);assert.equal(R.summary.find(x=>x.period==='2026-Q4').counts.not_yet_due,9);
  for(const x of R.summary)assert.equal(x.borrowers,9);
  // due dates: quarter end + 45 days; FY2025 annual statements: 2025-12-31 + 120 days
  const due=p=>row(R,'BOR-01',p).documents.financials.due_date;
  assert.deepEqual(['2026-Q1','2026-Q2','2026-Q3','2026-Q4'].map(due),['2026-05-15','2026-08-14','2026-11-14','2027-02-14']);
  assert.equal(row(R,'BOR-01','2026-Q1').documents.annual_statements.due_date,'2026-04-30');
  assert.equal(row(R,'BOR-01','2026-Q1').documents.annual_statements.fiscal_year,2025);
  assert.equal(row(R,'BOR-01','2026-Q2').documents.annual_statements,undefined,'annual statements are read on Q1 rows only');
  // consecutive quarters late or missing; BOR-07's certificate is missing 17 days on 2026-12-01
  assert.equal(row(R,'BOR-03','2026-Q3').consecutive_late_or_missing,3);assert.equal(row(R,'BOR-03','2026-Q2').consecutive_late_or_missing,2);
  assert.equal(row(R,'BOR-03','2026-Q4').consecutive_late_or_missing,0);
  const c7=row(R,'BOR-07','2026-Q3');assert.equal(c7.status,'missing');assert.equal(c7.documents.compliance_cert.days_overdue,17);assert.equal(c7.documents.financials.status,'on_time');
  // statement quality: BOR-05 internal is below the reviewed minimum (Q1 row, FY2025); audited BOR-01 and BOR-09 meet it
  assert.deepEqual(R.summary.find(x=>x.period==='2026-Q1').quality_flags,[{borrower_id:'BOR-05',fiscal_year:2025,value:'internal',minimum:'reviewed'}]);
  assert.equal(row(R,'BOR-01','2026-Q1').quality.value,'audited');assert.equal(row(R,'BOR-09','2026-Q1').quality.below_minimum,false);
  assert.equal(row(R,'BOR-05','2026-Q3').annual_reference.quality.below_minimum,true,'later quarters point to the year\'s Q1 result');
  assert.equal(row(R,'BOR-05','2026-Q3').status,'on_time','the carried annual result never changes a later quarter\'s status');
  // wording: "document review date", never "as-of date" (the UI searches covenant assumptions for that phrase)
  assert.ok(R.assumptions.some(a=>/document review date/.test(a)));assert.ok(!JSON.stringify(R).match(/as-of date/i));
  assert.ok(R.assumptions.some(a=>/Q1 rows only/.test(a)&&/FY2025/.test(a)));
 }finally{s.close();}
});

test('reporting never appears in /api/covenants, and a CSV without reporting columns says so',async()=>{
 const {s,base}=await start();try{
  const cov=await (await fetch(base+'/api/covenants')).text();for(const c of [...REPORTING_COLUMNS,'"reporting"'])assert.ok(!cov.includes(c),c);
  const strip=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!REPORTING_COLUMNS.includes(k)));
  const res=await post(base,{csv:toCSV(rows.map(strip))});assert.equal(res.status,200);const R=await res.json();
  assert.equal(R.supplied,false);assert.match(R.message,/No reporting data was supplied/);assert.match(R.assumptions[0],/No reporting data was supplied/);
  assert.deepEqual(R.summary,[]);assert.ok(R.results.every(x=>x.reporting===null));
 }finally{s.close();}
});

test('missing and unreadable dates are reported, never guessed or counted as on time',()=>{
 const base=rows.find(r=>r.borrower_id==='BOR-01'&&r.period==='2026-Q3');
 const one=(over,settings)=>evaluateReporting([{...base,...over}],settings).results[0].reporting;
 for(const bad of ['2026-02-30','2026/11/06','06-11-2026',' 2026-11-06','2026-13-01','yesterday']){
  const d=one({financials_received_date:bad}).documents.financials;assert.equal(d.status,'invalid',bad);assert.match(d.reason,/could not be read/);assert.equal(d.received_date,null);}
 const after=one({financials_received_date:'2026-12-02'}).documents.financials;assert.equal(after.status,'invalid');assert.match(after.reason,/after the 2026-12-01 document review date/);
 assert.equal(one({financials_received_date:'2026-12-01'}).documents.financials.status,'late','received on the review date itself is readable');
 assert.equal(one({financials_received_date:'2026-11-14'}).documents.financials.status,'on_time','received on the due date is on time');
 assert.equal(one({financials_received_date:'2026-11-15'}).documents.financials.days_late,1);
 const blank=one({financials_received_date:'',compliance_cert_received_date:''});assert.equal(blank.status,'missing');assert.equal(blank.documents.financials.days_overdue,17);
 // worst status wins: missing > late > invalid > not yet due > on time
 assert.equal(one({financials_received_date:'2026-11-20',compliance_cert_received_date:'bad'}).status,'late');
 assert.equal(one({financials_received_date:'bad'}).status,'invalid');
 // annual statements filled on a non-Q1 row are ignored and reported
 const R=evaluateReporting([{...base,annual_statements_received_date:'2026-04-15',statement_quality:'audited'}]);
 assert.equal(R.results[0].reporting.documents.annual_statements,undefined);assert.match(R.data_quality[0],/non-Q1 row and is ignored/);
 // quality values outside the list, and duplicates, are reported
 const q1=rows.find(r=>r.borrower_id==='BOR-01'&&r.period==='2026-Q1');
 assert.equal(evaluateReporting([{...q1,statement_quality:'excellent'}]).results[0].reporting.quality.status,'invalid');
 const dup=evaluateReporting([q1,{...q1,record_id:'X'}]).results;assert.ok(dup.every(x=>x.reporting.status==='invalid'&&/Duplicate/.test(x.reporting.reason)));
});

test('POST /api/reporting validates like POST /api/covenants: bad settings, files and cross-origin calls are rejected',async()=>{
 const {s,base}=await start();try{
  const cases=[[{reporting_settings:{due_days:{financials:-1}}},/whole number of days/],[{reporting_settings:{due_days:{financials:1.5}}},/whole number of days/],
   [{reporting_settings:{due_days:{tax_return:30}}},/Unknown document/],[{reporting_settings:{review_date:'2026-02-30'}},/real date/],[{reporting_settings:{review_date:'12/01/2026'}},/real date/],
   [{reporting_settings:{min_statement_quality:'great'}},/audited, reviewed, compiled or internal/],[{reporting_settings:{as_of:'2026-12-01'}},/Unknown reporting setting/],
   [{reporting_settings:{borrowers:{'BOR-01':{review_date:'2026-12-01'}}}},/Unknown reporting override/],[{reporting_settings:[]},/must be an object/],
   [{settings:{modes:{leverage:'sometimes'}}},/maintenance, springing or off/],[{csv:5},/csv must be a string/],[{csv:''},/empty/],[{csv:'hello\nworld\n'},/Missing required columns/],
   [{csv:'record_id,borrower_id,period,currency,debt_usd,ttm_ebitda_usd,ttm_debt_service_usd,ttm_available_cashflow_usd,max_leverage,min_dscr\n'},/no data rows/]];
  for(const [body,re] of cases){const r=await post(base,body);assert.equal(r.status,400,JSON.stringify(body));assert.match((await r.json()).error,re);}
  assert.equal((await post(base,{},{origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(base+'/api/reporting',{method:'PUT'})).status,401,'other methods fall through like any unknown route');
 }finally{s.close();}
});

test('reconciliation: every late or missing count ties back to the source rows (independent date arithmetic)',async()=>{
 const R=reportingReport(rows);
 const utc=s=>Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10))/86400000;
 const qEnd={Q1:'03-31',Q2:'06-30',Q3:'09-30',Q4:'12-31'};const review=utc('2026-12-01');
 for(const S of R.summary){
  const src=rows.filter(r=>r.period===S.period);let expected=[];
  for(const r of src){const due=utc(`${r.period.slice(0,4)}-${qEnd[r.period.slice(5)]}`)+45;
   const bad=['financials_received_date','compliance_cert_received_date'].filter(c=>r[c]?utc(r[c])>due:review>due);
   if(r.period.endsWith('Q1')){const ad=utc(`${Number(r.period.slice(0,4))-1}-12-31`)+120;const a=r.annual_statements_received_date;if(a?utc(a)>ad:review>ad)bad.push('annual');}
   if(bad.length)expected.push(r.borrower_id);}
  assert.deepEqual(S.late_or_missing.borrowers.map(b=>b.borrower_id),expected.sort(),S.period);
  assert.equal(S.rows,src.length);assert.equal(Object.values(S.counts).reduce((a,b)=>a+b,0),src.length);
  for(const b of S.late_or_missing.borrowers)for(const i of b.items){
   const r=src.find(x=>x.borrower_id===b.borrower_id);
   const rec=r[i.document==='financials'?'financials_received_date':'compliance_cert_received_date'];
   const due=utc(i.due_date);if(i.status==='late')assert.equal(i.days_late,utc(rec)-due);else assert.equal(i.days_overdue,review-due);}
 }
});

test('reporting settings: portfolio allowances, per-borrower overrides and the document review date',()=>{
 const p=(s,b,q)=>evaluateReporting(rows,s).results.find(x=>x.borrower_id===b&&x.period===q).reporting;
 assert.equal(p({borrowers:{'BOR-03':{due_days:{financials:60,compliance_cert:60}}}},'BOR-03','2026-Q2').status,'on_time');
 assert.equal(p({borrowers:{'BOR-03':{due_days:{financials:60}}}},'BOR-03','2026-Q2').documents.compliance_cert.days_late,12,'override applies to one document only');
 assert.equal(p({borrowers:{'BOR-03':{due_days:{financials:60}}}},'BOR-04','2026-Q2').documents.financials.allowance_days,45,'other borrowers keep the portfolio terms');
 assert.equal(p({due_days:{financials:30}},'BOR-01','2026-Q3').documents.financials.due_date,'2026-10-30');
 const early=evaluateReporting(rows,{review_date:'2026-11-20'});
 const q3=early.summary.find(s=>s.period==='2026-Q3');
 assert.equal(early.results.find(x=>x.borrower_id==='BOR-07'&&x.period==='2026-Q3').reporting.documents.compliance_cert.days_overdue,6);
 assert.equal(early.results.find(x=>x.borrower_id==='BOR-03'&&x.period==='2026-Q3').reporting.status,'invalid','received after the review date');
 assert.deepEqual(q3.late_or_missing.borrowers.map(b=>b.borrower_id),['BOR-07']);
 assert.equal(p({min_statement_quality:'audited'},'BOR-02','2026-Q1').quality.below_minimum,true);
 assert.equal(p({borrowers:{'BOR-05':{min_statement_quality:'internal'}}},'BOR-05','2026-Q1').quality.below_minimum,false);
 assert.deepEqual(normalizeReportingSettings(normalizeReportingSettings({borrowers:{'BOR-01':{}}})),{...DEFAULT_REPORTING_SETTINGS,due_days:{...DEFAULT_REPORTING_SETTINGS.due_days},borrowers:{}});
});

test('calendar arithmetic: no time zones, leap years, quarter ends',()=>{
 assert.equal(addDays('2026-09-30',45),'2026-11-14');assert.equal(addDays('2025-12-31',120),'2026-04-30');assert.equal(addDays('2028-02-15',14),'2028-02-29');
 assert.equal(addDays('2100-02-28',1),'2100-03-01');assert.equal(addDays('2000-02-28',1),'2000-02-29');assert.equal(daysBetween('2026-11-14','2026-12-01'),17);
 assert.equal(quarterEnd('2026-Q2'),'2026-06-30');assert.equal(quarterEnd('Q3-2026'),null);assert.equal(prevQuarter('2026-Q1'),'2025-Q4');
 assert.equal(parseDate('2027-02-29'),null);assert.equal(parseDate('2028-02-29').d,29);
 for(let z=-800000;z<=800000;z+=997)assert.equal(dayNumber(fromDayNumber(z)),z);
 assert.equal(formatDate(fromDayNumber(0)),'1970-01-01');
 assert.deepEqual(documentStatus('','2026-12-31',45,'2026-12-01'),{due_date:'2027-02-14',received_date:null,status:'not_yet_due',days_late:null,days_overdue:null,reason:null});
});
