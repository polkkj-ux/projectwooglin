// Relationship manager one-pager (Part 2): question mapping, missing reporting data, reconciliation with the
// three source APIs, the "newly flagged" rule shared with the browser, and request validation.
import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from '../server.js';
import {parseCSV,toCSV} from '../lib/csv.js';
import {REPORTING_COLUMNS} from '../lib/reporting.js';
import {isNewlyFlagged,resolvePath,LEGAL_NOTE,MAX_QUESTIONS} from '../lib/callprep.js';

const savedOpt=process.env.OPT_URL;delete process.env.OPT_URL; // cure plans come from the stored snapshot, as on Vercel
process.on('exit',()=>{if(savedOpt!==undefined)process.env.OPT_URL=savedOpt;});
const start=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));return {s,base:'http://127.0.0.1:'+s.address().port};};
const get=async(base,path)=>{const r=await fetch(base+path);return {status:r.status,j:await r.json()};};
const cp=(base,b,p)=>get(base,`/api/callprep?borrower=${b}&period=${p}`);
const post=(base,body,headers={})=>fetch(base+'/api/callprep',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const qs=j=>j.questions.map(q=>[q.rule,q.text]);

test('questions: BOR-09 2026-Q3 (failing covenants and the cheapest cure)',async()=>{
 const {s,base}=await start();try{
  const {status,j}=await cp(base,'BOR-09','2026-Q3');assert.equal(status,200);
  assert.deepEqual(qs(j),[
   [2,'Debt is $295,000.00 above what current EBITDA supports. What is the plan to pay down debt or grow earnings?'],
   [3,'Cash flow fell $12,000.00 short of what the 1.20x minimum DSCR requires for the loan payments, and $11,000.00 short on fixed-charge coverage. Were there one-time costs, and what do the next two quarters look like?'],
   [5,'The cheapest fix needs a $68,333.34 equity contribution. Is the sponsor able and willing to fund it?'],
   [6,'The plan assumes selling Division A for $150,000.00. Is that realistic this quarter?'],
   [10,'Current ratio headroom has narrowed two quarters in a row, from $170,000.00 in Q1 2026 to $150,000.00. What is driving it?']]);
  const c=j.what_it_would_take.cure;assert.equal(c.state,'plan');assert.equal(c.total_cost_usd,'78333.34');assert.equal(c.solved_offline,true);assert.equal(c.synthetic,true);
  assert.deepEqual(j.sections,['header','scorecard','trend','what_it_would_take','reporting','questions','footer']);
  assert.equal(j.header.status.label,'3 tests failed');assert.equal(j.header.newly_flagged,false);assert.equal(j.header.synthetic_scenario,null);
  assert.equal(j.trend.first_exception_period,'2026-Q1');assert.equal(j.financials,null,'no statement figures in the monitor yet, so the section is skipped');
  assert.deepEqual(j.footer.citations.map(c=>c.covenant),['leverage','dscr','fccr']);assert.equal(j.footer.note,LEGAL_NOTE);
  assert.equal(j.footer.data_date,'2026-09-30');assert.equal(j.footer.document_review_date,'2026-12-01');
 }finally{s.close();}
});

test('questions: BOR-03 2026-Q2 (passes every covenant, late two quarters running) and BOR-05 2026-Q1 (quality flag)',async()=>{
 const {s,base}=await start();try{
  const a=(await cp(base,'BOR-03','2026-Q2')).j;
  assert.ok(a.scorecard.every(x=>x.status==='pass'||x.status==='dormant'));assert.equal(a.what_it_would_take,null);
  assert.deepEqual(qs(a),[[8,'Reporting has been late 2 quarters in a row. Do you need help from your accountant or a different schedule?']]);
  assert.equal(a.reporting.consecutive_late_or_missing,2);assert.deepEqual(a.reporting.documents.map(d=>[d.key,d.status,d.days_late]),[['financials','late',12],['compliance_cert','late',12]]);
  const b=(await cp(base,'BOR-05','2026-Q1')).j;
  assert.deepEqual(qs(b),[
   [2,'Debt is $55,000.00 above what current EBITDA supports. What is the plan to pay down debt or grow earnings?'],
   [5,'The cheapest fix needs a $18,333.34 equity contribution. Is the sponsor able and willing to fund it?'],
   [12,'The agreement calls for reviewed annual statements; the FY2025 ones were internally prepared. When will reviewed statements be available?']]);
  // other rules: waiver (BOR-07 Q3), missing certificate, dormant springing test, healthy headroom, Q4 synthetic label
  const c=(await cp(base,'BOR-07','2026-Q3')).j;
  assert.equal(c.questions[0].text,'We would need a waiver to 1.21x minimum current ratio for Q3 2026. Can you support that request with a plan?');
  assert.ok(c.questions.some(q=>q.rule===7&&/compliance certificate for Q3 2026 is 17 days overdue/.test(q.text)));
  assert.deepEqual(qs((await cp(base,'BOR-02','2026-Q2')).j),[[11,'Revolver use is 20.0% against a 35% trigger. Do you expect to draw more?']]);
  assert.deepEqual(qs((await cp(base,'BOR-01','2026-Q1')).j),[[13,'Results look solid. Any plans for capital spending, acquisitions or distributions we should know about?']]);
  const q4=(await cp(base,'BOR-01','2026-Q4')).j;assert.equal(q4.header.synthetic_scenario,'Synthetic scenario');assert.ok(q4.questions.length<=MAX_QUESTIONS);
  for(const p of ['2026-Q1','2026-Q2','2026-Q3','2026-Q4'])for(let i=1;i<=9;i++){const j=(await cp(base,`BOR-0${i}`,p)).j;assert.ok(j.questions.length<=MAX_QUESTIONS);
   assert.deepEqual(j.questions.map(q=>q.rule),[...j.questions.map(q=>q.rule)].sort((x,y)=>x-y),'most serious first');}
 }finally{s.close();}
});

test('a CSV without reporting columns gives a one-pager without the reporting section, and no errors',async()=>{
 const {s,base}=await start();try{
  const rows=parseCSV(await fs.readFile(new URL('../data/team/loan_covenants_extended.csv',import.meta.url),'utf8'));
  const csv=toCSV(rows.map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>!REPORTING_COLUMNS.includes(k)))));
  const r=await post(base,{borrower:'BOR-03',period:'2026-Q2',csv});assert.equal(r.status,200);const j=await r.json();
  assert.equal(j.reporting,null);assert.ok(!j.sections.includes('reporting'));assert.equal(j.footer.document_review_date,null);
  assert.ok(j.questions.every(q=>q.rule<7||q.rule>12));assert.equal(j.footer.data_source,'Uploaded CSV, taken as supplied');
  const f=await (await post(base,{borrower:'BOR-09',period:'2026-Q3',csv})).json();
  assert.equal(f.what_it_would_take.cure.state,'unavailable','uploaded data: the cure planner is skipped and only the distance figures are shown');
  assert.ok(f.what_it_would_take.distance.length===3);assert.ok(f.questions.every(q=>q.rule!==5&&q.rule!==6));
 }finally{s.close();}
});

test('reconciliation: every number on the BOR-01 2026-Q3 one-pager equals its field in /api/covenants, /api/reporting and /api/cure',async()=>{
 const {s,base}=await start();try{
  const [{j:page},{j:cov},{j:rep},{j:cure}]=await Promise.all([cp(base,'BOR-01','2026-Q3'),get(base,'/api/covenants'),get(base,'/api/reporting'),get(base,'/api/cure?borrower=BOR-01&period=2026-Q3')]);
  const src={covenants:p=>cov.results.find(r=>r.borrower_id==='BOR-01'&&r.period===p),covenants_borrower:()=>cov.borrowers.find(b=>b.borrower_id==='BOR-01'),
   reporting:p=>rep.results.find(r=>r.borrower_id==='BOR-01'&&r.period===p),reporting_root:()=>rep,cure:()=>cure};
  assert.ok(page.figures.length>40);
  for(const f of page.figures)assert.deepEqual(resolvePath(src[f.source](f.period),f.path),f.value,`${f.label}: ${f.source} ${f.period||''} ${f.path}`);
  // every number shown on the page is one of those reconciled figures
  const vals=new Set(page.figures.map(f=>JSON.stringify(f.value)));
  let seen=0;const walk=(o,path)=>{if(o==null)return;if(Array.isArray(o))return o.forEach((x,i)=>walk(x,path+'.'+i));
   if(typeof o==='object'){for(const [k,v] of Object.entries(o))if(!['figures','rules','footer','questions'].includes(k)||path)walk(v,path+'.'+k);return;}
   if(typeof o==='number'||(typeof o==='string'&&/^-?\d+(\.\d+)?$/.test(o))){seen++;assert.ok(vals.has(JSON.stringify(o)),`${path} = ${o} is not reconciled`);}};
  for(const k of page.sections.filter(k=>k!=='footer'&&k!=='questions'))walk(page[k],k);
  assert.ok(seen>40,`walked ${seen} numbers`);
  for(const q of page.questions)for(const v of q.figures)assert.ok(vals.has(JSON.stringify(v)),`question ${q.rule}: ${v}`);
  // spot checks against the README's known answers
  const d=page.scorecard.find(x=>x.key==='dscr');assert.equal(d.value,1.1538);assert.equal(d.headroom_usd,'-12000.00');assert.equal(d.prior_value,1.2307);assert.equal(d.change,'weaker');
  assert.equal(page.what_it_would_take.cure.equity_cure_usd,'12000.00');assert.equal(page.header.debt_usd,cov.results.find(r=>r.record_id===page.header.record_id).inputs.debt_usd);
  assert.equal(page.header.newly_flagged,true);
  // footer citations are the monitor's own evidence for the failing covenant
  const ev=src.covenants('2026-Q3').evidence;assert.deepEqual(page.footer.citations.map(c=>[c.quote,c.start,c.end,c.sha256]),ev.map(e=>[e.definition.quote,e.definition.start,e.definition.end,e.definition.sha256]));
 }finally{s.close();}
});

test('"newly flagged" agrees with the app\'s isNew() for all 36 borrower-quarters',async()=>{
 const html=(await fs.readFile(new URL('../public/app.html',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const a=html.indexOf('/* ---------- formatting'),b=html.indexOf('/* ---------- tooltip');assert.ok(a>0&&b>a);
 const app=new Function(html.slice(a,b)+'\nreturn {load(d){data=d;byKey=new Map();for(const r of d.results)byKey.set((r.borrower_id||\'(missing)\')+\'|\'+(r.period||\'?\'),r);periods=[...new Set(d.results.map(r=>r.period).filter(p=>/^\\d{4}-Q[1-4]$/.test(p||\'\')))].sort();},isNew};')();
 const {s,base}=await start();try{
  for(const body of [undefined,{settings:{modes:{fccr:'maintenance'}}},{settings:{trigger_pct:'15',modes:{leverage:'off'}}}]){
   const cov=await (body?fetch(base+'/api/covenants',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}):fetch(base+'/api/covenants')).then(r=>r.json());
   app.load(cov);let n=0,flagged=[];
   for(const r of cov.results){n++;const want=app.isNew(r.borrower_id,r.period);assert.equal(isNewlyFlagged(cov,r.borrower_id,r.period),want,`${r.borrower_id} ${r.period}`);if(want)flagged.push(r.borrower_id+' '+r.period);}
   assert.equal(n,36);
   if(!body)assert.deepEqual(flagged,['BOR-01 2026-Q3','BOR-02 2026-Q3','BOR-03 2026-Q3']);
  }
 }finally{s.close();}
});

test('POST /api/callprep validates like POST /api/covenants; unknown rows are 404',async()=>{
 const {s,base}=await start();try{
  for(const [body,re] of [[{period:'2026-Q3'},/borrower is required/],[{borrower:'BOR-01',period:'Q3-2026'},/period must look like/],[{borrower:'BOR-01',period:'2026-Q3',csv:'hello\nworld\n'},/Missing required columns/],
   [{borrower:'BOR-01',period:'2026-Q3',reporting_settings:{review_date:'soon'}},/real date/],[{borrower:'BOR-01',period:'2026-Q3',settings:{modes:{dscr:'x'}}},/maintenance, springing or off/],[{borrower:'BOR-01',period:'2026-Q3',policy:7},/policy must be text/]]){
   const r=await post(base,body);assert.equal(r.status,400,JSON.stringify(body));assert.match((await r.json()).error,re);}
  assert.equal((await cp(base,'BOR-99','2026-Q3')).status,404);assert.equal((await get(base,'/api/callprep')).status,400);
  assert.equal((await post(base,{borrower:'BOR-01',period:'2026-Q3'},{origin:'https://evil.example'})).status,403);
  // reporting settings reach the one-pager; covenant settings change the scorecard the same way they change /api/covenants
  const late=await (await post(base,{borrower:'BOR-03',period:'2026-Q2',reporting_settings:{due_days:{financials:60,compliance_cert:60}}})).json();
  assert.equal(late.reporting.consecutive_late_or_missing,0);assert.ok(!late.questions.some(q=>q.rule===8));
  const m=await (await post(base,{borrower:'BOR-02',period:'2026-Q2',settings:{modes:{fccr:'maintenance'}}})).json();
  assert.equal(m.scorecard.find(x=>x.key==='fccr').status,'breach');assert.equal(m.scorecard.find(x=>x.key==='fccr').headroom_usd,'-6000.00');
 }finally{s.close();}
});
