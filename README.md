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
```

### Test credentials

`npm run db:seed` creates two companies with two users each. Every seeded user
has the password **`cip-demo-password`**.

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
| `CIP_SEED_PASSWORD` | no | Overrides the seeded test password. |
| `CIP_ALLOW_PROD_SEED` | no | The seed refuses to run with `NODE_ENV=production` unless this is `true`. |

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

### Proving it

```bash
npm test              # 17 assertions against a real PostgreSQL
npm run prove         # end-to-end over HTTP, needs the dev server running
npm run check:bundle  # fails if company data reached the client bundle
```

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
    migrations/           0001 core · 0002 workspace · 0003 isolation
    auth/                 password, session, membership, credentials, guards
    workspace/service.ts  every company-scoped read
    seed.ts, seed-data.ts development data
  components/, sections/  the CIP UI, unchanged in behaviour
  lib/                    presentation and formatting, derived in the browser
  types/workspace.ts      the wire contract
  proxy.ts                signed-out redirect (a convenience, not the boundary)
tests/isolation.test.ts   the test that matters most
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
- **`embedded-postgres` is a beta package,** used only by `npm test` and
  `npm run db:local`. Set `TEST_DATABASE_ADMIN_URL` to test against a real
  server instead.
