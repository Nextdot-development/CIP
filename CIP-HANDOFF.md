# CIP — handoff

_Written 16 September 2026, for whoever (or whatever) picks this up next. Everything
here was true at the time of writing; verify anything you are about to rely on._

---

## 1. What CIP is

**CIP (Create. Comply. Perform.)** is a multi-tenant **AI Brand Intelligence SaaS**, built by
**Nextdot** for **Radico Khaitan** (an Indian spirits house, 11 brands after a cleanup described
below: 8PM, Magic Moments, Whytehall, Rampur, Jaisalmer, Morpheus, Royal Ranthambore, Kohinoor
Reserve, Sangam, Afri Bull, Blue Finest).

It exists so a brand team can do four things without guessing:

1. **Know** what a brand looks and sounds like, traced back to the files that say so.
2. **Check** a new creative against that brand and against the law of the market it will run in.
3. **Make** new work grounded in the same knowledge.
4. **Ask** questions and get answers that cite what they came from.

The product follows the **CIS Developer Guidebook** (Snigdha Bose, Nextdot) and a design
prototype. Both live under `design/` (gitignored): the saved prototype page and `Main-html/`.
`design/Main-html/Main.dc.html` is the design of record for the UI.

---

## 2. The non-negotiables

These are not style preferences. Most of the code exists to enforce them, and several bugs in the
history came from breaking one.

1. **Nothing is asserted without evidence.** Every fact carries the files that produced it, every
   flag cites a rule, every answer cites a source, every market signal quotes its report verbatim.
   Anything that cannot cite what it was sent is **discarded, not shown**.
2. **The brand boundary.** Asked about 8PM, CIP may use 8PM's knowledge plus house-wide knowledge —
   never a sibling brand's. ("agar bola gya hai 8 pm toh bs 8 pm ka hi data dekha jaye" — the
   original complaint that shaped this.)
3. **Company isolation.** Every query runs under `withCompanyScope`, RLS is FORCE'd, and a
   handler can never receive a company id from the caller. Another company's id is "not found".
4. **Honest emptiness.** No seeded demo numbers. A score with nothing behind it says so; an area
   CIP knows nothing about is drawn empty.
5. **Never fake provider success.** If a key is missing, the call fails honestly.
6. **Secrets.** Never print, echo, or commit a key. Verify only that a variable is *present*.
   `.env.local` is read only to check presence. (Historic: a Supabase service_role key was exposed
   in development and still needs rotating — see §10.)

---

## 3. Stack and layout

Next.js 16 App Router (typed routes), React 19, TypeScript strict, `postgres` (porsager) with
tagged templates, Supabase Postgres + Supavisor pooler, Supabase Storage, OpenAI (Brain + images +
embeddings), Gemini (images), oxlint, `node:test`.

```
src/app/(workspace)/…      pages: / trust check ask chat market search calendar teach
src/app/api/…              route handlers (brain, drive, market, media, integrations)
src/sections/…             the big client components, one per screen
src/components/…           Sidebar, AddDataModal, ui/Bits, ui/Icon
src/server/db.ts           sql client + withCompanyScope (RLS binding)
src/server/brain/…         the Brain: understanding, brandDna, retrieval, planner, generate,
                           checker, chat, ideas, market, ocr, relations, calendar, markets,
                           brands, productBrain, learning, providers/{openai,fake,types}
src/server/drive/…         storage, upload, extraction (pdf/docx/csv/text + pdfRender), chunking,
                           embeddings, semantic search, processing queue
src/server/jobs/pump.ts    in-process queue runner (runs on web requests)
scripts/cip-worker.ts      the real worker: every stage, in dependency order
src/server/migrations/     NNNN_*.sql + down/NNNN_*.sql
tests/                     node:test suites, embedded Postgres
design/                    prototype + guidebook reference (gitignored)
Radico/                    source PDFs used for ingestion (untracked; do not commit)
```

**Provider interface** (`src/server/brain/providers/types.ts`) is the only place a vendor is
named. Implementations: `openai.ts` (real, strict JSON schemas) and `fake.ts` (deterministic, used
by every test). Methods: `analyzeImage`, `analyzeFrames`, `analyzeDocument`, `analyzePdfPage`,
`analyzeFeedback`, `buildGenerationBrief`, `checkCreative`, `readMarketDocument`, `answerQuestion`,
`ideateConcepts`, `transcribePage`.

---

## 4. The pipeline

Both `scripts/cip-worker.ts` and `src/server/jobs/pump.ts` run the same claim-and-process
functions under the same leases, so they are safe side by side. Order matters:

1. **Google Drive sync** → new `drive_files` rows (`claimConnectionForSync`).
2. **Brand attribution** (`suggestBrandsEverywhere`) — filename/alias → `drive_files.brand`.
3. **Market attribution** (`suggestMarketsEverywhere`) — filename, then folder path → `market`.
4. **Text extraction** (`claimNextFile` → `processClaimedFile`) → `drive_file_extractions` (kind
   `text`) + `drive_file_chunks`.
5. **OCR** (`claimOcrJob` → `runOcrJob`) — scanned PDFs and market images: render pages, transcribe
   word for word, store as extraction kind `ocr` + chunks.
6. **Embeddings** (`claimChunksNeedingEmbedding`) → `drive_file_embeddings` (pgvector).
7. **Understanding** (`claimAssetForUnderstanding`) — **brand material only** — images, video,
   documents, and PDFs read visually page by page (`pdf_page_understanding`, `pdf_post`).
8. **Brand DNA** (`recomputeEverywhere`) — evidence counted, facts promoted/demoted.
9. **Generated-image checks** (`checkNextGeneration`) — every generated image through the checker.
10. **Market reports** (`claimMarketSource` → `readClaimedMarketSource`) → `market_signals`.

**`drive_files.knowledge_role`** decides what a file is for: `brand` (default, read into Brand
DNA), `market` (read into signals, searchable, **never** Brand DNA), `reference` (searchable and
citable only). Registering a market source sets `market` and cancels any pending brand reading.

---

## 5. The modules, and where each stands

| Guidebook module | Route | State |
|---|---|---|
| Chat with the Brain | `/chat` | Built. Answers only from stored knowledge; citations that were not sent are dropped; an answer citing nothing is marked ungrounded. Threads saved per user. |
| Brand Brain | `/trust` | Built. Product Brain (one brand's DNA graph in six areas, stat chips, "Export Brand DNA Report" → Markdown) and Company Brain (portfolio graph + shared-trait insights), plus "What it learned" / "What it read" tabs. |
| Creative Search | `/search` | Built. Filename search + "Search by meaning" (embeddings). |
| Consistency Check | `/check` | Built. Score + visual/verbal/compliance, flags citing a rule or a pattern, "Disagree? Correct this" (exception vs wrong rule), rule list with legal verification. |
| Campaign Ideation | `/ask` | Built. Concept cards grounded in real sources ("Make this" seeds the composer) + the generate flow (plan shown, exact sizes, references). |
| Market Intelligence | `/market` | Built. Share bars, insight cards, every signal quoting its report, "Wrong? Remove it", source list. |
| Social Calendar | `/calendar` | Built. Real occasions per market, dry days marked in red. |

Also: `/teach` (upload + connect Google Drive), `/` (home), sidebar **brand switcher** (cookie
`cip_brand`, validated against the roster) and **"Add data to brain"** modal with a brand picker.

---

## 6. What happened in the last two sessions

**UI rebuilt on the prototype.** Dark warm theme (`src/styles/tokens.css`), Space Grotesk + IBM
Plex Sans, the seven guidebook modules in the sidebar, brand switcher, add-data modal. Sections:
`TrustSection`, `CheckSection`, `MarketSection`, `ChatSection`, `SearchSection`, `CalendarSection`,
`IdeationPanel`, `BrandBrainGraph`.

**Brand roster cleanup.** Whytehall Honey/Fire/Peanut Butter and Magic Moments Dazzle/Remix were
separate "brands" and read as duplicates. `npm run brands:merge` folds a line into its parent:
moves facts/files/rules, merges evidence for duplicate facts, keeps the line's name as an alias,
rebuilds traits and relations. Applied: 16 → 11 brands. Backups in the session scratchpad.

**Phase 2 built.** Chat (`chat.ts`) and Market Intelligence (`market.ts`), with migration 0025.

**18 fixes** (the list the user asked for, all but the local commit):
removed a revoked key from Windows env; `npm run set-login` (password from env, never printed,
sessions ended); setup refuses the public demo password; worker `Dockerfile.worker` + `render.yaml`;
rate limits moved to a shared table (0026) with memory fallback; mobile drawer nav; thumbnails
(`?size=`, WebP, cached in storage); scanned-report fallback; generated images auto-checked;
brand picker on upload; batched relation inserts (was one row at a time, minutes on real data);
metric-name normalisation for share bars; concept cards; question-relevant fact selection;
rule verification (0026) — an unverified CIP suggestion can warn but not fail a creative;
market name matching tightened ("Contact us.pdf" was tagged USA) plus Ghana/West Africa and folder
paths; prototype files moved to `design/`; CI workflow with pgvector.

**OCR** (migration 0027). Scanned PDFs and market images are rendered and transcribed page by page
(`src/server/brain/ocr.ts`), stored as an `ocr` extraction with `[Page N]` markers, chunked and
embedded. Tall pages are read in strips and the overlap is de-duplicated.

**Knowledge roles** (migration 0028) and `npm run ingest:market`, so market reports never pollute
Brand DNA.

**Long reports.** `chooseParts()` picks the 12 sections densest with market figures instead of the
first 12 — a DRHP's first pages are legal preamble.

---

## 7. Commands

```bash
npm run dev                     # local site on :3000
npm run db:migrate              # apply migrations (and set cip_app password)
npm run cip:worker              # one pass of every stage
npm run cip:worker -- --watch   # leave running: this is the one you want
npm test                        # whole suite (embedded Postgres, fake Brain)
npm test -- marketChat ocr      # one or more files by name
npm run lint                    # oxlint
npx tsc --noEmit -p .           # typecheck (run `npx next typegen` first for route types)

npm run ingest:market -- radico-khaitan Radico --reference HowBrandsGrow.pdf [--dry]
npm run brands:merge -- radico-khaitan --into "Whytehall" --from "Whytehall Honey" [--apply]
CIP_NEW_PASSWORD='…' npm run set-login -- brand@radico.test [--email new@example.com]
npm run compliance -- radico-khaitan [--apply]     # seed the 19 compliance rules
npm run calendar / websites / attribute / page     # other one-off loaders
```

---

## 8. Testing

- `npm test` runs each file against a throwaway embedded PostgreSQL with the **fake Brain** — no
  key, no network, no bill. `tests/harness.ts` starts it; `TEST_DATABASE_ADMIN_URL` points at a
  real server instead.
- **425 of 428 pass.** The 3 that do not are pgvector tests the embedded server cannot run; the
  new GitHub Actions workflow (`.github/workflows/tests.yml`) runs them against
  `pgvector/pgvector:pg17`.
- The runner exits non-zero on failure; if you pipe it (`| tail`), you get the pipe's status
  instead — that once hid a failure.
- Test files worth reading first: `tests/marketChat.test.ts` (grounding, brand boundary,
  isolation), `tests/ocr.test.ts`, `tests/brain.test.ts` (the checker lives here),
  `tests/migrations.test.ts` (every migration must have a down file that restores the schema).

---

## 9. Where the live system stands

- Migrations **through 0028 are applied** to the Supabase database.
- Roster is **11 brands**; the merged line names live on as aliases.
- **19 compliance rules** seeded (India Rule 7(2)(viii) + ASCI, Nigeria ARCON, Ghana FDA, Europe
  AVMSD). **None are legally verified yet** — CIP-suggested rules can warn but not fail.
- **52 market/reference files** are in: the 28 from `Radico/` plus 24 added since.
  **27 have been read → 1,823 market signals.** **24 are still waiting** on extraction and market
  reading. 6,219 chunks are embedded.
- **The worker is not running.** It was stopped when the previous session ended, mid-run. Start it
  again (`npm run cip:worker -- --watch`) to finish those 24 and to keep everything current.
- **Nothing is committed.** 90 changed or new paths sit in the working tree on `main`
  (last commit `066eaa3`). The user asked to hold off committing. `design/` is gitignored;
  `Radico/` is untracked and should be ignored too before any commit.

---

## 10. Open work

**Only the user can do these**

1. Rotate the exposed Supabase service_role key and the database password.
2. Set a real password and email for the Radico login (`npm run set-login`).
3. Create a hosting account for the worker (Render blueprint is ready) — Vercel cannot run it.
4. Have someone legally review the 19 compliance rules, then mark them verified in the UI.
5. Say which other markets Radico sells into, with their calendars and rules.

**Known gaps and risks**

- The Brain's real-world accuracy on these reports is **untested** — everything was proved against
  the fake provider. Read a few signals on `/market` against their source PDFs before trusting them.
- A proof check on a real Magic Moments India creative scored 49 (compliance 20) citing the ASCI
  surrogate rule and a missing statutory warning. **Needs human confirmation.**
- Market reading covers the 12 densest sections of a long report, not all of it.
- Two Radico earnings presentations (Q2, Q3) look like the same file uploaded twice.
- Rate limits fall back to per-process memory if the database is unreachable.
- Brand relations rebuild is batched now but still the slowest step on real data.

---

## 11. Gotchas that cost time before

- **Heredocs in Bash fail unpredictably here.** Write files with the editor tools, or write a
  `.cjs` script to a scratchpad and run it with `node`. Match CRLF: several files use it, and an
  exact-text edit silently misses otherwise.
- **Typed routes**: a new page's path is not a valid `Route` until `npx next typegen` or a build.
- **The Supabase pooler flakes** intermittently ("password authentication failed for user
  cip_app", `EAUTHQUERY`). It is transient — retry before debugging. Two uploads failed this way.
- **`postgres` tagged templates**: no expressions inside SQL comments, cast bare parameters
  (`${x}::uuid`, `${n}::int`), and a table constraint cannot hold an expression — use a functional
  unique index with `coalesce(nullable, '')`, as the existing migrations do.
- **Never delete from `google_drive_connections`** in any script, proof or test.
- **`next build` rewrites `next-env.d.ts`**; restore it (`git checkout -- next-env.d.ts`).
- Writing style in this codebase: comments explain *why*, in plain English, often naming the bug
  that motivated the code. Match it. No em dashes in code comments (they were deliberately
  avoided); prose in the UI is plain and never over-promises.

---

## 12. If you read only one thing

Start at `src/server/brain/checker.ts` (`groundFindings`), `src/server/brain/chat.ts`
(`gatherSources`), and `src/server/brain/market.ts` (`groundSignals`). Those three functions are
the product's argument: a model may propose anything, and only what cites something CIP actually
sent is allowed to reach a person.
