import "server-only";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createAdminClient } from "@/lib/supabase/admin";
import { getR2Client, getUploadsBucket } from "@/lib/r2";
import { submitImageToModelTask, submitMultiviewToModelTask, DEFAULT_FACE_LIMIT } from "@/lib/tripo";
import { submitFalImageToModelTask } from "@/lib/fal";

const SOURCE_URL_EXPIRY_SECONDS = 10 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

export interface SourceImageKeys {
  front: string;
  left?: string | null;
  back?: string | null;
  right?: string | null;
}

async function presignSourceUrl(key: string): Promise<string> {
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: getUploadsBucket(), Key: key }),
    { expiresIn: SOURCE_URL_EXPIRY_SECONDS },
  );
}

/**
 * Decides single-photo vs. multiview submission from which keys are present,
 * and does the R2 presigning either way. The one place that decision gets
 * made — shared by the initial submission below AND both webhook-side
 * resubmission paths (the size-budget retry and the QA regen retry in
 * app/api/webhooks/tripo/route.ts), so a model created with side/back photos
 * keeps using multiview_to_model on every retry too, not just its first
 * attempt.
 */
export async function submitTripoTaskForKeys(
  keys: SourceImageKeys,
  faceLimit: number = DEFAULT_FACE_LIMIT,
): Promise<{ taskId: string }> {
  const hasExtra = Boolean(keys.left || keys.back || keys.right);
  if (!hasExtra) {
    const frontUrl = await presignSourceUrl(keys.front);
    return submitImageToModelTask(frontUrl, faceLimit);
  }

  const [front, left, back, right] = await Promise.all([
    presignSourceUrl(keys.front),
    keys.left ? presignSourceUrl(keys.left) : Promise.resolve(undefined),
    keys.back ? presignSourceUrl(keys.back) : Promise.resolve(undefined),
    keys.right ? presignSourceUrl(keys.right) : Promise.resolve(undefined),
  ]);
  return submitMultiviewToModelTask({ front, left, back, right }, faceLimit);
}

/**
 * fal's trellis-2 endpoint has no multiview input — only ever called for the
 * single-photo (front-only) case; submitGeneration below never routes a
 * multiview job here regardless of GENERATION_PROVIDER. `faceLimit` isn't
 * accepted (fal has no equivalent param wired up yet, see lib/fal.ts) — kept
 * as an unused parameter only so call sites that resubmit at a smaller
 * budget (app/api/webhooks/tripo/route.ts's USDZ size-retry) can treat this
 * and submitTripoTaskForKeys as interchangeable.
 */
export async function submitFalTaskForKeys(
  keys: SourceImageKeys,
  _faceLimit: number = DEFAULT_FACE_LIMIT,
): Promise<{ taskId: string }> {
  const frontUrl = await presignSourceUrl(keys.front);
  return submitFalImageToModelTask(frontUrl);
}

export type GenerationProvider = "tripo" | "fal";

/**
 * GENERATION_PROVIDER picks the provider for new single-photo generations
 * (multiview always stays on Tripo — see submitFalTaskForKeys). Unset or
 * unrecognized values fail safe toward "tripo", the longer-proven path.
 */
export function getGenerationProvider(): GenerationProvider {
  return process.env.GENERATION_PROVIDER === "fal" ? "fal" : "tripo";
}

export interface SubmitGenerationInput {
  sourceImageKey: unknown;
  idempotencyKey: unknown;
  sourceImageWidth: unknown;
  sourceImageHeight: unknown;
  /** Optional extra angles (multi-view) — all three are best-effort additions to sourceImageKey ("front"), never required. */
  sourceImageKeyLeft?: unknown;
  sourceImageKeyBack?: unknown;
  sourceImageKeyRight?: unknown;
}

/**
 * consume_credit(uid) (migration 0001) checks `uid = auth.uid()` internally
 * and is granted only to `authenticated` — right for the cookie-based web
 * app (a real Supabase JWT), wrong for a token-authed extension request
 * (no JWT, so auth.uid() is null and the check would always fail).
 * consume_credit_service(uid) (migration 0019) is the service_role-only
 * twin with no auth.uid() check, for callers whose identity was already
 * verified a different way (lib/apiToken.ts's resolveApiToken). Each route
 * passes the RPC call appropriate to how IT authenticated its own caller —
 * this function doesn't choose, it just runs whichever one it's given.
 */
export type ConsumeCredit = () => Promise<{ consumed: boolean } | { error: true }>;

export type SubmitGenerationResult =
  | { ok: true; modelId: string }
  | { ok: false; status: number; error: string };

/**
 * Shared by app/api/generate/route.ts (cookie-authed) and
 * app/api/extension/generate/route.ts (token-authed) — the entire pipeline
 * from CLAUDE.md rule 12 (deduct credit -> insert pending row -> submit to
 * Tripo -> return immediately) lives here exactly once so rule 16-19's
 * idempotency/atomic-credit/refund-on-failure guarantees can't drift
 * between the two entry points. Callers must resolve and independently
 * verify `userId` themselves first (rule 30) — this function trusts it.
 *
 * Uses the admin client throughout (not a cookie-scoped one) because a
 * token-authed caller has no Supabase session/JWT for RLS to key off of —
 * every query below is explicitly scoped to `userId` in the WHERE clause
 * instead, which is what actually enforces ownership here.
 */
export async function submitGeneration(
  userId: string,
  input: SubmitGenerationInput,
  consumeCredit: ConsumeCredit,
): Promise<SubmitGenerationResult> {
  const {
    sourceImageKey,
    idempotencyKey,
    sourceImageWidth,
    sourceImageHeight,
    sourceImageKeyLeft,
    sourceImageKeyBack,
    sourceImageKeyRight,
  } = input;

  const validDimension = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  const imageWidth = validDimension(sourceImageWidth);
  const imageHeight = validDimension(sourceImageHeight);

  // Must be a key this user could only have gotten via presignUpload,
  // which always derives it as uploads/{userId}/{uuid}.ext (never
  // client-supplied) — re-checking the prefix here stops a caller from
  // pointing generation at another user's uploaded photo by guessing/
  // reusing a key that isn't theirs.
  if (typeof sourceImageKey !== "string" || !sourceImageKey.startsWith(`uploads/${userId}/`)) {
    return { ok: false, status: 400, error: "sourceImageKey буруу эсвэл дутуу байна" };
  }

  // Same ownership check as the required front key above, applied to each
  // optional extra angle — undefined/null is fine (that slot just isn't
  // used), but a present-and-wrong value is rejected the same way a forged
  // front key would be, not silently dropped.
  const validExtraKey = (value: unknown, label: string): { ok: true; key: string | null } | { ok: false; error: string } => {
    if (value === undefined || value === null) return { ok: true, key: null };
    if (typeof value !== "string" || !value.startsWith(`uploads/${userId}/`)) {
      return { ok: false, error: `${label} буруу байна` };
    }
    return { ok: true, key: value };
  };
  const leftResult = validExtraKey(sourceImageKeyLeft, "sourceImageKeyLeft");
  if (!leftResult.ok) return { ok: false, status: 400, error: leftResult.error };
  const backResult = validExtraKey(sourceImageKeyBack, "sourceImageKeyBack");
  if (!backResult.ok) return { ok: false, status: 400, error: backResult.error };
  const rightResult = validExtraKey(sourceImageKeyRight, "sourceImageKeyRight");
  if (!rightResult.ok) return { ok: false, status: 400, error: rightResult.error };

  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) {
    return { ok: false, status: 400, error: "idempotencyKey буруу эсвэл дутуу байна (UUID байх ёстой)" };
  }

  const admin = createAdminClient();

  // Fast path: a retry of the same attempt (lost response, double-click)
  // resends this exact key. If we already have a row for it, this IS that
  // attempt succeeding — return it as-is, no credit touched, no error.
  const { data: existing } = await admin
    .from("models")
    .select("id")
    .eq("user_id", userId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existing) {
    return { ok: true, modelId: existing.id };
  }

  const creditResult = await consumeCredit();
  if ("error" in creditResult) {
    return { ok: false, status: 500, error: "Кредитийн үлдэгдэл шалгахад алдаа гарлаа" };
  }
  if (!creditResult.consumed) {
    return { ok: false, status: 402, error: "Кредит хүрэлцэхгүй байна" };
  }

  // Multiview (left/back/right present) always stays on Tripo — fal's
  // trellis-2 endpoint has no multiview input (see submitFalTaskForKeys).
  const hasExtraAngles = Boolean(leftResult.key || backResult.key || rightResult.key);
  const provider: GenerationProvider = hasExtraAngles ? "tripo" : getGenerationProvider();

  const { data: model, error: insertError } = await admin
    .from("models")
    .insert({
      user_id: userId,
      source_image_key: sourceImageKey,
      source_image_key_left: leftResult.key,
      source_image_key_back: backResult.key,
      source_image_key_right: rightResult.key,
      status: "pending",
      provider,
      idempotency_key: idempotencyKey,
      source_image_width: imageWidth,
      source_image_height: imageHeight,
    })
    .select("id")
    .single();

  if (insertError || !model) {
    // No models row exists yet, so refund_credit (which keys off a model
    // row) can't be used — increment_credit_service (migration 0020) is an
    // atomic UPDATE instead of read-then-write, since this now runs from
    // two concurrent entry points (web app + extension).
    if (insertError?.code === UNIQUE_VIOLATION) {
      await admin.rpc("increment_credit_service", { uid: userId });
      const { data: winner } = await admin
        .from("models")
        .select("id")
        .eq("user_id", userId)
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (winner) {
        return { ok: true, modelId: winner.id };
      }
    } else {
      await admin.rpc("increment_credit_service", { uid: userId });
    }
    return { ok: false, status: 500, error: "Model үүсгэхэд алдаа гарлаа" };
  }

  try {
    const keys: SourceImageKeys = {
      front: sourceImageKey,
      left: leftResult.key,
      back: backResult.key,
      right: rightResult.key,
    };
    const { taskId } = provider === "fal" ? await submitFalTaskForKeys(keys) : await submitTripoTaskForKeys(keys);
    await admin.from("models").update({ status: "processing", provider_job_id: taskId }).eq("id", model.id);
  } catch (err) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: err instanceof Error ? err.message : `${provider} submission failed`,
    });
    return { ok: false, status: 502, error: "Үүсгэлт эхлүүлэхэд алдаа гарлаа" };
  }

  return { ok: true, modelId: model.id };
}
