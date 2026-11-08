// Production smoke test: node scripts/smoke-test.mjs https://your-app.vercel.app
// Compares the live API with the local covenant engine on the same bundled data, then exercises
// CSV upload, rejection of bad files, policy text parsing and the dashboard page.
import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';import {monitorCovenants} from '../lib/covenants.js';
const base=(process.argv[2]||'').replace(/\/+$/,'');if(!/^https?:\/\//.test(base)){console.error('Usage: node scripts/smoke-test.mjs https://your-app.vercel.app');process.exit(2);}
const rd=n=>fs.readFile(new URL('../data/'+n,import.meta.url),'utf8');
let fails=0;const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)fails++;};
const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
const land=await fetch(base+'/');const lhtml=await land.text();
ok(land.status===200&&lhtml.includes('Know which borrowers')&&lhtml.includes('href="/app"'),`GET / serves the product page with links to /app (${land.status})`);
ok(lhtml.includes("location.replace('/app#'+h)"),'product page forwards legacy /#overview-style links to the application');
const page=await fetch(base+'/app');const html=await page.text();
ok(page.status===200&&html.includes('<title>Covenant Monitor</title>')&&html.includes('id="page"')&&html.includes("load('/api/covenants')"),`GET /app serves the dashboard (${page.status})`);
ok(html.includes('Borrowers requiring attention')&&html.includes('id="rules"')&&html.includes('Kept only in this browser'),'GET /app includes the attention list, monitoring rules and browser-only review disclosure');
for(const r of [land,page])ok(/default-src 'none'.*img-src 'self'/.test(r.headers.get('content-security-policy')||''),`${r===land?'product page':'dashboard'} has the Content-Security-Policy header with self-hosted images`);
const img=await fetch(base+'/assets/hero-bor01@2x.webp');ok(img.status===200&&(img.headers.get('content-type')||'').startsWith('image/webp'),`application screenshot is served (${img.status})`);
const font=await fetch(base+'/fonts/inter-500.woff');ok(font.status===200,`bundled Inter font is served (${font.status})`);
const pol=await (await fetch(base+'/api/policy')).json();ok(typeof pol.text==='string'&&pol.text.includes('DSCR is trailing'),'GET /api/policy returns the policy text for the evidence panel');
const health=await (await fetch(base+'/api/health')).json();ok(health.ok===true,'GET /api/health ok');
ok(health.llamaParseConfigured===false,'no LlamaParse key on the public server (PDF uploads cannot spend credits)');
const live=await (await fetch(base+'/api/covenants')).json();
const local=monitorCovenants(parseCSV(await rd('team/loan_covenants_extended.csv')),await rd('documents/loan-policy.txt'),{supplements:[{name:'team/covenant-policy-addendum.txt',text:await rd('team/covenant-policy-addendum.txt')}]});
ok(JSON.stringify(live)===JSON.stringify(local),'live /api/covenants is identical to the local engine output (all 36 rows, citations, assumptions)');
const b1=live.results.find(r=>r.borrower_id==='BOR-01'&&r.period==='2026-Q3');
ok(b1&&b1.dscr.value===1.1538&&b1.dscr.cashflow_required_usd==='312000.00'&&b1.dscr.cashflow_headroom_usd==='-12000.00','BOR-01 Q3: DSCR 1.1538, needs $312,000.00, short $12,000.00');
ok(live.policy.definitions.dscr?.sha256===local.policy.definitions.dscr.sha256,'DSCR policy citation hash matches');
const csv=(await rd('loan_covenants.csv')).split('\n').slice(0,5).join('\n')+'\n';
const up=await post('/api/covenants',{csv});const uj=await up.json();ok(up.status===200&&uj.summary.rows===4,`CSV upload accepted (${uj.summary?.rows} rows)`);
for(const [label,body,re] of [['empty CSV',{csv:''},/empty/],['non-covenant file',{csv:'hello\nworld\n'},/Missing required columns/]]){const r=await post('/api/covenants',body);ok(r.status===400&&re.test((await r.json()).error),`${label} rejected with 400`);}
const sp=await post('/api/covenants',{settings:{modes:{fccr:'maintenance'}}});const spj=await sp.json();ok(sp.status===200&&spj.summary.dormant===0,'covenant terms toggle: FCCR maintenance leaves no dormant tests');
const smp=await (await fetch(base+'/api/recommend/sample')).json();const rec=await (await post('/api/recommend',{csv:smp.csv})).json();ok(rec.recommendations?.find(x=>x.key==='leverage')?.threshold==='4.00','Covenant Designer: sample statements recommend leverage ≤ 4.00x');
const parsed=await post('/api/policy/parse',{filename:'policy.txt',base64:Buffer.from(await rd('documents/loan-policy.txt')).toString('base64')});ok(parsed.status===200&&(await parsed.json()).status==='completed','policy .txt parse works');
const pdf=await post('/api/policy/parse',{filename:'p.pdf',base64:Buffer.from('%PDF-1.4 x').toString('base64')});ok(pdf.status===503,'PDF parse clearly disabled (503) without a key');
const xo=await fetch(base+'/api/covenants',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});ok(xo.status===403,'cross-origin POST refused');
// Cure planner (v9): the deployment has no live solver, so BOR-09 2026-Q3 must come from data/cure_snapshot.json, re-checked by the exact engine.
const cure=await (await fetch(base+'/api/cure?borrower=BOR-09&period=2026-Q3')).json();const cc=cure.options?.find(o=>o.key==='cheapest');
ok(cure.available===true&&cure.source==='snapshot'&&/^\d+\.\d+\.\d+$/.test(cure.gurobi_version||'')&&cure.solved_at,`BOR-09 Q3 cure served from the offline snapshot (${cure.source||cure.reason}, Gurobi ${cure.gurobi_version})`);
ok(cc?.status==='plan'&&cc.plan.verified===true&&cc.plan.total_cost_usd==='78333.34'&&cc.plan.actions==='Sell Division A; sponsor contributes $68,333.34'&&/^[0-9a-f]{64}$/.test(cc.model?.lp_sha256||''),'BOR-09 Q3 cheapest cure: sell Division A + $68,333.34, $78,333.34, verified, model SHA-256 present');
const cov=await post('/api/cure',{borrower:'BOR-09',period:'2026-Q3',overrides:{cures_remaining_4q:0}});ok(cov.status===503,'cure what-if inputs clearly need the live solver (503) on the public deployment');
// Reporting compliance tracker (lower-middle-market): its own route; synthetic received dates, document review date 2026-12-01.
const rep=await (await fetch(base+'/api/reporting')).json();const rq=p=>rep.summary?.find(s=>s.period===p)?.late_or_missing;
ok(rep.supplied===true&&rep.document_review_date==='2026-12-01'&&rq('2026-Q2')?.count===1&&rq('2026-Q2').borrowers[0].borrower_id==='BOR-03'&&rq('2026-Q3')?.count===2,'Reporting tracker: Q2 2026 1 of 9 late (BOR-03), Q3 2026 2 of 9 (document review date 2026-12-01)');
const cpj=await (await fetch(base+'/api/callprep?borrower=BOR-03&period=2026-Q2')).json();
ok(cpj.header?.status?.label==='Approaching limit'&&cpj.questions?.length===1&&cpj.questions[0].rule===8&&cpj.reporting?.consecutive_late_or_missing===2,'Call prep: BOR-03 Q2 2026 passes every covenant, late 2 quarters running, one reporting question');
const cp9=await (await fetch(base+'/api/callprep?borrower=BOR-09&period=2026-Q3')).json();ok(cp9.what_it_would_take?.cure?.total_cost_usd==='78333.34'&&cp9.what_it_would_take.cure.solved_offline===true&&cp9.footer?.note?.includes('not a legal determination'),'Call prep: BOR-09 Q3 2026 shows the $78,333.34 cheapest cure (solved offline) and the legal note');
console.log(fails?`\n${fails} check(s) failed`:'\nAll checks passed');process.exit(fails?1:0);
