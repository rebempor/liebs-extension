const express = require('express');
const { requireAuth, supabase } = require('../middleware/auth');
const { trackError } = require('../services/errorTracker');

const router = express.Router();

function isMissingMonitoringTables(err) {
  return Boolean(
    err &&
      err.code === 'PGRST205' &&
      /(generation_jobs|error_events)/.test(err.message || '')
  );
}

function toHours(value, fallback = 24) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 24 * 30);
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeJobs(jobs) {
  const counts = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  const errorCodeCounts = {};
  const completedDurations = [];

  for (const job of jobs) {
    const status = job.status;
    if (counts[status] !== undefined) {
      counts[status] += 1;
    }

    if (status === 'failed') {
      const code = job.error_code || 'UNKNOWN';
      errorCodeCounts[code] = (errorCodeCounts[code] || 0) + 1;
    }

    if (status === 'completed' && Number.isFinite(Number(job.duration_seconds))) {
      completedDurations.push(Number(job.duration_seconds));
    }
  }

  const finished = counts.completed + counts.failed;
  const successRate = finished > 0 ? (counts.completed / finished) * 100 : 0;
  const failureRate = finished > 0 ? (counts.failed / finished) * 100 : 0;
  const avgDurationSeconds = completedDurations.length > 0
    ? completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length
    : 0;

  const topErrorCodes = Object.entries(errorCodeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  return {
    totalJobs: jobs.length,
    queued: counts.queued,
    processing: counts.processing,
    completed: counts.completed,
    failed: counts.failed,
    successRate: round(successRate, 1),
    failureRate: round(failureRate, 1),
    avgDurationSeconds: round(avgDurationSeconds, 1),
    topErrorCodes,
  };
}

function parseMonitoringKey(req) {
  const explicitHeader = req.headers['x-monitoring-key'];
  if (typeof explicitHeader === 'string' && explicitHeader.trim()) {
    return explicitHeader.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
}

function requireMonitoringKey(req, res, next) {
  const configuredKey = process.env.MONITORING_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({
      error: 'Monitoring is not configured',
      code: 'MONITORING_NOT_CONFIGURED',
    });
  }

  const providedKey = parseMonitoringKey(req);
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Unauthorized monitoring request' });
  }

  next();
}

async function getMonitoringSummary({ userId = null, hours = 24 }) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let jobsQuery = supabase
    .from('generation_jobs')
    .select('status, error_code, duration_seconds, created_at')
    .gte('created_at', since);

  if (userId) {
    jobsQuery = jobsQuery.eq('user_id', userId);
  }

  const { data: jobs, error: jobsError } = await jobsQuery;
  if (jobsError) {
    throw jobsError;
  }

  let errorsQuery = supabase
    .from('error_events')
    .select('source, route, error_code, message, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);

  if (userId) {
    errorsQuery = errorsQuery.eq('user_id', userId);
  }

  const { data: recentErrors, error: recentErrorsError } = await errorsQuery;
  if (recentErrorsError && recentErrorsError.code !== 'PGRST205') {
    throw recentErrorsError;
  }

  return {
    windowHours: hours,
    windowStart: since,
    generatedAt: new Date().toISOString(),
    jobSummary: summarizeJobs(jobs || []),
    recentErrors: recentErrors || [],
  };
}

/**
 * GET /api/monitoring/summary
 * Per-user reliability metrics for the current authenticated user.
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const hours = toHours(req.query.hours, 24 * 7);
    const summary = await getMonitoringSummary({
      userId: req.user.id,
      hours,
    });

    res.json(summary);
  } catch (err) {
    console.error('[Monitoring] User summary error:', err.message);
    const schemaMissing = isMissingMonitoringTables(err);
    await trackError({
      source: 'monitoring',
      route: '/api/monitoring/summary',
      method: 'GET',
      statusCode: schemaMissing ? 503 : 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message,
      stack: err.stack || null,
    });
    if (schemaMissing) {
      return res.status(503).json({
        error: 'Monitoring schema is not ready yet',
        code: 'MONITORING_SCHEMA_MISSING',
      });
    }
    res.status(500).json({ error: 'Failed to load monitoring summary' });
  }
});

/**
 * GET /api/monitoring/admin/summary
 * Global reliability metrics (all users), protected with MONITORING_API_KEY.
 */
router.get('/admin/summary', requireMonitoringKey, async (req, res) => {
  try {
    const hours = toHours(req.query.hours, 24 * 7);
    const summary = await getMonitoringSummary({
      userId: null,
      hours,
    });

    res.json(summary);
  } catch (err) {
    console.error('[Monitoring] Admin summary error:', err.message);
    const schemaMissing = isMissingMonitoringTables(err);
    await trackError({
      source: 'monitoring',
      route: '/api/monitoring/admin/summary',
      method: 'GET',
      statusCode: schemaMissing ? 503 : 500,
      errorCode: err.code || null,
      message: err.message,
      stack: err.stack || null,
    });
    if (schemaMissing) {
      return res.status(503).json({
        error: 'Monitoring schema is not ready yet',
        code: 'MONITORING_SCHEMA_MISSING',
      });
    }
    res.status(500).json({ error: 'Failed to load admin monitoring summary' });
  }
});

module.exports = router;
