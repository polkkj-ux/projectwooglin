// Cure planner inputs: synthetic cure terms (data/cure_terms.csv) and the fictional cure policy
// (data/documents/cure-policy.txt). Deterministic code only; money is BigInt cents via minor().
import {minor} from './finance.js';
import {sha256,verifyCitation} from './citations.js';

export const CURE_TERM_FIELDS=['borrower_id','equity_cure_cap_usd','cures_remaining_4q','cash_usd','min_liquidity_usd','ds_reduction_per_usd','prepay_premium_bps','asset_name','asset_proceeds_usd','asset_ebitda_usd','asset_cashflow_usd','sale_cost_usd','synthetic'];

// One borrower's terms. Money in cents (BigInt); k (debt-service reduction per dollar repaid) in
// 1/10000 units so 0.18 -> 1800n; premium in integer basis points. Throws on anything malformed.
export function parseCureTermRow(r){
 for(const f of CURE_TERM_FIELDS)if(r[f]===undefined||r[f]===null)throw Error(`Cure terms: missing field ${f}`);
 if(!/^BOR-\d+$/.test(r.borrower_id))throw Error(`Cure terms: bad borrower_id ${r.borrower_id}`);
 if(!/^\d+$/.test(r.cures_remaining_4q))throw Error(`Cure terms ${r.borrower_id}: cures_remaining_4q must be a whole number`);
 if(!/^\d+$/.test(r.prepay_premium_bps)||Number(r.prepay_premium_bps)>10000)throw Error(`Cure terms ${r.borrower_id}: prepay_premium_bps must be 0-10000`);
 if(r.synthetic!=='true'&&r.synthetic!=='false')throw Error(`Cure terms ${r.borrower_id}: synthetic must be true or false`);
 const t={borrower_id:r.borrower_id,
  equity_cure_cap:minor(r.equity_cure_cap_usd),cures_remaining:Number(r.cures_remaining_4q),
  cash:minor(r.cash_usd),min_liquidity:minor(r.min_liquidity_usd),
  ds_reduction_per_usd_e4:minor(r.ds_reduction_per_usd,{scale:4}),prepay_premium_bps:Number(r.prepay_premium_bps),
  asset_name:r.asset_name.trim()||null,asset_proceeds:minor(r.asset_proceeds_usd),asset_ebitda:minor(r.asset_ebitda_usd,{signed:true}),
  asset_cashflow:minor(r.asset_cashflow_usd,{signed:true}),sale_cost:minor(r.sale_cost_usd),synthetic:r.synthetic==='true',raw:{...r}};
 if(t.ds_reduction_per_usd_e4>10000n)throw Error(`Cure terms ${r.borrower_id}: ds_reduction_per_usd above 1.00 is not plausible`);
 if(!t.asset_name&&(t.asset_proceeds||t.asset_ebitda||t.asset_cashflow||t.sale_cost))throw Error(`Cure terms ${r.borrower_id}: asset figures given without an asset_name`);
 return t;
}
export function parseCureTerms(rows){
 const out=new Map();
 for(const r of rows){const t=parseCureTermRow(r);if(out.has(t.borrower_id))throw Error(`Cure terms: duplicate row for ${t.borrower_id}`);out.set(t.borrower_id,t);}
 return out;
}

// Cite each cure clause by exact UTF-16 offsets. A clause starts with its label ("Equity cure:")
// and ends at the first period followed by whitespace or end of text. Never invents a citation.
export const CURE_CLAUSES={equity_cure:'Equity cure:',cure_frequency:'Cure frequency:',minimum_liquidity:'Minimum liquidity:',prepayment:'Prepayment:',asset_sale:'Asset sales:',cure_cash:'Cure cash:'};
export function cureClauseCitations(text,sourceDocument='documents/cure-policy.txt'){
 const out={},warnings=[];
 for(const [k,label] of Object.entries(CURE_CLAUSES)){
  const start=text.indexOf(label);
  if(start<0){out[k]=null;warnings.push(`No "${label}" clause found in ${sourceDocument}.`);continue;}
  const m=/\.(?=\s|$)/g;m.lastIndex=start;const e=m.exec(text);const end=e?e.index+1:text.length;
  const quote=text.slice(start,end);const c={source_document:sourceDocument,start,end,quote,sha256:sha256(quote)};
  if(!verifyCitation(text,c))throw Error('Citation failed verification');
  out[k]=c;
 }
 return {clauses:out,warnings};
}
