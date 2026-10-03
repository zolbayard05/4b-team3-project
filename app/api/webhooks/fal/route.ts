import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createAdminClient } from "@/lib/supabase/admin";
import { getR2Client, getModelsBucket, MODEL_CONTENT_TYPES, MODEL_CACHE_CONTROL } from "@/lib/r2";
import { verifyFalWebhookSignature, type FalWebhookPayload } from "@/lib/fal";
import { submitUsdzConversionTask } from "@/lib/tripo";
import { compressGlb, validateGlb } from "@/lib/glbCompress";
import { buildModelUrl } from "@/lib/models";
import { sweepStaleGenerations } from "@/lib/sweepStaleGenerations";

// Same reasoning as app/api/webhooks/tripo/route.ts: Draco compression +
// validation can run past the default 10s Vercel timeout. 60s is the
// Hobby-plan ceiling.
export const maxDuration = 60;

/**
 * GLB-only webhook for the fal.ai/trellis-2 provider (see lib/fal.ts). Only
 * ever handles the GLB stage — once uploaded here, USDZ conversion is
 * handed off to Tripo's /models/convert task (fed this upload's own public
 * URL rather than a Tripo task_id), and that task's completion lands back
 * on the existing app/api/webhooks/tripo/route.ts webhook unchanged, since
 * it's a genuine Tripo task either way (matched via usdz_provider_job_id,
 * which doesn't care what generated the GLB).
 *
 * Deliberately simpler than the Tripo webhook: no QA regen-retry on a
 * validateGlb failure (just refund) — fal jobs are cheap enough, and this
 * provider new enough, that adding that complexity isn't justified without
 * real failure-rate data yet. CLAUDE.md rule 13's ordering (verify
 * signature -> download+reupload to R2 -> only then advance the DB row)
 * and rule 16 (idempotent on state transition, not receipt) both apply here
 * exactly as they do for Tripo.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = await verifyFalWebhookSignature(rawBody, {
    requestId: request.headers.get("x-fal-webhook-request-id"),
    userId: request.headers.get("x-fal-webhook-user-id"),
    timestamp: request.headers.get("x-fal-webhook-timestamp"),
    signature: request.headers.get("x-fal-webhook-signature"),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Same opportunistic-sweep pattern as the Tripo webhook — piggybacks
  // recovery of any OTHER stuck model onto real traffic on this endpoint
  // too, independent of this request's own payload.
  try {
    await sweepStaleGenerations();
  } catch (err) {
    console.warn("fal webhook: opportunistic stale-generation sweep failed", err);
  }

  let body: FalWebhookPayload;
  try {
    body = JSON.parse(rawBody) as FalWebhookPayload;
    if (!body?.request_id || !body.status) throw new Error("missing request_id/status");
  } catch {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: model } = await admin
    .from("models")
    .select("*")
    .eq("provider_job_id", body.request_id)
    .eq("provider", "fal")
    .maybeSingle();

  if (!model) {
    // Unrecognized request_id — ack anyway, same rationale as the Tripo
    // webhook: a non-200 only makes fal retry a delivery that will never
    // resolve to anything (stale env, a different project, etc).
    console.warn(`fal webhook: no model matches request_id=${body.request_id}`);
    return NextResponse.json({ ok: true });
  }

  // Idempotency guard — our own row is the source of truth on "already
  // acted on", not receipt of this event (rule 16).
  if (model.status === "ready" || model.status === "failed" || model.glb_url !== null) {
    return NextResponse.json({ ok: true, note: "already processed" });
  }

  if (body.status === "ERROR") {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: body.error || "fal trellis-2 task failed",
    });
    return NextResponse.json({ ok: true });
  }

  if (body.status !== "OK") {
    return NextResponse.json({ ok: true, note: `no-op for status=${body.status}` });
  }

  const modelGlbUrl = body.payload?.model_glb?.url;
  if (!modelGlbUrl) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: "fal trellis-2 task reported OK with no payload.model_glb.url",
    });
    return NextResponse.json({ ok: true });
  }

  const fileRes = await fetch(modelGlbUrl);
  if (!fileRes.ok) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: `Failed to download fal GLB output: HTTP ${fileRes.status}`,
    });
    return NextResponse.json({ ok: true });
  }
  let fileBytes = Buffer.from(await fileRes.arrayBuffer());

  // Rule 21: same Draco-compress + texture cap as the Tripo GLB stage.
  // Compression failure falls back to the uncompressed file rather than
  // losing the generation entirely.
  let bbox: { width: number; depth: number; height: number } | undefined;
  try {
    const result = await compressGlb(fileBytes);
    fileBytes = Buffer.from(result.glb);
    bbox = result.bbox;
    if (result.seamGap) {
      console.info(
        `fal webhook: model ${model.id} seam luminance gap (P99, low-freq layer) ${result.seamGap.before.toFixed(1)} -> ${result.seamGap.after.toFixed(1)}`,
      );
    }
  } catch (err) {
    console.warn(`fal webhook: GLB compression failed for model ${model.id}, storing uncompressed`, err);
  }

  const validation = await validateGlb(fileBytes);
  if (validation.aspectRatio !== undefined) {
    console.info(
      `fal webhook: model ${model.id} GLB aspect ratio ${validation.aspectRatio.toFixed(2)}:1 (${validation.valid ? "passed" : "REJECTED"})`,
    );
  }
  if (!validation.valid) {
    console.warn(`fal webhook: model ${model.id} failed GLB validation: ${validation.reason}`);
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: `Model failed validation: ${validation.reason}`,
    });
    return NextResponse.json({ ok: true, note: "failed validation" });
  }

  // Same bare-R2-key storage rationale as the Tripo webhook (no
  // NEXT_PUBLIC_MODELS_CDN_URL in production yet — see README Phase 4).
  const key = `models/${model.id}.glb`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getModelsBucket(),
      Key: key,
      Body: fileBytes,
      ContentType: MODEL_CONTENT_TYPES.glb,
      CacheControl: MODEL_CACHE_CONTROL,
    }),
  );

  // Permanent, never-overwritten original — same rationale as the Tripo
  // webhook's models/{id}.raw.glb: any future rescale bakes FROM this fixed
  // reference, never from a previously-baked glb_url.
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getModelsBucket(),
      Key: `models/${model.id}.raw.glb`,
      Body: fileBytes,
      ContentType: MODEL_CONTENT_TYPES.glb,
      CacheControl: MODEL_CACHE_CONTROL,
    }),
  );

  const { data: updated } = await admin
    .from("models")
    .update({
      glb_url: key,
      ...(bbox && { bbox_width_m: bbox.width, bbox_depth_m: bbox.depth, bbox_height_m: bbox.height }),
    })
    .eq("id", model.id)
    .is("glb_url", null)
    .neq("status", "failed")
    .select("id");

  if (!updated || updated.length === 0) {
    // Lost the race to a concurrent duplicate delivery already driving this.
    return NextResponse.json({ ok: true, note: "concurrent delivery already handled" });
  }

  // Tripo needs a URL it can fetch over the public internet — buildModelUrl
  // returns a path relative to this app's own origin when no CDN domain is
  // configured yet (the common case right now, see README Phase 4), so it
  // has to be made absolute with NEXT_PUBLIC_APP_URL here specifically
  // (unlike client-side uses of buildModelUrl, which rely on the browser
  // resolving a relative URL against the current page).
  const relativeOrAbsolute = buildModelUrl(key);
  const publicGlbUrl = /^https?:\/\//.test(relativeOrAbsolute)
    ? relativeOrAbsolute
    : `${(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")}${relativeOrAbsolute}`;

  try {
    const { taskId: usdzTaskId } = await submitUsdzConversionTask({ url: publicGlbUrl });
    await admin.from("models").update({ usdz_provider_job_id: usdzTaskId }).eq("id", model.id);
  } catch (err) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: err instanceof Error ? err.message : "Failed to start USDZ conversion",
    });
  }

  return NextResponse.json({ ok: true });
}
