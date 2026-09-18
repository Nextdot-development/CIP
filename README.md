# CIP — Phase 1

**Create. Comply. Perform.**

A multi-tenant brand intelligence platform. Phase 1 is the secure foundation:
a user signs in, the server works out who they are and which company they
belong to, and they see that company's workspace and nothing else.

The AI, the Brand Brain, Company Drive, generation and Pod automation are all
later phases. None of them are here.

---

## Run it locally

You need Node 24+. You do **not** need Docker or a Postgres install — the repo
can start a real PostgreSQL of its own.

```bash
npm install
cp .env.example .env.local          # then fill in SESSION_SECRET (see below)

npm run db:local                    # terminal 1 — starts PostgreSQL on :55432
npm run db:reset                    # terminal 2 — migrations, then seed
npm run dev                         # terminal 2 — http://localhost:3000
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

For local development `.env.local` can be exactly:

```
DATABASE_ADMIN_URL=postgres://cip_admin:cip_admin@localhost:55432/cip
DATABASE_URL=postgres://cip_app:local-dev-password@localhost:55432/cip
CIP_APP_DB_PASSWORD=local-dev-password
SESSION_SECRET=<paste the generated value>
CIP_SEED_PASSWORD=<what the seeded users will sign in with>
```

### Test credentials

`npm run db:seed` creates two companies with two users each. Every seeded user
gets the password you put in `CIP_SEED_PASSWORD`, and the seed refuses to run
without one.

There used to be a default here, printed in this file. It was still the
password on every seeded account months later, including a client's, so it is
gone: a password written down in a public repository is not a password.

| Email | Company | Role |
| --- | --- | --- |
| `sneha@magicmoments.test` | Magic Moments | owner |
| `dev@magicmoments.test` | Magic Moments | member |
| `rahul@narayanahealth.test` | Narayana Health | owner |
| `kavya@narayanahealth.test` | Narayana Health | viewer |

Sign in as one, then the other. The workspace changes completely — branding,
pod, requests, metrics, compliance record — and neither can reach the other.

### Pointing at Supabase

```
DATABASE_ADMIN_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres?sslmode=require
DATABASE_URL=postgresql://cip_app:<app-password>@db.<ref>.supabase.co:5432/postgres?sslmode=require
CIP_APP_DB_PASSWORD=<app-password>
```

`DATABASE_ADMIN_URL` is the string from Project Settings → Database, used only
by `db:migrate` and `db:seed`. `DATABASE_URL` must be the `cip_app` role that
migration 0003 creates: Supabase's `postgres` role has `rolbypassrls = true`
and would read straight through row-level security.

Then `npm run db:migrate` (which creates `cip_app` and sets its password from
`CIP_APP_DB_PASSWORD`) followed by `npm run db:seed`.

Three things that will bite you:

- **Percent-encode the password.** A `@`, `#`, `/` or `:` in it will otherwise
  be parsed as URL structure. `p@ssw0rd` becomes `p%40ssw0rd`.
- **`?sslmode=require` is mandatory.** Supabase refuses plaintext connections;
  the driver reads this from the URL, so no code change is needed.
- **`db.<ref>.supabase.co` resolves to IPv6 only.** It works from a machine
  with IPv6, but an IPv4-only host or CI runner needs the pooler host from
  Project Settings → Database → Connection pooling instead. Use *session* mode
  (port 5432); transaction mode also works but needs `prepare: false` on the
  driver.

Check it took: **`GET /api/health`** reports `rowLevelSecurity: "binding"` when
the running app cannot bypass RLS, and returns 503 with a warning when it can.

---

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Application connection. Must be a non-superuser role, or the second isolation layer silently stops applying. |
| `DATABASE_ADMIN_URL` | migrations only | Elevated connection for `db:migrate` / `db:seed`. Never used to serve a request. |
| `CIP_APP_DB_PASSWORD` | migrations only | Password set on the `cip_app` role, so no secret sits in a committed `.sql` file. |
| `SESSION_SECRET` | yes | 32+ characters. Keys the HMAC over session tokens. |
| `CIP_SEED_PASSWORD` | seeding only | The password every seeded user gets, at least 8 characters. There is no default: the seed refuses without it. |
| `CIP_ALLOW_PROD_SEED` | no | The seed refuses to run with `NODE_ENV=production` unless this is `true`. |
| `CIP_STORAGE_DIR` | no | Where Drive file bytes are written. Defaults to `./.storage`. |

`.env.local` is gitignored. `.env.example` is the template.

---

## How isolation works

Three things have to line up before a row reaches a browser.

**1 — The session says who you are.** The cookie holds an opaque random token;
only an HMAC of it is stored, so a database leak yields neither live sessions
nor anything precomputable without `SESSION_SECRET`.

**2 — Membership says what you may open.** `getSession()` joins `memberships`
on every request. A session row records which company was chosen at sign-in; it
is not on its own permission to read that company. Revoking a membership takes
effect on the next request, not the next sign-in.

**3 — Every query is scoped, twice.**

- *Service layer.* Company data is reachable only through `getWorkspace(session)`,
  whose sole argument is a `CompanyScope`. A scope can only be built from a
  verified session, so there is no parameter through which a browser could
  supply a company id.
- *Row-level security.* Migration 0003 enables RLS with `FORCE` on every
  company-owned table, keyed to a setting that `withCompanyScope` sets per
  transaction. A query that forgets its `WHERE` clause returns nothing rather
  than another company's rows, and no scope at all returns nothing at all.

`GET /api/workspace` takes no company parameter. Adding one would be the bug.

### A note on the service role key

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security completely — it is the
one credential that can read every company's data at once. It is server-only:
never import it into a client component, and `npm run check:bundle` fails the
build if it, or `service_role`, ever appears in client output.

Supabase Storage policies are written against Supabase Auth JWTs (`auth.uid()`),
and CIP issues its own sessions, so a bucket policy cannot tell one CIP company
from another. That is why the bucket is **private with no policies at all** and
every byte is served through `/api/drive/files/[id]/content`, which checks the
session and the company first. The `drive_files` row — which is under row-level
security — is what decides whether a key may be read.

### Proving it

```bash
npm test              # 50 assertions, no network needed (runs serially:
                      # each DB-backed file starts its own PostgreSQL)
npm run test:storage  # 7 more against the real Supabase bucket
npm run prove         # workspace isolation over HTTP, needs the dev server up
npm run prove:drive   # Drive isolation over HTTP, needs the dev server up
npm run check:bundle  # fails if company data or a secret reached the bundle
npm run storage:gc    # reports stored objects with no database row
```

### Storage housekeeping

Rows and objects can drift apart: a `truncate companies cascade` during a
re-seed, or any raw SQL delete, drops the row and leaves the bytes. Bytes that
outlive their row are invisible in the UI but still exist, which is both a cost
and a privacy problem.

```bash
npm run storage:gc              # report
npm run storage:gc -- --delete  # remove orphaned objects
npm run storage:migrate         # copy local-disk objects into Supabase Storage
```

---

## Company Drive

Folders and files, owned by exactly one company. `/drive` in the workspace.

Browse and nest folders, upload (drag-and-drop or picker), rename, archive and
restore, download, preview, search and filter by file type. Breadcrumbs carry
the folder id in the URL, which is checked against the session before anything
loads — a pasted link to another company's folder renders "not found", the same
as an id that never existed.

**File metadata.** `drive_files` carries `id`, `company_id`, `folder_id`, `name`,
`original_filename`, `file_type`, `mime_type`, `file_size`, `storage_path`,
`uploaded_by`, `created_at`, `updated_at`, `archived_at` and
`processing_status`, plus `checksum_sha256`, `processing_attempts`,
`processing_error`, `processed_at` and a `metadata` JSONB column.
`storage_path` and `checksum_sha256` are internal and appear in no API response.

**Accepted types** (`src/lib/fileTypes.ts`, 50 MB each): PDF, DOC/DOCX,
XLS/XLSX, PPT/PPTX, CSV, TXT, JPG/JPEG, PNG, WEBP, SVG, MP4, MOV, MP3, WAV.
The extension decides the stored MIME type — a browser's Content-Type is a hint,
not evidence — and renaming cannot change it.

**Isolation beyond the policy.** Both Drive tables carry `UNIQUE (id, company_id)`
and reference parents through a **composite foreign key** on
`(parent_id, company_id)`. A file in company A inside a folder from company B is
not merely refused, it is unrepresentable: the referential constraint rejects it
before any policy is consulted.

**Storage.** `src/server/drive/storage.ts` is an adapter with two drivers.
Supabase Storage is used when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
set; local disk under `CIP_STORAGE_DIR` (`./.storage`, gitignored) otherwise,
which is what the offline tests run against. `GET /api/health` reports which one
is live. Object keys are always
`companies/<company_id>/<file_id>.<ext>`, so a mis-scoped read is wrong in the
object store too. Nothing is ever served from storage directly: there is no
public bucket and no signed URL, and every byte leaves through
`/api/drive/files/[id]/content`, which proves the session and the company first.
Downloads carry `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox`
CSP; SVG is never rendered inline, because it can carry script and this is our
own origin.

---

## Knowledge Layer

Deterministic text extraction. No AI, no embeddings, no retrieval — this phase
turns stored files into text and ordered chunks, and stops there.

**What is read:** PDF (pdf.js), DOCX (mammoth), TXT (UTF-8 and UTF-16), CSV.
Everything else is stored and listed normally and shows as "Not read yet"
rather than sitting in a queue that will never move.

**The worker.** `npm run drive:worker` drains the queue once; `-- --watch`
keeps it running. It is a separate process on purpose: Next.js has no durable
background work, so anything started after a response can be killed the moment
that response is flushed. Two workers can run side by side — claiming uses
`FOR UPDATE SKIP LOCKED`, so they never take the same file.

Finding work is the one operation that must look across companies, and it is
the only one that does: a single admin statement returns a file id and its
company id. **Everything after that runs inside `withCompanyScope` for that one
company**, under the app role, so row-level security applies to every read and
write the extraction performs.

**Failure handling.** Three attempts with growing backoff (2, 4, 8 minutes),
then `failed` with a plain reason. A row left in `processing` for more than 15
minutes is assumed to be from a dead worker and reclaimed. A per-file timeout,
a 5M character cap and a 2,000 page cap stop one pathological file exhausting
the worker.

**Chunking** is deterministic and model-agnostic: paragraph-aware, ~1000
characters with ~200 of overlap, every chunk carrying exact offsets into the
extraction. `chunker_version` allows re-chunking from the stored text without
re-reading the file. `token_estimate` is chars÷4, not a model tokeniser — that
answer belongs to whichever embedding model is chosen later.

**Still not built:** embeddings, retrieval, semantic search, OCR, and image,
audio or video analysis. `drive_file_embeddings` will key off `chunk_id` and
`company_id` when a model is chosen; pgvector is available on Supabase but not
installed.

---

## Migrations

Forward-only by default, reversible on demand. Every migration in
`src/server/migrations/` has a matching file in `src/server/migrations/down/`,
and the runner refuses to roll back a migration that has no down file rather
than leaving the schema half-undone.

```bash
npm run db:migrate                    # apply everything outstanding
npm run db:rollback                   # undo the most recent migration
npm run db:rollback -- --steps=3      # undo the last three
```

`tests/migrations.test.ts` walks the whole chain down and back up and asserts
the schema comes back identical.

Rolling back `0003_isolation` drops the `cip_app` role, which the running
application connects as — stop the app first, or the drop fails.

---

## Structure

```
src/
  app/                    Next.js App Router
    (workspace)/          the signed-in shell: layout resolves the session,
                          loads the company, and passes it down as props
    login/                the only unauthenticated page
    api/workspace         the scoped data endpoint
    api/health            reports whether RLS is actually binding
    actions.ts            sign-in and sign-out server actions
  server/                 never reachable from a client component
    db.ts                 connection, CompanyScope, withCompanyScope
    migrations/           0001 core · 0002 workspace · 0003 isolation · 0004 drive
    drive/                service, storage adapter, HTTP wrapper
    auth/                 password, session, membership, credentials, guards
    workspace/service.ts  every company-scoped read
    seed.ts, seed-data.ts development data
  components/, sections/  the CIP UI, unchanged in behaviour
  lib/                    presentation and formatting, derived in the browser
  types/workspace.ts      the wire contract
  proxy.ts                signed-out redirect (a convenience, not the boundary)
tests/isolation.test.ts   workspace isolation
tests/drive.test.ts       Drive behaviour and isolation
```

### The data contract

The server sends ISO timestamps, minor-unit money and numeric percentages.
Words, colours, icons and relative dates are worked out in `src/lib`. So
`₹3.4L`, `2 days ago` and an avatar gradient are all derived — none of them are
columns, and none of them constrain what the API can be used for later.

---

## Known limitations

- **One company per session.** The schema supports many memberships per user;
  sign-in opens the oldest. A company chooser is a later phase.
- **No self-service account management.** No sign-up, password reset, email
  verification or invitations. Users arrive through the seed.
- **Writes are still local.** Confirming a brand question, editing an Ask brief
  and acting on a blocked item change React state and do not persist yet.
- **`src/lib/interpret.ts` still runs in the browser.** It is a keyword matcher
  standing in for request understanding. It reads nothing but the current
  workspace, and moves server-side when the Brand Brain arrives.
- **Logos are monograms.** `companies.logo_url` exists and is rendered when
  set; uploads wait for Supabase Storage.
- **No rate limiting on sign-in.** Failures are constant-time and generic, but
  nothing throttles repeated attempts yet.
- **Deleting a row does not delete its bytes** unless it goes through the
  service. `npm run storage:gc` finds the strays; nothing runs it on a schedule.
- **Uploads are not resumable** and the whole file is buffered in memory, so
  the 50 MB cap is also a practical memory limit per request.
- **Archived files are not purged automatically.** They keep their bytes until
  someone deletes them permanently, and there is no archive screen yet —
  `GET /api/drive/archive` lists them.
- **No file versioning, moving between folders, or sharing.**
- **`embedded-postgres` is a beta package,** used only by `npm test` and
  `npm run db:local`. Set `TEST_DATABASE_ADMIN_URL` to test against a real
  server instead.
