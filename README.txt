VERSION 1.2 — November 1, 2026. Adds optional OmniRoute model router guide (guides/omniroute.txt). v1.1 added Sam Yeh blockchain/crypto challenges 26–30.

REDHAWK BACKEND AND DATA STARTER
See START-HERE.txt for the shortest path.

Architecture: Node.js 22+, native HTTP server, Supabase JavaScript client. Framework-neutral backend modules can be called from a later Next.js app. No UI or Next.js frontend, no LLM provider and no reference apps are included.

COMMANDS
npm ci: install exact locked dependencies.
npm run demo: analyze all 1,500 invoices offline.
npm test: financial, CSV, dataset, API and mocked upstream contract checks.
npm run db:test: execute the migration and access policies in PGlite PostgreSQL with simulated Supabase Auth/Storage schemas.
npm run check: offline configuration status, or authenticate/query the live schema when a user token is supplied.
npm run dev: local API server.
npm run import:data -- TEAM_UUID invoices: import/upsert the dataset into a configured Supabase project. Repeat with a table name from the manifest.

MONEY AND EVIDENCE
All CSV amounts are USD decimal strings. The library uses BigInt cents and explicit rounding. Ratios are presentation values; preserve original amounts. Loan schedules use equal-principal amortization, not level payments. Runway assumes same-month cash flows. Evidence offsets index the exact stored JavaScript string in UTF-16 code units; save quotes with their source and hash.

LIMITS
Local API binds to loopback. It is a workshop backend, not a public multi-tenant service: add rate limiting, monitoring, deployment authentication policy and operational recovery before public deployment. No cloud instance was provisioned. No live parser or financial-data request was billed or run. Wrapper tests use mocked responses; hosted Auth, Storage and PostgREST require a live smoke test after setup. Upsert imports are resumable, not one transaction across all batches. Document storage upload and metadata insert are not one distributed transaction.

Dataset ground truth lives in validation/. Keep answer keys out of model input when measuring detection quality. CSVs do not contain answer labels. Uploaded records are untrusted data. No private personal records are included.

CHALLENGE 5 UI: npm run dev, then open http://127.0.0.1:4180/ . Static page in public/index.html, no build step. It calls GET/POST /api/covenants. Upload CSV posts your file to the local backend only. Shows borrower-by-quarter status, headroom and the cited policy definition. Not a production UI.
POLICY PARSING (Challenge 5): in the UI, "Upload policy (PDF/TXT)". TXT is read locally. PDF goes to LlamaParse (fast tier) and may use your account credits; set LLAMA_CLOUD_API_KEY in .env and restart. Extracted text is shown for review and editing before any checks run. Routes: POST /api/policy/parse, GET /api/policy/parse/JOB_ID, POST /api/covenants {csv?, policy?, policy_name?}. Parser response handling is tested with mocked responses only; run one live parse with your key before relying on it. Rotate any key that has been pasted into a chat.

COVENANT MONITOR UI (redesign): single static page public/index.html, no framework or build step. Views: Overview, Borrowers, Covenant Analysis, How it works. The reporting period defaults to the latest quarter ended on or before the dataset reporting date; later quarters are labelled projected. Uploads live under "Data & policy sources" in the header. Backend change in this version: lib/covenants.js sentence-boundary fix so each cited definition is exactly one sentence (regression test added).
