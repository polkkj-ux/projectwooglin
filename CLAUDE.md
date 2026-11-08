# Project rules for Claude

## Frontend design (required)
Before changing public/index.html, public/app.html or public/statements.html, read
docs/design-system.md and follow it. Don't redesign any page.

- Use only the existing CSS tokens and components. No new hex colours, fonts or font weights.
- Newsreader Display 300 is for landing-page section headings only; Inter 400/500/600 for everything else.
- Landing-page section headers use the split layout (headline left, intro right); section backgrounds alternate.
- Thin rules instead of cards. Champagne is an accent only. Red and teal mean fail and pass, nothing else.
- Every financial figure on the landing page comes from the live API (/api/covenants, /api/cure,
  /api/reporting, /api/statements/saved) via data-k. Every image is a real screenshot of /app or /statements.
- New motion must respect prefers-reduced-motion.
- Check 1440, 1280, 1024 and 390px widths for horizontal overflow before committing.

## Engine
Don't change calculation results in lib/, data/ or opt/. Run npm test before committing.
Never change line endings: data/documents/loan-policy.txt is stored with CRLF and its citation
character positions depend on it.

## Docs
Don't create new documentation files. Feature notes go in a new README.md section, following the
existing v-numbered pattern.

## Environment and deployment
Claude Code runs in a Docker sandbox; the dev server (127.0.0.1:4180) is reachable only inside the
container, so visual review happens on Vercel preview URLs. Production is
https://redhawk-builds-hackathon.vercel.app and deploys automatically from main. Branch previews
need a Vercel login. Never merge to main without the user's approval.
