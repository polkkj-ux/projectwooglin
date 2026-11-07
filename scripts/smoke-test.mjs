// Production smoke test: node scripts/smoke-test.mjs https://your-app.vercel.app
// Compares the live API with the local covenant engine on the same bundled data, then exercises
// CSV upload, rejection of bad files, policy text parsing and the dashboard page.
import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {monitorCovenants} from '../lib/covenants.js';
const base=(process.argv[2]||'').replace(/\/+$/,'');if(!/^https?:\/\//.test(base)){console.error('Usage: node scripts/smoke-test.mjs https://your-app.vercel.app');process.exit(2);}
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
const page=await fetch(base+'/');const html=await page.text();
ok(page.status===200&&html.includes('<title>Covenant Monitor</title>'),`GET / serves the dashboard (${page.status})`);
ok((page.headers.get('content-security-policy')||'').includes("default-src 'none'"),'dashboard has the Content-Security-Policy header');
const font=await fetch(base+'/fonts/inter-500.woff');ok(font.status===200,`bundled Inter font is served (${font.status})`);
const pol=await (await fetch(base+'/api/policy')).json();ok(typeof pol.text==='string'&&pol.text.includes('DSCR is trailing'),'GET /api/policy returns the policy text for the evidence panel');
const health=await (await fetch(base+'/api/health')).json();ok(health.ok===true,'GET /api/health ok');
ok(health.llamaParseConfigured===false,'no LlamaParse key on the public server (PDF uploads cannot spend credits)');
const live=await (await fetch(base+'/api/covenants')).json();
const local=monitorCovenants(parseCSV(await rd('loan_covenants.csv')),await rd('documents/loan-policy.txt'));
ok(JSON.stringify(live)===JSON.stringify(local),'live /api/covenants is identical to the local engine output (all 36 rows, citations, assumptions)');
const b1=live.results.find(r=>r.borrower_id==='BOR-01'&&r.period==='2026-Q3');
ok(b1&&b1.dscr.value===1.1538&&b1.dscr.cashflow_required_usd==='312000.00'&&b1.dscr.cashflow_headroom_usd==='-12000.00','BOR-01 Q3: DSCR 1.1538, needs $312,000.00, short $12,000.00');
ok(live.policy.definitions.dscr?.sha256===local.policy.definitions.dscr.sha256,'DSCR policy citation hash matches');
const csv=(await rd('loan_covenants.csv')).split('\n').slice(0,5).join('\n')+'\n';
const up=await post('/api/covenants',{csv});const uj=await up.json();ok(up.status===200&&uj.summary.rows===4,`CSV upload accepted (${uj.summary?.rows} rows)`);
for(const [label,body,re] of [['empty CSV',{csv:''},/empty/],['non-covenant file',{csv:'hello\nworld\n'},/Missing required columns/]]){const r=await post('/api/covenants',body);ok(r.status===400&&re.test((await r.json()).error),`${label} rejected with 400`);}
const parsed=await post('/api/policy/parse',{filename:'policy.txt',base64:Buffer.from(await rd('documents/loan-policy.txt')).toString('base64')});ok(parsed.status===200&&(await parsed.json()).status==='completed','policy .txt parse works');
const pdf=await post('/api/policy/parse',{filename:'p.pdf',base64:Buffer.from('%PDF-1.4 x').toString('base64')});ok(pdf.status===503,'PDF parse clearly disabled (503) without a key');
const xo=await fetch(base+'/api/covenants',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});ok(xo.status===403,'cross-origin POST refused');
console.log(fails?`\n${fails} check(s) failed`:'\nAll checks passed');process.exit(fails?1:0);
