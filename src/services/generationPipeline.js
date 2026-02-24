const { generatePixarImage } = require('./fal');
const { generateVideo } = require('./replicate');
const { renderMp4 } = require('./remotion');
const { convertMp4ToGif, uploadBase64ImageToS3, concatMp4s } = require('./videoCompress');
const { removeBackground } = require('./backgroundRemoval');
const { applyTextOverlay } = require('./textOverlay');

const GENERATION_CANCELLED_CODE = 'GENERATION_CANCELLED';

function createGenerationCancelledError(message = 'Generation cancelled by user') {
  const err = new Error(message);
  err.code = GENERATION_CANCELLED_CODE;
  return err;
}

function isAbortError(err) {
  return Boolean(err && err.name === 'AbortError');
}

async function throwIfCancelled({
  abortSignal,
  shouldCancel,
  message = 'Generation cancelled by user',
}) {
  if (abortSignal?.aborted) {
    throw createGenerationCancelledError(message);
  }

  if (typeof shouldCancel === 'function') {
    const cancelled = await shouldCancel();
    if (cancelled) {
      throw createGenerationCancelledError(message);
    }
  }

  if (abortSignal?.aborted) {
    throw createGenerationCancelledError(message);
  }
}

/**
 * Run the full Pixar GIF generation pipeline.
 * Throws on failure and refunds credits if a credit was deducted.
 */
async function runGenerationPipeline({
  supabase,
  userId,
  photoUrl,
  photoBase64,
  firstName,
  lastName,
  greeting,
  ctaText,
  onProgress,
  abortSignal,
  shouldCancel,
}) {
  const startTime = Date.now();
  let creditDeducted = false;

  try {
    if (!photoUrl && !photoBase64) {
      const err = new Error('Photo URL or base64 required');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    if (!firstName) {
      const err = new Error('First name required');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    await throwIfCancelled({ abortSignal, shouldCancel });

    console.log(`[Generate] Starting for ${firstName} (user: ${userId})`);

    const { data: deducted, error: deductError } = await supabase.rpc('deduct_credit', {
      p_user_id: userId,
    });

    if (deductError) {
      throw deductError;
    }

    if (!deducted || deducted.length === 0) {
      const err = new Error('Insufficient credits');
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }

    creditDeducted = true;
    const creditsRemaining = deducted[0].balance;
    console.log(`[Generate] Deducted 1 credit, balance now ${creditsRemaining}`);

    await throwIfCancelled({ abortSignal, shouldCancel });

    let originalPhotoS3Url = null;
    if (photoBase64) {
      console.log('[Generate] Step 0: Uploading original photo to S3...');
      originalPhotoS3Url = await uploadBase64ImageToS3(photoBase64);
    }

    console.log('[Generate] Steps 0.5+1: Starting background removal and Pixar generation in parallel...');
    const imageInput = photoBase64 || photoUrl;
    const greetingText = greeting || `Hey, ${firstName}!`;
    const ctaTextFinal = ctaText || 'Open to talk?';

    const [silhouetteUrl, pixarImageUrl] = await Promise.all([
      originalPhotoS3Url
        ? removeBackground(originalPhotoS3Url).catch((err) => {
            console.warn(
              '[Generate] Step 0.5: Background removal failed (non-fatal):',
              err.message
            );
            return null;
          })
        : Promise.resolve(null),
      generatePixarImage(imageInput, { signal: abortSignal }),
    ]);

    await throwIfCancelled({ abortSignal, shouldCancel });

    // Report silhouette URL mid-flight so the extension can show it during preview
    if (silhouetteUrl && typeof onProgress === 'function') {
      onProgress({ silhouette_url: silhouetteUrl }).catch((err) => {
        console.warn('[Generate] Failed to report silhouette progress:', err.message);
      });
    }
    let phase1Promise = null;
    if (originalPhotoS3Url) {
      console.log('[Generate] Step 3a: Starting Remotion Phase 1 (frames 0-44)...');
      phase1Promise = renderMp4({
        originalPhotoUrl: originalPhotoS3Url,
        silhouetteUrl,
        pixarImageUrl: originalPhotoS3Url,
        videoUrl: originalPhotoS3Url,
        firstName,
        frameRange: [0, 44],
        signal: abortSignal,
      }).catch((err) => {
        console.warn('[Generate] Phase 1 render failed (non-fatal):', err.message);
        return null;
      });
    }

    console.log('[Generate] Step 2: Generating video...');
    const videoUrl = await generateVideo(pixarImageUrl, { signal: abortSignal });

    await throwIfCancelled({ abortSignal, shouldCancel });

    const phase1Mp4 = phase1Promise ? await phase1Promise : null;

    let mp4Url;
    if (phase1Mp4) {
      console.log('[Generate] Step 3b: Rendering Remotion Phase 2 (frames 45-149)...');
      const phase2Mp4 = await renderMp4({
        originalPhotoUrl: originalPhotoS3Url,
        silhouetteUrl,
        pixarImageUrl,
        videoUrl,
        firstName,
        frameRange: [45, 149],
        signal: abortSignal,
      });

      await throwIfCancelled({ abortSignal, shouldCancel });

      console.log('[Generate] Step 3c: Concatenating phases...');
      mp4Url = await concatMp4s(phase1Mp4, phase2Mp4);
    } else {
      console.log('[Generate] Step 3: Rendering full MP4 with Remotion Lambda...');
      mp4Url = await renderMp4({
        originalPhotoUrl: originalPhotoS3Url,
        silhouetteUrl,
        pixarImageUrl,
        videoUrl,
        firstName,
        signal: abortSignal,
      });
    }

    await throwIfCancelled({ abortSignal, shouldCancel });

    // Step 3.5: Apply greeting and CTA text via ffmpeg drawtext.
    // mp4Url (pre-text) is stored so text can be re-applied cheaply later.
    console.log('[Generate] Step 3.5: Applying text overlay...');
    if (typeof onProgress === 'function') {
      onProgress({ current_step: 'compose' }).catch((err) => {
        console.warn('[Generate] Failed to report compose progress:', err.message);
      });
    }
    const mp4NoTextUrl = mp4Url;
    const mp4WithTextUrl = await applyTextOverlay(mp4Url, {
      greeting: greetingText,
      ctaText: ctaTextFinal,
    });

    await throwIfCancelled({ abortSignal, shouldCancel });

    console.log('[Generate] Step 4: Converting MP4 to GIF...');
    const gifUrl = await convertMp4ToGif(mp4WithTextUrl);

    await throwIfCancelled({ abortSignal, shouldCancel });

    const { error: usageTxError } = await supabase.from('transactions').insert({
      user_id: userId,
      type: 'usage',
      amount: -1,
      description: `Generated Pixar GIF for ${firstName}${lastName ? ' ' + lastName : ''}`,
    });

    if (usageTxError) {
      throw usageTxError;
    }

    const { data: generationRow, error: generationError } = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        linkedin_profile_url: photoUrl || null,
        gif_url: gifUrl,
        mp4_no_text_url: mp4NoTextUrl,
        first_name: firstName,
        last_name: lastName || null,
      })
      .select('id')
      .single();

    if (generationError) {
      throw generationError;
    }

    const durationSeconds = Number(((Date.now() - startTime) / 1000).toFixed(1));
    console.log(`[Generate] Complete in ${durationSeconds}s`);

    return {
      gifUrl,
      silhouetteUrl,
      mp4Url: mp4WithTextUrl,
      mp4NoTextUrl,
      pixarImageUrl,
      videoUrl,
      creditsRemaining,
      durationSeconds,
      generationId: generationRow?.id || null,
    };
  } catch (err) {
    const normalizedError =
      err.code === GENERATION_CANCELLED_CODE || isAbortError(err) || abortSignal?.aborted
        ? createGenerationCancelledError()
        : err;

    if (creditDeducted) {
      try {
        await supabase.rpc('refund_credit', { p_user_id: userId });
        console.log('[Generate] Refunded 1 credit after failure');
      } catch (refundErr) {
        console.error('[Generate] Failed to refund credit:', refundErr.message);
      }
    }

    throw normalizedError;
  }
}

module.exports = { runGenerationPipeline };
