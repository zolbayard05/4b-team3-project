import "server-only";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * fal.ai queue client (image → 3D via fal-ai/trellis-2) and webhook
 * signature verification.
 *
 * Chosen over Tripo as the primary GLB-generation provider for single-photo
 * jobs (see lib/generateModel.ts) because it runs Microsoft's open-weight
 * TRELLIS.2 model (MIT-licensed, no per-account-tier commercial restriction
 * unlike Hunyuan3D) as a hosted, pay-per-call endpoint — same reliability
 * profile as Tripo (no self-hosted GPU/uptime to manage) at lower cost and,
 * per published benchmarks, meaningfully higher image-to-3D fidelity.
 *
 * fal only ever produces a .glb (no USDZ output on any fal 3D endpoint) —
 * rule 1 still requires both formats, so the USDZ side of the pipeline stays
 * on Tripo's /models/convert task (lib/tripo.ts submitUsdzConversionTask),
 * now fed a public URL to our own uploaded GLB instead of a Tripo task_id.
 * app/api/webhooks/fal/route.ts only ever handles the GLB stage; the USDZ
 * stage it kicks off lands back on the existing app/api/webhooks/tripo/
 * route.ts unchanged, since that's a genuine Tripo task either way.
 *
 * Confirmed against fal's own docs (docs.fal.ai): queue submission endpoint
 * + fal_webhook query param, Authorization: Key <FAL_API_KEY>, trellis-2's
 * `image_url` input field, the webhook payload envelope
 * ({request_id, status, payload, error}), and the ED25519/JWKS webhook
 * signature scheme. NOT independently verified against a live account:
 * trellis-2's exact optional-parameter defaults (resolution/texture_size/
 * decimation_target) — left unset below to take fal's own defaults rather
 * than guessing values tuned for a different provider's face_limit.
 */

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_TRELLIS_ENDPOINT = "fal-ai/trellis-2";
const JWKS_URL = "https://rest.fal.ai/.well-known/jwks.json";
const JWKS_CACHE_MS = 24 * 60 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

function getApiKey(): string {
  return requiredEnv("FAL_API_KEY");
}

function getWebhookUrl(): string {
  const appUrl = requiredEnv("NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
  return `${appUrl}/api/webhooks/fal`;
}

interface FalSubmitResponse {
  request_id: string;
}

/**
 * Submits the image-to-3D job. `sourceImageUrl` is a short-lived presigned
 * GET URL for the photo in our private `uploads` bucket — same pattern and
 * same rationale as lib/tripo.ts's submitImageToModelTask (fal fetches it
 * once at submission time; expiry only needs to outlive network latency).
 *
 * Unlike Tripo, fal has no per-request model-version string and no
 * multiview endpoint on trellis-2 — multiview-angle jobs stay on Tripo
 * regardless of GENERATION_PROVIDER (see lib/generateModel.ts).
 */
export async function submitFalImageToModelTask(sourceImageUrl: string): Promise<{ taskId: string }> {
  const url = `${FAL_QUEUE_BASE}/${FAL_TRELLIS_ENDPOINT}?fal_webhook=${encodeURIComponent(getWebhookUrl())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Key ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: sourceImageUrl }),
  });

  const json = (await res.json().catch(() => null)) as FalSubmitResponse | null;
  if (!res.ok || !json?.request_id) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`fal ${FAL_TRELLIS_ENDPOINT} submission failed: ${detail}`);
  }

  return { taskId: json.request_id };
}

export interface FalWebhookPayload {
  request_id: string;
  gateway_request_id?: string;
  status: "OK" | "ERROR";
  payload?: { model_glb?: { url?: string }; [key: string]: unknown };
  error?: string;
}

interface Jwk {
  x: string;
  [key: string]: unknown;
}

let cachedJwks: { keys: Jwk[]; fetchedAt: number } | undefined;

async function getJwks(forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh && cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_MS) {
    return cachedJwks.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`fal JWKS fetch failed: HTTP ${res.status}`);
  const json = (await res.json()) as { keys: Jwk[] };
  cachedJwks = { keys: json.keys, fetchedAt: Date.now() };
  return json.keys;
}

/**
 * Verifies a fal.ai webhook signature.
 *
 * Scheme (per docs.fal.ai/model-apis/model-endpoints/webhooks, ED25519 +
 * JWKS — deliberately different from Tripo's HMAC scheme, so this is its
 * own function rather than a shared one):
 *   headers: X-Fal-Webhook-Request-Id, X-Fal-Webhook-User-Id,
 *            X-Fal-Webhook-Timestamp (unix seconds),
 *            X-Fal-Webhook-Signature (hex)
 *   message: `${requestId}\n${userId}\n${timestamp}\n${sha256(rawBody).hex}`
 *   key: ED25519 public key, base64url `x` field from the JWKS endpoint,
 *        tried against every key currently cached — a match on ANY passes
 *        (supports key rotation, same reasoning as Tripo's multi-v1 scheme)
 *   replay window: reject if |now - timestamp| exceeds toleranceSeconds
 *
 * If no cached key matches, refetches the JWKS once (keys rotate) before
 * giving up — mirrors the behavior documented at docs.fal.ai.
 */
export async function verifyFalWebhookSignature(
  rawBody: Buffer | string,
  headers: { requestId: string | null; userId: string | null; timestamp: string | null; signature: string | null },
  toleranceSeconds = 300,
): Promise<boolean> {
  const { requestId, userId, timestamp, signature } = headers;
  if (!requestId || !userId || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (!/^[0-9a-f]+$/i.test(signature)) return false;

  const signedAtMs = Number(timestamp) * 1000;
  if (Math.abs(Date.now() - signedAtMs) > toleranceSeconds * 1000) return false;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const bodyHashHex = createHash("sha256").update(bodyBuffer).digest("hex");
  const message = Buffer.from(`${requestId}\n${userId}\n${timestamp}\n${bodyHashHex}`, "utf8");
  const signatureBytes = Buffer.from(signature, "hex");

  const tryKeys = async (keys: Jwk[]): Promise<boolean> => {
    for (const jwk of keys) {
      try {
        const publicKey = createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
          format: "jwk",
        });
        if (cryptoVerify(null, message, publicKey, signatureBytes)) return true;
      } catch {
        // Malformed/incompatible key entry — try the next one.
      }
    }
    return false;
  };

  if (await tryKeys(await getJwks())) return true;
  // Keys may have rotated since our cache was populated — refetch once.
  return tryKeys(await getJwks(true));
}
