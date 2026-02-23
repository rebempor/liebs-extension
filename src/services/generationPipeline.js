const { generatePixarImage } = require('./fal');
const { generateVideo } = require('./replicate');
const { renderMp4 } = require('./remotion');
const { convertMp4ToGif, uploadBase64ImageToS3, concatMp4s } = require('./videoCompress');
const { removeBackground } = require('./backgroundRemoval');

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
  greeting,
  ctaText,
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
      generatePixarImage(imageInput),
    ]);

    let phase1Promise = null;
    if (originalPhotoS3Url) {
      console.log('[Generate] Step 3a: Starting Remotion Phase 1 (frames 0-44)...');
      phase1Promise = renderMp4({
        originalPhotoUrl: originalPhotoS3Url,
        silhouetteUrl,
        pixarImageUrl: originalPhotoS3Url,
        videoUrl: originalPhotoS3Url,
        firstName,
        greeting: greetingText,
        ctaText: ctaTextFinal,
        frameRange: [0, 44],
      }).catch((err) => {
        console.warn('[Generate] Phase 1 render failed (non-fatal):', err.message);
        return null;
      });
    }

    console.log('[Generate] Step 2: Generating video...');
    const videoUrl = await generateVideo(pixarImageUrl);

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
        greeting: greetingText,
        ctaText: ctaTextFinal,
        frameRange: [45, 149],
      });

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
        greeting: greetingText,
        ctaText: ctaTextFinal,
      });
    }

    console.log('[Generate] Step 3.5: Converting MP4 to GIF...');
    const gifUrl = await convertMp4ToGif(mp4Url);

    const { error: usageTxError } = await supabase.from('transactions').insert({
      user_id: userId,
      type: 'usage',
      amount: -1,
      description: `Generated Pixar GIF for ${firstName}`,
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
        first_name: firstName,
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
      mp4Url,
      pixarImageUrl,
      videoUrl,
      creditsRemaining,
      durationSeconds,
      generationId: generationRow?.id || null,
    };
  } catch (err) {
    if (creditDeducted) {
      try {
        await supabase.rpc('refund_credit', { p_user_id: userId });
        console.log('[Generate] Refunded 1 credit after failure');
      } catch (refundErr) {
        console.error('[Generate] Failed to refund credit:', refundErr.message);
      }
    }

    throw err;
  }
}

module.exports = { runGenerationPipeline };
