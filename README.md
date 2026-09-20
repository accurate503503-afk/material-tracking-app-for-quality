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
- **PO Dashboard** — a basic quantity reconciliation view per PO.

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
- **Special Process** tracking is intentionally out of scope, per the
  spec, but nothing in the schema blocks adding it later.

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
