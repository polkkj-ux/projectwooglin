// HTTP glue for the lower-middle-market features. Reads the bundled data and validates request bodies the
// same way POST /api/covenants does, then hands off to the pure modules (lib/reporting.js). It never changes
// what /api/covenants, /api/cure, /api/recommend or /api/policy return.
import fs from 'node:fs/promises';
import {parseCSV} from './csv.js';
import {covenantColumnsError,normalizeSettings} from './covenants.js';
import {reportingReport} from './reporting.js';

const DATA=new URL('../data/',import.meta.url);
// Same default dataset as GET /api/covenants (server.js DEFAULT_CSV).
export const DEFAULT_CSV='team/loan_covenants_extended.csv';
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
