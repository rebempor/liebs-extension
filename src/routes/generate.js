const express = require('express');
const { requireAuth, supabase } = require('../middleware/auth');
const { generatePixarImage } = require('../services/fal');
const { generateVideo } = require('../services/replicate');
const { renderMp4 } = require('../services/remotion');
const { compressAndUpload, convertMp4ToGif, uploadBase64ImageToS3, concatMp4s } = require('../services/videoCompress');
const { removeBackground } = require('../services/backgroundRemoval');

const router = express.Router();

/**
 * POST /api/generate/pixar-gif
 * Main endpoint - generates Pixar GIF from LinkedIn photo
 *
 * Requires: 1 credit
 * Body: { photoUrl: string, firstName: string, greeting: string, ctaText: string }
 * Returns: { gifUrl: string } or { error: string }
 */
router.post('/pixar-gif', requireAuth, async (req, res) => {
  const startTime = Date.now();
  const userId = req.user.id;

  try {
    const { photoUrl, photoBase64, firstName, greeting, ctaText } = req.body;

    // Validate inputs
    if (!photoUrl && !photoBase64) {
      return res.status(400).json({ error: 'Photo URL or base64 required' });
    }
    if (!firstName) {
      return res.status(400).json({ error: 'First name required' });
    }

    console.log(`[Generate] Starting for ${firstName} (user: ${userId})`);

    // Atomically deduct 1 credit before starting the pipeline.
    // This prevents race conditions where concurrent requests read the same
    // balance and all pass the credit check.
    const { data: deducted, error: deductError } = await req.supabase
      .rpc('deduct_credit', { p_user_id: userId });

    if (deductError) {
      throw deductError;
    }

    if (!deducted || deducted.length === 0) {
      return res.status(402).json({
        error: 'Insufficient credits',
        balance: 0,
        required: 1
      });
    }

    const balanceAfterDeduct = deducted[0].balance;
    console.log(`[Generate] Deducted 1 credit, balance now ${balanceAfterDeduct}`);

    // Step 0: Upload original LinkedIn photo to S3 (so Remotion can access it)
    let originalPhotoS3Url = null;
    if (photoBase64) {
      console.log('[Generate] Step 0: Uploading original photo to S3...');
      originalPhotoS3Url = await uploadBase64ImageToS3(photoBase64);
    }

    // Steps 0.5 + 1 in parallel: background removal and Pixar generation
    // have no dependency on each other (both only need the original photo).
    console.log('[Generate] Steps 0.5+1: Starting background removal and Pixar generation in parallel...');
    const imageInput = photoBase64 || photoUrl;
    const greetingText = greeting || `Hey, ${firstName}!`;
    const ctaTextFinal = ctaText || 'Open to talk?';

    const [silhouetteUrl, pixarImageUrl] = await Promise.all([
      // Step 0.5: Background removal (non-fatal — silhouette glow is optional)
      originalPhotoS3Url
        ? removeBackground(originalPhotoS3Url).catch((err) => {
            console.warn('[Generate] Step 0.5: Background removal failed (non-fatal):', err.message);
            return null;
          })
        : Promise.resolve(null),

      // Step 1: Pixar image generation (fatal — everything downstream needs this)
      generatePixarImage(imageInput),
    ]);

    // Kick off Remotion Phase 1 immediately (frames 0-44, no video needed).
    // The Video component isn't mounted until frame 45 (<Sequence from={45}>),
    // so these frames only need originalPhotoUrl + silhouetteUrl.
    // Don't await — let it render while video generates.
    let phase1Promise = null;
    if (originalPhotoS3Url) {
      console.log('[Generate] Step 3a: Starting Remotion Phase 1 (frames 0-44)...');
      phase1Promise = renderMp4({
        originalPhotoUrl: originalPhotoS3Url,
        silhouetteUrl,
        pixarImageUrl: originalPhotoS3Url,  // not used in frames 0-44
        videoUrl: originalPhotoS3Url,        // not used — Video not mounted before frame 45
        firstName,
        greeting: greetingText,
        ctaText: ctaTextFinal,
        frameRange: [0, 44],
      }).catch((err) => {
        console.warn('[Generate] Phase 1 render failed (non-fatal):', err.message);
        return null;
      });
    }

    // Step 2: Generate video
    console.log('[Generate] Step 2: Generating video...');
    const rawVideoUrl = await generateVideo(pixarImageUrl);

    // Step 2.5: Compress video for faster Remotion rendering
    console.log('[Generate] Step 2.5: Compressing video...');
    const videoUrl = await compressAndUpload(rawVideoUrl);

    // Await Phase 1 (should be done by now — it started ~100s ago)
    const phase1Mp4 = phase1Promise ? await phase1Promise : null;

    let mp4Url;
    if (phase1Mp4) {
      // Phase 2: render frames 45-149 only (video portion)
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

      // Concatenate Phase 1 + Phase 2
      console.log('[Generate] Step 3c: Concatenating phases...');
      mp4Url = await concatMp4s(phase1Mp4, phase2Mp4);
    } else {
      // Fallback: single full render (if Phase 1 failed or no S3 photo)
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

    // Step 3.5: Convert MP4 to GIF server-side with FFmpeg palettegen
    console.log('[Generate] Step 3.5: Converting MP4 to GIF...');
    const gifUrl = await convertMp4ToGif(mp4Url);

    // Credit was already deducted atomically at the start of the request.

    // Log transaction and generation in parallel (independent DB writes)
    await Promise.all([
      req.supabase.from('transactions').insert({
        user_id: userId,
        type: 'usage',
        amount: -1,
        description: `Generated Pixar GIF for ${firstName}`
      }),
      req.supabase.from('generations').insert({
        user_id: userId,
        linkedin_profile_url: photoUrl || null,
        gif_url: gifUrl,
        first_name: firstName
      }),
    ]);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Generate] Complete in ${duration}s`);

    res.json({
      success: true,
      gifUrl: gifUrl,
      mp4Url: mp4Url,
      pixarImageUrl: pixarImageUrl,
      videoUrl: videoUrl,
      creditsRemaining: balanceAfterDeduct,
      duration: `${duration}s`
    });

  } catch (err) {
    console.error('[Generate] Error:', err.message);

    // Refund the credit that was deducted at the start
    try {
      await req.supabase
        .rpc('refund_credit', { p_user_id: userId });
      console.log('[Generate] Refunded 1 credit after failure');
    } catch (refundErr) {
      console.error('[Generate] Failed to refund credit:', refundErr.message);
    }

    res.status(500).json({
      error: err.message,
      step: err.step || 'unknown'
    });
  }
});

/**
 * GET /api/generate/history
 * Get user's generation history
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('generations')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    res.json({ generations: data || [] });
  } catch (err) {
    console.error('[Generate] History error:', err.message);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

module.exports = router;
