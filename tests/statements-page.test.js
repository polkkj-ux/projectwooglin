// The Statements review page and the two small app.html changes (sidebar link, Designer PDF upload).
import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const rd=n=>fs.readFile(new URL('../public/'+n,import.meta.url),'utf8');
const page=await rd('statements.html'),app=await rd('app.html');

test('statements page: v8 shell, no external resources, and every figure comes from the API',()=>{
 assert.match(page,/<title>Statements · Covenant Monitor<\/title>/);
 assert.match(page,/--nav:#101A2B/);assert.match(page,/url\(\/fonts\/inter-400\.woff\)/);
 assert.doesNotMatch(page,/<script[^>]+src=|<link[^>]+stylesheet|https?:\/\/(?!www\.w3\.org)/,'no external scripts, styles or hosts (CSP)');
 for(const api of ['/api/statements/saved','/api/statements/extract','/api/statements/job','/api/statements/confirm'])assert.ok(page.includes(api),api);
 // The browser never computes a covenant number: no BigInt or ratio arithmetic on amounts in the page script.
 const js=page.match(/<script>([\s\S]*)<\/script>/)[1];
 assert.doesNotMatch(js,/BigInt|minor\(|\/api\/covenants/);
 new Function(js); // parses
});

test('statements page: review table, location-only treatment, count, saved label, run and links',()=>{
 for(const s of ['Line item','Quarter','Value','Page','Source (citation)','Confidence','Confirm'])assert.ok(page.includes(`'${s}'`)||page.includes(`['${s}'`),s);
 assert.match(page,/Located on page \$\{it\.page\} \(no quoted text\)/);
 assert.match(page,/icon\('pin',16,'p'\)/);assert.match(page,/icon\('quote',16,'q'\)/);   // different icons
 assert.match(page,/box x \$\{Math\.round\(b\.x\)\}/);                                     // bounding box shown
 assert.match(page,/Ties to: /);assert.match(page,/cs\.message/);                          // tie-out named; count at top
 assert.match(page,/Extracted offline with LlamaExtract on \$\{fmtDate/);
 assert.match(page,/\$\('pick'\)\.disabled=!S\.key/);                                       // upload only with a key
 assert.match(page,/'Run covenant tests'/);assert.match(page,/'\/app#borrower-'\+encodeURIComponent\(id\)/);
 assert.match(page,/disabled:!it\.confirmable/);                                           // unconfirmable values cannot be ticked
 assert.match(page,/sessionStorage\.setItem\('cm\.statements\.designer'/);
});

test('app.html: Statements link in the sidebar; Designer upload accepts PDF and takes confirmed line items back',()=>{
 assert.match(app,/h\('a',\{href:'\/statements'\},icon\('doc',18\),h\('span',null,'Statements'\)\)/);
 assert.match(app,/accept:'\.csv,text\/csv,\.txt,text\/plain,\.pdf,application\/pdf'/);
 assert.match(app,/fetch\('\/api\/statements\/extract',post\(\{filename:f\.name,base64\}\)\)/);
 assert.match(app,/sessionStorage\.getItem\('cm\.statements\.designer'\)/);
 assert.match(app,/if\(handoff\)recommend\(\);/);
 // The original CSV path is unchanged.
 assert.match(app,/if\(f\.size>1_000_000\)return say\('File too large \(1 MB max\)\.','err'\);/);
 assert.match(app,/'Use sample statements'/);
 new Function(app.match(/<script>([\s\S]*)<\/script>/)[1]);
});
