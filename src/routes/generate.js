const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  JOB_STATUS,
  enqueueGenerationJob,
  getGenerationJob,
  cancelGenerationJob,
} = require('../services/generationJobs');
const { trackError } = require('../services/errorTracker');
const { applyTextAndConvertToGif } = require('../services/textOverlay');

const router = express.Router();

function isMissingGenerationJobsTable(err) {
  return Boolean(
    err &&
      err.code === 'PGRST205' &&
      /generation_jobs/.test(err.message || '')
  );
}

/**
 * POST /api/generate/pixar-gif
 * Queue a generation job and return immediately.
 */
router.post('/pixar-gif', requireAuth, async (req, res) => {
  try {
    const { photoUrl, photoBase64, firstName, lastName, greeting, ctaText } = req.body;

    if (!photoUrl && !photoBase64) {
      return res.status(400).json({ error: 'Photo URL or base64 required' });
    }

    if (!firstName) {
      return res.status(400).json({ error: 'First name required' });
    }

    const job = await enqueueGenerationJob({
      userId: req.user.id,
      photoUrl,
      photoBase64,
      firstName,
      lastName,
      greeting,
      ctaText,
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      status: job.status,
      queuedAt: job.created_at,
    });
  } catch (err) {
    console.error('[Generate] Queue error:', err.message);
    const queueNotReady = isMissingGenerationJobsTable(err);
    await trackError({
      source: 'generate',
      route: '/api/generate/pixar-gif',
      method: 'POST',
      statusCode: queueNotReady ? 503 : 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to queue generation job',
      stack: err.stack || null,
    });
    if (queueNotReady) {
      return res.status(503).json({
        error: 'Generation queue is not ready yet',
        code: 'JOB_QUEUE_NOT_READY',
      });
    }
    res.status(500).json({ error: 'Failed to queue generation job' });
  }
});

/**
 * GET /api/generate/jobs/:id
 * Poll job status and retrieve result.
 */
router.get('/jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = await getGenerationJob(req.params.id, req.user.id);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const payload = {
      jobId: job.id,
      status: job.status,
      queuedAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    };

    // Silhouette URL is available during processing (mid-flight) and after completion
    if (job.silhouette_url) {
      payload.silhouetteUrl = job.silhouette_url;
    }

    // Current pipeline step — used by the extension to show the Compose stage
    if (job.current_step) {
      payload.currentStep = job.current_step;
    }


    if (job.status === JOB_STATUS.COMPLETED) {
      payload.gifUrl = job.gif_url;
      payload.mp4Url = job.mp4_url;
      payload.pixarImageUrl = job.pixar_image_url;
      payload.videoUrl = job.video_url;
      payload.creditsRemaining = job.credits_remaining;
      payload.durationSeconds = job.duration_seconds;
      payload.generationId = job.generation_id;
    }

    if (job.status === JOB_STATUS.FAILED) {
      payload.error = job.error || 'Generation failed';
      payload.errorCode = job.error_code || null;
    }

    if (job.status === JOB_STATUS.CANCELLED) {
      payload.error = job.error || 'Generation cancelled by user';
      payload.errorCode = job.error_code || 'GENERATION_CANCELLED';
    }

    res.json(payload);
  } catch (err) {
    console.error('[Generate] Job status error:', err.message);
    const queueNotReady = isMissingGenerationJobsTable(err);
    await trackError({
      source: 'generate',
      route: '/api/generate/jobs/:id',
      method: 'GET',
      statusCode: queueNotReady ? 503 : 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to get job status',
      stack: err.stack || null,
      context: { jobId: req.params.id },
    });
    if (queueNotReady) {
      return res.status(503).json({
        error: 'Generation queue is not ready yet',
        code: 'JOB_QUEUE_NOT_READY',
      });
    }
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

/**
 * POST /api/generate/jobs/:id/cancel
 * Cancel a queued or in-progress generation job.
 */
router.post('/jobs/:id/cancel', requireAuth, async (req, res) => {
  try {
    const result = await cancelGenerationJob(req.params.id, req.user.id);

    if (!result) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({
      success: true,
      jobId: result.job?.id || req.params.id,
      status: result.job?.status || null,
      cancelled: Boolean(result.cancelled),
      alreadyFinal: Boolean(result.alreadyFinal),
      completedAt: result.job?.completed_at || null,
    });
  } catch (err) {
    console.error('[Generate] Cancel job error:', err.message);
    const queueNotReady = isMissingGenerationJobsTable(err);
    await trackError({
      source: 'generate',
      route: '/api/generate/jobs/:id/cancel',
      method: 'POST',
      statusCode: queueNotReady ? 503 : 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to cancel job',
      stack: err.stack || null,
      context: { jobId: req.params.id },
    });
    if (queueNotReady) {
      return res.status(503).json({
        error: 'Generation queue is not ready yet',
        code: 'JOB_QUEUE_NOT_READY',
      });
    }
    res.status(500).json({ error: 'Failed to cancel job' });
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

    if (error) {
      throw error;
    }

    res.json({ generations: data || [] });
  } catch (err) {
    console.error('[Generate] History error:', err.message);
    await trackError({
      source: 'generate',
      route: '/api/generate/history',
      method: 'GET',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to get generation history',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * POST /api/generate/generations/:id/restamp-text
 * Re-apply text to a previously generated GIF using only the ffmpeg drawtext step.
 * This is much faster than a full re-render because the pre-rendered MP4 (without
 * text) is already stored in S3. Only the text stamp and GIF conversion are re-run.
 *
 * Body: { greeting: string, ctaText: string }
 * Returns: { success: true, gifUrl: string }
 */
router.post('/generations/:id/restamp-text', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { greeting, ctaText } = req.body;

  if (!greeting && !ctaText) {
    return res.status(400).json({ error: 'At least one of greeting or ctaText is required' });
  }

  try {
    // Fetch the generation row owned by this user
    const { data: generation, error: fetchError } = await req.supabase
      .from('generations')
      .select('id, mp4_no_text_url, first_name')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !generation) {
      return res.status(404).json({ error: 'Generation not found' });
    }

    if (!generation.mp4_no_text_url) {
      return res.status(409).json({
        error: 'This generation was created before text re-stamping was supported.',
      });
    }

    console.log(`[Restamp] Re-applying text for generation ${id}`);
    const { mp4WithTextUrl, gifUrl } = await applyTextAndConvertToGif(
      generation.mp4_no_text_url, {
        greeting: greeting || `Hey, ${generation.first_name}!`,
        ctaText: ctaText || 'Open to talk?',
      }
    );

    const { error: updateError } = await req.supabase
      .from('generations')
      .update({ gif_url: gifUrl })
      .eq('id', id)
      .eq('user_id', req.user.id);

    if (updateError) {
      throw updateError;
    }

    console.log(`[Restamp] Done for generation ${id}: ${gifUrl}`);
    res.json({ success: true, gifUrl });
  } catch (err) {
    console.error('[Restamp] Error:', err.message);
    await trackError({
      source: 'generate',
      route: '/api/generate/generations/:id/restamp-text',
      method: 'POST',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to restamp text',
      stack: err.stack || null,
      context: { generationId: id },
    });
    res.status(500).json({ error: 'Failed to restamp text' });
  }
});

module.exports = router;
