// Relationship manager one-pager ("call prep"). Assembles one borrower-quarter page ONLY from what the APIs
// already return: the monitor result (/api/covenants), the reporting result (/api/reporting) and the cure
// result (/api/cure). No new calculation of any covenant; no LLM. Questions come from a fixed mapping.
//
// Every number placed on the page is read through take(), which records where it came from
// (source API, borrower-quarter and field path) in `figures`, so it can be reconciled field by field.
import {minor} from './finance.js';

export const COVENANT_NAMES={leverage:'Leverage',dscr:'Debt-service coverage (DSCR)',fccr:'Fixed-charge coverage (FCCR)',current_ratio:'Current ratio'};
const SHORT={leverage:'Leverage',dscr:'DSCR',fccr:'FCCR',current_ratio:'Current ratio'};
const DOC_LABEL={financials:'quarterly financials',compliance_cert:'compliance certificate',annual_statements:'annual statements'};
const QUALITY_WORD={audited:'audited',reviewed:'reviewed',compiled:'compiled',internal:'internally prepared'};
const PERIOD=/^(\d{4})-Q([1-4])$/;
// The app's default internal "approaching a limit" rule (public/app.html RULE_DEFAULTS.near): a passing test
// with less than 5.0% headroom, measured as dollar headroom ÷ the amount the limit allows, in exact cents.
export const HEALTHY_HEADROOM_PCT='5.0';
export const MAX_QUESTIONS=6;
export const LEGAL_NOTE='Covenant test results are calculations for review, not a legal determination of default.';

// ---- small helpers (formatting only) -----------------------------------------------------------
const cents=s=>minor(String(s),{signed:true});
export function money(s){
 const c=cents(s),neg=c<0n,a=neg?-c:c,w=(a/100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return (neg?'-':'')+'$'+w+'.'+String(a%100n).padStart(2,'0');
}
const moneyAbs=s=>money(String(s).replace(/^-/,''));
// Same display rule as the app: two decimals, four when two would hide that a value is not at its limit.
export function ratioText(v,limit){if(v==null)return 'n/a';let s=v.toFixed(2);if(limit!=null&&s===Number(limit).toFixed(2)&&v!==Number(limit))s=v.toFixed(4);return s+'x';}
const limText=l=>Number(l).toFixed(2)+'x';
const pct=u=>(u*100).toFixed(1)+'%';
export const periodLabel=p=>{const m=PERIOD.exec(p||'');return m?`Q${m[2]} ${m[1]}`:String(p);};
export const quarterEndOf=p=>{const m=PERIOD.exec(p||'');return m?`${m[1]}-${['03-31','06-30','09-30','12-31'][+m[2]-1]}`:null;};
const listAnd=a=>a.length<3?a.join(' and '):a.slice(0,-1).join(', ')+' and '+a.at(-1);
const neg=s=>s!=null&&cents(s)<0n;

// Resolve "a.b.c" in an API object. On arrays, a segment matches an element's `key` (cure options) or an index.
export function resolvePath(obj,path){
 let o=obj;for(const seg of path.split('.')){if(o==null)return undefined;o=Array.isArray(o)?(o.find(x=>x&&x.key===seg)??o[Number(seg)]):o[seg];}
 return o;
}

// The data date of the covenant results, found exactly as the app finds it (the assumption naming it).
export function dataDateOf(monitor){const a=(monitor.assumptions||[]).find(t=>/as-of date/i.test(t));const m=a&&/(\d{4}-\d{2}-\d{2})/.exec(a);return m?m[1]:null;}
export const periodsOf=monitor=>[...new Set(monitor.results.map(r=>r.period).filter(p=>PERIOD.test(p||'')))].sort();
const rowIn=(monitor,b,p)=>{let r;for(const x of monitor.results)if((x.borrower_id||'(missing)')===b&&(x.period||'?')===p)r=x;return r;}; // last wins, like the app's Map

// "Newly flagged this quarter": the same rule as isNew() in public/app.html. The previous quarter in the data
// passed every applicable covenant, this quarter is an exception with at least one tested covenant failing.
export function isNewlyFlagged(monitor,b,p){
 const ps=periodsOf(monitor),i=ps.indexOf(p);if(i<1)return false;
 const pr=rowIn(monitor,b,ps[i-1]),cur=rowIn(monitor,b,p);
 return !!(pr&&cur&&pr.status==='pass'&&cur.status==='exception'&&Object.values(cur.covenants||{}).some(c=>c.status==='breach'));
}
// Healthy = passes with at least 5.0% of the limit in hand (exactly 5.00% is healthy, as in the app).
const healthy=c=>c.status==='pass'&&c.numerator_headroom_usd!=null&&c.numerator_limit_usd!=null&&cents(c.numerator_limit_usd)>0n&&cents(c.numerator_headroom_usd)*1000n>=50n*cents(c.numerator_limit_usd);

function statusOf(row){
 if(!row||row.status==='invalid')return {key:'error',tone:'na',label:'Data error'};
 const cs=Object.values(row.covenants||{}),tested=cs.filter(c=>c.status!=='dormant'),fails=tested.filter(c=>c.status==='breach').length;
 if(fails)return {key:'breach',tone:'bad',label:`${fails} test${fails>1?'s':''} failed`};
 if(tested.some(c=>c.status==='unevaluable'))return {key:'review',tone:'warn',label:'Cannot calculate'};
 if(!tested.length)return {key:'untested',tone:'na',label:'No covenant tested'};
 if(cs.some(c=>c.status==='dormant'&&c.would_status==='breach'))return {key:'dormant',tone:'warn',label:'Springing test would fail'};
 if(tested.some(c=>!healthy(c)))return {key:'watch',tone:'warn',label:'Approaching limit',note:`Internal monitoring rule: a passing test with less than ${HEALTHY_HEADROOM_PCT}% headroom.`};
 return {key:'ok',tone:'ok',label:'Within limits'};
}
const STATUS_WORD={pass:'Pass',breach:'Fail',dormant:'Dormant (springing, not triggered)',unevaluable:'Cannot calculate'};

// Distance-to-compliance fields the monitor already returns, per covenant (labels only here).
// Two ways back to compliance per covenant: [label, amount at the limit, headroom against it (negative = gap)].
const DISTANCE={
 leverage:[['Largest debt at current EBITDA','max_debt_usd','debt_headroom_usd'],['EBITDA needed at current debt','ebitda_required_usd','ebitda_headroom_usd']],
 dscr:[['Cash flow needed at current debt service','cashflow_required_usd','cashflow_headroom_usd'],['Highest debt service current cash flow supports','debt_service_max_usd','denominator_headroom_usd']],
 fccr:[['Cash flow after capex, taxes and distributions needed','numerator_limit_usd','numerator_headroom_usd'],['Highest fixed charges current cash flow supports','denominator_limit_usd','denominator_headroom_usd']],
 current_ratio:[['Current assets needed','numerator_limit_usd','numerator_headroom_usd'],['Highest current liabilities current assets support','denominator_limit_usd','denominator_headroom_usd']]};

/**
 * @param monitor   the /api/covenants response object
 * @param reporting the /api/reporting response object, or null
 * @param cure      the /api/cure response body for this borrower-quarter, or null
 * @param cureNote  why `cure` is null (shown instead of the cure plan)
 */
export function assembleCallPrep({monitor,reporting=null,cure=null,cureNote=null,borrower,period,dataSource=null,policySource=null}){
 const row=rowIn(monitor,borrower,period);if(!row)return null;
 const figures=[];
 const take=(source,p,path,label)=>{
  const base=source==='covenants'?rowIn(monitor,borrower,p):source==='covenants_borrower'?monitor.borrowers.find(x=>x.borrower_id===borrower):
   source==='reporting'?reporting?.results.find(x=>x.borrower_id===borrower&&x.period===p):source==='reporting_root'?reporting:source==='cure'?cure:null;
  const value=resolvePath(base,path);
  if(value!==undefined&&value!==null)figures.push({source,borrower_id:borrower,period:source==='covenants'||source==='reporting'?p:null,path,value,label:label||null});
  return value??null;
 };
 const ps=periodsOf(monitor),i=ps.indexOf(period),pp=i>0?ps[i-1]:null,ppp=i>1?ps[i-2]:null;
 const prow=pp?rowIn(monitor,borrower,pp):null;
 const dataDate=dataDateOf(monitor),end=quarterEndOf(period),synthetic=!!(dataDate&&end&&end>dataDate);
 const st=statusOf(row);
 const ok=row.status!=='invalid';
 const sections=['header'];

 // 1. Header
 const header={borrower_id:borrower,period,period_label:periodLabel(period),period_end:end,record_id:row.record_id??null,
  status:st,newly_flagged:isNewlyFlagged(monitor,borrower,period),synthetic_scenario:synthetic?'Synthetic scenario':null,
  debt_usd:ok?take('covenants',period,'inputs.debt_usd','Debt outstanding'):null,error:ok?null:row.error};

 // 2. Covenant scorecard
 const scorecard=[];
 if(ok)for(const [k,c] of Object.entries(row.covenants||{})){
  const at=`covenants.${k}`,pc=prow&&prow.status!=='invalid'?prow.covenants?.[k]:null;
  const value=take('covenants',period,at+'.value',`${SHORT[k]} value`),limit=take('covenants',period,at+'.limit',`${SHORT[k]} limit`);
  const prior=pc&&pc.value!=null?take('covenants',pp,at+'.value',`${SHORT[k]} value, ${periodLabel(pp)}`):null;
  const dir=c.direction;
  const change=prior==null||value==null?null:value===prior?'unchanged':(dir==='max'?value<prior:value>prior)?'stronger':'weaker';
  scorecard.push({key:k,name:COVENANT_NAMES[k],direction:dir,value,limit,status:c.status,status_word:STATUS_WORD[c.status]||c.status,would_status:c.would_status??null,mode:c.mode,
   headroom_usd:c.numerator_headroom_usd!=null?take('covenants',period,at+'.numerator_headroom_usd',`${SHORT[k]} dollar headroom`):null,
   prior_period:prior!=null?pp:null,prior_value:prior,change,reason:c.reason??null,
   springing:c.springing?{trigger_pct:take('covenants',period,at+'.springing.trigger_pct',`${SHORT[k]} springing trigger %`),utilization:take('covenants',period,at+'.springing.utilization',`${SHORT[k]} revolver utilization`),triggered:c.springing.triggered,note:c.springing.note}:null});
 }
 if(scorecard.length)sections.push('scorecard');

 // 3. Trend: each covenant's value for every quarter in the data, and the first quarter in exception
 const trendCovs=scorecard.map(s=>s.key);
 const trend=trendCovs.length?{periods:ps.map(p=>({period:p,label:periodLabel(p),synthetic:!!(dataDate&&quarterEndOf(p)>dataDate)})),
  covenants:Object.fromEntries(trendCovs.map(k=>[k,ps.map(p=>{const r=rowIn(monitor,borrower,p),c=r&&r.status!=='invalid'?r.covenants?.[k]:null;return {period:p,value:c&&c.value!=null?take('covenants',p,`covenants.${k}.value`,`${SHORT[k]} ${periodLabel(p)}`):null,status:c?c.status:null};})])),
  first_exception_period:take('covenants_borrower',null,'first_exception_period','First quarter in exception')}:null;
 if(trend)sections.push('trend');

 // 4. What it would take: distance to compliance (monitor) and the cure planner's cheapest verified plan
 const failing=scorecard.filter(s=>s.status==='breach');
 const distance=failing.map(s=>({key:s.key,name:s.name,options:DISTANCE[s.key].map(([label,f,g])=>{const at=`covenants.${s.key}.`;if(resolvePath(row,at+f)==null)return null;
  return {label,field:f,value:take('covenants',period,at+f,`${SHORT[s.key]}: ${label}`),gap_field:g,gap:resolvePath(row,at+g)==null?null:take('covenants',period,at+g,`${SHORT[s.key]}: headroom against ${label.toLowerCase()}`)};}).filter(Boolean)}));
 let curePart=null;
 if(cure&&cure.needed!==false){
  const src={source:cure.source??null,solved_offline:cure.source==='snapshot',solved_at:cure.solved_at??null,gurobi_version:cure.gurobi_version??null,synthetic:true,terms_source:'cure_terms.csv'};
  const c=cure.available?cure.options?.find(o=>o.key==='cheapest'):null;
  if(!cure.available)curePart={state:'unavailable',reason:cure.reason||'Cure options unavailable.'};
  else if(c?.status==='plan'){
   const P='options.cheapest.plan.';
   curePart={state:'plan',...src,actions:c.plan.actions,
    total_cost_usd:take('cure',null,P+'total_cost_usd','Cheapest cure: total cost'),equity_cure_usd:take('cure',null,P+'equity_cure_usd','Cheapest cure: equity cure'),
    paydown_usd:take('cure',null,P+'paydown_usd','Cheapest cure: debt repaid early'),sell_asset:c.plan.sell_asset,asset_name:c.plan.asset_name,
    asset_proceeds_usd:c.plan.sell_asset?take('cure',null,'terms.asset_proceeds_usd','Asset sale proceeds'):null,
    leverage_after:take('cure',null,P+'leverage','Leverage after cure'),dscr_after:take('cure',null,P+'dscr','DSCR after cure'),verified:c.plan.verified===true};
  }else if(c?.status==='no_cure'){
   const W='options.cheapest.waiver.',w=c.waiver;
   curePart={state:'no_cure',...src,blocked_by:(c.iis||[]).map(x=>x.title),
    waiver:w?{request:w.request,paydown_usd:take('cure',null,W+'paydown_usd','Waiver: debt repaid early'),actions:w.actions,
     waived:['leverage','dscr','fccr','current_ratio'].filter(k=>w[k+'_waived']).map(k=>({key:k,direction:k==='leverage'?'max':'min',
      threshold:take('cure',null,W+({leverage:'max_leverage',dscr:'min_dscr',fccr:'min_fccr',current_ratio:'min_current_ratio'})[k],`Waiver threshold, ${SHORT[k]}`)}))}:null,
    waiver_error:c.waiver_error??null};
  }else curePart={state:'unavailable',reason:c?.reason||c?.error||'The cure planner returned no verified plan.'};
 }else if(!cure&&cureNote&&failing.length)curePart={state:'unavailable',reason:cureNote};
 const what=failing.length||curePart?.state==='plan'||curePart?.state==='no_cure'?{distance,cure:curePart}:null;
 if(what)sections.push('what_it_would_take');

 // 5. Financial snapshot: shown only when a future monitor row carries statement figures.
 const financials=ok&&row.statements&&typeof row.statements==='object'?Object.entries(row.statements).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>({line_item:k,value:take('covenants',period,`statements.${k}`,k)})):null;
 if(financials?.length)sections.push('financials');

 // 6. Reporting
 let rep=null;
 if(reporting?.supplied){
  const rr=reporting.results.find(x=>x.borrower_id===borrower&&x.period===period)?.reporting;
  if(rr&&rr.documents){
   const R='reporting.';
   const docs=Object.entries(rr.documents).map(([k,d])=>({key:k,label:DOC_LABEL[k],status:d.status,due_date:take('reporting',period,`${R}documents.${k}.due_date`,`${DOC_LABEL[k]} due`),
    received_date:d.received_date?take('reporting',period,`${R}documents.${k}.received_date`,`${DOC_LABEL[k]} received`):null,
    days_late:d.days_late!=null?take('reporting',period,`${R}documents.${k}.days_late`,`${DOC_LABEL[k]} days late`):null,
    days_overdue:d.days_overdue!=null?take('reporting',period,`${R}documents.${k}.days_overdue`,`${DOC_LABEL[k]} days overdue`):null,reason:d.reason??null,fiscal_year:d.fiscal_year??null}));
   const qPath=rr.quality?`${R}quality`:rr.annual_reference?.quality?`${R}annual_reference.quality`:null;
   const q=qPath?resolvePath(reporting.results.find(x=>x.borrower_id===borrower&&x.period===period),qPath):null;
   rep={status:rr.status,documents:docs,
    quality:q?{fiscal_year:take('reporting',period,qPath+'.fiscal_year','Annual statements fiscal year'),value:q.value,minimum:q.minimum,below_minimum:q.below_minimum,status:q.status,reason:q.reason,from_period:rr.quality?period:rr.annual_reference.from_period}:null,
    consecutive_late_or_missing:take('reporting',period,`${R}consecutive_late_or_missing`,'Consecutive quarters late or missing'),
    document_review_date:take('reporting_root',null,'document_review_date','Document review date')};
   sections.push('reporting');
  }
 }

 // 7. Questions to ask the owner (fixed mapping, most serious first, at most six)
 const questions=[];const ask=(rule,text,figs=[])=>questions.push({rule,text,figures:figs});
 const sc=k=>scorecard.find(s=>s.key===k);
 if(curePart?.state==='no_cure'&&curePart.waiver?.waived?.length){
  const parts=curePart.waiver.waived.map(w=>`${limText(w.threshold)} ${w.direction==='max'?'maximum':'minimum'} ${({leverage:'leverage',dscr:'DSCR',fccr:'FCCR',current_ratio:'current ratio'})[w.key]}`);
  ask(1,`We would need a waiver to ${listAnd(parts)} for ${periodLabel(period)}. Can you support that request with a plan?`,curePart.waiver.waived.map(w=>w.threshold));
 }
 const lev=sc('leverage');
 if(lev?.status==='breach'&&neg(lev.headroom_usd))ask(2,`Debt is ${moneyAbs(lev.headroom_usd)} above what current EBITDA supports. What is the plan to pay down debt or grow earnings?`,[lev.headroom_usd]);
 const ds=sc('dscr'),fc=sc('fccr');
 if(ds?.status==='breach'&&neg(ds.headroom_usd)){
  const also=fc?.status==='breach'&&neg(fc.headroom_usd)?`, and ${moneyAbs(fc.headroom_usd)} short on fixed-charge coverage`:'';
  ask(3,`Cash flow fell ${moneyAbs(ds.headroom_usd)} short of what the ${limText(ds.limit)} minimum DSCR requires for the loan payments${also}. Were there one-time costs, and what do the next two quarters look like?`,[ds.headroom_usd,ds.limit,...(also?[fc.headroom_usd]:[])]);
 }else if(fc?.status==='breach'&&neg(fc.headroom_usd))ask(3,`Cash flow after capex, taxes and distributions fell ${moneyAbs(fc.headroom_usd)} short of what the ${limText(fc.limit)} minimum FCCR requires for the loan payments. Were there one-time costs, and what do the next two quarters look like?`,[fc.headroom_usd,fc.limit]);
 const cr=sc('current_ratio');
 if(cr?.status==='breach'&&cr.value!=null)ask(4,`Current assets cover current liabilities only ${ratioText(cr.value,cr.limit)} against a ${limText(cr.limit)} minimum. What is happening with receivables and payables?`,[cr.value,cr.limit]);
 if(curePart?.state==='plan'&&cents(curePart.equity_cure_usd)>0n)ask(5,`The cheapest fix needs a ${money(curePart.equity_cure_usd)} equity contribution. Is the sponsor able and willing to fund it?`,[curePart.equity_cure_usd]);
 if(curePart?.state==='plan'&&curePart.sell_asset&&curePart.asset_proceeds_usd!=null)ask(6,`The plan assumes selling ${curePart.asset_name} for ${money(curePart.asset_proceeds_usd)}. Is that realistic this quarter?`,[curePart.asset_proceeds_usd]);
 if(rep){
  for(const d of rep.documents.filter(d=>(d.key==='financials'||d.key==='compliance_cert')&&d.status==='missing'))
   ask(7,`The ${d.label} for ${periodLabel(period)} ${d.key==='financials'?'are':'is'} ${d.days_overdue} day${d.days_overdue===1?'':'s'} overdue. When can we expect the ${d.label}? Is anything holding it up?`,[d.days_overdue]);
  const run=rep.consecutive_late_or_missing;
  if(run>=2){
   // "late" when every quarter in the run had only late items; "late or missing" otherwise.
   let allLate=true;let p=period;for(let n=0;n<run&&p;n++){const x=reporting.results.find(r=>r.borrower_id===borrower&&r.period===p)?.reporting;if(x?.status!=='late')allLate=false;const m=PERIOD.exec(p);p=m?(+m[2]===1?`${+m[1]-1}-Q4`:`${m[1]}-Q${+m[2]-1}`):null;}
   ask(8,`Reporting has been ${allLate?'late':'late or missing'} ${run} quarters in a row. Do you need help from your accountant or a different schedule?`,[run]);
  }else{
   const late=rep.documents.filter(d=>(d.key==='financials'||d.key==='compliance_cert')&&d.status==='late');
   if(late.length===2&&late[0].days_late===late[1].days_late)ask(9,`The quarterly financials and the compliance certificate arrived ${late[0].days_late} days late. Is anything changing in your close process?`,[late[0].days_late]);
   else for(const d of late)ask(9,`The ${d.label} arrived ${d.days_late} day${d.days_late===1?'':'s'} late. Is anything changing in your close process?`,[d.days_late]);
  }
 }
 // 10. Headroom on a passing test narrowed two quarters running (dollar headroom, exact cents).
 if(pp&&ppp)for(const s of scorecard.filter(s=>s.status==='pass'&&s.headroom_usd!=null)){
  const h=p=>{const r=rowIn(monitor,borrower,p),c=r&&r.status!=='invalid'?r.covenants?.[s.key]:null;return c&&(c.status==='pass'||c.status==='breach')&&c.numerator_headroom_usd!=null?c.numerator_headroom_usd:null;};
  const a=h(ppp),b=h(pp);
  if(a!=null&&b!=null&&cents(b)<cents(a)&&cents(s.headroom_usd)<cents(b)){
   take('covenants',ppp,`covenants.${s.key}.numerator_headroom_usd`,`${SHORT[s.key]} dollar headroom, ${periodLabel(ppp)}`);take('covenants',pp,`covenants.${s.key}.numerator_headroom_usd`,`${SHORT[s.key]} dollar headroom, ${periodLabel(pp)}`);
   ask(10,`${SHORT[s.key]} headroom has narrowed two quarters in a row, from ${money(a)} in ${periodLabel(ppp)} to ${money(s.headroom_usd)}. What is driving it?`,[a,s.headroom_usd]);
  }
 }
 // 11. Springing test dormant but would fail
 const dorm=scorecard.filter(s=>s.status==='dormant'&&s.would_status==='breach'&&s.springing?.utilization!=null);
 if(dorm.length){const s=dorm[0];ask(11,`Revolver use is ${pct(s.springing.utilization)} against a ${Number(s.springing.trigger_pct)}% trigger. Do you expect to draw more?`,[s.springing.utilization,s.springing.trigger_pct]);}
 // 12. Annual statement quality below the minimum
 if(rep?.quality?.below_minimum)ask(12,`The agreement calls for ${QUALITY_WORD[rep.quality.minimum]} annual statements; the FY${rep.quality.fiscal_year} ones were ${QUALITY_WORD[rep.quality.value]}. When will ${QUALITY_WORD[rep.quality.minimum]} statements be available?`,[rep.quality.fiscal_year]);
 // 13. Everything passing with healthy headroom
 const tested=scorecard.filter(s=>s.status!=='dormant');
 if(ok&&tested.length&&tested.every(s=>healthy(row.covenants[s.key]))&&!dorm.length)ask(13,'Results look solid. Any plans for capital spending, acquisitions or distributions we should know about?');
 questions.sort((a,b)=>a.rule-b.rule);
 const shown=questions.slice(0,MAX_QUESTIONS);
 sections.push('questions');

 // 8. Footer
 const citations=(row.evidence||[]).map(e=>e.definition?{covenant:e.covenant,name:COVENANT_NAMES[e.covenant]||e.covenant,quote:e.definition.quote,source_document:e.definition.source_document,start:e.definition.start,end:e.definition.end,sha256:e.definition.sha256}:{covenant:e.covenant,name:COVENANT_NAMES[e.covenant]||e.covenant,quote:null,note:e.note||'No definition found in policy text'});
 const footer={data_source:dataSource,policy_source:policySource,data_date:dataDate,document_review_date:rep?rep.document_review_date:null,citations,note:LEGAL_NOTE};
 sections.push('footer');

 return {borrower_id:borrower,period,sections,header,scorecard,trend,what_it_would_take:what,financials:financials?.length?financials:null,reporting:rep,
  questions:shown,questions_omitted:questions.length-shown.length,footer,figures,
  rules:{question_order:'Fixed mapping in lib/callprep.js, most serious first, at most six.',healthy_headroom:`A passing test with at least ${HEALTHY_HEADROOM_PCT}% of its limit in hand (the app's default internal monitoring rule).`,newly_flagged:'Passed every applicable covenant in the previous quarter in the data and failed at least one tested covenant this quarter (same rule as the app).'}};
}
