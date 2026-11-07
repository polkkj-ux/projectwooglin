import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';
import {monitorCovenants} from '../lib/covenants.js';
const rows=parseCSV(await fs.readFile(new URL('../data/loan_covenants.csv',import.meta.url),'utf8'));
const policy=await fs.readFile(new URL('../data/documents/loan-policy.txt',import.meta.url),'utf8');
const r=monitorCovenants(rows,policy);
console.log('Covenant monitoring (USD, synthetic data)\n',r.summary,'\n');
console.log('borrower  first exception  latest   latest lev  latest DSCR  debt headroom   cash-flow headroom');
for(const b of r.borrowers){const t=b.trend.at(-1);console.log(b.borrower_id.padEnd(9),String(b.first_exception_period).padEnd(16),b.latest.padEnd(8),String(t.leverage).padEnd(11),String(t.dscr).padEnd(12),String(t.debt_headroom_usd).padStart(13),String(t.cashflow_headroom_usd).padStart(18));}
const ex=r.results.find(x=>x.status==='exception');
console.log('\nExample exception with evidence:\n'+JSON.stringify(ex,null,1));
console.log('\nAssumptions:\n- '+r.assumptions.join('\n- '));
