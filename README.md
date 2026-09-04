# CIP — Client App (Phase 1)

**Create. Comply. Perform.**

A multi-tenant frontend for CIP, an AI-powered brand intelligence platform. Every
client company gets its own isolated workspace: its own branding, Brand Brain,
campaigns, requests, pod and trust record.

The system behind this is complicated. The product is not — the whole client app
is three ideas: **Teach**, **Ask**, **Trust**.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
```

## Multi-tenancy

One application, many companies. Nothing is forked per client.

- `src/data/types.ts` — the `Tenant` contract. Everything the UI renders comes
  from one object: branding, hero art, prompt suggestions, pod, brand
  understanding, requests, metrics and trust record.
- `src/data/magicMoments.ts`, `src/data/narayanaHealth.ts` — two sample tenants.
- `src/data/index.ts` — the registry and `getTenant()`, the seam where the real
  API call will go.
- `src/context/TenantContext.tsx` + `src/context/tenantStore.ts` — resolves the
  one workspace this session may see, and the `useTenant()` hook every component
  reads it through. In production the server returns the signed-in user's tenant
  and there is no switching; `switchTenant` is gated on `import.meta.env.DEV`.
- `src/components/CompanyWorkspace.tsx` — turns the tenant's branding into CSS
  variables for the whole shell, and remounts the tree on tenant change so no
  stale company data can survive a switch.

**Adding a company** means adding one data file and one registry entry. No new
components and no new stylesheet.

The workspace switcher in the sidebar is visible in development only, and says
so.

## The three pillars

| Section | File | Purpose |
| --- | --- | --- |
| Teach | `src/sections/TeachSection.tsx` | What we understand about the brand, what is missing, and what each step unlocks. |
| Ask | `src/sections/AskSection.tsx` | Type a request in plain words → read back what we understood → correct it → see what you get, when, and for how much. |
| Trust | `src/sections/TrustSection.tsx` | What shipped, what is stuck and why, rights, approvals, checks, learnings and cost. |

### Two ways to make it

The composer offers both, and the trade-off is stated, never implied:

- **Generate instantly** — CIP drafts it now, on its own. About two minutes, a
  fraction of the cost, and clearly labelled *not checked yet*. The result
  screen carries an amber note and a "Send to my pod for checks" button. Amber,
  not red: an unchecked draft needs attention, it is not blocked.
- **Create with pod** — the primary action. Your people make it and check it,
  and you get a timeline, an estimate and a progress tracker.

Both paths share the same read-back step: "Here is what we understood", with
every line editable, removable and addable, and the mode switchable right up
until you confirm. `interpret()` prices and times the same request both ways
(`plans.instant` / `plans.pod`).

`src/lib/interpret.ts` stands in for the Brand Brain's request understanding so
the Ask flow can be designed and reviewed end to end before the backend exists.
Replace that one function and the UI does not change.

## Rules the code keeps

- **Nothing technical reaches the client.** No models, tokens, routing,
  confidence scores or vector-store language anywhere in the UI or the data.
- **Red means "this cannot be shipped."** Amber means attention, green means
  ready. Enforced in one place — `StatusPill` in `src/components/ui/Bits.tsx`
  and the `edge()` helper in Trust.
- **Every number explains itself.** "68% understood. Paid campaigns unlock at
  80%", never a bare "68%".
- **Empty states teach.** They say what to do next and give the button to do it.
- **One primary action per screen.** On Home and Ask, that is the request box.
- **No control that does nothing.** There is no placeholder search, no dead
  overflow menu and no button wired to a "coming soon" toast. If it is on the
  screen, it works.
- **The pod is always visible.** People and AI, plainly working together.

## Structure

```
src/
  components/        AppShell, Sidebar, CompanySwitcher, CompanyWorkspace,
                     RequestComposer, RecentRequests, MonthlySummary, PodCard
    ui/              Icon (hand-rolled set), Bits (Avatar, Card, StatusPill,
                     Progress, EmptyState, LogoMark)
  context/           TenantContext + tenantStore (workspace resolution),
                     NavContext (routing)
  data/              Tenant contract + one file per sample tenant
  lib/               interpret.ts — mock request understanding
  sections/          HomeDashboard, TeachSection, AskSection, TrustSection
  styles/            Design tokens and one stylesheet per area
```

Routing is hash-based (`#/teach`, `#/ask`, `#/trust`) so the back button works
without pulling in a router.

## Not built yet

The Brand Brain backend, auth, the Pod Console, real asset previews and search.
Everything here is wired so those drop in behind the existing seams.
