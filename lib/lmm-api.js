// HTTP glue for the lower-middle-market features. Reads the bundled data and validates request bodies the
// same way POST /api/covenants does, then hands off to the pure modules (lib/reporting.js, lib/callprep.js). It never changes
// what /api/covenants, /api/cure, /api/recommend or /api/policy return.
import fs from 'node:fs/promises';
import {parseCSV} from './csv.js';
import {covenantColumnsError,normalizeSettings,monitorCovenants} from './covenants.js';
import {reportingReport} from './reporting.js';
import {curePlan} from './cure.js';
import {assembleCallPrep} from './callprep.js';

const DATA=new URL('../data/',import.meta.url);
// Same default dataset and policy documents as GET /api/covenants (server.js DEFAULT_CSV and ADDENDUM).
export const DEFAULT_CSV='team/loan_covenants_extended.csv',ADDENDUM='team/covenant-policy-addendum.txt',POLICY='documents/loan-policy.txt';
const rd=n=>fs.readFile(new URL(n,DATA),'utf8');

function objectBody(b){if(b===null||typeof b!=='object'||Array.isArray(b))throw Error('JSON object body required');return b;}
// Rows from an uploaded CSV (validated like POST /api/covenants) or the bundled sample.
export async function loadRows(b){
 if(b.csv!==undefined&&typeof b.csv!=='string')throw Error('csv must be a string');
 if(b.csv!==undefined){const e=covenantColumnsError(b.csv);if(e)return {error:e};}
 const rows=parseCSV(b.csv??await rd(DEFAULT_CSV));
 if(!rows.length)return {error:'The CSV has a header row but no data rows.'};
 const sample=b.csv===undefined;
 return {rows,sample,dataSource:sample?`data/${DEFAULT_CSV} (bundled synthetic sample)`:'Uploaded CSV, taken as supplied'};
}

// GET /api/reporting (bundled sample, default settings) and POST /api/reporting {csv?, settings?, reporting_settings?}.
// `settings` (covenant terms) is accepted and validated for symmetry with the other routes, but reporting
// does not depend on covenant terms.
export async function reportingRoute(raw={}){
 const b=objectBody(raw);
 const x=await loadRows(b);if(x.error)return {code:400,body:{error:x.error}};
 if(b.settings!==undefined)normalizeSettings(b.settings);
 return {code:200,body:reportingReport(x.rows,b.reporting_settings,{sample:x.sample,dataSource:x.dataSource})};
}

// GET /api/callprep?borrower=&period= and POST /api/callprep {borrower, period, csv?, settings?, reporting_settings?,
// policy?, policy_name?}. Runs the monitor exactly as /api/covenants does (same data, policy and settings), the
// reporting tracker as /api/reporting does, and, for the bundled sample, the cure planner as /api/cure does, then
// assembles the one-pager from those results.
export async function callprepRoute(raw={}){
 const b=objectBody(raw);
 if(typeof b.borrower!=='string'||!b.borrower.trim()||b.borrower.length>100)throw Error('borrower is required, for example BOR-03');
 if(typeof b.period!=='string'||!/^\d{4}-Q[1-4]$/.test(b.period))throw Error('period must look like 2026-Q2');
 if(b.policy!==undefined&&(typeof b.policy!=='string'||b.policy.length>2_000_000))throw Error('policy must be text under 2 million characters');
 const x=await loadRows(b);if(x.error)return {code:400,body:{error:x.error}};
 const custom=typeof b.policy==='string';
 const policyName=custom?(typeof b.policy_name==='string'&&/^[A-Za-z0-9_. -]{1,100}$/.test(b.policy_name)?b.policy_name:'uploaded-policy'):undefined;
 const monitor=monitorCovenants(x.rows,custom?b.policy:await rd(POLICY),{sourceDocument:policyName,supplements:custom?[]:[{name:ADDENDUM,text:await rd(ADDENDUM)}],settings:b.settings});
 const reporting=reportingReport(x.rows,b.reporting_settings,{sample:x.sample,dataSource:x.dataSource});
 let cure=null,cureNote=null;
 if(!x.sample||custom)cureNote='Cure planning uses the bundled sample data, policy and synthetic cure terms, so it is not available for an uploaded CSV or policy.';
 else{try{const r=await curePlan({borrower:b.borrower,period:b.period,settings:b.settings});if(r.code===200)cure=r.body;else cureNote=r.body?.error||r.body?.reason||`Cure planner returned ${r.code}`;}catch(e){cureNote=`Cure planner unavailable: ${e.message}`;}}
 const page=assembleCallPrep({monitor,reporting,cure,cureNote,borrower:b.borrower,period:b.period,dataSource:x.dataSource,
  policySource:custom?`${policyName} (uploaded, reviewed by the user)`:`${POLICY} and ${ADDENDUM} (fictional; the addendum is team-written and synthetic)`});
 if(!page)return {code:404,body:{error:`No covenant row for ${b.borrower} ${b.period}`}};
 return {code:200,body:page};
}
