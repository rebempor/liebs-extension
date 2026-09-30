// Shared runtime-safe helpers for content scripts, popup, and background worker.
// Keep this file DOM-agnostic so it can run in every extension context.

const API_BASE_URL = 'https://api.liebs.app'; // Production
const WEB_APP_URL = 'https://liebs.app';
const OUTREACH_DURATION_MS = 90 * 60 * 1000;
const VIDEO_POLL_PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_POLL_MAX_FAILURES = 3;
const VIDEO_POLL_MAX_RETRY_DELAY_MS = 15000;
const RATE_LIMIT_ERROR_CODES = new Set([
  'API_RATE_LIMITED',
  'JOB_POLL_RATE_LIMITED',
  'VIDEO_PROJECT_POLL_RATE_LIMITED',
  'EXPENSIVE_ROUTE_RATE_LIMITED',
  'PRE_PROCESS_RATE_LIMITED',
  'AUTH_RATE_LIMITED',
  'SIGNUP_RATE_LIMITED',
]);
const RETRIABLE_API_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

function buildApiError(response, payload = {}, fallbackMessage = null) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const message =
    safePayload.error ||
    safePayload.message ||
    fallbackMessage ||
    `Request failed (${response?.status || 'unknown'})`;

  const error = new Error(message);
  error.code =
    (typeof safePayload.code === 'string' && safePayload.code.trim()) ||
    (typeof safePayload.errorCode === 'string' && safePayload.errorCode.trim()) ||
    null;
  error.status = Number.isFinite(Number(response?.status)) ? Number(response.status) : null;

  const retryAfterMs = parseRetryAfterMs(
    typeof response?.headers?.get === 'function'
      ? response.headers.get('Retry-After')
      : null
  );
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    error.retryAfterMs = retryAfterMs;
  }

  return error;
}

function isRateLimitCode(code) {
  return typeof code === 'string' && RATE_LIMIT_ERROR_CODES.has(code);
}

function isRetriableApiError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (isRateLimitCode(error.code)) {
    return true;
  }

  if (RETRIABLE_API_STATUS_CODES.has(Number(error.status))) {
    return true;
  }

  return /timed out|network error|failed to fetch/i.test(error.message || '');
}

function getFriendlyApiErrorMessage(error, options = {}) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const context = typeof options?.context === 'string' ? options.context : 'generic';

  if (code === 'JOB_POLL_RATE_LIMITED') {
    return 'We are checking too often right now. Your GIF may still finish — check history in a minute.';
  }

  if (code === 'VIDEO_PROJECT_POLL_RATE_LIMITED') {
    return 'We are checking video status too often right now. Your video may still finish. Check back in a minute.';
  }

  if (code === 'API_RATE_LIMITED') {
    return context === 'auth'
      ? 'The app is a little busy right now. Showing your saved details while we wait.'
      : 'The app is getting too many requests right now. Give it a moment and try again.';
  }

  if (code === 'EXPENSIVE_ROUTE_RATE_LIMITED') {
    return 'Too many new GIFs were started at once. Give it a minute, then try again.';
  }

  if (code === 'PRE_PROCESS_RATE_LIMITED') {
    return 'Too many profiles were prepped too quickly. Wait a bit, then try again.';
  }

  if (code === 'AUTH_RATE_LIMITED' || code === 'SIGNUP_RATE_LIMITED') {
    return 'Too many sign-in attempts right now. Please wait a moment and try again.';
  }

  if (code === 'JOB_QUEUE_NOT_READY') {
    return 'The generation queue is waking up. Please try again in a moment.';
  }

  if (code === 'PRE_PROCESS_NOT_READY') {
    return 'The profile warm-up lane is not ready yet. Please try again shortly.';
  }

  if (code === 'VIDEO_PROJECT_SCHEMA_MISSING') {
    return 'The video studio is not fully set up yet. The server still needs the latest database update.';
  }

  if (error?.status === 503) {
    return 'The server is catching up right now. Please try again in a moment.';
  }

  if (error?.message) {
    return error.message;
  }

  return context === 'auth'
    ? 'Could not verify your account right now. Showing saved details.'
    : 'Something interrupted the request. Please try again.';
}

function resolveVideoPollRetryDelayMs(error, failureCount, fallbackMs) {
  const baseDelayMs = Math.max(1000, Number(fallbackMs) || 3000);
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(VIDEO_POLL_MAX_RETRY_DELAY_MS, Math.max(baseDelayMs, retryAfterMs));
  }

  if (Number(failureCount) <= 1) {
    return baseDelayMs;
  }

  if (Number(failureCount) === 2) {
    return Math.min(VIDEO_POLL_MAX_RETRY_DELAY_MS, baseDelayMs * 2);
  }

  return Math.min(VIDEO_POLL_MAX_RETRY_DELAY_MS, baseDelayMs * 4);
}

function extractSilhouetteUrl(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.silhouetteUrl || payload.silhouette_url || null;
}

function extractLiebsImageUrl(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.liebsImageUrl || payload.liebs_image_url || null;
}

function extractRenderProgress(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.renderProgress ?? payload.render_progress;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}
