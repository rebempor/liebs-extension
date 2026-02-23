const { supabase } = require('../middleware/auth');
const { runGenerationPipeline } = require('./generationPipeline');
const { trackError } = require('./errorTracker');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const JOB_POLL_INTERVAL_MS = readPositiveNumber(process.env.GENERATION_JOB_POLL_MS, 3000);
const STALE_JOB_MINUTES = readPositiveNumber(process.env.GENERATION_JOB_STALE_MINUTES, 30);

let workerStarted = false;
let processingTick = false;
let missingQueueTableLogged = false;

function nowIso() {
  return new Date().toISOString();
}

function isMissingQueueTableError(err) {
  return Boolean(
    err &&
      (err.code === 'PGRST205' ||
        /generation_jobs/.test(err.message || ''))
  );
}

async function enqueueGenerationJob({
  userId,
  photoUrl,
  photoBase64,
  firstName,
  greeting,
  ctaText,
}) {
  const { data, error } = await supabase
    .from('generation_jobs')
    .insert({
      user_id: userId,
      status: JOB_STATUS.QUEUED,
      photo_url: photoUrl || null,
      photo_base64: photoBase64 || null,
      first_name: firstName,
      greeting: greeting || `Hey, ${firstName}!`,
      cta_text: ctaText || 'Open to talk?',
      updated_at: nowIso(),
    })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  processNextJob().catch((err) => {
    console.error('[Jobs] Failed to process job after enqueue:', err.message);
  });

  return data;
}

async function getGenerationJob(jobId, userId) {
  const { data, error } = await supabase
    .from('generation_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function claimNextQueuedJob() {
  const { data: queuedRows, error: queuedError } = await supabase
    .from('generation_jobs')
    .select('*')
    .eq('status', JOB_STATUS.QUEUED)
    .order('created_at', { ascending: true })
    .limit(1);

  if (queuedError) {
    if (isMissingQueueTableError(queuedError)) {
      if (!missingQueueTableLogged) {
        missingQueueTableLogged = true;
        console.warn('[Jobs] generation_jobs table is missing. Apply migration to enable async generation worker.');
      }
      return null;
    }

    throw queuedError;
  }

  if (missingQueueTableLogged) {
    missingQueueTableLogged = false;
    console.log('[Jobs] generation_jobs table detected. Worker resumed.');
  }

  if (!queuedRows || queuedRows.length === 0) {
    return null;
  }

  const candidate = queuedRows[0];
  const startedAt = nowIso();

  const { data: claimedRows, error: claimError } = await supabase
    .from('generation_jobs')
    .update({
      status: JOB_STATUS.PROCESSING,
      started_at: startedAt,
      updated_at: startedAt,
      error: null,
      error_code: null,
    })
    .eq('id', candidate.id)
    .eq('status', JOB_STATUS.QUEUED)
    .select('*');

  if (claimError) {
    throw claimError;
  }

  if (!claimedRows || claimedRows.length === 0) {
    return null;
  }

  return claimedRows[0];
}

async function markJobCompleted(jobId, result) {
  const completedAt = nowIso();

  const { error } = await supabase
    .from('generation_jobs')
    .update({
      status: JOB_STATUS.COMPLETED,
      gif_url: result.gifUrl,
      mp4_url: result.mp4Url,
      pixar_image_url: result.pixarImageUrl,
      video_url: result.videoUrl,
      credits_remaining: result.creditsRemaining,
      duration_seconds: result.durationSeconds,
      generation_id: result.generationId,
      completed_at: completedAt,
      updated_at: completedAt,
      error: null,
      error_code: null,
    })
    .eq('id', jobId);

  if (error) {
    throw error;
  }
}

async function markJobFailed(jobId, userId, err) {
  const completedAt = nowIso();

  const { error } = await supabase
    .from('generation_jobs')
    .update({
      status: JOB_STATUS.FAILED,
      error: err.message || 'Generation failed',
      error_code: err.code || null,
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq('id', jobId);

  if (error) {
    console.error('[Jobs] Failed to mark job as failed:', error.message);
  }

  await trackError({
    source: 'generation-jobs',
    route: 'worker/process-job',
    method: 'ASYNC',
    statusCode: 500,
    userId: userId || null,
    errorCode: err.code || null,
    message: err.message || 'Generation job failed',
    stack: err.stack || null,
    context: {
      jobId,
    },
  });
}

async function processClaimedJob(job) {
  console.log(`[Jobs] Processing job ${job.id} for user ${job.user_id}`);

  try {
    const result = await runGenerationPipeline({
      supabase,
      userId: job.user_id,
      photoUrl: job.photo_url,
      photoBase64: job.photo_base64,
      firstName: job.first_name,
      greeting: job.greeting,
      ctaText: job.cta_text,
    });

    await markJobCompleted(job.id, result);
    console.log(`[Jobs] Job ${job.id} completed`);
  } catch (err) {
    console.error(`[Jobs] Job ${job.id} failed:`, err.message);
    await markJobFailed(job.id, job.user_id, err);
  }
}

async function processNextJob() {
  if (processingTick) {
    return;
  }

  processingTick = true;
  try {
    const job = await claimNextQueuedJob();
    if (!job) {
      return;
    }

    await processClaimedJob(job);

    // Drain queue quickly after finishing one job.
    process.nextTick(() => {
      processNextJob().catch((err) => {
        console.error('[Jobs] Failed to continue queue drain:', err.message);
      });
    });
  } finally {
    processingTick = false;
  }
}

async function requeueStaleProcessingJobs() {
  if (!Number.isFinite(STALE_JOB_MINUTES) || STALE_JOB_MINUTES <= 0) {
    return;
  }

  const staleBefore = new Date(Date.now() - STALE_JOB_MINUTES * 60 * 1000).toISOString();
  const resetAt = nowIso();

  const { error } = await supabase
    .from('generation_jobs')
    .update({
      status: JOB_STATUS.QUEUED,
      started_at: null,
      updated_at: resetAt,
      error: null,
      error_code: null,
    })
    .eq('status', JOB_STATUS.PROCESSING)
    .lt('started_at', staleBefore);

  if (error) {
    if (isMissingQueueTableError(error)) {
      if (!missingQueueTableLogged) {
        missingQueueTableLogged = true;
        console.warn('[Jobs] generation_jobs table is missing. Apply migration to enable async generation worker.');
      }
      return;
    }

    console.error('[Jobs] Failed to requeue stale jobs:', error.message);
  }
}

function startGenerationJobWorker() {
  if (workerStarted) {
    return;
  }

  workerStarted = true;
  console.log(`[Jobs] Worker started (poll interval: ${JOB_POLL_INTERVAL_MS}ms)`);

  requeueStaleProcessingJobs().catch((err) => {
    console.error('[Jobs] Initial stale-job requeue failed:', err.message);
  });

  setInterval(() => {
    processNextJob().catch((err) => {
      console.error('[Jobs] Poll tick failed:', err.message);
    });
  }, JOB_POLL_INTERVAL_MS);

  processNextJob().catch((err) => {
    console.error('[Jobs] Initial queue drain failed:', err.message);
  });
}

module.exports = {
  JOB_STATUS,
  enqueueGenerationJob,
  getGenerationJob,
  startGenerationJobWorker,
};
