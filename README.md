# ULTRA@503 Material Traceability & Handover (Phase 1)

A separate app from Rework/Rejection and Visual Check Sheet. This one is
backed by a real shared database (Supabase/Postgres) instead of local
device storage, because its core feature — the Release → Awaiting Receipt
→ Receive handover chain — only makes sense if two different people, on
two different phones, see the same live data.

## Setup order (do this once)

1. Run `phase1_schema.sql` in Supabase's SQL Editor.
2. Run `phase1_patch_01.sql` (fixes profile self-signup + a handover
   permission bug).
3. Run `phase1_patch_02.sql` (fixes the `dispatch` role, moves ledger/
   stage bookkeeping into the database as triggers, adds photo storage
   policies).
4. Run `phase1_patch_03.sql` (lets the `fitting` role register new
   Parts/POs, not just admin).
5. In Supabase: **Storage → Create bucket** → name it exactly
   `attachments` → set it **Private** (the SQL patches already added the
   read/write policies for it).
6. `config.js` in this project already has your Project URL and
   `anon`/`publishable` key filled in. That key is safe to commit
   publicly — it only ever does what the database's Row Level Security
   policies allow.
7. Push this whole folder to its own GitHub repository (including
   `.github/workflows/main.yml`), then in that repo's
   **Settings → Pages**, set Source to **GitHub Actions**.

## First-run: getting your first real user

1. Open the deployed site → **Create Account** with an email + password.
   - If your Supabase project has email confirmation turned on (the
     default), you'll need to check that inbox and confirm before
     signing in. For faster internal testing, you can turn this off:
     Supabase → **Authentication → Providers → Email → "Confirm email"**
     toggle off.
2. Sign in → you'll land on **Complete Your Profile** → enter your name
   and Employee ID.
3. You'll then see **Pending Role Assignment**. Go to Supabase →
   **Table Editor → profiles**, find your row, and type a role directly
   into the `role` column (one of: `admin`, `fitting`, `marking`,
   `mpi_pmi`, `final_inspection`, `cmm`, `coating`, `visual_inspection`,
   `packing`, `dispatch`, `dock_audit`).
4. Back in the app, click **"I've been assigned a role — Refresh"**.
5. Repeat for every real employee. There is no in-app admin screen yet
   in Phase 1 — assigning roles is a manual step in Supabase's Table
   Editor. This is intentional (see "Phase 1 scope" below).

## What's built in Phase 1

- **Auth** — email/password sign-up and sign-in via Supabase Auth.
- **Profile** — name + employee ID, saved once; role assigned by an
  admin via the database directly (see above).
- **Search** — by Part Number, PO Number, UC Batch, Heat Batch, or
  Route Card No.
- **QR scanning** — reuses the proven scanner (native `BarcodeDetector`
  first, `jsQR` fallback, rear camera, auto-stop) from the other
  ULTRA@503 apps, both to search for an existing Route Card and to
  prefill a new one.
- **New Route Card registration** — finds or creates the Part and PO
  automatically, then creates the Route Card.
- **Stage completion** — role-gated: you can only complete a stage that
  matches your assigned role (`dispatch` covers both RFD and Customer
  Pickup; `admin` can complete any stage).
- **Release → Awaiting Receipt → Receive** — the headline feature.
  Releasing does not update anything about "current stage" by itself;
  only the receiver's confirmation moves the material forward. This is
  enforced by the database, not just the interface.
- **Rework** — raise → mark completed → verify, restricted to the
  roles named in the spec (Final Inspection, Visual Inspection,
  Packing, Dock Audit, Admin).
- **Rejection/Scrap** — restricted to MPI/PMI, Final Inspection, Visual
  Inspection, Dock Audit, Admin.
- **Photos** — optional, attachable to stage completion, handover
  release, rework raise, and rejection report.
- **Timeline** — every event for a Route Card, merged and sorted, with
  who/what/quantity/when.
- **Append-only audit trail & quantity ledger** — enforced at the
  database level (an `UPDATE` or `DELETE` on `audit_log` or
  `quantity_movements` is actually rejected by Postgres, not just
  discouraged by the app).
- **PO Dashboard** — Part No. as heading, PO No. as subheading, and
  every Route Card under that PO listed with its own live current
  stage (a PO can have several Route Cards/batches, each at a
  different point in the process, so this is shown per-Route-Card
  rather than as a single aggregate count).
- **Urgent / Top Priority** — `admin` and `supervisor` only can flag a
  Route Card urgent (with an optional reason) from its own page, and
  get a dedicated tab listing every urgent Route Card plant-wide.
  Anyone can still see the 🔴 badge on a Route Card they already have
  open.
- **Awaiting My Receipt** sits in its own highlighted box on the
  Dashboard that visibly pulses whenever there's at least one handover
  waiting on you, so it's hard to miss.
- **Back button** — from any screen other than the Dashboard, a single
  back press returns you to the Dashboard. From the Dashboard itself,
  one back press warns "Press back again to exit"; only a second press
  within ~2 seconds is allowed to actually leave the app.
- **Special Process** (Carburizing / Heat Treatment / Induction) is
  now a real stage, positioned after Marking/MPI-PMI and before Final
  Inspection, matching section 4 of the original spec. No dedicated
  role is mapped to it yet — only `admin` can complete it for now (see
  the note in `phase1_patch_05.sql` for how to add a dedicated role
  later).

- **Completing Dock Audit auto-archives the Route Card** — its status
  becomes `completed` and it stops appearing in Search, PO Dashboard,
  and Urgent, the same as manually-removed material. Nothing is
  deleted — full history stays intact and it's still reachable directly.
- **`role` is a plain text column with a CHECK constraint**, not a
  Postgres enum — this was changed deliberately after enum-related
  migration failures; see `ULTRA_503_Material_Traceability_Master_Prompt.md`
  §18 for why.

## Known Phase 1 simplifications (by design, not oversights)

- **No in-app admin screen.** Role assignment happens in Supabase's
  Table Editor. Fine for a small team; worth building a proper screen
  once the user list stabilizes.
- **Anyone can release a handover for any Route Card**, regardless of
  whether they're the one who "currently holds" it — Phase 1 has no
  explicit custody/location field beyond `current_stage_id`. If this
  causes confusion in practice, Phase 2 should add a `held_by` field to
  `route_cards`, updated on receipt, and restrict releasing to whoever
  currently holds it.
- **Customer-approved PO split, RFD/Customer Pickup dedicated screens,
  and Dock Audit planning** are not built as separate guided workflows
  yet — RFD and Customer Pickup can currently be recorded as ordinary
  stage completions by the `dispatch` role, which covers the data model
  but not the richer approval workflow described in sections 15 and 18
  of the original spec.
- **CMM required/not-required** is not yet surfaced as an explicit
  toggle in the UI, though the `route_cards.cmm_required` column exists
  and is ready for it.
- **Special Process** now has a stage and shows up everywhere stages
  are listed (Complete Stage for admins, Release/Handover destination,
  Rework/Rejection stage pickers). What's still Phase 2: a dedicated
  role for it, and any richer workflow beyond "it's a stage like any
  other."

## Setup order, updated

If you're setting this up from scratch, run the SQL patches in this
exact order: `phase1_schema.sql` → `phase1_patch_01.sql` →
`phase1_patch_02.sql` → `phase1_patch_03.sql` → `phase1_patch_04a.sql`
→ `phase1_patch_04b.sql` → `phase1_patch_05.sql`. If you already had
01–03 running, you only need to add 04a, 04b and 05.

## Testing checklist (needs two real accounts on two devices)

1. Account A = `fitting` role: register a new Route Card.
2. Account A: complete the Fitting stage.
3. Account A: Release / Handover to Marking.
4. Account B = `marking` role, different phone: open **Awaiting My
   Receipt**, confirm the handover shows up, confirm receipt.
5. Both accounts: open the same Route Card and confirm the Timeline
   shows both events with the correct names and timestamps.
6. Try completing a stage that does **not** match your role — it
   should be rejected by the database (you won't even see the option
   in "Complete Stage" unless your role matches, but this is worth
   confirming Postgres also refuses it, not just the UI hiding it).
7. Raise a rework, mark it completed (can be the same or a different
   authorized user), then verify it — confirm all three show up
   correctly in the timeline.
8. Report a rejection and confirm it appears in the PO Dashboard's
   "Scrapped" count.
