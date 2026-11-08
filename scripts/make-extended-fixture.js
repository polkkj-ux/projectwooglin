// Builds data/team/loan_covenants_extended.csv: the organizer's loan_covenants.csv (unchanged values)
// plus team-made SYNTHETIC columns for FCCR, current ratio and revolver utilization.
// Run: node scripts/make-extended-fixture.js
import fs from 'node:fs/promises';
import {parseCSV,toCSV} from '../lib/csv.js';
const rows=parseCSV(await fs.readFile(new URL('../data/loan_covenants.csv',import.meta.url),'utf8'));
// Per borrower: [capex, cash taxes, distributions] (USD thousands), revolver drawn by quarter (USD thousands
// of a 500K commitment; null = not reported), current assets and current liabilities by quarter (thousands).
const P={
 'BOR-01':{c:[50,20,0],d:[100,125,150,200],ca:[900,880,860,840],cl:[600,600,610,620]},   // FCCR fails in Q4 once utilization reaches 40%
 'BOR-02':{c:[70,20,0],d:[75,100,225,250],ca:[960,960,950,950],cl:[600,600,600,600]},    // FCCR would fail in Q2 but is dormant; springs in Q3
 'BOR-03':{c:[40,15,0],d:[50,50,50,50],ca:[1000,990,980,970],cl:[620,620,620,620]},
 'BOR-04':{c:[60,20,0],d:[300,300,300,300],ca:[880,870,860,850],cl:[600,600,600,600]},  // high utilization: FCCR always tested
 'BOR-05':{c:[30,15,0],d:[150,150,150,150],ca:[1050,1040,1030,1020],cl:[650,650,650,650]},
 'BOR-06':{c:[30,15,40],d:[100,100,100,100],ca:[940,930,920,910],cl:[600,600,600,600]},  // distributions push FCCR below 1.10, but it never springs
 'BOR-07':{c:[40,15,0],d:[250,250,250,250],ca:[840,820,780,750],cl:[600,620,640,650]},  // current ratio deteriorates below 1.25 from Q3
 'BOR-08':{c:[50,15,0],d:[400,400,400,400],ca:[900,900,900,900],cl:[600,600,600,600]},
 'BOR-09':{c:[35,15,0],d:[null,null,null,null],ca:[920,910,900,890],cl:[600,600,600,600]}}; // revolver not reported: trigger unknown, tested
const k=n=>(n*1000).toFixed(2);
// SYNTHETIC reporting dates (lib/reporting.js). Q1-Q3 financials and certificate received; Q4 not yet due.
// Annual statements and statement_quality are on Q1 rows only and refer to the prior fiscal year (FY2025).
const RECEIVED={default:['2026-05-08','2026-08-07','2026-11-06',''],'BOR-03':['2026-05-29','2026-08-26','2026-11-28','']}; // BOR-03: 14, 12, 14 days late
function reporting(b,q){
 const f=(RECEIVED[b]||RECEIVED.default)[q];
 const cert=b==='BOR-07'&&q===2?'':f; // BOR-07: Q3 compliance certificate missing
 const q1=q===0;
 return {financials_received_date:f,compliance_cert_received_date:cert,
  annual_statements_received_date:q1?(b==='BOR-05'?'2026-04-20':'2026-04-15'):'',
  statement_quality:q1?(b==='BOR-05'?'internal':b==='BOR-01'||b==='BOR-09'?'audited':'reviewed'):''};
}
const out=rows.map(r=>{const p=P[r.borrower_id],q=Number(r.period.slice(-1))-1;
 return {...r,source_document:'documents/loan-policy.txt; team/covenant-policy-addendum.txt',
  ttm_capex_usd:k(p.c[0]),ttm_cash_taxes_usd:k(p.c[1]),ttm_distributions_usd:k(p.c[2]),
  current_assets_usd:k(p.ca[q]),current_liabilities_usd:k(p.cl[q]),
  revolver_commitment_usd:p.d[q]==null?'':k(500),revolver_drawn_usd:p.d[q]==null?'':k(p.d[q]),
  min_fccr:'1.10',min_current_ratio:'1.25',...reporting(r.borrower_id,q)};});
await fs.writeFile(new URL('../data/team/loan_covenants_extended.csv',import.meta.url),toCSV(out));
console.log(`Wrote ${out.length} rows`);
