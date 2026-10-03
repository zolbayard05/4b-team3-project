import { randomUUID } from "node:crypto";
import { NextResponse, after } from "next/server";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createAdminClient } from "@/lib/supabase/admin";
import { getR2Client, getModelsBucket, getUploadsBucket, MODEL_CONTENT_TYPES, MODEL_CACHE_CONTROL } from "@/lib/r2";
import {
  verifyTripoWebhookSignature,
  getWebhookSecret,
  submitUsdzConversionTask,
  faceLimitForAttempt,
  TARGET_USDZ_BYTES,
  MAX_SIZE_RETRIES,
  MAX_REGEN_RETRIES,
  type TripoTask,
} from "@/lib/tripo";
import { submitTripoTaskForKeys, submitFalTaskForKeys } from "@/lib/generateModel";
import { compressGlb, validateGlb } from "@/lib/glbCompress";
import { bakeGlbScale } from "@/lib/glbScale";
import { bakeUsdzScale } from "@/lib/usdzScale";
import { renderThumbnail } from "@/lib/renderThumbnail";
import { guessModelHeightCm } from "@/lib/gemini";
import { sweepStaleGenerations } from "@/lib/sweepStaleGenerations";

// Default Vercel function timeout (10s) isn't enough headroom once this
// handler launches headless Chromium for lib/renderThumbnail.ts on top of
// everything else it already does (download, Draco compress, frequency
// separation, validate). 60s is the Hobby-plan ceiling — the safe universal
// max without assuming a Pro/Enterprise plan that could go higher.
export const maxDuration = 60;

type Stage = "glb" | "usdz";

/**
 * Tripo delivers two independent completion events per model here (see
 * lib/tripo.ts): the image-to-model task (produces GLB) and, kicked off
 * from this handler once that succeeds, a convert-to-USDZ task. Both land
 * on this one endpoint; `provider_job_id` / `usdz_provider_job_id` on the
 * models row is how an incoming task_id gets matched back to a stage.
 *
 * CLAUDE.md rule 13's ordering is load-bearing: verify signature, THEN
 * download+re-upload the provider's files to R2, and ONLY THEN flip the DB
 * row toward ready — marking ready before the files actually exist in R2
 * means a client's <model-viewer> 404s.
 *
 * Rule 16: idempotent on the state transition, not on receipt. Every write
 * below is guarded so a duplicate delivery (Tripo retries) is a no-op, never
 * a second refund or a second R2 write racing a first.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("tripo-webhook-signature");

  if (!verifyTripoWebhookSignature(rawBody, signature, getWebhookSecret())) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Piggybacks recovery of any OTHER stuck model onto real webhook traffic —
  // see lib/sweepStaleGenerations.ts for why this runs here (works on every
  // Vercel plan tier, no cron infrastructure needed) as well as from a
  // once-daily cron backstop. Independent of this request's own payload, so
  // a failure here must never block processing the actual delivery below.
  try {
    await sweepStaleGenerations();
  } catch (err) {
    console.warn("Tripo webhook: opportunistic stale-generation sweep failed", err);
  }

  let task: TripoTask;
  try {
    const parsed = JSON.parse(rawBody) as { data?: TripoTask; type?: string };

    // Tripo posts every account-level event type to this same webhook URL,
    // not just task completions (observed live: "balance.low", whose data
    // has a task_id — coincidentally the id of an in-flight task — but no
    // status). Only a task-status event has `data.status`; anything else is
    // a real, expected delivery we don't act on. Same rationale as the
    // unmatched-task_id branch below: ack 200, don't 400, or Tripo retries
    // a delivery that will never resolve to anything.
    if (!parsed?.data?.status) {
      console.info(`Tripo webhook: ignoring non-task-status event type=${parsed?.type ?? "unknown"}`);
      return NextResponse.json({ ok: true, note: `ignored event type=${parsed?.type ?? "unknown"}` });
    }
    if (!parsed.data.task_id) throw new Error("missing data.task_id");
    task = parsed.data;
  } catch {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  const admin = createAdminClient();

  const [glbMatch, usdzMatch] = await Promise.all([
    admin.from("models").select("*").eq("provider_job_id", task.task_id).maybeSingle(),
    admin.from("models").select("*").eq("usdz_provider_job_id", task.task_id).maybeSingle(),
  ]);

  const stage: Stage | null = glbMatch.data ? "glb" : usdzMatch.data ? "usdz" : null;
  const model = glbMatch.data ?? usdzMatch.data;

  if (!stage || !model) {
    // Unrecognized task_id — not a model we know about (stale env, a task
    // from a different project, etc). Ack anyway: returning non-200 only
    // makes Tripo retry a delivery that will never resolve to anything.
    console.warn(`Tripo webhook: no model matches task_id=${task.task_id}`);
    return NextResponse.json({ ok: true });
  }

  // Idempotency guard — the actual source of truth. task.status is trusted
  // provider input, but "have we already acted on this stage" is ours to
  // decide from our own row, not from receiving an event.
  if (stage === "glb" && (model.status === "ready" || model.status === "failed" || model.glb_url !== null)) {
    return NextResponse.json({ ok: true, note: "already processed" });
  }
  if (stage === "usdz" && (model.status === "ready" || model.status === "failed" || model.usdz_url !== null)) {
    return NextResponse.json({ ok: true, note: "already processed" });
  }

  if (task.status === "failed" || task.status === "cancelled") {
    // A USDZ-stage failure means the model has a GLB but not a USDZ — rule 1
    // requires both, so this is not a partial success; treat it the same as
    // a GLB-stage failure and refund. refund_credit's own WHERE clause
    // (status <> 'failed') makes this idempotent against a duplicate
    // delivery of the same failure event.
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: task.error_message || `Tripo ${stage} task ${task.status}`,
    });
    return NextResponse.json({ ok: true });
  }

  if (task.status !== "success") {
    // Terminal-only delivery is documented Tripo behavior, so a
    // queued/running event landing here would be unexpected — ack without
    // acting rather than erroring, since there's nothing wrong to report.
    return NextResponse.json({ ok: true, note: `no-op for status=${task.status}` });
  }

  const modelUrl = task.output?.model_url;
  if (!modelUrl) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: `Tripo ${stage} task reported success with no output.model_url`,
    });
    return NextResponse.json({ ok: true });
  }

  const fileRes = await fetch(modelUrl);
  if (!fileRes.ok) {
    await admin.rpc("refund_credit", {
      model_id: model.id,
      failure_reason: `Failed to download Tripo ${stage} output: HTTP ${fileRes.status}`,
    });
    return NextResponse.json({ ok: true });
  }
  let fileBytes = Buffer.from(await fileRes.arrayBuffer());

  // Rule 21: Draco-compress + cap textures at 2K on the GLB specifically.
  // Not applicable to USDZ — KHR_draco_mesh_compression is a glTF-only
  // extension, ARKit's format has no equivalent (see lib/glbCompress.ts).
  // Compression failure shouldn't lose the generation entirely: fall back to
  // the uncompressed file rather than refunding over a post-process step.
  let bbox: { width: number; depth: number; height: number } | undefined;
  if (stage === "glb") {
    try {
      const result = await compressGlb(fileBytes);
      fileBytes = Buffer.from(result.glb);
      bbox = result.bbox;
      if (result.seamGap) {
        // Visibility into the frequency-separation quality pass itself, not
        // just whether it ran: if this technique quietly stops helping on
        // some object/material type, this is where that shows up in data
        // rather than being discovered by a user first.
        console.info(
          `Tripo webhook: model ${model.id} seam luminance gap (P99, low-freq layer) ${result.seamGap.before.toFixed(1)} -> ${result.seamGap.after.toFixed(1)}`,
        );
      }
    } catch (err) {
      console.warn(
        `Tripo webhook: GLB compression failed for model ${model.id}, storing uncompressed`,
        err,
      );
    }

    // Gate before anything is uploaded or the USDZ conversion (another paid
    // Tripo task) is even kicked off: a model that can't parse, has no real
    // geometry, or has implausible proportions shouldn't reach a user as
    // "ready" and shouldn't cost a credit — see lib/glbCompress.ts's
    // validateGlb. Runs on `fileBytes` as it stands right now (compressed,
    // or the raw fallback above if compression itself failed) — whichever
    // one we'd actually be shipping.
    const validation = await validateGlb(fileBytes);

    // Logged unconditionally, pass or fail — MAX_ASPECT_RATIO in
    // lib/glbCompress.ts is currently sized to catch one sample (the
    // "512x512" placeholder case). This is the data that turns it into a
    // measured threshold instead of a guess: without the passing values too,
    // there's no distribution to compare a rejection against, only the one
    // failure that prompted picking 10 in the first place.
    if (validation.aspectRatio !== undefined) {
      console.info(
        `Tripo webhook: model ${model.id} GLB aspect ratio ${validation.aspectRatio.toFixed(2)}:1 (${validation.valid ? "passed" : "REJECTED"})`,
      );
    }

    if (!validation.valid) {
      console.warn(`Tripo webhook: model ${model.id} failed GLB validation: ${validation.reason}`);

      // QA regen retry: validateGlb rejected the geometry itself (bad aspect
      // ratio, no geometry, degenerate bounds) — unlike the size-budget retry
      // below, nothing about the *request* was wrong, so resubmit the exact
      // same inputs at the same face_limit and hope the generative model's
      // own run-to-run variance produces something usable. This is the
      // closest thing to Vertebrae/VNTANA's human cleanup pass that an
      // automated pipeline with no mesh-repair tooling can actually do —
      // detect-and-regenerate, not detect-and-fix. Bounded to
      // MAX_REGEN_RETRIES for the same reason as MAX_SIZE_RETRIES: a full
      // paid Tripo generation per attempt.
      if (model.regen_retry_count < MAX_REGEN_RETRIES) {
        const nextRegenAttempt = model.regen_retry_count + 1;
        console.warn(
          `Tripo webhook: model ${model.id} retrying generation from scratch (QA regen attempt ${nextRegenAttempt}) after failed validation`,
        );
        try {
          const { taskId: newTaskId } = await submitTripoTaskForKeys(
            {
              front: model.source_image_key,
              left: model.source_image_key_left,
              back: model.source_image_key_back,
              right: model.source_image_key_right,
            },
            faceLimitForAttempt(model.size_retry_count),
          );
          const { data: updated } = await admin
            .from("models")
            .update({
              status: "processing",
              glb_url: null,
              usdz_url: null,
              provider_job_id: newTaskId,
              usdz_provider_job_id: null,
              regen_retry_count: nextRegenAttempt,
            })
            .eq("id", model.id)
            .is("usdz_url", null)
            .neq("status", "failed")
            .select("id");

          if (!updated || updated.length === 0) {
            // Lost the race to a concurrent duplicate delivery already
            // driving this — don't submit a second retry on top of it.
            return NextResponse.json({ ok: true, note: "concurrent delivery already handled" });
          }
          return NextResponse.json({ ok: true, note: `QA regen retry submitted (attempt ${nextRegenAttempt})` });
        } catch (err) {
          // Resubmission itself failed (Tripo API error) — there's no valid
          // file to ship this time (unlike the size-retry's fall-through
          // below), so fall through to the refund.
          console.warn(`Tripo webhook: model ${model.id} QA regen resubmission failed, refunding instead`, err);
        }
      }

      await admin.rpc("refund_credit", {
        model_id: model.id,
        failure_reason: `Model failed validation: ${validation.reason}`,
      });
      return NextResponse.json({ ok: true, note: "failed validation" });
    }
  }

  // Rule 21's size budget, enforced (not just hoped for): USDZ can't be
  // Draco-compressed after the fact (see lib/glbCompress.ts), so geometry
  // complexity at generation time is the only lever — an oversized result
  // here means the *generation itself* has to be retried at a lower
  // face_limit, not a local re-process. Bounded to MAX_SIZE_RETRIES: this
  // costs a full new Tripo generation per attempt, not a cheap step.
  if (stage === "usdz" && fileBytes.length > TARGET_USDZ_BYTES && model.size_retry_count < MAX_SIZE_RETRIES) {
    const attemptedFaceLimit = faceLimitForAttempt(model.size_retry_count);
    const nextAttempt = model.size_retry_count + 1;
    const nextFaceLimit = faceLimitForAttempt(nextAttempt);
    console.warn(
      `Tripo webhook: model ${model.id} USDZ ${(fileBytes.length / (1024 * 1024)).toFixed(2)} MB ` +
        `exceeds ${(TARGET_USDZ_BYTES / (1024 * 1024)).toFixed(0)} MB target at face_limit=${attemptedFaceLimit} ` +
        `(attempt ${model.size_retry_count}) — retrying at face_limit=${nextFaceLimit} (attempt ${nextAttempt})`,
    );

    try {
      // The USDZ stage is always a genuine Tripo conversion task regardless
      // of which provider generated the GLB (see lib/tripo.ts
      // submitUsdzConversionTask) — but an oversized result means the
      // *geometry* has to be regenerated, and that must go back through
      // whichever provider originally produced it (model.provider), not
      // always Tripo, or a fal-sourced model would silently and incorrectly
      // flip to Tripo-generated geometry on retry without models.provider
      // ever reflecting that.
      const keys = {
        front: model.source_image_key,
        left: model.source_image_key_left,
        back: model.source_image_key_back,
        right: model.source_image_key_right,
      };
      const { taskId: newTaskId } =
        model.provider === "fal" ? await submitFalTaskForKeys(keys, nextFaceLimit) : await submitTripoTaskForKeys(keys, nextFaceLimit);
      const { data: updated } = await admin
        .from("models")
        .update({
          status: "processing",
          glb_url: null,
          usdz_url: null,
          provider_job_id: newTaskId,
          usdz_provider_job_id: null,
          size_retry_count: nextAttempt,
        })
        .eq("id", model.id)
        .is("usdz_url", null)
        .neq("status", "failed")
        .select("id");

      if (!updated || updated.length === 0) {
        // Lost the race to a concurrent duplicate delivery already driving
        // this — don't submit a second retry generation on top of it.
        return NextResponse.json({ ok: true, note: "concurrent delivery already handled" });
      }
      return NextResponse.json({ ok: true, note: `size retry submitted (attempt ${nextAttempt})` });
    } catch (err) {
      // Resubmission failed — don't strand the model row on a discarded
      // oversized file. Fall through (past this whole if-block) and ship
      // what we have instead; it's oversized but still a valid, deliverable
      // model (rule: never fail a paid generation over a size-budget retry).
      console.warn(`Tripo webhook: model ${model.id} size-retry resubmission failed, shipping oversized result instead`, err);
    }
  }

  if (stage === "usdz") {
    // Final size, logged either way — this is the data set rule 21's
    // DEFAULT_FACE_LIMIT guess needs to become a measured value instead of
    // a guess, after enough real objects have gone through this.
    const withinTarget = fileBytes.length <= TARGET_USDZ_BYTES;
    console.info(
      `Tripo webhook: model ${model.id} final USDZ ${(fileBytes.length / (1024 * 1024)).toFixed(2)} MB ` +
        `(face_limit=${faceLimitForAttempt(model.size_retry_count)}, attempt ${model.size_retry_count}, ` +
        `${withinTarget ? "within" : "OVER"} ${(TARGET_USDZ_BYTES / (1024 * 1024)).toFixed(0)} MB target)`,
    );
  }

  // Stored as the bare R2 key, not a full URL: NEXT_PUBLIC_MODELS_CDN_URL
  // isn't live yet (see README — Phase 4 is blocked on a production
  // domain), so there is no real URL to write. Writing one anyway would
  // mean either a broken link now or a backfill migration later; storing
  // the key means Phase 4 just prefixes NEXT_PUBLIC_MODELS_CDN_URL at
  // render time and nothing here needs to change once the domain exists.
  const key = `models/${model.id}.${stage}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getModelsBucket(),
      Key: key,
      Body: fileBytes,
      ContentType: MODEL_CONTENT_TYPES[stage],
      CacheControl: MODEL_CACHE_CONTROL,
    }),
  );

  if (stage === "glb") {
    // Permanent, never-overwritten copy of Tripo's original, un-rescaled
    // output — sizeModel() below (and any future re-scale) always bakes
    // FROM this fixed reference, never from a previously-baked `glb_url`,
    // so repeated scale adjustments can't compound floating-point drift
    // through a chain of "scale applied to an already-scaled file."
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
      // Guards against the stale-sweep race (scripts run via
      // app/api/cron/sweep-stale-generations/route.ts): if the sweep already
      // refunded and failed this row while this delivery was in flight, this
      // must not revive it by writing glb_url onto a row the user has
      // already been told (and refunded) failed.
      .neq("status", "failed")
      .select("id");

    if (!updated || updated.length === 0) {
      // Lost the race to a concurrent duplicate delivery that already set
      // glb_url — the other delivery is already driving the USDZ stage.
      return NextResponse.json({ ok: true, note: "concurrent delivery already handled" });
    }

    try {
      const { taskId: usdzTaskId } = await submitUsdzConversionTask({ taskId: task.task_id });
      await admin.from("models").update({ usdz_provider_job_id: usdzTaskId }).eq("id", model.id);
    } catch (err) {
      await admin.rpc("refund_credit", {
        model_id: model.id,
        failure_reason: err instanceof Error ? err.message : "Failed to start USDZ conversion",
      });
    }
    return NextResponse.json({ ok: true });
  }

  // Permanent, never-overwritten copy of Tripo's original, un-rescaled
  // USDZ — same reasoning as .raw.glb above: sizeModel() below (and any
  // future re-scale) always bakes the USDZ side (lib/usdzScale.ts) FROM
  // this fixed reference too, so repeated adjustments can't compound.
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getModelsBucket(),
      Key: `models/${model.id}.raw.usdz`,
      Body: fileBytes,
      ContentType: MODEL_CONTENT_TYPES.usdz,
      CacheControl: MODEL_CACHE_CONTROL,
    }),
  );

  // stage === "usdz": this is the last step — flip to ready atomically with
  // the write, guarded the same way as the GLB branch above. Also guarded
  // against the stale-sweep race (see the glb_url update above) — without
  // this, a sweep that refunds+fails this row a moment before this delivery
  // lands would get silently overwritten back to "ready" by this write.
  const { data: readyUpdated } = await admin
    .from("models")
    .update({ usdz_url: key, status: "ready" })
    .eq("id", model.id)
    .is("usdz_url", null)
    .neq("status", "failed")
    .select("id");

  if (readyUpdated && readyUpdated.length > 0) {
    // after(), not await: Tripo gets its 200 the moment the row is ready —
    // a slow render must not risk Tripo treating this delivery as timed out
    // and retrying it (harmless, since the idempotency guard above would
    // just no-op the retry, but pointless). Vercel keeps this invocation
    // alive to run the callback after the response is sent, up to
    // maxDuration — the render's own RENDER_HARD_TIMEOUT_MS (25s) fits
    // comfortably inside that.
    after(() => renderAndStoreThumbnail(admin, model.id));
    // Independent of the thumbnail render above — uses the source photo,
    // not the GLB, so it has nothing to wait on. Cosmetic like the
    // thumbnail: never allowed to affect the ready transition, which has
    // already happened by the time this runs.
    after(() => sizeModel(admin, model.id, model.source_image_key, model.bbox_height_m));
  }

  return NextResponse.json({ ok: true });
}

/**
 * design/01, design/06 — the feed shows the generated object on a dark
 * studio backdrop, not the source photo. Runs strictly AFTER the row is
 * already `ready`, not before: rendering is cosmetic, and the credit/model
 * delivery must never wait on or be jeopardized by it (this is exactly what
 * broke on the first real Vercel run — see KNOWN_ISSUES.md — a caught,
 * fast-failing bug that time, but the render call had no bound on the
 * *entire* operation, only on the internal "wait for model to load" step;
 * a hang in Chromium launch or the screenshot itself was unbounded except by
 * Vercel's own 60s function timeout, which would have delayed the ready
 * transition had the failure mode been a hang instead of a fast throw).
 *
 * RENDER_HARD_TIMEOUT_MS bounds the ENTIRE call, launch included, via
 * Promise.race — if it fires, this function returns and the webhook
 * responds normally; the abandoned renderThumbnail() call has no further
 * effect since Vercel freezes the invocation shortly after the response is
 * sent. A model with no render just keeps showing its source photo (already
 * the fallback), never held up.
 */
const RENDER_HARD_TIMEOUT_MS = 25_000;

async function renderAndStoreThumbnail(admin: ReturnType<typeof createAdminClient>, modelId: string): Promise<void> {
  try {
    const { data: model } = await admin
      .from("models")
      .select("glb_url, bbox_width_m, bbox_depth_m, bbox_height_m")
      .eq("id", modelId)
      .single();

    if (!model?.glb_url || model.bbox_width_m == null || model.bbox_depth_m == null || model.bbox_height_m == null) {
      return;
    }

    const glbObject = await getR2Client().send(new GetObjectCommand({ Bucket: getModelsBucket(), Key: model.glb_url }));
    if (!glbObject.Body) return;
    const glb = Buffer.from(await glbObject.Body.transformToByteArray());
    const bbox = { width: model.bbox_width_m, depth: model.bbox_depth_m, height: model.bbox_height_m };

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`thumbnail render exceeded ${RENDER_HARD_TIMEOUT_MS}ms hard timeout`)), RENDER_HARD_TIMEOUT_MS),
    );
    const rendered = await Promise.race([renderThumbnail({ glb, bbox, modelId }), timeout]);

    const renderKey = `models/${modelId}.webp`;
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getModelsBucket(),
        Key: renderKey,
        Body: rendered.image,
        ContentType: MODEL_CONTENT_TYPES.webp,
        CacheControl: MODEL_CACHE_CONTROL,
      }),
    );

    await admin.from("models").update({ render_url: renderKey }).eq("id", modelId).is("render_url", null);
  } catch (err) {
    console.warn(`Tripo webhook: thumbnail render failed for model ${modelId}, feed falls back to source photo`, err);
  }
}

const UPLOAD_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Matches ModelScaleControl.tsx's own default min/max — never write a
// smart-guess scale the slider itself can't represent or let the user
// adjust back down/up from.
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

/**
 * Best-effort initial-scale guess from the source photo — models are never
 * auto-named (2026-09-02 product decision: an AI-guessed name read as odd
 * often enough that no name at all was preferred over it; titles were
 * removed entirely shortly after, including manual renaming). A failed or
 * missing Gemini call leaves
 * `scale` at its schema default of 1 and `glb_url` pointing at the raw,
 * unscaled file — same as if this had never run — so there's nothing to
 * fail here in the way a real generation step can fail. `.eq("scale", 1)`
 * makes this idempotent against a duplicate webhook delivery AND against a
 * user who already rescaled the model in the window between the ready
 * update and this running — the guard failing to match just means "someone
 * already got there first," not an error.
 *
 * The scale guess is exactly that — a guess, not a measurement (rule 22:
 * Tripo's mesh has no real-world scale at all). bboxHeightM is itself
 * unitless mesh-space geometry despite its name (see lib/models.ts's own
 * comment) — real display height is bboxHeightM * scale * 100cm, so
 * solving for the scale that makes that equal Gemini's heightCm guess is
 * the whole trick: scale = heightCm / (bboxHeightM * 100).
 *
 * 2026-09-02: this used to just write `scale` to the DB and stop, on the
 * assumption <model-viewer>'s `scale` attribute would apply it at render
 * time. It doesn't — see lib/glbScale.ts's header for why that attribute is
 * a no-op in the installed model-viewer version, on-page AND in AR. So this
 * now bakes the guess directly into the GLB's own geometry (from the
 * permanent `models/{id}.raw.glb` written at the GLB stage above, never
 * from a previously-baked file, to avoid compounding rescales) and points
 * `glb_url` at a freshly-keyed copy — a new key, not an overwrite, because
 * rule 3's `immutable` Cache-Control means whatever a CDN/browser already
 * cached under the OLD key must never need to change; overwriting it in
 * place would leave stale bytes forever cached at a URL that no longer
 * matches its own content.
 *
 * 2026-09-03: same thing now also happens to the USDZ (lib/usdzScale.ts,
 * from `models/{id}.raw.usdz`) — GLB-only baking left iOS Quick Look (which
 * loads `ios-src` natively, never the GLB at all) still showing every
 * model at its raw, unscaled size, reported directly against a real
 * iPhone. The visible scale slider (rule 22) is what gets the last word —
 * see app/api/models/rescale/route.ts, which re-bakes both files the same
 * way when the user adjusts it.
 */
async function sizeModel(
  admin: ReturnType<typeof createAdminClient>,
  modelId: string,
  sourceImageKey: string,
  bboxHeightM: number | null,
): Promise<void> {
  try {
    if (bboxHeightM == null || bboxHeightM <= 0) return;

    const object = await getR2Client().send(new GetObjectCommand({ Bucket: getUploadsBucket(), Key: sourceImageKey }));
    if (!object.Body) return;
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    const ext = sourceImageKey.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = object.ContentType || UPLOAD_MIME_TYPES[ext] || "image/jpeg";

    const heightCm = await guessModelHeightCm(bytes, mimeType);
    if (heightCm == null) return;

    const guessedScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, heightCm / (bboxHeightM * 100)));

    const rawObject = await getR2Client().send(
      new GetObjectCommand({ Bucket: getModelsBucket(), Key: `models/${modelId}.raw.glb` }),
    );
    if (!rawObject.Body) return;
    const rawGlb = Buffer.from(await rawObject.Body.transformToByteArray());
    const scaledGlb = await bakeGlbScale(rawGlb, guessedScale);

    const scaledGlbKey = `models/${modelId}.${randomUUID().slice(0, 8)}.glb`;
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getModelsBucket(),
        Key: scaledGlbKey,
        Body: scaledGlb,
        ContentType: MODEL_CONTENT_TYPES.glb,
        CacheControl: MODEL_CACHE_CONTROL,
      }),
    );

    // USDZ side of the same fix (lib/usdzScale.ts) — iOS Quick Look loads
    // this file natively, completely independent of the GLB, so baking
    // only the GLB leaves iOS still showing the raw, unscaled size. Kept
    // best-effort and separate from the GLB write above: a USDZ-baking
    // failure shouldn't also lose the GLB fix that already succeeded.
    let scaledUsdzKey: string | undefined;
    try {
      const rawUsdzObject = await getR2Client().send(
        new GetObjectCommand({ Bucket: getModelsBucket(), Key: `models/${modelId}.raw.usdz` }),
      );
      if (rawUsdzObject.Body) {
        const rawUsdz = Buffer.from(await rawUsdzObject.Body.transformToByteArray());
        const scaledUsdz = await bakeUsdzScale(rawUsdz, guessedScale);
        scaledUsdzKey = `models/${modelId}.${randomUUID().slice(0, 8)}.usdz`;
        await getR2Client().send(
          new PutObjectCommand({
            Bucket: getModelsBucket(),
            Key: scaledUsdzKey,
            Body: scaledUsdz,
            ContentType: MODEL_CONTENT_TYPES.usdz,
            CacheControl: MODEL_CACHE_CONTROL,
          }),
        );
      }
    } catch (err) {
      console.warn(`Tripo webhook: USDZ scale-baking failed for model ${modelId}, iOS AR will show the unscaled size`, err);
    }

    await admin
      .from("models")
      .update({ scale: guessedScale, glb_url: scaledGlbKey, ...(scaledUsdzKey && { usdz_url: scaledUsdzKey }) })
      .eq("id", modelId)
      .eq("scale", 1);
  } catch (err) {
    console.warn(`Tripo webhook: auto-sizing failed for model ${modelId}, leaving scale unset`, err);
  }
}
