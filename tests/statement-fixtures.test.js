// The synthetic statement PDFs (scripts/make-statement-fixtures.py) must tie to the CSV the monitor uses.
// Recomputes each 2026-Q3 covenant row from the generator's quarterly numbers, to the cent, under
// data/statements/definitions.txt, and checks that every balance sheet balances and cash rolls forward.
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {amount} from '../lib/finance.js';import {parseCSV} from '../lib/csv.js';
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url));
const fx=JSON.parse(await rd('statements/fixtures.json'));
const csv=parseCSV((await rd('team/loan_covenants_extended.csv')).toString());
const Q=fx.quarters;
const sum=(b,k)=>Q.reduce((a,q)=>a+BigInt(b.quarters[q][k]),0n);
const at=(b,q,k)=>b.quarters[q][k]===undefined?null:BigInt(b.quarters[q][k]);

test('statement fixtures are four synthetic quarters ending 2026-Q3 for BOR-09 and BOR-01',()=>{
 assert.equal(fx.synthetic,true);assert.deepEqual(Q,['2025-Q4','2026-Q1','2026-Q2','2026-Q3']);
 assert.deepEqual(Object.keys(fx.borrowers).sort(),['BOR-01','BOR-09']);
});

for(const id of ['BOR-09','BOR-01']){
 const b=fx.borrowers[id],last=Q[3];
 test(`${id}: four quarters recompute the 2026-Q3 CSV row to the cent`,()=>{
  const row=csv.find(r=>r.borrower_id===id&&r.period==='2026-Q3');assert.ok(row);
  const ebitda=sum(b,'operating_income')+sum(b,'depreciation_amortization');          // EBITDA = operating income + D&A
  const debt=(at(b,last,'revolver_drawn')??0n)+at(b,last,'term_loan')+at(b,last,'finance_lease'); // gross debt
  const service=sum(b,'interest_expense')+sum(b,'scheduled_principal');               // interest + scheduled principal
  const acf=ebitda-sum(b,'cash_taxes')-sum(b,'capex')+sum(b,'change_in_working_capital'); // available cash flow
  const got={debt_usd:amount(debt),ttm_ebitda_usd:amount(ebitda),ttm_debt_service_usd:amount(service),ttm_available_cashflow_usd:amount(acf),
   ttm_capex_usd:amount(sum(b,'capex')),ttm_cash_taxes_usd:amount(sum(b,'cash_taxes')),ttm_distributions_usd:amount(sum(b,'distributions')),
   current_assets_usd:amount(at(b,last,'current_assets')),current_liabilities_usd:amount(at(b,last,'current_liabilities')),
   revolver_commitment_usd:at(b,last,'revolver_commitment')==null?'':amount(at(b,last,'revolver_commitment')),
   revolver_drawn_usd:at(b,last,'revolver_drawn')==null?'':amount(at(b,last,'revolver_drawn'))};
  for(const [k,v] of Object.entries(got))assert.equal(v,row[k],`${id} ${k}`);
 });
 test(`${id}: earlier balance sheets match the CSV's 2026-Q1 and 2026-Q2 rows`,()=>{
  for(const q of ['2026-Q1','2026-Q2']){const row=csv.find(r=>r.borrower_id===id&&r.period===q);
   assert.equal(amount(at(b,q,'total_debt')),row.debt_usd);assert.equal(amount(at(b,q,'current_assets')),row.current_assets_usd);
   assert.equal(amount(at(b,q,'current_liabilities')),row.current_liabilities_usd);
   assert.equal(at(b,q,'revolver_drawn')==null?'':amount(at(b,q,'revolver_drawn')),row.revolver_drawn_usd);}
 });
 test(`${id}: statements articulate (subtotals, balance sheet balances, cash rolls forward)`,()=>{
  let prevCash=null;
  for(const q of Q){const v=k=>at(b,q,k)??0n;
   assert.equal(v('operating_expenses'),v('cost_of_sales')+v('selling_general_administrative')+v('depreciation_amortization'),q);
   assert.equal(v('operating_income'),v('revenue')-v('operating_expenses'),q);
   assert.equal(v('net_income'),v('operating_income')-v('interest_expense')-v('income_tax_expense'),q);
   assert.equal(v('current_assets'),v('cash')+v('accounts_receivable')+v('inventory'),q);
   assert.equal(v('total_assets'),v('current_assets')+v('property_equipment_net')+v('long_term_investments'),q);
   assert.equal(v('current_liabilities'),v('accounts_payable')+v('accrued_liabilities')+v('current_portion_ltd'),q);
   assert.equal(v('total_liabilities'),v('current_liabilities')+v('revolver_drawn')+v('long_term_debt'),q);
   assert.equal(v('total_equity'),v('common_stock')+v('retained_earnings'),q);
   assert.equal(v('total_assets'),v('total_liabilities_and_equity'),`${q} balance sheet balances`);
   assert.equal(v('total_liabilities_and_equity'),v('total_liabilities')+v('total_equity'),q);
   assert.equal(v('total_debt'),v('revolver_drawn')+v('term_loan')+v('finance_lease'),q);
   assert.equal(v('total_debt'),v('current_portion_ltd')+v('long_term_debt')+v('revolver_drawn'),q);
   assert.equal(v('scheduled_principal'),v('term_loan_repayment')+v('finance_lease_principal'),q);
   assert.equal(v('cash_from_operations'),v('net_income')+v('depreciation_amortization')+v('change_in_working_capital'),q);
   assert.equal(v('cash_from_investing'),-v('capex')-v('investments_net'),q);
   assert.equal(v('cash_from_financing'),v('revolver_net_borrowings')-v('term_loan_repayment')-v('finance_lease_principal')-v('distributions'),q);
   assert.equal(v('net_change_in_cash'),v('cash_from_operations')+v('cash_from_investing')+v('cash_from_financing'),q);
   assert.equal(v('cash_end'),v('cash_beginning')+v('net_change_in_cash'),q);assert.equal(v('cash_end'),v('cash'),q);
   if(prevCash!==null)assert.equal(v('cash_beginning'),prevCash,`${q} opening cash`);prevCash=v('cash');
  }
 });
 test(`${id}: the PDF is marked SYNTHETIC on every page and prints the fixture numbers`,async()=>{
  const pdf=(await rd('statements/'+b.pdf)).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  const pages=(pdf.match(/\/Type \/Page\b/g)||[]).length;assert.equal(pages,3);
  assert.equal((pdf.match(/\(SYNTHETIC - team-made test fixture/g)||[]).length,pages);
  const fmt=n=>{const neg=n<0n;const s=amount(neg?-n:n).replace(/\B(?=(\d{3})+(?!\d))(?=.*\.)/g,',');return neg?`(${s})`:s;};
  for(const k of ['revenue','operating_income','depreciation_amortization','interest_expense','cash_taxes','capex','scheduled_principal','total_debt','current_assets','current_liabilities','total_assets','total_liabilities_and_equity'])
   for(const q of Q){const s=fmt(at(b,q,k)<0n?-at(b,q,k):at(b,q,k));assert.ok(pdf.includes('('+s+')')||pdf.includes('(\\('+s+'\\))'),`${id} ${q} ${k} printed`);}
 });
}

test('statement definitions are synthetic, one sentence per term, and name every term the calculations use',async()=>{
 const t=(await rd('statements/definitions.txt')).toString();
 assert.match(t,/^FICTIONAL STATEMENT DEFINITIONS \(TEAM-MADE SYNTHETIC FIXTURE\)/);
 for(const re of [/EBITDA means operating income plus depreciation and amortization\./,/Gross debt means the sum of the revolving loan, term loan and finance lease liability balances at period end\./,
  /Debt service means interest expense plus scheduled principal payments/,/Available cash flow means EBITDA minus cash taxes paid, minus unfinanced capital expenditures, plus the decrease \(or minus the increase\) in operating working capital\./])assert.match(t,re);
});
