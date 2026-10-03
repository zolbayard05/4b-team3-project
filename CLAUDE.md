@AGENTS.md

# Project rules

Numbered so they can be referenced from code comments (e.g. "see rule 30").

## Storage & AR constraints

1. **Every generated model MUST be stored in both `.glb` and `.usdz`.** GLB
   serves web + Android AR; USDZ serves Apple AR. Storing only one breaks
   half of all devices.
2. **On R2 upload, set `Content-Type` explicitly**: `.glb` →
   `model/gltf-binary`, `.usdz` → `model/vnd.usdz+zip`. R2 defaults to
   `application/octet-stream`, and with that MIME type iOS Quick Look fails
   SILENTLY — no error, nothing happens.
3. **Set `Cache-Control: public, max-age=31536000, immutable` on model
   objects.**
4. **Never serve models from the r2.dev domain in production** (rate-limited).
   Use a custom domain (`cdn.<domain>`) and document the DNS setup in the
   README.
5. **Two buckets**: `uploads` (private) and `models` (public, custom domain,
   CORS for GET/HEAD from our origin only).
5a. **An R2 API token's "Object Read & Write" permission only covers object
    operations** (GetObject/PutObject/ListObjects/HeadObject/HeadBucket). It
    does NOT cover bucket-level configuration — CORS, lifecycle rules, public
    access settings. Reading or writing those needs an "Admin Read & Write"
    token, or the Cloudflare dashboard directly. Don't burn a debugging cycle
    assuming a 403 on `GetBucketCorsCommand`/`PutBucketCorsCommand` means the
    policy wasn't applied — check the token's permission tier first.
6. **Never use presigned GET URLs for models** — they expire, which kills
   shared AR links and QR codes. Public bucket + unguessable UUID keys.
7. **Use `<model-viewer>` for AR launch.** Do NOT hand-roll the iOS `rel="ar"`
   anchor: Apple requires an `img` element as the direct first child of the
   anchor, and getting it wrong degrades to a plain file download instead of
   AR.
8. **Config**: `ar`, `ar-modes="webxr scene-viewer quick-look"`, `src` = GLB,
   `ios-src` = USDZ.
9. **Assume WebXR is unavailable on iPhone Safari.** iOS AR goes through
   native AR Quick Look: no custom UI, no in-AR analytics, and the user
   leaves our app during the session. Never build features that assume
   in-AR callbacks.
10. **Known iOS bug**: the AR button can grey out after a prior AR session
    until cache is cleared. `ModelDetail.tsx` had a visible fallback link for
    this (direct navigation to the `.usdz` URL, independent of the button's
    JS state) — removed 2026-08-24 by explicit product decision, accepting
    the dead-end risk for a cleaner screen. Don't re-add it reflexively
    citing this rule; if the grey-out turns out to actually bite users,
    that's a fresh product call, not an automatic revert.
11. **`<model-viewer>` must be a client component, dynamically imported** —
    it touches `window`/custom elements and will break SSR otherwise.

## Async pipeline

12. Generation takes 30–100 seconds. Never block a serverless function waiting
    for it. Flow: POST /api/generate → deduct credit → insert a `models` row as
    `pending` → submit the job to Tripo with a callback_url → return 202 plus
    the model id immediately.
13. The provider webhook handler must, in this order: verify the signature,
    download the provider's files and re-upload them to R2 (provider URLs
    expire), and only then update the DB row to `ready`. That order matters —
    if the row is marked ready first, clients fetch files that aren't there yet.
14. Client updates come from a Supabase Realtime subscription on the `models`
    row. No polling.
15. Uploads go browser → R2 directly via presigned PUT. Never route image bytes
    through a Next.js route handler; serverless body size limits will fail on
    real photos.

## Webhook and credit accounting

16. Webhooks retry. Every webhook handler must be idempotent — guard on a state
    transition, not on receipt. A second delivery for an already-processed model
    must be a no-op, never a second refund or a second write.
17. Credit deduction is atomic in a Postgres function (UPDATE ... WHERE
    credits > 0 RETURNING). A read-then-write pattern lets concurrent requests
    generate for free. This is a revenue bug, not a style issue.
18. A failed generation refunds the credit exactly once, via refund_credit,
    guarded on the transition into `failed`.
19. service_role is the only write path for status, glb_url, usdz_url, credits,
    and plan. Every write to those columns goes through a server action or
    webhook — never a client-side .update().

## Input quality

20. **Validate uploads client-side**: single clear subject, reasonable size,
    supported MIME. Show example good/bad reference images. Blurry photos,
    heavy shadows, and multi-object scenes produce unusable meshes and burn
    paid credits.
21. **Post-process for mobile AR**: target < 8 MB per model, Draco
    compression, textures capped at 1–2K. Large models simply never load on
    phones. **Enforced, not just hoped for**, on the USDZ side specifically:
    the webhook checks final USDZ size and retries the *generation* (not a
    local re-process — USDZ can't be Draco-compressed after the fact, see
    rule 24) at a lower `face_limit` if it's over target, bounded to
    `MAX_SIZE_RETRIES` in `lib/tripo.ts` since each retry is a full paid
    Tripo generation, not a cheap step. Final size is logged per model
    either way (`app/api/webhooks/tripo/route.ts`) — `DEFAULT_FACE_LIMIT`
    is still a guess (one chair measured at 7.34 MB, under target, but
    geometry complexity varies enormously by object type), so that log data
    is what should eventually replace the guess with a measured value.
22. **AI meshes have no real-world scale.** Provide a scale control and
    persist the user's chosen scale per model.

## Texture pipeline decisions

23. **`texture_quality: "standard"` is final — decided three times, settled
    2026-08-23. Do not relitigate without new measured evidence.**

    Timeline: started on Tripo's legacy V2-compatible request shape, which
    silently ignores `texture_quality` entirely (rule 12's original
    `{model, input}` body). Moved to the real H3 request shape and tried
    `"detailed"` (native 4096, +10 credits) paired with frequency separation
    (rule below) — looked clean in crops. Tried reverting to `"standard"`
    (native 2048) to save credits — read visibly worse on a real device,
    more than expected. Root cause turned out to be a bug, not a resolution
    limitation: `BLUR_SIGMA` in `lib/textureFreqSeparate.ts` was a **fixed
    pixel value (40)**, tuned against the 4096 `"detailed"` texture, applied
    *unchanged* to the 2048 `"standard"` texture — running proportionally
    2x too large. Confirmed by direct measurement that larger sigma made it
    *worse*, not better: at a fixed sample-point seam, sigma=20 (correct
    for 2048) closed 90.7% of the gap; sigma=60 (oversized) only closed
    77.9% — a blur wide enough to approach UV-island size starts averaging
    in unrelated neighboring islands (arbitrarily adjacent in atlas space,
    not 3D space) rather than isolating each one's own baked tone. Fixed by
    making it a resolution-proportional ratio (`BLUR_SIGMA_RATIO = 40/4096`)
    instead of a fixed constant, then re-compared `"standard"` against
    `"detailed"` with the fix in place, on the same source photo, through
    the real production pipeline both times:

    | | detailed | standard (retuned) |
    |---|---|---|
    | Seam-gap reduction | 1.7 → 0.2 (88%) | 2.8 → 0.3 (89%) |
    | Credits/model | 45 (40 + 5) | 35 (30 + 5) |
    | GLB | 2.18 MB | 0.94 MB |
    | USDZ | 8.76 MB (over target) | 7.34 MB |

    Cleanup quality is a wash between tiers once the bug is fixed. Verified
    on-device that the resolution/grain difference itself (2048 vs 4096) is
    not perceptible in AR either. `"standard"` wins on every measurable
    axis (credits, both file sizes) with no measured quality cost — that's
    the decision, and why it's now default in `lib/tripo.ts`.

    **General lesson**: a fixed pixel constant tuned against one texture
    resolution can silently misbehave at another, in a direction that isn't
    obviously "less effective" — it can actively make the underlying
    algorithm *worse*, not just proportionally weaker. Any per-pixel
    constant derived from testing at one resolution (blur radii, kernel
    sizes, thresholds) needs either a resolution-proportional form or an
    explicit note that it's only verified at that one resolution.

24. **Frequency separation cleans baked lighting; it doesn't add material
    detail.** Diffuse texture atlases from single-image reconstruction carry
    two different problems at different spatial frequencies: low-frequency
    per-UV-island baked lighting/AO (reads as "dirty/patchy," removable) and
    high-frequency weave/grain (the material's real character, must be
    preserved). `lib/textureFreqSeparate.ts` separates on the luminance
    channel only (chroma untouched, so hue/saturation are mathematically
    invariant — verified: identical saturation before/after on a real wood
    sample) and flattens only the low-frequency layer toward its own global
    mean by `FLATTEN_STRENGTH` (currently 0.9, named so it's tunable without
    hunting for a magic number). A failure here must never fail a paid
    generation — caught independently of the rest of `compressGlb`, falling
    back to the unprocessed texture; Draco/resize still run either way. The
    before/after seam-luminance gap is logged per model in the webhook —
    watch that data for the technique quietly degrading on an unfamiliar
    object/material type rather than finding out from a user.

## Multiple generation providers

37. **`models.provider` can be `"tripo"` or `"fal"`.** `GENERATION_PROVIDER`
    (lib/generateModel.ts `getGenerationProvider()`) picks the default for a
    new single-photo generation; multiview (left/back/right present) always
    forces `"tripo"` regardless of that setting, since fal's trellis-2
    endpoint (lib/fal.ts) has no multiview input. Rule 12's "submit the job
    to Tripo" should be read as "submit to the selected provider" — the
    deduct-credit/insert-pending/submit/return-202 shape is identical either
    way, shared by both in `submitGeneration` (lib/generateModel.ts).
38. **USDZ conversion always goes through Tripo's `/models/convert` task,
    regardless of which provider generated the GLB.** Neither provider
    emits USDZ directly. A fal-sourced GLB is uploaded to our own public
    `models` bucket first (app/api/webhooks/fal/route.ts), then that URL
    (not a task_id) is passed to `submitUsdzConversionTask` — the resulting
    Tripo task's completion lands on the existing
    app/api/webhooks/tripo/route.ts webhook unchanged, matched via
    `usdz_provider_job_id` same as a Tripo-originated model. Rules 13/16
    (verify-then-reupload-then-ready ordering; idempotent on state
    transition) apply identically to app/api/webhooks/fal/route.ts.
39. **A size-budget retry on an oversized USDZ must resubmit through
    `model.provider`, not always Tripo** — see the branch in
    app/api/webhooks/tripo/route.ts's USDZ-stage handling. Getting this
    wrong would silently regenerate a fal-sourced model's geometry via Tripo
    on retry without `models.provider` ever reflecting that.

## Auth & authorization

30. **`proxy.ts` is not an authorization boundary.** It refreshes the Supabase
    session cookie and redirects logged-out browsers away from `/dashboard`
    as a UX convenience only — it provides no security guarantee and can be
    bypassed. Every route handler and Server Action must independently call
    `supabase.auth.getUser()` and verify the caller owns the specific
    resource it's touching. Never assume proxy already checked this.
31. **Never use `supabase.auth.getSession()` for server-side authorization
    decisions.** `getSession()` reads the session from the cookie without
    revalidating it against the Auth server — a stale or forged cookie can
    pass. `getUser()` round-trips to Supabase and confirms the token is
    still valid; it's the only one safe to gate access with.
32. **Never edit a migration file that has already been applied to a live
    database.** Add a new migration file instead. An already-applied file is
    part of the historical record other environments replay in order —
    editing it in place means a fresh database and an existing one diverge
    silently, since the existing one already ran the old contents and won't
    re-run the edited version.
33. **RLS restricts rows, not columns.** A `USING (auth.uid() = id)` policy
    is satisfied by a user updating their own row, including columns that
    must be server-only (e.g. credits, plan, status) — row ownership says
    nothing about which columns they should be allowed to set. Any table
    with a mix of user-writable and server-only columns needs column-level
    `GRANT`/`REVOKE`, not just a row policy, to close that gap.
34. **`service_role` is the only write path for `profiles.credits`,
    `profiles.plan`, `models.status`, `models.glb_url`, and
    `models.usdz_url`.** `authenticated` has no grant on these columns at
    the database level (see rule 33) — every write to them must go through
    a server action or webhook using the service role key. Never add a
    client-side `.update()` touching these columns; it will fail at the
    database, and if it didn't, it would be the security hole rule 33
    exists to prevent.
35. **RLS restricts rows, not columns, and column-level grants must be
    audited for INSERT as well as UPDATE.** A user who can insert a row can
    set every column in it. We've hit this class of bug twice: first on
    UPDATE (rule 33 — a user updating their own row could also set
    server-only columns like credits/status), then on INSERT (`models`'s
    owner-insert policy only checked `user_id`, so a user could insert a row
    with `status = 'ready'` and a fabricated `glb_url`, self-granting a
    finished model for free). Any table with a mix of user-writable and
    server-only columns needs both directions checked, not just UPDATE.
36. **Third occurrence of the rule 33/35 class of bug, found auditing
    migration 0008: `anon` — not just `authenticated` — needs its grants
    checked too, and on every table, not just the ones already audited.**
    `anon` had blanket INSERT/UPDATE on *every* column of both `models` and
    `profiles`, on every column including ones that predate this — 0004/0005
    only ever revoked from `authenticated`, `anon` was never addressed at
    all, this whole project (fixed in 0009). Not currently exploitable
    (RLS's row policies block anon regardless — no INSERT policy survives
    on either table, and UPDATE policies require `auth.uid() = user_id/id`,
    never true with no JWT) but that's "the safety happens to be on," not
    "there's no loaded gun" — fix it anyway, same principle as rule 33/34
    already establish for authenticated. Also confirmed: Supabase's
    default-privileges auto-grant re-triggers on `ALTER TABLE ADD COLUMN`,
    not just `CREATE TABLE` — every migration since 0006 that added a
    column had this gap for anon on that column specifically, in addition
    to the pre-existing gap on every older column. Check `anon` grants,
    not just `authenticated`, whenever auditing a table after this.
