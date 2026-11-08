# Covenant Monitor: design system, reverse-engineered

This file covers the visual system only. Feature history and verification notes stay in `README.md` (sections v8 and v10 describe the redesign). Don't copy them here.

Source: `polkkj-ux/projectwooglin`, commits `a3e9af4` → `c5b67d4` (Nov 7 2026), plus the two later commits that refined the landing page (`768116a`, `b6d581d`). Everything below is read from the actual CSS and markup in `public/index.html` (landing) and `public/app.html` (application).

---

## 1. What actually caused the shift

| Commit | Time | Author | What it did to the design |
|---|---|---|---|
| `10fe41c` | 1:09 PM | Liam | **No design change.** Engine work (FCCR, current ratio, springing covenants, Designer). Still the old look. |
| `cfcb409` | 1:18 PM | Kevin's Claude | **The shift, part 1: the application.** Replaced the whole stylesheet with a token system, bundled Inter, sentence-case labels, icon set, radii, shadows, limit rails, segmented controls. |
| `71cc46a` | 1:47 PM | Kevin's Claude | Ported Liam's features *into* the new design. No new design language; proves the system extends to new content. |
| `1b8df07` | 2:41 PM | Kevin's Claude | **The shift, part 2: the landing page.** New editorial product page at `/`, app moved to `/app`. Added Newsreader serif, champagne accent, dark/light section rhythm, scroll motion. Also re-skinned the app's accent (teal → champagne) and serif (Charter → Newsreader) so both share one brand. |
| `c5b67d4` | 2:41 PM | Kevin's Claude | Cleanup only (removed QA screenshots). |

**About the prompt you suspected.** That "Institutional Private Credit Platform Upgrade" prompt maps to commit `b6d581d` (9:05 PM). It came **after** the shift, and it says "Preserve the premium brand landing page that has already been built" and "Do not start another complete redesign." So it added the watchlist, review workflow and research notes (`docs/competitive-research.md`), but it did **not** create the visual style. Its section 9 says the design references "remain" Apollo, Ares and J.P. Morgan AM. That wording suggests an earlier prompt named those references. Commit `1b8df07` also says the motion patterns were "inspired by 21st.dev." That earlier prompt isn't in the repo; everything below is reconstructed from the code it produced.

---

## 2. Before → after: the levers that made the difference

| Lever | Before (`10fe41c`) | After (`cfcb409` + `1b8df07`) | Why it reads as "institutional" |
|---|---|---|---|
| Type | Georgia for headings *and* big numbers; system sans | **Inter** (400/500/600, bundled) for UI and numbers. **Newsreader** serif only for display headings and quoted text | A serif signals editorial and premium. Restricting it to headlines and quotations keeps the data crisp. |
| Labels | UPPERCASE, letter-spaced 1.2–1.4px | Sentence case, 12.5–13px, weight 500, muted ink | All-caps labels look like a template. Sentence case looks like a finance publication. |
| Palette | Beige paper `#f7f5f0`, teal accent, warm grey lines | Cool neutrals (`#FAFAF8` ivory, `#E4E7EB` rules), midnight navy `#101A2B`, desaturated blue `#345675`, **champagne `#C4AE87`** as the brand accent | Champagne on midnight is the private-bank / asset-manager signature. Status colours were muted and reserved for meaning. |
| Status | Filled pills with white icon circles | Text + 14px stroke icon in the status colour, no fill | Lighter, and it doesn't shout. |
| Shape | 3px radius, square boxes, 4px coloured left borders | 4px controls (landing), 6px controls / 8px panels (app), hairline rules, very soft shadows | Rules and whitespace do the work instead of boxes. |
| Big numbers | Serif 46px | Inter 500, 36–40px, `letter-spacing:-.025em`, tabular figures | Reads like a terminal. Figures line up in columns. |
| Structure | Cards and boxes | KPI strip divided by vertical hairlines; tables in one bordered panel; "cards used sparingly" (a literal CSS comment) | Less chrome, more data. |
| Imagery | None | Real screenshots of the working app, at 1× and 2× WebP, with annotation rings | It shows the product. There is no decorative illustration. |
| Motion | None | One orchestrated hero entrance; nav condenses on scroll; hero screenshot settles from a tilt; sticky story stage. All of it is off under `prefers-reduced-motion` | Gives a premium feel without gimmicks. |
| Copy | Functional | Short declarative headlines ending in a period; plain-English claims; explicit disclaimers; every figure traceable | Credibility is part of the design. |

---

## 3. Landing page tokens (`public/index.html`)

```css
/* surfaces */
--midnight:#101A2B;  /* hero, trust section, nav when scrolled */
--navy:#142238;      /* = --ink; active step nodes, shortfall callout */
--navy-2:#1A2A44;
--deep:#0C1422;      /* footer only */
--ivory:#FAFAF8;     /* default page background */
--paper:#FFFFFF;     /* quotes, active controls */
--mist:#F3F5F7;      /* alternate light section (story) */

/* brand accent: use sparingly */
--champagne:#C4AE87; --champagne-hi:#D3C09D; --champagne-edge:#AE966B;

/* ink on light */
--ink:#142238; --ink-2:#2D3A4D; --ink-3:#5B6779; --slate:#667386;
--rule:#E2E5EA; --rule-2:#D2D8DF;

/* ink on dark (.dark sections) */
--d-ink:#F2F4F7; --d-ink-2:#B4BECC; --d-ink-3:#97A3B4;
--d-rule:rgba(226,232,240,.13); --d-grid:rgba(196,174,135,.085);

/* meaning only */
--teal:#18736D; /* pass */  --red:#B64549; /* fail */  --red-wash:#F8ECEC;

/* type */
--display:'Newsreader Display',...;  /* weight 300 ONLY */
--serif:'Newsreader Text',...;       /* weight 400 ONLY */
--sans:'Inter',...;                  /* 400 / 500 / 600 only */

/* layout */
--pad:clamp(20px,4.5vw,64px);
```

Only these font files are bundled: `inter-400/500/600.woff`, `newsreader-display-300.woff`, `newsreader-text-400.woff`. **Never set `font-weight:700`, and never bold the serif.** The browser would fake it and it looks cheap. If you need a new weight, add the file and its `@font-face`.

### Type scale

| Role | Spec |
|---|---|
| Hero H1 | `300 clamp(44px,5.55vw,84px)/1 var(--display)`, `letter-spacing:-.022em`, each line a `<span>` |
| Section H2 (`.h-display`) | `300 clamp(34px,3.9vw,56px)/1.06 var(--display)`, `-.014em`, `max-width` 15–20ch |
| Sub-section H2 | same class, `font-size:clamp(30px,3vw,44px)` |
| Closing H2 | `clamp(40px,4.8vw,68px)` |
| Capability title (`.cap h3`) | `300 clamp(30px,2.6vw,38px)/1.05 var(--display)` |
| Step title (`.step h3`) | `600 20px/1.3 var(--sans)` (sans, not serif) |
| Ledger term (dark) | `400 clamp(22px,1.9vw,27px)/1.25 var(--serif)` |
| Kicker | 14px / 500, champagne, preceded by a 40px × 1px champagne rule |
| Lede / intro | 18px / 1.58–1.62, `max-width:36–44ch` |
| Body | `400 17px/1.6 var(--sans)` (16px under 600px) |
| Claim (bold line under a title) | 600 16.5px, `--ink` |
| Secondary body | 15.5–16px, `--ink-3` |
| Captions | 12.5–13.5px, `--ink-3` |
| Quotes from the policy | `15px/1.65 var(--serif)`; highlight with `<mark>` = red-wash + 2px red underline |

Numbers always use `font-variant-numeric:tabular-nums lining-nums` (`.num`).

---

## 4. Layout grammar

**Container.** `.wrap`: max 1240px content + `--pad` on each side. Inside it, `.g` is a 12-column grid with a 24px gutter.

**The editorial split (the signature move).** Every section header is asymmetric:

```
| H2 (cols 1–7 or 1–8) ..................... |   | intro (cols 9–12) |
                                     align-items:end
```

Headline left, short muted paragraph right, bottoms aligned. Under 1100px both go full width.

**Section rhythm.** Backgrounds alternate dark and light, never two of the same in a row:

1. Hero: `--midnight`, fading to ivory behind the screenshot (gradient hard-stop) with a 4-column champagne hairline grid behind the text
2. Platform: `--ivory`
3. Story: `--mist`
4. Trust and closing: `--midnight` (`.dark`)
5. Footer: `--deep`

Section padding: `clamp(80px,10vw,144px) 0`. Internal sub-blocks are separated by a 1px `--rule` top border with `clamp(56px,6vw,80px)` above it. Use rules and space, not boxes.

**Breakpoints:** 1100 (headers stack; sticky story stage off), 900 (mobile menu; 3-up track becomes a vertical timeline; ledger becomes 1 column), 700 (hero swaps to a single card screenshot), 600 (type down a step; full-width buttons).

---

## 5. Component inventory (reuse these, don't invent new ones)

| Component | Classes | Use for |
|---|---|---|
| Primary button | `.btn.btn-primary` (champagne fill, midnight text, 4px radius, 48px tall) | The **one** CTA treatment, on both light and dark. `.btn-sm` in the nav. |
| Quiet button | `.btn.btn-quiet` | Secondary action **on dark only** (translucent outline) |
| Text link | `.tlink` | Secondary action on light: underline in champagne-edge, 5px offset |
| Kicker | `<p class="kicker"><i></i>Text</p>` | Eyebrow above a hero-level headline |
| Numbered track | `ol.track > li.cap` with `.node`, `h3`, `.claim`, `.body`, `.art` | 3-up process (Detect / Quantify / Verify); a champagne→grey gradient line joins the nodes |
| Scroll story | `.story-g` → `ol.steps > li.step` + sticky `.stage` with `.panel`s and `.dots` | Narrated walkthrough with screenshots that change as you read |
| Figures list | `dl.figs` | Label/value pairs, right-aligned tabular values, `.bad` / `.ok` / `.sub` |
| Mini list | `ul.minilist` | Compact borrower/status rows with `.st` status and `.tag` |
| Limit rail | `svg.rail` | Ratio vs. limit: grey track, red-tinted breach zone, navy tick at the limit, dot for the value |
| Quote | `blockquote.quote` + `<mark>` | Verbatim policy text |
| Callout note | `.note` | 2px champagne left border, translucent white; caveats inside light sections |
| Screenshot | `figure.shot` (8px radius, hairline ring + deep soft shadow) + `.ann` | Real app captures; `.ann` = navy ring + champagne halo to point at something |
| Ledger | `dl.ledger` | 2-column principles list on dark; serif term with a 20px champagne stroke icon |
| Disclosure | `aside.disclosure` | Champagne-bordered notice on dark (synthetic data, not legal advice) |
| Shortfall callout | `.shortfall` | Navy block with a display-serif number and a champagne left rule |

**Icons:** inline SVG, 14–20px, `stroke="currentColor"`, `stroke-width` 1.6–1.8, round caps, no fills. Never oversized and never decorative.

---

## 6. Motion rules

- One entrance only: kicker → H1 lines → lede rise in sequence (`rise .8s cubic-bezier(.2,.7,.2,1)`, staggered 0.02–0.30s); hero screenshot `lift` at 0.28s. **CTAs are never delayed.**
- Nav: transparent over the hero, then `.scrolled` = 95% midnight + blur + champagne hairline; height 72→60px; a 1px champagne indicator slides under the current section link.
- Hero screenshot settles from a 9° tilt to flat as you scroll (≥900px only).
- Story panels fade in (`.35s`).
- Everything is wrapped in `prefers-reduced-motion:no-preference`. New motion must be too.
- Easing: always `cubic-bezier(.2,.7,.2,1)` or `ease`; durations 0.15–0.45s for UI, 0.8–1s for the entrance.

---

## 7. Content rules (as much a part of the look as the CSS)

1. **Headlines are short declarative sentences ending in a period.** For example: "Built for decisions that require evidence."
2. **Sentence case everywhere.** No ALL-CAPS labels. Title Case is used only for nav items and buttons.
3. **Every figure is real.** Hard-code the checked value *and* tag it `data-k="…"`; the script at the bottom refreshes it from `/api/covenants` so it can't drift. Add new keys to the `V` object there; figures from `/api/cure` or `/api/reporting` get their own `fetch` in the same pattern, failing silently to the checked default.
4. **Imagery is screenshots of the working product** (`/app` or `/statements`), captured at 1× and 2× as WebP into `public/assets/`, with `srcset`, explicit `width`/`height`, and descriptive `alt` text that states the numbers shown.
5. **Honesty is part of the design:** "synthetic data," "signals for analyst review, not legal default determinations," "internal rule, not a covenant term." Keep those caveats; put them in `.note` or `.disclosure`.
6. No hype words, no invented metrics, no vendor names or logos, no stock imagery, no gradients except the two structural ones (hero hard-stop, track line).

---

## 8. Recipe: adding a new landing section

Pick light or dark so the alternation holds (see section 4), then copy one of these.

**Light section (insert between existing sections, alternating ivory/mist):**

```html
<section class="sec" id="new-thing" aria-labelledby="newH">
 <div class="wrap">
  <div class="g story-head">                       <!-- reuse the split header -->
   <h2 class="h-display" id="newH">One plain sentence that states the benefit.</h2>
   <p class="intro">Two sentences of context in muted ink, under 45 characters per line.</p>
  </div>

  <!-- body: prefer a track, figs, ledger-style list or a screenshot, not a card grid -->
  <ol class="track">
   <li class="cap"><span class="node" aria-hidden="true">1</span>
    <h3>Verb</h3><p class="claim">One-line claim.</p><p class="body">Supporting sentence.</p></li>
   <li class="cap">…</li>
   <li class="cap">…</li>
  </ol>
 </div>
</section>
```

If it sits next to the ivory platform section, add `style="background:var(--mist)"` (or a new class with that background) so it doesn't merge with it.

**Dark section:**

```html
<section class="sec dark" style="background:var(--midnight)" id="…" aria-labelledby="…">
 <div class="wrap">
  <div class="g trust-head"><h2 class="h-display" id="…">…</h2><p class="intro">…</p></div>
  <dl class="ledger"> <div><dt><svg …/>Term</dt><dd>Explanation.<span>Detail line.</span></dd></div> … </dl>
 </div>
</section>
```

**Also do:**

- Add the section to the nav `.links` if it's a top-level destination. The sliding indicator picks it up automatically via the IntersectionObserver map, since it reads every `#links a[href^="#"]`.
- Add its stacking rules to the `@media (max-width:1100px)` and `(max-width:900px)` blocks (header to `grid-column:1/-1`, intro to `1/span 9`, then `1/-1`).
- Check at 1440, 1280, 1024 and 390px for horizontal overflow (the original commits verified those widths).

---

## 9. Checklist before you ship a change

- [ ] Uses existing tokens only; no new hex values (add a token if you truly need one)
- [ ] Serif only for display headings, ledger terms and quotes; weight 300 (display) or 400 (text)
- [ ] Inter weights 400/500/600 only; numbers use tabular figures
- [ ] Champagne appears only as accent: CTA, kicker rule, nodes, indicator, disclosure border
- [ ] Red and teal only mean fail and pass
- [ ] No card grid, no drop-shadowed tiles, no icon larger than 20px
- [ ] Section alternates background with its neighbours
- [ ] Split header (H2 left / intro right) if the section has a heading
- [ ] Any figure is engine-backed (`data-k`) and any image is a real capture of `/app` or `/statements`
- [ ] Motion respects reduced motion; CTAs never animate in late
- [ ] Mobile breakpoints added; no overflow at 390px

---

## 10. Prompt block to give Claude when you add something

> You are extending the Covenant Monitor product page (`public/index.html`). Do not redesign it. Follow `docs/design-system.md` exactly: use only the existing CSS tokens, components and classes; Newsreader Display 300 for section headings and Inter 400/500/600 for everything else; the asymmetric 12-column split header (H2 cols 1–7/8, intro cols 9–12, aligned to the bottom); alternate section backgrounds (midnight / ivory / mist); hairline rules instead of cards; champagne only as an accent; red/teal only for fail/pass. Copy is sentence case, declarative, ending in a period, with no marketing hype. Any financial figure must come from the live API (`/api/covenants`, `/api/cure`, `/api/reporting`) via a `data-k` key, and any image must be a real screenshot of `/app` or `/statements`. Wrap new motion in `prefers-reduced-motion:no-preference`. Add responsive rules at 1100/900/600px and verify no horizontal overflow at 1440, 1280, 1024 and 390px. Show me the diff before committing.
