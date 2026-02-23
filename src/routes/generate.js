const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  JOB_STATUS,
  enqueueGenerationJob,
  getGenerationJob,
} = require('../services/generationJobs');
const { trackError } = require('../services/errorTracker');

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
    const { photoUrl, photoBase64, firstName, greeting, ctaText } = req.body;

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

module.exports = router;
