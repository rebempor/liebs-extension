const express = require('express');
const { requireAuth, supabase } = require('../middleware/auth');
const { generatePixarImage } = require('../services/fal');
const { generateVideo } = require('../services/replicate');
const { renderGif } = require('../services/remotion');
const { compressAndUpload, uploadBase64ImageToS3 } = require('../services/videoCompress');
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

    // Check credits
    const { data: credits, error: creditsError } = await req.supabase
      .from('credits')
      .select('balance')
      .eq('user_id', userId)
      .single();

    if (creditsError && creditsError.code !== 'PGRST116') {
      throw creditsError;
    }

    const balance = credits?.balance || 0;
    if (balance < 1) {
      return res.status(402).json({
        error: 'Insufficient credits',
        balance: balance,
        required: 1
      });
    }

    console.log(`[Generate] User has ${balance} credits`);

    // Step 0: Upload original LinkedIn photo to S3 (so Remotion can access it)
    let originalPhotoS3Url = null;
    if (photoBase64) {
      console.log('[Generate] Step 0: Uploading original photo to S3...');
      originalPhotoS3Url = await uploadBase64ImageToS3(photoBase64);
    }

    // Step 0.5: Generate silhouette (background removal) from original photo
    let silhouetteUrl = null;
    if (originalPhotoS3Url) {
      console.log('[Generate] Step 0.5: Generating silhouette...');
      silhouetteUrl = await removeBackground(originalPhotoS3Url);
    }

    // Step 1: Generate Pixar image
    console.log('[Generate] Step 1: Generating Pixar image...');
    const imageInput = photoBase64 || photoUrl;
    const pixarImageUrl = await generatePixarImage(imageInput);

    // Step 2: Generate video
    console.log('[Generate] Step 2: Generating video...');
    const rawVideoUrl = await generateVideo(pixarImageUrl);

    // Step 2.5: Compress video for faster Remotion rendering
    console.log('[Generate] Step 2.5: Compressing video...');
    const videoUrl = await compressAndUpload(rawVideoUrl);

    // Step 3: Render GIF with Remotion Lambda
    console.log('[Generate] Step 3: Rendering GIF with Remotion Lambda...');
    const gifUrl = await renderGif({
      originalPhotoUrl: originalPhotoS3Url,  // Original LinkedIn photo (from S3)
      silhouetteUrl: silhouetteUrl,          // Person cutout with transparent BG
      pixarImageUrl: pixarImageUrl,          // Transformed Pixar image
      videoUrl,
      firstName,
      greeting: greeting || `Hey, ${firstName}!`,
      ctaText: ctaText || 'Open to talk?'
    });

    // Deduct credit
    console.log('[Generate] Deducting 1 credit...');
    await req.supabase
      .from('credits')
      .update({
        balance: balance - 1,
        updated_at: new Date()
      })
      .eq('user_id', userId);

    // Log transaction
    await req.supabase.from('transactions').insert({
      user_id: userId,
      type: 'usage',
      amount: -1,
      description: `Generated Pixar GIF for ${firstName}`
    });

    // Log generation (optional)
    await req.supabase.from('generations').insert({
      user_id: userId,
      linkedin_profile_url: photoUrl || null,
      gif_url: gifUrl,
      first_name: firstName
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Generate] Complete in ${duration}s`);

    res.json({
      success: true,
      gifUrl: gifUrl,
      pixarImageUrl: pixarImageUrl,
      videoUrl: videoUrl,
      creditsRemaining: balance - 1,
      duration: `${duration}s`
    });

  } catch (err) {
    console.error('[Generate] Error:', err.message);
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
