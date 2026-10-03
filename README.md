# Realify

Upload a photo → generate a 3D model → view it in AR from a phone browser. PWA only, no
app stores. See the build spec in project history for full scope; phases land incrementally.

## Stack

Next.js 16 (App Router, TS strict) · Tailwind CSS v4 · Supabase (auth/DB/Realtime) ·
Cloudflare R2 · Tripo + fal.ai/TRELLIS.2 (image→3D) · `<model-viewer>` · Stripe · Vercel.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in real values — see comments in the file
npm run dev
```

Apply the database schema against your Supabase project (SQL editor, or `supabase db push`
if you have the CLI linked): run every file in `supabase/migrations/` in order.

## Project rules

See `CLAUDE.md` for durable rules AI assistants (and contributors) should follow — notably
that `proxy.ts` is a UX convenience, not an authorization boundary; every route handler and
Server Action must independently verify the session and resource ownership.

## Design system

All color/spacing/radius/shadow/font values live in `styles/tokens.css` (shape) and
`styles/themes.css` (per-theme colors, keyed off `data-theme` on `<html>`), mapped into
Tailwind via `@theme inline` in `app/globals.css`. Components use only the resulting semantic
classes (`bg-surface`, `text-muted`, `rounded-card`, ...) — never raw hex values or Tailwind's
default palette/arbitrary-value utilities. This is enforced by an ESLint rule in
`eslint.config.mjs` scoped to `components/**` and `app/**`.

To restyle the whole app, edit `styles/tokens.css` / `styles/themes.css` only.

## Storage: R2 buckets

Two buckets, provisioned by hand in the Cloudflare dashboard (R2 object storage —
there's no Terraform/CLI provisioning yet). See `CLAUDE.md` rules 1–6 for the
constraints behind these settings.

### `uploads` — private

- **Public Access**: disabled (default). Never enable a public URL or custom domain
  on this bucket — it holds raw user-uploaded source photos.
- **Access**: only via the S3 API (`https://<account-id>.r2.cloudflarestorage.com`),
  using a presigned PUT issued by `app/api/upload-url` (5 minute expiry). There is
  no presigned GET — nothing ever reads this bucket back to a browser.
- **Key convention**: `uploads/{userId}/{uuid}.{ext}` — always generated server-side
  from the authenticated session, never from client input (see rule 30 and the
  route's comments).
- **CORS** (Settings → CORS Policy) — allows the browser to PUT directly using the
  presigned URL:

  ```json
  [
    {
      "AllowedOrigins": ["https://<yourdomain>", "http://localhost:3000"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

### `models` — public, custom domain

- **Public Access**: enabled via **Custom Domain only** (see the DNS section
  below) — leave the `*.r2.dev` public development URL toggle off. Rule 4: never
  serve models from `r2.dev` in production, it's rate-limited.
- **Not yet configured** — no production domain exists yet, so there's no custom
  domain bound and `NEXT_PUBLIC_MODELS_CDN_URL` is unset. **This blocks Phase 4.**
  See the "R2 setup" section below for the steps once a domain exists; don't
  substitute the `*.r2.dev` URL to unblock Phase 4 early.
- **Access pattern**: plain public GET, no presigned URLs (rule 6 — a presigned GET
  would expire and break shared AR links / QR codes). Reads are safe to leave
  unauthenticated because keys are unguessable UUIDs (`models.id` is
  `gen_random_uuid()`), not because the bucket restricts who can read.
- **Key convention**: `models/{modelId}.glb` and `models/{modelId}.usdz`, written by
  the generation pipeline (Phase 3) under `service_role` — see `lib/r2.ts` for the
  required `Content-Type` (rule 2) and `Cache-Control` (rule 3) on every write.
- **CORS** (Settings → CORS Policy) — `<model-viewer>` fetches the GLB/USDZ from JS,
  so it needs CORS; native iOS Quick Look opens the USDZ via direct navigation and
  doesn't:

  ```json
  [
    {
      "AllowedOrigins": ["https://<yourdomain>", "http://localhost:3000"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 86400
    }
  ]
  ```

Replace `<yourdomain>` with the real production origin in both policies before
applying them — keep `http://localhost:3000` alongside it for local dev.

Once both buckets exist and `.env.local` has real `R2_*` values, run
`node scripts/verify-r2-storage.mjs` — it presigns and PUTs a real object, reads
back the actual stored `Content-Type`, confirms a presigned URL can't be redirected
to another key, confirms `uploads` rejects an unauthenticated direct fetch, and (once
`NEXT_PUBLIC_MODELS_CDN_URL` is live) checks the `models` CORS policy against a real
and a spoofed origin.

## Generation pipeline (Tripo + fal.ai)

`POST /api/generate` (rule 12/37) deducts a credit, inserts a `pending`
models row, and submits an image-to-model job to a provider — then returns
202 immediately. Two providers exist (`lib/generateModel.ts
getGenerationProvider()`, `models.provider`):

- **Tripo** — the original, default provider. Handles multiview jobs
  (left/back/right photos) unconditionally, and single-photo jobs when
  `GENERATION_PROVIDER` is unset/`"tripo"`.
- **fal.ai (TRELLIS.2)** — `GENERATION_PROVIDER=fal`, single-photo only.
  Runs Microsoft's open-weight TRELLIS.2 model as a hosted fal.ai endpoint
  (`lib/fal.ts`) — no self-hosted GPU, lower cost and (per published
  benchmarks) higher image-to-3D fidelity than Tripo's model.

Neither provider's base generation step produces USDZ — rule 1 needs both
formats, so **USDZ conversion always goes through Tripo's `/models/convert`
task**, regardless of which provider generated the GLB:

1. The GLB-generation job completes → provider-specific webhook fires
   (`/api/webhooks/tripo` or `/api/webhooks/fal`) → handler downloads the
   result and re-uploads it to the `models` bucket as `{modelId}.glb`, then
   submits a **second**, separate Tripo task (`/models/convert` → `USDZ`) —
   fed either a Tripo `task_id` (Tripo-originated) or a public URL to the
   just-uploaded GLB (fal-originated; `/models/convert` accepts either, see
   `lib/tripo.ts submitUsdzConversionTask`).
2. That conversion task completes → webhook fires on `/api/webhooks/tripo`
   (always — it's a genuine Tripo task either way) → handler downloads,
   uploads `{modelId}.usdz`, and flips the row to `ready`.

Both of a Tripo-originated model's events land on `/api/webhooks/tripo`;
`models.provider_job_id` / `models.usdz_provider_job_id` is how an incoming
`task_id` gets matched back to which stage it belongs to. A fal-originated
model's first event lands on `/api/webhooks/fal` instead (matched via
`provider_job_id` + `provider='fal'`), and its second (USDZ) event still
lands on `/api/webhooks/tripo` like any other Tripo task.

**Required setup for fal.ai:**

- `FAL_API_KEY` — fal.ai dashboard → Keys.
- `NEXT_PUBLIC_APP_URL` — fal has a per-request `fal_webhook` query param
  (unlike Tripo's console-configured webhook), built from this var in
  `lib/fal.ts`. In local dev this means `localhost` isn't reachable from fal
  either — same tunnel requirement as Tripo's webhook, below.
- fal's webhook signature scheme (ED25519 + JWKS, `lib/fal.ts
  verifyFalWebhookSignature`) needs no secret to configure — it's verified
  against fal's own published public keys.

**Required setup Tripo doesn't take as request parameters:**

- **Webhook URL and signing secret are configured in the Tripo developer
  console** (Settings → Webhooks), not passed per-request. Point it at
  `https://<your-deployment>/api/webhooks/tripo`, then copy the `whsec_...`
  secret it shows into `TRIPO_WEBHOOK_SECRET`. In local dev this means
  `localhost` isn't reachable from Tripo — use a tunnel (ngrok or similar) and
  update the console's webhook URL to match while testing.
- `TRIPO_API_KEY` — from the same console.
- `TRIPO_MODEL_VERSION` — optional, defaults to `v2.5-20250123` in code (see
  `lib/tripo.ts`) if unset.

`glb_url`/`usdz_url` on a `ready` model store the bare R2 **key** (e.g.
`models/<id>.glb`), not a full URL — `lib/models.ts`'s `buildModelUrl()`
joins that key onto `NEXT_PUBLIC_MODELS_CDN_URL` at render time (falling
back to the `/api/models` proxy route when that env var is unset, e.g. a
fresh local checkout with no CDN configured yet). The var itself is live in
production (see the R2 setup section below), so this is the real path
`<model-viewer>`'s `src`/`ios-src` resolve through today, not a
Phase-4-pending placeholder.

Endpoint/field names and the webhook signature scheme in `lib/tripo.ts` are
sourced from Tripo's V3 OpenAPI spec as reconstructed by
[github.com/tryAGI/Tripo](https://github.com/tryAGI/Tripo) (a third-party SDK
— Tripo doesn't publish a public machine-readable schema) and cross-checked
against its webhook-signature source. Not independently verified against a
live Tripo account — confirm against a real task/webhook delivery before
relying on this in production.

## R2 setup (custom domain for model files)

> **Status: live in production.** `NEXT_PUBLIC_MODELS_CDN_URL` is set in Vercel
> (Production + Preview) and the `models` bucket has a custom domain bound —
> Phase 4 (AR viewer) is unblocked, `<model-viewer>`'s `src`/`ios-src` resolve
> through it today (see `buildModelUrl()` above). `.env.local` leaves the var
> unset by design: local dev falls back to the `/api/models` proxy route
> instead of needing every contributor to own a Cloudflare-zoned domain just
> to run the app. The steps below are for
> setting up a **new** environment (a fork, a second Cloudflare account,
> etc.) from scratch — do not redo them against the existing production
> domain, and do not point anything at the bucket's `*.r2.dev` public
> development URL even temporarily: rule 4 exists because `r2.dev` is
> rate-limited, and code that reads from it in dev tends to survive into
> production.

Constraint: generated `.glb`/`.usdz` files must never be served from the `*.r2.dev` domain in
production (it's rate-limited) — they're served from `NEXT_PUBLIC_MODELS_CDN_URL`
(e.g. `cdn.yourdomain.com`) instead. To connect it:

1. Your domain's DNS zone must be on Cloudflare (same account as the R2 bucket). If it isn't
   already, add it via Cloudflare's **partial (CNAME) setup** — this only needs the one
   subdomain you're using for the CDN, not a full nameserver migration of the whole domain.
2. Cloudflare dashboard → **R2 object storage** → the `models` bucket → **Settings** →
   **Custom Domains** → **Add**.
3. Enter the subdomain (e.g. `cdn.yourdomain.com`) → **Continue**. Cloudflare shows the exact
   DNS record it's about to create — **you do not create this record by hand**, it's
   auto-added to the zone since the zone is already on Cloudflare.
4. **Connect Domain**. Status shows "Initializing" then flips to "Active" within a few
   minutes (refresh the page to see it update).
5. Set `NEXT_PUBLIC_MODELS_CDN_URL=https://cdn.yourdomain.com` in `.env.local` / Vercel env vars.

Do this early — DNS/SSL provisioning has a few minutes of lag, and Phase 2's upload code
assumes the domain is already live.

(Source: [Cloudflare R2 public buckets docs](https://developers.cloudflare.com/r2/buckets/public-buckets/), verified 2026-08-18.)

## Scripts

```bash
npm run dev      # start dev server
npm run build    # production build
npm run start    # run the production build
npm run lint     # eslint .
```
