import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {minor} from '../lib/finance.js';import {verifyCitation,sha256} from '../lib/citations.js';
import {parseCureTerms,parseCureTermRow,cureClauseCitations,CURE_TERM_FIELDS} from '../lib/cure-terms.js';
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');

test('cure_terms.csv: 9 synthetic rows, money parsed exactly with minor()',async()=>{
 const rows=parseCSV(await rd('cure_terms.csv'));
 assert.equal(rows.length,9);assert.deepEqual(Object.keys(rows[0]),CURE_TERM_FIELDS);
 assert.ok(rows.every(r=>r.synthetic==='true'));
 const terms=parseCureTerms(rows);assert.equal(terms.size,9);
 for(let i=1;i<=9;i++)assert.ok(terms.has('BOR-0'+i));
 const b9=terms.get('BOR-09');
 assert.equal(b9.equity_cure_cap,minor('100000.00'));assert.equal(b9.cash,40000000n);assert.equal(b9.min_liquidity,15000000n);
 assert.equal(b9.ds_reduction_per_usd_e4,1800n);assert.equal(b9.prepay_premium_bps,100);assert.equal(b9.cures_remaining,1);
 assert.equal(b9.asset_name,'Division A');assert.equal(b9.asset_proceeds,15000000n);assert.equal(b9.asset_ebitda,2000000n);
 assert.equal(b9.asset_cashflow,2500000n);assert.equal(b9.sale_cost,1000000n);
 const b1=terms.get('BOR-01');assert.equal(b1.asset_name,null);assert.equal(b1.asset_proceeds,0n);
});

test('cure terms reject malformed rows',async()=>{
 const good=parseCSV(await rd('cure_terms.csv'))[0];
 assert.throws(()=>parseCureTermRow({...good,cash_usd:'12abc'}),/Invalid money/);
 assert.throws(()=>parseCureTermRow({...good,cures_remaining_4q:'1.5'}),/whole number/);
 assert.throws(()=>parseCureTermRow({...good,asset_proceeds_usd:'5.00'}),/without an asset_name/);
 assert.throws(()=>parseCureTerms([good,good]),/duplicate/);
});

test('cure-policy.txt: one citable sentence per clause, verified by offsets and SHA-256',async()=>{
 const text=await rd('documents/cure-policy.txt');
 assert.match(text,/^FICTIONAL CURE TERMS/);assert.match(text,/synthetic/);
 const {clauses,warnings}=cureClauseCitations(text);
 assert.deepEqual(warnings,[]);
 const expect={equity_cure:/^Equity cure: .*equity cure cap in cure_terms\.csv\.$/,cure_frequency:/^Cure frequency: .*at least 1\.$/,
  minimum_liquidity:/^Minimum liquidity: .*minimum liquidity in cure_terms\.csv\.$/,prepayment:/^Prepayment: .*per dollar repaid\.$/,
  asset_sale:/^Asset sales: .*trailing twelve-month figures\.$/,cure_cash:/^Cure cash: .*paid from its gross proceeds\.$/};
 for(const [k,re] of Object.entries(expect)){
  const c=clauses[k];assert.ok(c,k);assert.match(c.quote,re);assert.ok(verifyCitation(text,c));assert.equal(c.sha256,sha256(c.quote));
  assert.equal(c.source_document,'documents/cure-policy.txt');
 }
 assert.equal(cureClauseCitations('nothing here').warnings.length,6);
});
