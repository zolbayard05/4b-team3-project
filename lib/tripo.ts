import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tripo API V3 client (image → 3D generation) and webhook verification.
 *
 * Field/endpoint names below are sourced from Tripo's V3 OpenAPI spec as
 * reconstructed at https://github.com/tryAGI/Tripo (a third-party SDK —
 * Tripo doesn't publish a public machine-readable schema, per that repo's
 * own spec header) and cross-checked against its webhook-signature source
 * and README. Confirmed, not guessed:
 *   - base URL, Bearer auth, POST /generation/image-to-model,
 *     POST /models/convert, response envelope { code, data }.
 *   - webhook signature scheme (Stripe-style t=/v1= HMAC-SHA256, see below).
 *   - there is NO per-request callback_url field anywhere in the spec — the
 *     webhook URL is configured out-of-band in the Tripo developer console.
 *     CLAUDE.md rule 12 describes "submit the job with a callback_url"; that
 *     doesn't match V3. Flagged to the user — the console-configured webhook
 *     is what actually delivers events here.
 * Not independently verified against a live account: the exact set of
 * `model` version strings still offered (TRIPO_MODEL_VERSION below is
 * configurable for exactly this reason) and real end-to-end payload
 * behavior. Confirm against a live task before relying on this in prod.
 */

const API_BASE = "https://openapi.tripo3d.ai/v3";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

function getApiKey(): string {
  return requiredEnv("TRIPO_API_KEY");
}

// v2.5-20250123 (the prior default here) is a V2-era model string that
// doesn't accept ANY of the H3-family quality parameters below — texture_
// quality, geometry_quality, face_limit, etc. are silently unreachable on
// that version. v3.1-20260211 is Tripo's current H3 endpoint (confirmed
// against docs.tripo3d.ai, not the third-party spec this file used to cite
// exclusively). Override via env if you deliberately want the legacy path.
function getModelVersion(): string {
  return process.env.TRIPO_MODEL_VERSION || "v3.1-20260211";
}

// Adaptive face_limit on a single-photo reconstruction produced ~13-14 MB of
// raw (pre-Draco) mesh data even at default quality — the dominant
// contributor to output size, well ahead of texture data (confirmed: a
// generation with ~350 KB of combined PBR textures still produced a 14 MB
// GLB). USDZ can't be Draco-compressed (KHR_draco_mesh_compression is a
// glTF-only extension; ARKit's format has no equivalent), so constraining
// geometry at generation time is the only lever that helps *that* file at
// all. 200k faces is generous for a single piece of furniture at AR viewing
// distance — this is a starting point to tune against real output (one
// chair measured at 7.34 MB USDZ, under target, but geometry complexity
// varies enormously by object type: a lattice/high-poly object could still
// exceed rule 21's 8 MB target at this same face_limit — see
// app/api/webhooks/tripo/route.ts's size-budget retry, which exists
// specifically because this number is still a guess, not measured across
// object types yet).
export const DEFAULT_FACE_LIMIT = 200_000;

// rule 21's target. Checked against the final USDZ specifically — the file
// that can't be Draco-compressed after the fact, so this is the only stage
// where "still too big" can still be fixed (by retrying at a lower
// face_limit), rather than merely observed.
export const TARGET_USDZ_BYTES = 8 * 1024 * 1024;

// Bounded to 1: a retry re-submits an entire new Tripo generation (another
// ~30-45 credits), not a cheap local re-process — must never spiral into
// unbounded cost chasing a target that a genuinely complex object (a dense
// lattice, foliage) may not be able to hit at any reasonable face_limit.
// Ship the result and log it past this point rather than retry forever.
export const MAX_SIZE_RETRIES = 1;

/**
 * face_limit for a given attempt index (0 = first attempt, 1 = first retry,
 * ...) — halved per retry. `models.size_retry_count` tracks how many
 * retries have already happened, which *is* the attempt index of the most
 * recently completed attempt (0 retries so far = attempt 0 just finished).
 */
export function faceLimitForAttempt(attemptIndex: number): number {
  return attemptIndex === 0 ? DEFAULT_FACE_LIMIT : Math.round(DEFAULT_FACE_LIMIT / 2 ** attemptIndex);
}

type TripoEnvelope<T> = { code: number; status?: string; data: T };

export type TripoTaskStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export interface TripoTaskOutput {
  model_url?: string;
  [key: string]: unknown;
}

export interface TripoTask {
  task_id: string;
  type?: string;
  status: TripoTaskStatus;
  output?: TripoTaskOutput;
  error_code?: number;
  error_message?: string;
}

async function tripoFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as TripoEnvelope<T> | null;

  if (!res.ok || !json || json.code !== 0) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`Tripo ${path} failed: ${detail}`);
  }

  return json.data;
}

/**
 * Submits the image-to-model task. `sourceImageUrl` is a short-lived
 * presigned GET URL for the photo in our private `uploads` bucket — Tripo
 * fetches it once at submission time, so the expiry only needs to outlive
 * network latency, not the generation itself (rule 6 is about long-lived
 * shared AR links on the *models* bucket; this is a one-shot ingestion
 * fetch on a different, private bucket — not the same concern).
 *
 * Request shape confirmed against docs.tripo3d.ai's image-to-model (H3)
 * reference: `type` + `file.url` + `model_version`, not the `{model, input}`
 * shape this used to send (which happened to still be accepted under a
 * legacy/back-compat path, but silently ignores every quality parameter
 * below — there is no `texture_quality`/`geometry_quality`/`face_limit` on
 * that path). face_limit is set explicitly (see DEFAULT_FACE_LIMIT) because
 * USDZ can't be Draco-compressed after the fact, so this is the only real
 * lever for keeping that file under rule 21's size target.
 *
 * texture_quality is left at "standard" (the default, so simply omitted).
 * This was decided three times — see CLAUDE.md's decision log (rule on
 * texture quality) for the full numbers and the general lesson (a fixed-
 * pixel blur radius silently misbehaving across texture resolutions) before
 * touching this again. geometry_quality is left at "standard" too — that
 * lever affects mesh fidelity, not the texture defect, and face_limit
 * already controls the geometry budget directly.
 */
export async function submitImageToModelTask(
  sourceImageUrl: string,
  faceLimit: number = DEFAULT_FACE_LIMIT,
): Promise<{ taskId: string }> {
  const data = await tripoFetch<{ task_id: string }>("/generation/image-to-model", {
    type: "image_to_model",
    file: { url: sourceImageUrl },
    model_version: getModelVersion(),
    face_limit: faceLimit,
  });
  return { taskId: data.task_id };
}

export interface MultiviewUrls {
  front: string;
  left?: string;
  back?: string;
  right?: string;
}

// Bounded to 1 for the same reason as MAX_SIZE_RETRIES: a retry is a whole
// new paid Tripo generation, not a cheap step. This one guards a *different*
// failure mode — validateGlb (lib/glbCompress.ts) rejecting the geometry
// itself as implausible, not an oversized file — but the cost argument is
// identical, so it gets its own bound rather than being folded into
// MAX_SIZE_RETRIES (the two loops are independent and can both fire on the
// same model: an aspect-ratio-implausible first attempt, a correctly-shaped
// but oversized second one, for instance).
export const MAX_REGEN_RETRIES = 1;

/**
 * Submits the multiview-to-model task — Tripo's H3 endpoint documented at
 * docs.tripo3d.ai/model-generation/multiview-to-model-v3-0-v3-1.html for
 * meaningfully better geometry on non-symmetric objects than a single photo
 * can ever resolve (the whole point: image_to_model only ever sees one side
 * of the object). `files` is fixed [front, left, back, right] order per that
 * doc; front is required, and Tripo's own docs say not to submit fewer than
 * 2 images total. Omitted slots are sent as `{}` (that doc: "you may omit
 * certain input files by omitting the file_token").
 *
 * UNVERIFIED: the exact endpoint path below (`/generation/multiview-to-model`)
 * is inferred by convention from image-to-model's already-confirmed path
 * (`/generation/image-to-model`) and this task's own docs-page slug
 * (`multiview-to-model-v3-0-v3-1.html`) — the docs site's own "Endpoint"
 * section renders via client-side JS that this environment's fetch tooling
 * couldn't execute, so unlike image-to-model's path, this one was never
 * directly confirmed against rendered doc text or a live call. tripoFetch
 * throws loudly on a non-2xx/non-code-0 response, so a wrong path fails
 * fast rather than silently — confirm against a real submission before
 * trusting this in prod, same caveat this file's header already carries for
 * TRIPO_MODEL_VERSION.
 */
export async function submitMultiviewToModelTask(
  urls: MultiviewUrls,
  faceLimit: number = DEFAULT_FACE_LIMIT,
): Promise<{ taskId: string }> {
  const toFile = (url: string | undefined) => (url ? { type: "url", url } : {});
  const data = await tripoFetch<{ task_id: string }>("/generation/multiview-to-model", {
    type: "multiview_to_model",
    files: [toFile(urls.front), toFile(urls.left), toFile(urls.back), toFile(urls.right)],
    model_version: getModelVersion(),
    face_limit: faceLimit,
  });
  return { taskId: data.task_id };
}

/**
 * Submits a format-conversion task to USDZ (rule 1: every model needs both
 * .glb and .usdz; neither Tripo's image-to-model task nor fal's trellis-2
 * endpoint produces USDZ directly — this is always a second, separate async
 * task).
 *
 * `input` accepts either a prior Tripo task_id (the original Tripo-sourced
 * flow) or a plain publicly-fetchable URL to a GLB — confirmed at
 * developers.tripo3d.ai/en/docs/models-convert ("input ... supports task_id
 * or file_token" plus a direct URL to GLB/GLTF/FBX/OBJ/STL, max 150MB). The
 * URL form is what lets a fal-generated GLB (lib/fal.ts) feed into this same
 * conversion task — app/api/webhooks/fal/route.ts uploads the GLB to our own
 * public `models` bucket first, then passes that URL here. Either way, the
 * resulting task_id lands on the existing app/api/webhooks/tripo/route.ts
 * webhook unchanged, matched via models.usdz_provider_job_id.
 */
export async function submitUsdzConversionTask(input: { taskId: string } | { url: string }): Promise<{ taskId: string }> {
  const data = await tripoFetch<{ task_id: string }>("/models/convert", {
    input: "taskId" in input ? input.taskId : input.url,
    format: "USDZ",
  });
  return { taskId: data.task_id };
}

/**
 * Verifies a Tripo webhook signature. Stripe-style scheme, confirmed from
 * the reference SDK's actual verifier source (github.com/tryAGI/Tripo):
 *   header: "Tripo-Webhook-Signature: t=<unix_seconds>,v1=<hex_hmac>[,v1=<hex_hmac>...]"
 *   signed message: `${t}.${rawBody}` (exact raw bytes, before JSON parsing)
 *   mac: HMAC-SHA256(key = secret string incl. its "whsec_" prefix, message)
 *   compare: constant-time, against every v1 value present (supports
 *            secret rotation — a valid match on ANY of them passes)
 *   replay window: reject if |now - t| exceeds toleranceSeconds
 */
export function verifyTripoWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;

  const signedAtMs = Number(timestamp) * 1000;
  if (Math.abs(Date.now() - signedAtMs) > toleranceSeconds * 1000) return false;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), bodyBuffer]);
  const expected = createHmac("sha256", secret).update(signedPayload).digest();

  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const actual = Buffer.from(sig, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export function getWebhookSecret(): string {
  return requiredEnv("TRIPO_WEBHOOK_SECRET");
}
