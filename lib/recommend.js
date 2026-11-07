// Covenant Designer: read a borrower's financial statements (CSV of line items), compute the ratios the
// monitor tests, and recommend a covenant package with a lender-chosen cushion. Deterministic rules only,
// no LLM. Money is BigInt cents; ratio thresholds are x100 integers (3.25x -> 325n).
import {parseCSV} from './csv.js';
import {amount,ratio} from './finance.js';

// Canonical line items and the labels we accept for each (matched after normalizing case and punctuation).
const ITEMS={
 revenue:['revenue','revenues','total revenue','net revenue','net sales','sales','total sales'],
 ebitda:['ebitda','adjusted ebitda','ttm ebitda'],
 operating_income:['operating income','income from operations','operating profit','ebit'],
 depreciation_amortization:['depreciation and amortization','d and a','da','depreciation amortization','depreciation and amortisation'],
 net_income:['net income','net earnings','net profit'],
 income_tax_expense:['income tax expense','provision for income taxes','income taxes','tax expense'],
 interest_expense:['interest expense','cash interest','interest paid','cash interest paid'],
 scheduled_principal:['scheduled principal','scheduled principal payments','principal payments','scheduled debt repayments','required principal payments'],
 current_portion_ltd:['current portion of long term debt','current maturities of long term debt','current portion of debt'],
 short_term_debt:['short term debt','short term borrowings','notes payable'],
 long_term_debt:['long term debt','long term debt net of current portion','long term debt less current portion','long term borrowings'],
 total_debt:['total debt','funded debt','gross debt','total funded debt'],
 capex:['capital expenditures','capex','purchases of property plant and equipment','purchase of property plant and equipment','unfinanced capital expenditures'],
 cash_taxes:['income taxes paid','cash taxes','taxes paid','cash taxes paid'],
 distributions:['dividends paid','distributions','dividends','distributions to owners','owner distributions'],
 current_assets:['total current assets','current assets'],
 current_liabilities:['total current liabilities','current liabilities'],
 total_assets:['total assets'],
 cash:['cash','cash and cash equivalents','cash and equivalents'],
 revolver_commitment:['revolver commitment','revolving credit commitment','revolving facility commitment','revolver limit','revolving credit facility commitment'],
 revolver_drawn:['revolver drawn','revolver balance','revolver outstanding','revolver borrowings','borrowings under revolver','revolving credit borrowings'],
};
const LABEL={revenue:'Revenue',ebitda:'EBITDA',operating_income:'Operating income',depreciation_amortization:'Depreciation and amortization',net_income:'Net income',income_tax_expense:'Income tax expense',interest_expense:'Interest expense',scheduled_principal:'Scheduled principal',current_portion_ltd:'Current portion of long-term debt',short_term_debt:'Short-term debt',long_term_debt:'Long-term debt',total_debt:'Total debt',capex:'Capital expenditures',cash_taxes:'Cash taxes paid',distributions:'Distributions',current_assets:'Current assets',current_liabilities:'Current liabilities',total_assets:'Total assets',cash:'Cash',revolver_commitment:'Revolver commitment',revolver_drawn:'Revolver drawn'};
// Outflows are often shown as negatives or in parentheses on a cash flow statement; we use their size.
const OUTFLOWS=new Set(['interest_expense','scheduled_principal','current_portion_ltd','capex','cash_taxes','distributions','depreciation_amortization','income_tax_expense']);
const norm=s=>String(s).toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const LOOKUP=new Map(Object.entries(ITEMS).flatMap(([k,ls])=>ls.map(l=>[norm(l),k])));

// Tool conventions (stated to the user, not market data).
export const CONVENTIONS=Object.freeze({default_cushion_pct:25,min_cushion_pct:5,max_cushion_pct:50,leverage_step:25n,coverage_step:5n,
 floors:{dscr:110n,fccr:100n,current_ratio:100n},high_leverage:500n,heavy_capex_bps:1500n,working_capital_share_bps:2500n,springing_trigger_pct:'35.00'});

// "(1,250.50)", "$1,250", "-1250.5" -> signed cents. Throws on anything else.
function money(raw){
 let t=String(raw).trim().replace(/[$\s]/g,'').replace(/,/g,'');let neg=false;
 if(/^\(.*\)$/.test(t)){neg=true;t=t.slice(1,-1);}
 if(t.startsWith('-')){neg=!neg;t=t.slice(1);}
 if(!/^\d+(\.\d{1,2})?$/.test(t))throw Error(`"${raw}" is not an amount with at most two decimals`);
 const [w,f='']=t.split('.');const n=BigInt(w)*100n+BigInt(f.padEnd(2,'0'));return neg?-n:n;
}
const pickHeader=(headers,names)=>headers.find(h=>names.includes(norm(h)));

export function readStatements(csvText){
 if(typeof csvText!=='string'||!csvText.trim())throw Error('The statements file is empty.');
 const rows=parseCSV(csvText,{maxRows:2000});
 if(!rows.length)throw Error('The statements file has a header row but no line items.');
 const headers=Object.keys(rows[0]);
 const hl=pickHeader(headers,['line item','item','account','label','description']),ha=pickHeader(headers,['amount usd','amount','value','usd','ttm amount usd']);
 if(!hl||!ha)throw Error('Statements need two columns: line_item and amount_usd (one row per line item, USD, trailing twelve months for income and cash flow items, period end for balance sheet items).');
 const facts={},ignored=[],errors=[],notes=[];
 rows.forEach((r,i)=>{
  const label=String(r[hl]??'').trim(),raw=String(r[ha]??'').trim(),line=i+2;
  if(!label)return;if(!raw){ignored.push({line,label,reason:'no amount (treated as a heading)'});return;}
  const key=LOOKUP.get(norm(label));if(!key){ignored.push({line,label,reason:'not a line item this tool uses'});return;}
  let v;try{v=money(raw);}catch(e){errors.push(`Line ${line} (${label}): ${e.message}.`);return;}
  if(facts[key]){errors.push(`${LABEL[key]} appears twice (line ${facts[key].line} "${facts[key].label}" and line ${line} "${label}"); keep one so the tool does not have to guess.`);return;}
  if(OUTFLOWS.has(key)&&v<0n){v=-v;notes.push(`${label} (line ${line}) was shown as a negative outflow; its size, ${amount(v)}, is used.`);}
  facts[key]={key,label,line,cents:v};
 });
 if(errors.length)throw Error(errors.join(' '));
 return {facts,ignored,notes};
}

// Derive the figures the ratios need, recording how each one was obtained.
function derive(facts){
 const F={},src={},notes=[];
 const take=k=>{if(facts[k]){F[k]=facts[k].cents;src[k]={line:facts[k].line,label:facts[k].label};return true;}return false;};
 for(const k of Object.keys(ITEMS))take(k);
 const has=(...ks)=>ks.every(k=>F[k]!==undefined);
 if(!has('ebitda')){
  if(has('operating_income','depreciation_amortization')){F.ebitda=F.operating_income+F.depreciation_amortization;src.ebitda={derived:'Operating income + depreciation and amortization'};}
  else if(has('net_income','interest_expense','income_tax_expense','depreciation_amortization')){F.ebitda=F.net_income+F.interest_expense+F.income_tax_expense+F.depreciation_amortization;src.ebitda={derived:'Net income + interest + income tax expense + depreciation and amortization'};}
 }
 if(!has('total_debt')){const parts=['short_term_debt','current_portion_ltd','long_term_debt'].filter(k=>has(k));
  if(parts.length){F.total_debt=parts.reduce((a,k)=>a+F[k],0n);src.total_debt={derived:parts.map(k=>LABEL[k]).join(' + ')};
   if(has('revolver_drawn'))notes.push('Total debt was built from the debt lines listed and does not add the revolver balance separately. If revolver borrowings are not already in those lines, add a "Total debt" line.');}}
 if(!has('scheduled_principal')&&has('current_portion_ltd')){F.scheduled_principal=F.current_portion_ltd;src.scheduled_principal={derived:'Current portion of long-term debt (principal due in the next twelve months)'};}
 if(!has('cash_taxes')){
  if(has('income_tax_expense')){F.cash_taxes=F.income_tax_expense;src.cash_taxes={derived:'Income tax expense (no cash taxes line supplied)'};}
  else{F.cash_taxes=0n;src.cash_taxes={derived:'Not supplied; assumed zero. This flatters coverage, so add an "Income taxes paid" line if the company pays tax.'};notes.push('No tax line was found; cash taxes are assumed to be zero, which makes coverage look stronger.');}
 }
 if(!has('distributions')){F.distributions=0n;src.distributions={derived:'Not supplied; assumed zero'};}
 if(has('interest_expense','scheduled_principal')){F.debt_service=F.interest_expense+F.scheduled_principal;src.debt_service={derived:'Interest expense + scheduled principal'};}
 return {F,src,notes};
}

const ceilDiv=(n,d)=>(n+d-1n)/d;
const roundUp=(x,s)=>ceilDiv(x,s)*s, roundDown=(x,s)=>x/s*s;
const x100=v=>amount(v); // 325n -> "3.25"
const pct=(n,d)=>d>0n?Number(n*10000n/d)/100:null; // percentage with two decimals, rounded down

export function recommendCovenants(csvText,{cushion_pct=CONVENTIONS.default_cushion_pct,company=null}={}){
 const c=Number(cushion_pct);
 if(!Number.isInteger(c)||c<CONVENTIONS.min_cushion_pct||c>CONVENTIONS.max_cushion_pct)throw Error(`Cushion must be a whole percentage from ${CONVENTIONS.min_cushion_pct} to ${CONVENTIONS.max_cushion_pct}.`);
 if(company!=null&&(typeof company!=='string'||company.length>100))throw Error('Company name must be text under 100 characters.');
 const cb=BigInt(c*100); // cushion in basis points
 const {facts,ignored,notes:readNotes}=readStatements(csvText);
 const {F,src,notes}=derive(facts);
 const has=(...ks)=>ks.every(k=>F[k]!==undefined);
 const warnings=[...notes];
 const metrics={},recs={};
 const need=(...ks)=>ks.filter(k=>F[k]===undefined).map(k=>LABEL[k]||k.replace(/_/g,' '));
 const missingMsg=m=>`Needs ${m.join(', ')} in the statements.`;

 // Leverage (maximum): debt / EBITDA.
 if(has('total_debt','ebitda')){
  const ok=F.ebitda>0n;metrics.leverage={value:ok?ratio(F.total_debt,F.ebitda):null,numerator_usd:amount(F.total_debt),denominator_usd:amount(F.ebitda),formula:'Total debt ÷ EBITDA'};
  if(F.total_debt===0n)recs.leverage={decision:'not_recommended',rationale:['The company reports no funded debt, so a leverage covenant would not constrain anything today.']};
  else if(!ok)recs.leverage={decision:'not_recommended',rationale:['EBITDA is zero or negative, so leverage is not meaningful. Consider a minimum EBITDA or minimum liquidity covenant instead.']};
  else{
   // Maximum such that EBITDA can fall by the cushion before breach: debt / (EBITDA × (1 − c)), rounded up to 0.25x.
   let th=roundUp(ceilDiv(F.total_debt*100n*10000n,F.ebitda*(10000n-cb)),CONVENTIONS.leverage_step);
   const r=['Every term loan has one: it caps debt relative to earnings and is the first signal of over-borrowing.',
    `Set so EBITDA could fall about ${c}% before a breach, then rounded up to the nearest 0.25x.`];
   if(th>CONVENTIONS.high_leverage)r.push(`Recommended maximum is above ${x100(CONVENTIONS.high_leverage)}x, which this tool treats as high. Consider lower debt, more equity or step-downs over time.`);
   recs.leverage={decision:'recommended',mode:'maintenance',threshold:x100(th),direction:'max',
    implied_cushion_pct:pct(th*F.ebitda-F.total_debt*100n,th*F.ebitda),rationale:r};
  }
 }else recs.leverage={decision:'insufficient_data',missing:need('total_debt','ebitda'),rationale:[missingMsg(need('total_debt','ebitda'))]};

 // Minimum-type coverage ratios share one rule: threshold = current level × (1 − c), rounded down, never below the floor.
 const minRec=(key,num,den)=>{
  if(num<=0n)return {decision:'not_recommended',rationale:['The cash flow for this ratio is zero or negative, so the company would fail any positive minimum today. Restructure the debt or require equity before setting this covenant.']};
  let th=roundDown(num*100n*(10000n-cb)/(den*10000n),CONVENTIONS.coverage_step);
  const floor=CONVENTIONS.floors[key],floored=th<floor;if(floored)th=floor;
  const fails=num*100n<th*den;
  return {threshold:x100(th),direction:'min',floored,fails_at_signing:fails,implied_cushion_pct:fails?null:pct(num*100n-th*den,num*100n)};
 };
 // DSCR: (EBITDA − cash taxes) / (interest + scheduled principal).
 let dscrOk=false,fccrOk=false;
 if(has('ebitda','debt_service')&&F.debt_service>0n){dscrOk=true;const num=F.ebitda-F.cash_taxes;
  metrics.dscr={value:ratio(num,F.debt_service),numerator_usd:amount(num),denominator_usd:amount(F.debt_service),formula:'(EBITDA − cash taxes) ÷ (interest + scheduled principal)'};
  recs.dscr={...minRec('dscr',num,F.debt_service),mode:'maintenance'};}
 else recs.dscr={decision:'insufficient_data',missing:need('ebitda','interest_expense','scheduled_principal'),rationale:[has('debt_service')?'Debt service is zero, so there is nothing to cover.':missingMsg(need('ebitda','interest_expense','scheduled_principal'))]};
 // FCCR: (EBITDA − capex − cash taxes − distributions) / (interest + scheduled principal).
 if(has('ebitda','debt_service','capex')&&F.debt_service>0n){fccrOk=true;const num=F.ebitda-F.capex-F.cash_taxes-F.distributions;
  metrics.fccr={value:ratio(num,F.debt_service),numerator_usd:amount(num),denominator_usd:amount(F.debt_service),formula:'(EBITDA − capex − cash taxes − distributions) ÷ (interest + scheduled principal)'};
  recs.fccr={...minRec('fccr',num,F.debt_service)};}
 else recs.fccr={decision:'insufficient_data',missing:need('ebitda','capex','interest_expense','scheduled_principal'),rationale:[missingMsg(need('ebitda','capex','interest_expense','scheduled_principal'))]};
 // Current ratio: current assets / current liabilities.
 if(has('current_assets','current_liabilities')&&F.current_liabilities>0n){
  metrics.current_ratio={value:ratio(F.current_assets,F.current_liabilities),numerator_usd:amount(F.current_assets),denominator_usd:amount(F.current_liabilities),formula:'Current assets ÷ current liabilities'};
  recs.current_ratio={...minRec('current_ratio',F.current_assets,F.current_liabilities),mode:'maintenance'};}
 else recs.current_ratio={decision:'insufficient_data',missing:need('current_assets','current_liabilities'),rationale:[missingMsg(need('current_assets','current_liabilities'))]};

 // Which coverage test to lead with: FCCR when capex and distributions are a large call on EBITDA.
 const burden=fccrOk&&F.ebitda>0n?(F.capex+F.distributions)*10000n/F.ebitda:null;
 const heavy=burden!=null&&burden>=CONVENTIONS.heavy_capex_bps;
 const revolver=has('revolver_commitment')&&F.revolver_commitment>0n;
 const util=revolver&&has('revolver_drawn')?ratio(F.revolver_drawn,F.revolver_commitment):null;
 const decide=(key,lead,why)=>{const r=recs[key];if(r.decision)return;
  r.decision=r.fails_at_signing?'fails_at_signing':lead?'recommended':'optional';
  r.rationale=[...why];
  if(r.floored)r.rationale.push(`The cushion rule gave a minimum below ${x100(CONVENTIONS.floors[key])}x, so the tool's floor of ${x100(CONVENTIONS.floors[key])}x is used.`);
  else r.rationale.push(`Set so ${key==='current_ratio'?'current assets':'the cash flow in this ratio'} could fall about ${c}% before a breach, then rounded down to the nearest 0.05x.`);
  if(r.fails_at_signing)r.rationale.push(`The company is already below ${r.threshold}x today, so it would be in breach at signing. Negotiate a lower opening level or require improvement first.`);};
 const bp=burden==null?null:Number(burden)/100;
 decide('fccr',heavy||!dscrOk,[heavy?`Capex and distributions take ${bp}% of EBITDA, so a test that subtracts them (FCCR) shows the cash really available for lenders.`:`Capex and distributions take ${bp??'an unknown share'}% of EBITDA. DSCR already captures most of the risk, so FCCR is optional.`]);
 decide('dscr',!(heavy&&fccrOk),[heavy&&fccrOk?'FCCR is recommended instead: it covers the same debt service and also subtracts capex and distributions. Use DSCR only if the lender prefers the simpler test.':'Tests whether operating cash flow after taxes covers interest and scheduled principal.']);
 if(recs.fccr.decision&&recs.fccr.decision!=='insufficient_data'&&recs.fccr.threshold){
  recs.fccr.mode=revolver?'springing':'maintenance';
  if(revolver){recs.fccr.trigger_pct=CONVENTIONS.springing_trigger_pct;recs.fccr.currently_triggered=util==null?null:F.revolver_drawn*10000n>=BigInt(Math.round(Number(CONVENTIONS.springing_trigger_pct)*100))*F.revolver_commitment;
   recs.fccr.rationale.push(`The company has a revolver, so FCCR is suggested as springing: tested only in quarters when the revolver is at least ${Number(CONVENTIONS.springing_trigger_pct)}% drawn${util==null?'. Revolver drawn amount was not supplied, so the tool cannot say whether it would be tested today.':`. It is ${(util*100).toFixed(1)}% drawn today, so it would ${recs.fccr.currently_triggered?'be tested now':'not be tested now'}.`}`);}
 }
 const caShare=has('current_assets','total_assets')&&F.total_assets>0n?F.current_assets*10000n/F.total_assets:null;
 const wcHeavy=caShare!=null&&caShare>=CONVENTIONS.working_capital_share_bps;
 decide('current_ratio',revolver||wcHeavy,[revolver||wcHeavy?`${wcHeavy?`Current assets are ${Number(caShare)/100}% of total assets`:'The company relies on a revolver'}, so short-term liquidity matters to repayment.`:'Working capital is not a large part of this balance sheet, so a current ratio test is optional.']);

 const NAME={leverage:'Leverage',dscr:'Debt-service coverage (DSCR)',fccr:'Fixed-charge coverage (FCCR)',current_ratio:'Current ratio'};
 const recommendations=['leverage','fccr','dscr','current_ratio'].map(k=>({key:k,name:NAME[k],current_value:metrics[k]?.value??null,missing:[],...recs[k]}));
 const figures=Object.entries(src).filter(([k])=>F[k]!==undefined).map(([k,s])=>({key:k,name:LABEL[k]||'Debt service',amount_usd:amount(F[k]),...(s.line?{line:s.line,source_label:s.label}:{derived:s.derived})}));
 return {company,cushion_pct:c,figures,ignored,metrics,recommendations,warnings,notes:readNotes,
  revolver:revolver?{commitment_usd:amount(F.revolver_commitment),drawn_usd:has('revolver_drawn')?amount(F.revolver_drawn):null,utilization:util}:null,
  assumptions:['Income and cash flow lines are read as trailing-twelve-month totals and balance sheet lines as period-end values, all in USD.',
   `Cushion: maximums are set so EBITDA can fall about ${c}% before a breach; minimums so the ratio's cash flow (or current assets) can fall about ${c}%. Leverage is rounded up to 0.25x and minimums down to 0.05x.`,
   `Floors (tool conventions, not market data): DSCR ${x100(CONVENTIONS.floors.dscr)}x, FCCR ${x100(CONVENTIONS.floors.fccr)}x, current ratio ${x100(CONVENTIONS.floors.current_ratio)}x. A leverage maximum above ${x100(CONVENTIONS.high_leverage)}x is flagged as high.`,
   `FCCR leads over DSCR when capex plus distributions are at least ${Number(CONVENTIONS.heavy_capex_bps)/100}% of EBITDA. A revolver makes FCCR springing at ${Number(CONVENTIONS.springing_trigger_pct)}% utilization. Current ratio is recommended with a revolver or when current assets are at least ${Number(CONVENTIONS.working_capital_share_bps)/100}% of total assets.`,
   'Figures are taken as supplied and are not audited or checked against filings. Recommendations are a starting point for a credit analyst, not credit approval or legal advice.']};
}
