// LinkedIn Liebs GIF Generator - Background Script (SaaS Version)
// Calls backend API instead of direct AI services

const backgroundGlobal = typeof globalThis !== 'undefined' ? globalThis : self;

if (typeof backgroundGlobal.window === 'undefined') {
  backgroundGlobal.window = backgroundGlobal;
}

try {
  importScripts('vendor/sentry.min.js', 'sentry-init.js');
  if (typeof initExtensionSentry === 'function') {
    initExtensionSentry({
      source: 'background',
    });
  }
} catch (error) {
  console.warn('[Sentry] Background telemetry disabled:', error?.message || error);
}

importScripts('shared-core.js', 'lib/posthog.js', 'analytics.js');

console.log('[Liebs GIF] SaaS background script loaded');

function trackBackgroundError(eventName, error, context = {}) {
  if (typeof captureExtensionError === 'function') {
    captureExtensionError(eventName, error, context);
  }
}

function addBackgroundBreadcrumb(message, data = {}, level = 'info') {
  if (typeof addExtensionBreadcrumb === 'function') {
    addExtensionBreadcrumb(message, data, level);
  }
}


const activeGenerationsByTab = new Map();
const preProcessRequestsByFingerprint = new Map();
const GENERATION_CANCELLED_CODE = 'GENERATION_CANCELLED';
const AUTH_EXPIRED_CODE = 'AUTH_EXPIRED';
const OUTREACH_ALARM_NAME = 'outreach-mode-auto-stop';
const GENERATION_KEEPALIVE_ALARM_NAME = 'generation-job-keepalive';
const ACTIVE_GENERATIONS_STORAGE_KEY = 'activeGenerationSessionsV1';
const RECENT_BACKGROUND_RESULTS_KEY = 'recentBackgroundGenerationResultsV1';
const MAX_STORED_BACKGROUND_RESULTS = 25;
const MAX_PARALLEL_GENERATIONS = 2;
const MAX_PARALLEL_PRE_PROCESS_REQUESTS = 1;
const MAX_BATCH_JOB_STATUS_IDS = 20;
const ACCOUNT_SNAPSHOT_TTL_MS = 30000;
const PIPELINE_STAGES = new Set(['queued', 'image', 'video', 'compose']);
const STAGE_DELAY_THRESHOLDS = {
  queued: 3,
  image: 7,
  video: 15,
  compose: 5,
};
const STAGE_WARNING_THRESHOLDS = {
  video: 20, // ~60s — show warning banner in sidecar
};
const STAGE_TIME_HINTS = {
  video: 'usually takes ~30s',
  compose: '~5s left',
};
const POLL_INTERVAL_DEFAULT_MS = 3000;
const POLL_INTERVAL_EARLY_MS = 2000;
const POLL_INTERVAL_MAX_MS = 15000;
const MAX_TRANSIENT_POLL_FAILURES = 12;
const MAX_FATAL_POLL_FAILURES = 3;
const EARLY_POLL_STAGES = new Set(['queued', 'image']);
const STAGE_MESSAGES = {
  queued: [
    'Warming up the studio...',
    'Preparing the canvas...',
    'Getting your scene ready...',
  ],
  image: [
    'Mixing the character palette...',
    'Sculpting their look...',
    'Refining the stylized look...',
  ],
  video: [
    'Teaching them to move...',
    'Animating frame by frame...',
    'Bringing the motion to life...',
  ],
  compose: [
    'Putting the finishing touches...',
    'Wrapping up your masterpiece...',
    'Sealing the final render...',
  ],
  delay: [
    'Taking a bit longer than usual...',
    'Good things take a moment...',
    'Hang tight, still working on it...',
  ],
};
const generationWaitQueue = [];
const preProcessTaskQueue = [];
let activePreProcessTasks = 0;
let sharedPollTimer = null;
let sharedPollInFlight = false;
let cachedAccountSnapshot = null;
let cachedAccountSnapshotExpiresAt = 0;
let accountSnapshotRequestPromise = null;
let accountSnapshotVersion = 0;

initializeAnalytics();
syncAnalyticsIdentityFromStorage().catch((error) => {
  console.warn('[Analytics] Failed to restore identity from storage:', error?.message || error);
});

async function syncAnalyticsIdentityFromStorage() {
  const result = await chrome.storage.sync.get(['authToken', 'userEmail']);
  if (result?.authToken && result?.userEmail) {
    identifyAnalyticsUser(result.userEmail, { email: result.userEmail });
  }
}

function clearAccountSnapshotCache() {
  accountSnapshotVersion += 1;
  cachedAccountSnapshot = null;
  cachedAccountSnapshotExpiresAt = 0;
  accountSnapshotRequestPromise = null;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function cacheAccountSnapshot(snapshot, ttlMs = ACCOUNT_SNAPSHOT_TTL_MS, version = accountSnapshotVersion) {
  const normalizedSnapshot = {
    authenticated: Boolean(snapshot?.authenticated),
    email: typeof snapshot?.email === 'string' ? snapshot.email : null,
    credits: normalizeOptionalNumber(snapshot?.credits),
    code: typeof snapshot?.code === 'string' ? snapshot.code : null,
    error: typeof snapshot?.error === 'string' ? snapshot.error : null,
  };

  if (version !== accountSnapshotVersion) {
    return { ...normalizedSnapshot };
  }

  cachedAccountSnapshot = normalizedSnapshot;
  cachedAccountSnapshotExpiresAt = Date.now() + Math.max(1000, Number(ttlMs) || ACCOUNT_SNAPSHOT_TTL_MS);
  return { ...cachedAccountSnapshot };
}

function updateCachedAccountCredits(credits) {
  if (!Number.isFinite(Number(credits))) {
    return;
  }

  const nextSnapshot = cachedAccountSnapshot && cachedAccountSnapshot.authenticated
    ? { ...cachedAccountSnapshot, credits: Number(credits), code: null, error: null }
    : {
        authenticated: true,
        email: null,
        credits: Number(credits),
        code: null,
        error: null,
      };

  cacheAccountSnapshot(nextSnapshot);
}

async function fetchFreshAccountSnapshot() {
  const requestVersion = accountSnapshotVersion;
  const result = await chrome.storage.sync.get(['authToken']);
  if (!result.authToken) {
    return cacheAccountSnapshot({ authenticated: false }, ACCOUNT_SNAPSHOT_TTL_MS, requestVersion);
  }

  const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`, {
    headers: {
      'Authorization': `Bearer ${result.authToken}`
    }
  }, 8000);

  if (response.ok) {
    const data = await response.json();
    return cacheAccountSnapshot({
      authenticated: true,
      email: typeof data?.user?.email === 'string' ? data.user.email : null,
      credits: data?.credits,
    }, ACCOUNT_SNAPSHOT_TTL_MS, requestVersion);
  }

  const data = await response.json().catch(() => ({}));
  const error = buildApiError(response, data, 'Failed to verify account');
  return cacheAccountSnapshot({
    authenticated: false,
    code: error.code || null,
    error: getFriendlyApiErrorMessage(error, { context: 'auth' }),
  }, ACCOUNT_SNAPSHOT_TTL_MS, requestVersion);
}

async function getCachedAccountSnapshot({ forceRefresh = false } = {}) {
  const isFresh = Boolean(cachedAccountSnapshot) && Date.now() < cachedAccountSnapshotExpiresAt;
  if (!forceRefresh && isFresh) {
    return { ...cachedAccountSnapshot };
  }

  if (accountSnapshotRequestPromise) {
    return accountSnapshotRequestPromise.then((snapshot) => ({ ...snapshot }));
  }

  const requestVersion = accountSnapshotVersion;
  accountSnapshotRequestPromise = fetchFreshAccountSnapshot()
    .catch((error) => {
      if (requestVersion === accountSnapshotVersion && cachedAccountSnapshot?.authenticated) {
        return { ...cachedAccountSnapshot };
      }
      throw error;
    })
    .finally(() => {
      accountSnapshotRequestPromise = null;
    });

  return accountSnapshotRequestPromise.then((snapshot) => ({ ...snapshot }));
}

function normalizeTrackingProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined) continue;
    if (
      rawValue === null ||
      typeof rawValue === 'string' ||
      typeof rawValue === 'number' ||
      typeof rawValue === 'boolean'
    ) {
      normalized[key] = rawValue;
      continue;
    }
    if (rawValue instanceof Date) {
      normalized[key] = rawValue.toISOString();
      continue;
    }
    normalized[key] = String(rawValue);
  }

  return normalized;
}

function inferTrackingSource(sender) {
  if (typeof sender?.url === 'string' && sender.url.includes('/popup/')) {
    return 'popup';
  }
  if (typeof sender?.tab?.url === 'string' && sender.tab.url.includes('linkedin.com')) {
    return 'content';
  }
  if (Number.isInteger(sender?.tab?.id)) {
    return 'tab';
  }
  return 'background';
}

function handleTrackEventRequest(request, sender) {
  const eventName = typeof request?.eventName === 'string' ? request.eventName.trim() : '';
  if (!eventName) {
    return;
  }

  const properties = normalizeTrackingProperties(request.properties);
  const source = typeof request?.source === 'string' ? request.source : inferTrackingSource(sender);
  if (!properties.source) {
    properties.source = source;
  }
  if (Number.isInteger(sender?.tab?.id) && properties.tab_id === undefined) {
    properties.tab_id = sender.tab.id;
  }

  trackAnalyticsEvent(eventName, properties);
}

function normalizeLinkedInProfileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    const hostname = String(url.hostname || '').toLowerCase();
    if (!hostname.endsWith('linkedin.com')) {
      return null;
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (!normalizedPath) {
      return null;
    }

    return `${url.origin.toLowerCase()}${normalizedPath.toLowerCase()}`;
  } catch (_error) {
    return null;
  }
}

function buildGenerationDedupeKey({ profileUrl, photoFingerprint } = {}) {
  const normalizedProfileUrl = normalizeLinkedInProfileUrl(profileUrl);
  const normalizedFingerprint = normalizeFingerprint(photoFingerprint);

  if (normalizedProfileUrl && normalizedFingerprint) {
    return `profile:${normalizedProfileUrl}|photo:${normalizedFingerprint}`;
  }
  if (normalizedProfileUrl) {
    return `profile:${normalizedProfileUrl}`;
  }
  if (normalizedFingerprint) {
    return `photo:${normalizedFingerprint}`;
  }
  return null;
}

function findActiveGenerationByDedupeKey(dedupeKey, { excludeTabId = null } = {}) {
  if (!dedupeKey) {
    return null;
  }

  for (const session of activeGenerationsByTab.values()) {
    if (!session || session.resultSettled || session.executionState === 'finished') {
      continue;
    }
    if (Number.isInteger(excludeTabId) && session.tabId === excludeTabId) {
      continue;
    }
    if (session.dedupeKey === dedupeKey) {
      return session;
    }
  }

  return null;
}

function createSerializableGenerationSession(session) {
  if (!session || !Number.isInteger(session.tabId) || !session.jobId || !session.authToken) {
    return null;
  }
  return {
    tabId: session.tabId,
    jobId: session.jobId,
    authToken: session.authToken,
    profileUrl: session.profileUrl || null,
    firstName: session.firstName || null,
    dedupeKey: session.dedupeKey || null,
    startedAt: session.startedAt || Date.now(),
  };
}

function hydrateGenerationSession(rawSession) {
  if (!rawSession || !Number.isInteger(rawSession.tabId) || !rawSession.jobId || !rawSession.authToken) {
    return null;
  }

  return {
    tabId: rawSession.tabId,
    authToken: rawSession.authToken,
    jobId: rawSession.jobId,
    profileUrl: rawSession.profileUrl || null,
    firstName: rawSession.firstName || null,
    dedupeKey:
      (typeof rawSession.dedupeKey === 'string' && rawSession.dedupeKey) ||
      buildGenerationDedupeKey({ profileUrl: rawSession.profileUrl }),
    startedAt: rawSession.startedAt || Date.now(),
    cancelRequested: false,
    cancelRequestInFlight: false,
    restoredFromStorage: true,
    executionState: 'active',
  };
}

function serializeActiveGenerations() {
  const sessions = {};
  for (const [tabId, session] of activeGenerationsByTab.entries()) {
    const serializable = createSerializableGenerationSession(session);
    if (serializable) {
      sessions[String(tabId)] = serializable;
    }
  }
  return sessions;
}

async function persistActiveGenerationsToStorage() {
  const sessions = serializeActiveGenerations();
  await chrome.storage.local.set({ [ACTIVE_GENERATIONS_STORAGE_KEY]: sessions });
}

async function updateGenerationKeepAliveAlarm() {
  if (activeGenerationsByTab.size > 0) {
    chrome.alarms.create(GENERATION_KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
    return;
  }
  await chrome.alarms.clear(GENERATION_KEEPALIVE_ALARM_NAME);
}

async function mirrorActiveGenerationsState() {
  try {
    await persistActiveGenerationsToStorage();
    await updateGenerationKeepAliveAlarm();
  } catch (err) {
    console.warn('[Liebs GIF] Failed to mirror active generation state:', err.message);
  }
}

async function appendCompletedGenerationResult(session, resultPayload) {
  const gifUrl = resultPayload?.gifUrl || resultPayload?.gif_url || null;
  if (!gifUrl) {
    return;
  }

  try {
    const existing = await chrome.storage.local.get([RECENT_BACKGROUND_RESULTS_KEY]);
    const records = Array.isArray(existing?.[RECENT_BACKGROUND_RESULTS_KEY])
      ? existing[RECENT_BACKGROUND_RESULTS_KEY]
      : [];

    const nextRecord = {
      tabId: session?.tabId ?? null,
      jobId: session?.jobId ?? null,
      firstName: session?.firstName || null,
      profileUrl: session?.profileUrl || null,
      generationId: resultPayload?.generationId || resultPayload?.generation_id || null,
      gifUrl,
      completedAt: new Date().toISOString(),
    };

    const deduped = records.filter((record) => record?.jobId !== nextRecord.jobId);
    deduped.unshift(nextRecord);
    const trimmed = deduped.slice(0, MAX_STORED_BACKGROUND_RESULTS);

    await chrome.storage.local.set({ [RECENT_BACKGROUND_RESULTS_KEY]: trimmed });
  } catch (err) {
    console.warn('[Liebs GIF] Failed to persist completed background generation:', err.message);
  }
}

function createGenerationCancelledError(message = 'Generation cancelled by user') {
  const err = new Error(message);
  err.code = GENERATION_CANCELLED_CODE;
  return err;
}

function isGenerationCancelledError(error) {
  return Boolean(
    error &&
      (error.code === GENERATION_CANCELLED_CODE ||
        /generation cancelled/i.test(error.message || ''))
  );
}

function countRunningGenerations() {
  let count = 0;
  for (const session of activeGenerationsByTab.values()) {
    if (session?.executionState === 'active') {
      count += 1;
    }
  }
  return count;
}

function buildQueueWaitingMessage(queuePosition) {
  const safePosition = Math.max(1, Number(queuePosition) || 1);
  if (safePosition === 1) {
    return 'Preparing your GIF...';
  }
  if (safePosition === 2) {
    return 'Getting your GIF ready...';
  }
  return 'Starting your GIF in the background...';
}

function notifyQueuedGenerationStates() {
  generationWaitQueue.forEach((session, index) => {
    notifyContentScript(session?.tabId, {
      action: 'generationUpdate',
      status: 'generating',
      step: 'Generating...',
      substage: buildQueueWaitingMessage(index + 1),
      progress: Math.min(12, 4 + index),
    });
  });
}

function rejectQueuedGeneration(session, error) {
  if (!session) {
    return false;
  }

  const queueIndex = generationWaitQueue.indexOf(session);
  if (queueIndex === -1) {
    return false;
  }

  generationWaitQueue.splice(queueIndex, 1);
  session.executionState = 'finished';
  const reject = session.queueReject;
  session.queueResolve = null;
  session.queueReject = null;
  notifyQueuedGenerationStates();
  reject?.(error);
  drainGenerationWaitQueue();
  return true;
}

function drainGenerationWaitQueue() {
  while (countRunningGenerations() < MAX_PARALLEL_GENERATIONS && generationWaitQueue.length > 0) {
    const nextSession = generationWaitQueue.shift();
    if (!nextSession) {
      continue;
    }

    if (nextSession.cancelRequested) {
      const reject = nextSession.queueReject;
      nextSession.queueResolve = null;
      nextSession.queueReject = null;
      nextSession.executionState = 'finished';
      reject?.(createGenerationCancelledError());
      continue;
    }

    nextSession.executionState = 'active';
    const resolve = nextSession.queueResolve;
    nextSession.queueResolve = null;
    nextSession.queueReject = null;
    notifyContentScript(nextSession.tabId, {
      action: 'generationUpdate',
      status: 'generating',
      step: 'Generating...',
      substage: 'Starting your GIF...',
      progress: 6,
    });
    resolve?.();
  }

  notifyQueuedGenerationStates();
}

async function waitForGenerationSlot(session) {
  if (!session) {
    return;
  }

  if (session.executionState === 'active') {
    return;
  }

  if (countRunningGenerations() < MAX_PARALLEL_GENERATIONS && generationWaitQueue.length === 0) {
    session.executionState = 'active';
    return;
  }

  session.executionState = 'queued';
  notifyContentScript(session.tabId, {
    action: 'generationUpdate',
    status: 'generating',
    step: 'Generating...',
    substage: 'Preparing your GIF...',
    progress: 5,
  });

  await new Promise((resolve, reject) => {
    session.queueResolve = resolve;
    session.queueReject = reject;
    generationWaitQueue.push(session);
    notifyQueuedGenerationStates();
  });
}

function releaseGenerationSlot(session) {
  if (!session) {
    return;
  }

  if (session.executionState === 'queued') {
    rejectQueuedGeneration(session, createGenerationCancelledError());
    return;
  }

  if (session.executionState === 'active') {
    session.executionState = 'finished';
  }

  session.queueResolve = null;
  session.queueReject = null;
  drainGenerationWaitQueue();
}

function drainPreProcessTaskQueue() {
  while (activePreProcessTasks < MAX_PARALLEL_PRE_PROCESS_REQUESTS && preProcessTaskQueue.length > 0) {
    const queuedTask = preProcessTaskQueue.shift();
    if (!queuedTask) {
      continue;
    }

    activePreProcessTasks += 1;
    Promise.resolve()
      .then(() => queuedTask.taskFactory())
      .then((value) => queuedTask.resolve(value))
      .catch((error) => queuedTask.reject(error))
      .finally(() => {
        activePreProcessTasks = Math.max(0, activePreProcessTasks - 1);
        drainPreProcessTaskQueue();
      });
  }
}

function enqueuePreProcessTask(taskFactory) {
  return new Promise((resolve, reject) => {
    preProcessTaskQueue.push({ taskFactory, resolve, reject });
    drainPreProcessTaskQueue();
  });
}

function resolvePollRetryDelayMs(error, failureCount, fallbackMs) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(POLL_INTERVAL_MAX_MS, Math.max(fallbackMs, retryAfterMs));
  }

  const multiplier = Math.min(5, Math.max(1, failureCount));
  return Math.min(POLL_INTERVAL_MAX_MS, fallbackMs * multiplier);
}

function resolveStage(status, currentStep) {
  if (status === 'queued') {
    return 'queued';
  }

  if (PIPELINE_STAGES.has(currentStep)) {
    return currentStep;
  }

  if (status === 'processing' || status === 'generating') {
    return 'image';
  }

  if (status === 'completed') {
    return 'compose';
  }

  return 'queued';
}

function pickStageMessage(stage, pollCountInStage) {
  const safePollCount = Math.max(1, Number(pollCountInStage) || 1);
  const stageMessages = STAGE_MESSAGES[stage] || STAGE_MESSAGES.queued;
  const stageMessage = stageMessages[(safePollCount - 1) % stageMessages.length];
  const delayThreshold = STAGE_DELAY_THRESHOLDS[stage];

  if (!Number.isFinite(delayThreshold) || safePollCount <= delayThreshold) {
    return stageMessage;
  }

  // Alternate in empathetic delay copy once a stage has exceeded expected time.
  const delayMessages = STAGE_MESSAGES.delay;
  const delayIndex = safePollCount - delayThreshold - 1;
  if (delayIndex % 2 === 0) {
    return delayMessages[delayIndex % delayMessages.length];
  }

  return stageMessage;
}

function computeProgress({ status, attempt, stage, renderProgress }) {
  const queuedProgress = Math.min(30, 8 + attempt * 2);
  if (status === 'queued') {
    return queuedProgress;
  }

  const fallbackProcessingProgress = Math.min(95, 30 + attempt);

  // Real Remotion progress is meaningful during the compose render phase.
  if (stage === 'compose' && Number.isFinite(renderProgress)) {
    return Math.min(95, Math.max(75, Math.round(75 + renderProgress * 20)));
  }

  return fallbackProcessingProgress;
}

async function requestBackendCancel(session) {
  if (!session || !session.authToken || !session.jobId) {
    return;
  }

  if (session.cancelRequestInFlight) {
    return;
  }

  session.cancelRequestInFlight = true;
  try {
    await fetchWithTimeout(
      `${API_BASE_URL}/api/generate/jobs/${session.jobId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.authToken}`
        }
      },
      10000
    );
  } catch (error) {
    console.warn('[Liebs GIF] Failed to notify backend about cancellation:', error.message);
  } finally {
    session.cancelRequestInFlight = false;
  }
}

function createInitialStagePollCounts() {
  return {
    queued: 0,
    image: 0,
    video: 0,
    compose: 0,
  };
}

function ensureSessionPollState(session) {
  if (!session) {
    return null;
  }

  if (!session.pollState) {
    session.pollState = {
      attemptCount: 0,
      consecutivePollFailures: 0,
      pollIntervalMs: POLL_INTERVAL_DEFAULT_MS,
      stagePollCounts: createInitialStagePollCounts(),
      previousStage: null,
      nextPollAt: Date.now(),
      maxPollAttempts: 180,
    };
  }

  return session.pollState;
}

function getPollableSessions() {
  const sessions = [];
  for (const session of activeGenerationsByTab.values()) {
    if (
      session?.executionState === 'active' &&
      session?.jobId &&
      session?.authToken &&
      !session?.resultSettled
    ) {
      sessions.push(session);
    }
  }
  return sessions;
}

function clearSharedPollTimer() {
  if (sharedPollTimer !== null) {
    clearTimeout(sharedPollTimer);
    sharedPollTimer = null;
  }
}

function scheduleSharedPollLoop(delayMs = null) {
  clearSharedPollTimer();

  const sessions = getPollableSessions();
  if (sessions.length === 0) {
    return;
  }

  const now = Date.now();
  let nextDelay = Number.isFinite(delayMs) ? Math.max(0, Number(delayMs)) : null;

  if (nextDelay === null) {
    nextDelay = sessions.reduce((minDelay, session) => {
      const pollState = ensureSessionPollState(session);
      const sessionDelay = Math.max(0, Number(pollState?.nextPollAt || now) - now);
      return minDelay === null ? sessionDelay : Math.min(minDelay, sessionDelay);
    }, null);
  }

  sharedPollTimer = setTimeout(() => {
    sharedPollTimer = null;
    runSharedPollLoop().catch((error) => {
      console.error('[Liebs GIF] Shared job polling failed:', error);
      scheduleSharedPollLoop(POLL_INTERVAL_DEFAULT_MS);
    });
  }, Math.max(0, Number(nextDelay) || 0));
}

function settleSessionResult(session, value) {
  if (!session || session.resultSettled) {
    return;
  }

  addBackgroundBreadcrumb('generation.session_settled', {
    jobId: session.jobId || null,
    tabId: session.tabId || null,
    outcome: 'success',
  });
  session.resultSettled = true;
  session.resultPromise = null;
  session.pollState = null;
  const resolve = session.resolveResult;
  session.resolveResult = null;
  session.rejectResult = null;
  resolve?.(value);
}

function settleSessionError(session, error) {
  if (!session || session.resultSettled) {
    return;
  }

  addBackgroundBreadcrumb('generation.session_settled', {
    jobId: session.jobId || null,
    tabId: session.tabId || null,
    outcome: 'error',
    code: error?.code || null,
    message: error?.message || null,
  });
  session.resultSettled = true;
  session.resultPromise = null;
  session.pollState = null;
  const reject = session.rejectResult;
  session.resolveResult = null;
  session.rejectResult = null;
  reject?.(error);
}

function buildAuthExpiredError(message) {
  const authExpiredError = new Error(
    message || 'Your session expired — check your generation history for the result!'
  );
  authExpiredError.code = AUTH_EXPIRED_CODE;
  return authExpiredError;
}

async function fetchJobStatusesBatch(jobIds, authToken) {
  const response = await fetchWithTimeout(
    `${API_BASE_URL}/api/generate/jobs/status`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ jobIds }),
    },
    10000
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw buildAuthExpiredError(data.error);
    }
    throw buildApiError(response, data, `Failed to check job status (${response.status})`);
  }

  return Array.isArray(data?.jobs) ? data.jobs : [];
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function groupSessionsByAuthToken(sessions) {
  const grouped = new Map();
  sessions.forEach((session) => {
    const key = session?.authToken || '';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(session);
  });
  return grouped;
}

function createMissingJobError(jobId) {
  const error = new Error('Job not found');
  error.code = 'JOB_NOT_FOUND';
  error.status = 404;
  error.jobId = jobId;
  return error;
}

function scheduleSessionRetry(session, delayMs) {
  const pollState = ensureSessionPollState(session);
  pollState.nextPollAt = Date.now() + Math.max(0, Number(delayMs) || POLL_INTERVAL_DEFAULT_MS);
}

function applyRetriablePollError(session, error) {
  const pollState = ensureSessionPollState(session);
  pollState.consecutivePollFailures += 1;
  pollState.pollIntervalMs = resolvePollRetryDelayMs(
    error,
    pollState.consecutivePollFailures,
    pollState.pollIntervalMs || POLL_INTERVAL_DEFAULT_MS
  );
  scheduleSessionRetry(session, pollState.pollIntervalMs);

  notifyContentScript(session.tabId, {
    action: 'generationUpdate',
    status: 'generating',
    step: isRateLimitCode(error?.code) ? 'Waiting...' : 'Reconnecting...',
    substage: getFriendlyApiErrorMessage(error, { context: 'poll' }),
    progress: 65,
    stage: pollState.previousStage || 'video',
    stageDelayed: true,
  });

  if (pollState.consecutivePollFailures >= MAX_TRANSIENT_POLL_FAILURES) {
    trackBackgroundError('generation.poll_failures', error, {
      jobId: session.jobId,
      tabId: session.tabId,
      consecutivePollFailures: pollState.consecutivePollFailures,
      pollIntervalMs: pollState.pollIntervalMs,
      retriable: true,
    });
    settleSessionError(session, error);
    return true;
  }

  return false;
}

function applyFatalPollError(session, error) {
  const pollState = ensureSessionPollState(session);
  pollState.consecutivePollFailures += 1;
  scheduleSessionRetry(session, pollState.pollIntervalMs || POLL_INTERVAL_DEFAULT_MS);

  if (pollState.consecutivePollFailures >= MAX_FATAL_POLL_FAILURES) {
    trackBackgroundError('generation.poll_failures', error, {
      jobId: session.jobId,
      tabId: session.tabId,
      consecutivePollFailures: pollState.consecutivePollFailures,
      pollIntervalMs: pollState.pollIntervalMs,
    });
    settleSessionError(session, error);
    return true;
  }

  return false;
}

function processPolledJobPayload(session, data) {
  const pollState = ensureSessionPollState(session);
  pollState.consecutivePollFailures = 0;

  if (data.status === 'missing') {
    settleSessionError(session, createMissingJobError(session.jobId));
    return;
  }

  const silhouetteUrl = extractSilhouetteUrl(data);
  const liebsImageUrl = extractLiebsImageUrl(data);
  const renderProgress = extractRenderProgress(data);

  if (data.status === 'completed') {
    const gifUrl = data.gifUrl || data.gif_url || null;
    const generationId = data.generationId || data.generation_id || null;
    addBackgroundBreadcrumb('generation.completed', {
      jobId: session.jobId,
      generationId,
      tabId: session.tabId,
    });
    notifyContentScript(session.tabId, {
      action: 'generationUpdate',
      status: 'completed',
      step: 'Completed',
      substage: 'Finalizing…',
      silhouetteUrl,
      liebsImageUrl,
      gifUrl,
      generationId,
      progress: 100,
      stage: 'compose',
    });
    settleSessionResult(session, data);
    return;
  }

  if (data.status === 'failed') {
    const error = new Error(data.error || 'Generation failed');
    error.code = data.errorCode || null;
    settleSessionError(session, error);
    return;
  }

  if (data.status === 'cancelled') {
    const error = createGenerationCancelledError(data.error || 'Generation cancelled by user');
    error.code = data.errorCode || GENERATION_CANCELLED_CODE;
    settleSessionError(session, error);
    return;
  }

  pollState.attemptCount += 1;
  if (pollState.attemptCount >= pollState.maxPollAttempts) {
    const timeoutError = new Error('Generation is taking longer than expected. Please check your history in a few minutes.');
    timeoutError.code = 'JOB_TIMEOUT';
    trackBackgroundError('generation.poll_timeout', timeoutError, {
      jobId: session.jobId,
      tabId: session.tabId,
      maxPollAttempts: pollState.maxPollAttempts,
      pollIntervalMs: pollState.pollIntervalMs,
    });
    settleSessionError(session, timeoutError);
    return;
  }

  const stage = resolveStage(data.status, data.currentStep || null);
  const stageChanged = stage !== pollState.previousStage;
  const progress = computeProgress({
    status: data.status,
    attempt: pollState.attemptCount,
    stage,
    renderProgress,
  });
  pollState.stagePollCounts[stage] = (pollState.stagePollCounts[stage] || 0) + 1;

  if (stageChanged) {
    pollState.previousStage = stage;
    console.log(`[Liebs GIF] Job ${session.jobId} stage -> ${stage}`);
  }

  const visibleStatus = data.status === 'queued' ? 'generating' : data.status;
  const stepLabel = data.status === 'queued'
    ? 'Generating...'
    : stage === 'compose'
      ? 'Finishing...'
      : 'Generating...';
  const warningThreshold = STAGE_WARNING_THRESHOLDS[stage];
  const stageDelayed = Number.isFinite(warningThreshold) && pollState.stagePollCounts[stage] > warningThreshold;
  const shouldUseEarlyPolling = !silhouetteUrl && EARLY_POLL_STAGES.has(stage);
  pollState.pollIntervalMs = shouldUseEarlyPolling ? POLL_INTERVAL_EARLY_MS : POLL_INTERVAL_DEFAULT_MS;
  scheduleSessionRetry(session, pollState.pollIntervalMs);

  notifyContentScript(session.tabId, {
    action: 'generationUpdate',
    status: visibleStatus,
    step: stepLabel,
    substage: pickStageMessage(stage, pollState.stagePollCounts[stage]),
    silhouetteUrl,
    liebsImageUrl,
    progress,
    stage,
    timeHint: stageChanged ? (STAGE_TIME_HINTS[stage] || null) : null,
    renderProgress,
    currentStep: data.currentStep || null,
    stageDelayed,
  });
}

async function runSharedPollLoop() {
  if (sharedPollInFlight) {
    return;
  }

  const now = Date.now();
  const dueSessions = getPollableSessions().filter((session) => {
    const pollState = ensureSessionPollState(session);
    return Number(pollState?.nextPollAt || 0) <= now;
  });

  if (dueSessions.length === 0) {
    scheduleSharedPollLoop();
    return;
  }

  sharedPollInFlight = true;
  try {
    for (const session of dueSessions) {
      if (!session?.cancelRequested) {
        continue;
      }
      await requestBackendCancel(session);
      settleSessionError(session, createGenerationCancelledError());
    }

    const activeDueSessions = dueSessions.filter((session) => !session.resultSettled && !session.cancelRequested);
    const authGroups = groupSessionsByAuthToken(activeDueSessions);

    for (const [authToken, authSessions] of authGroups.entries()) {
      for (const sessionChunk of chunkArray(authSessions, MAX_BATCH_JOB_STATUS_IDS)) {
        const chunkJobIds = sessionChunk.map((session) => session.jobId).filter(Boolean);
        if (chunkJobIds.length === 0) {
          continue;
        }

        try {
          const jobs = await fetchJobStatusesBatch(chunkJobIds, authToken);
          const jobsById = new Map(
            jobs
              .filter((job) => job && typeof job.jobId === 'string')
              .map((job) => [job.jobId, job])
          );

          sessionChunk.forEach((session) => {
            if (session.resultSettled) {
              return;
            }
            const jobPayload = jobsById.get(session.jobId);
            if (!jobPayload) {
              applyFatalPollError(session, createMissingJobError(session.jobId));
              return;
            }
            processPolledJobPayload(session, jobPayload);
          });
        } catch (error) {
          if (error?.code === AUTH_EXPIRED_CODE) {
            sessionChunk.forEach((session) => {
              if (!session.resultSettled) {
                trackBackgroundError('api.auth_expired', error, {
                  endpoint: '/api/generate/jobs/status',
                  jobId: session.jobId,
                  tabId: session.tabId,
                });
                settleSessionError(session, buildAuthExpiredError(error.message));
              }
            });
            continue;
          }

          sessionChunk.forEach((session) => {
            if (session.resultSettled) {
              return;
            }
            if (isRetriableApiError(error)) {
              applyRetriablePollError(session, error);
              return;
            }
            applyFatalPollError(session, error);
          });
        }
      }
    }
  } finally {
    sharedPollInFlight = false;
    scheduleSharedPollLoop();
  }
}

function waitForSharedJobCompletion(session) {
  if (!session) {
    return Promise.reject(new Error('Generation session unavailable'));
  }

  if (session.resultPromise) {
    return session.resultPromise;
  }

  session.resultSettled = false;
  const pollState = ensureSessionPollState(session);
  pollState.nextPollAt = Date.now();

  session.resultPromise = new Promise((resolve, reject) => {
    session.resolveResult = resolve;
    session.rejectResult = reject;
  });

  scheduleSharedPollLoop(0);
  return session.resultPromise;
}

async function pollGenerationJob(jobId, authToken, tabId, session) {
  if (!session) {
    throw new Error('Generation session unavailable');
  }

  session.jobId = jobId;
  session.authToken = authToken;
  session.tabId = tabId;
  const pollState = ensureSessionPollState(session);
  pollState.nextPollAt = Date.now();
  return waitForSharedJobCompletion(session);
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
  return normalized;
}

async function notifyAllLinkedInTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.linkedin.com/*'] });
    await Promise.all(
      tabs.map((tab) => (
        Number.isInteger(tab.id)
          ? chrome.tabs.sendMessage(tab.id, message).catch(() => {})
          : Promise.resolve()
      ))
    );
  } catch (err) {
    console.warn('[Liebs GIF] Failed to notify LinkedIn tabs:', err.message);
  }
}

async function setOutreachMode(enabled, { resetCount = false, reason = 'manual' } = {}) {
  const now = Date.now();
  const outreachEndsAt = enabled ? now + OUTREACH_DURATION_MS : null;
  const existing = await chrome.storage.local.get(['outreachCount']);
  const nextCount = resetCount ? 0 : (Number(existing.outreachCount) || 0);

  const payload = {
    outreachMode: enabled,
    outreachEndsAt,
    outreachActivatedAt: enabled ? now : null,
    outreachCount: nextCount,
  };

  await chrome.storage.local.set(payload);

  if (enabled) {
    await chrome.alarms.clear(OUTREACH_ALARM_NAME);
    chrome.alarms.create(OUTREACH_ALARM_NAME, { when: outreachEndsAt });
  } else {
    await chrome.alarms.clear(OUTREACH_ALARM_NAME);
    preProcessRequestsByFingerprint.clear();
  }

  await notifyAllLinkedInTabs({
    action: 'outreachModeUpdate',
    outreachMode: enabled,
    outreachEndsAt,
  });

  trackAnalyticsEvent('outreach_mode_toggled', {
    enabled: Boolean(enabled),
    reason,
    outreach_count: nextCount,
    auto_stop_at: outreachEndsAt,
  });

  return {
    outreachMode: enabled,
    outreachEndsAt,
    outreachCount: nextCount,
  };
}

async function incrementOutreachCount() {
  const { outreachCount } = await chrome.storage.local.get(['outreachCount']);
  const nextCount = (Number(outreachCount) || 0) + 1;
  await chrome.storage.local.set({ outreachCount: nextCount });
  return nextCount;
}

async function readAuthToken() {
  const result = await chrome.storage.sync.get(['authToken']);
  return result.authToken || null;
}

async function handleStartOutreachMode(sendResponse) {
  try {
    const state = await setOutreachMode(true, { resetCount: true, reason: 'manual_start' });
    sendResponse({ success: true, ...state });
  } catch (err) {
    console.error('[Liebs GIF] startOutreachMode error:', err.message);
    sendResponse({ success: false, error: err.message || 'Failed to start Outreach Mode' });
  }
}

async function handleStopOutreachMode(sendResponse) {
  try {
    const state = await setOutreachMode(false, { reason: 'manual_stop' });
    sendResponse({ success: true, ...state });
  } catch (err) {
    console.error('[Liebs GIF] stopOutreachMode error:', err.message);
    sendResponse({ success: false, error: err.message || 'Failed to stop Outreach Mode' });
  }
}

async function handlePreProcessProfile(request, sendResponse) {
  const {
    photoUrl,
    photoBase64,
    firstName,
    profileUrl,
    photoFingerprint,
  } = request;

  try {
    if (!photoUrl || !firstName) {
      sendResponse({ success: false, error: 'Missing photo URL or first name' });
      return;
    }

    const outreachState = await chrome.storage.local.get(['outreachMode', 'outreachEndsAt']);
    if (!outreachState.outreachMode) {
      sendResponse({ success: false, error: 'Outreach Mode is disabled' });
      return;
    }
    if (Number(outreachState.outreachEndsAt) && Number(outreachState.outreachEndsAt) <= Date.now()) {
      await setOutreachMode(false, { reason: 'expired' });
      sendResponse({ success: false, error: 'Outreach Mode has expired' });
      return;
    }

    const authToken = await readAuthToken();
    if (!authToken) {
      sendResponse({ success: false, error: 'Not authenticated' });
      return;
    }

    const normalizedFingerprint = normalizeFingerprint(photoFingerprint);
    if (normalizedFingerprint && preProcessRequestsByFingerprint.has(normalizedFingerprint)) {
      const cached = await preProcessRequestsByFingerprint.get(normalizedFingerprint);
      trackAnalyticsEvent('profile_preprocessed', {
        deduped: true,
        reused: Boolean(cached?.reused),
        has_preprocess_id: Boolean(cached?.preProcessId),
        outreach_count: cached?.outreachCount ?? null,
      });
      sendResponse({ success: true, deduped: true, ...cached });
      return;
    }

    const requestPromise = enqueuePreProcessTask(async () => {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/generate/pre-process`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            photoUrl,
            photoBase64,
            firstName,
            profileUrl,
          }),
        },
        20000
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw buildApiError(response, data, `Failed to pre-process profile (${response.status})`);
      }

      return {
        preProcessId: data.preProcessId || null,
        status: data.status || null,
        reused: Boolean(data.reused),
      };
    });

    if (normalizedFingerprint) {
      preProcessRequestsByFingerprint.set(normalizedFingerprint, requestPromise);
    }

    const preProcessResult = await requestPromise;
    const outreachCount = await incrementOutreachCount();
    const resultWithCount = { ...preProcessResult, outreachCount };

    if (normalizedFingerprint) {
      preProcessRequestsByFingerprint.set(normalizedFingerprint, Promise.resolve(resultWithCount));
    }

    trackAnalyticsEvent('profile_preprocessed', {
      deduped: false,
      reused: Boolean(resultWithCount.reused),
      has_preprocess_id: Boolean(resultWithCount.preProcessId),
      outreach_count: resultWithCount.outreachCount ?? null,
    });

    sendResponse({ success: true, ...resultWithCount });
  } catch (err) {
    console.error('[Liebs GIF] preProcessProfile error:', err.message);
    const normalizedFingerprint = normalizeFingerprint(photoFingerprint);
    if (normalizedFingerprint) {
      preProcessRequestsByFingerprint.delete(normalizedFingerprint);
    }
    sendResponse({
      success: false,
      code: err?.code || null,
      error: getFriendlyApiErrorMessage(err, { context: 'pre-process' }),
    });
  }
}

async function handleCheckPreProcessStatus(request, sendResponse) {
  try {
    const { preProcessId } = request;
    if (!preProcessId) {
      sendResponse({ success: false, error: 'No preProcessId provided' });
      return;
    }

    const authToken = await readAuthToken();
    if (!authToken) {
      sendResponse({ success: false, error: 'Not authenticated' });
      return;
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/generate/pre-process/${preProcessId}`,
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      },
      10000
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = buildApiError(response, data, 'Failed to check pre-process status');
      sendResponse({
        success: false,
        code: error.code || null,
        error: getFriendlyApiErrorMessage(error, { context: 'pre-process' }),
      });
      return;
    }

    sendResponse({ success: true, ...data });
  } catch (err) {
    console.error('[Liebs GIF] checkPreProcessStatus error:', err.message);
    sendResponse({
      success: false,
      code: err?.code || null,
      error: getFriendlyApiErrorMessage(err, { context: 'pre-process' }),
    });
  }
}

async function resumeGenerationSession(session) {
  const tabId = session?.tabId;
  if (!Number.isInteger(tabId) || !session?.jobId || !session?.authToken) {
    return;
  }

  try {
    session.executionState = 'active';
    console.log(`[Liebs GIF] Resuming generation job ${session.jobId} for tab ${tabId}`);
    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'generating',
      step: 'Resuming...',
      substage: 'Still working in the background...',
      progress: 40
    });

    const jobResult = await pollGenerationJob(session.jobId, session.authToken, tabId, session);
    await appendCompletedGenerationResult(session, jobResult);

    const silhouetteUrl = extractSilhouetteUrl(jobResult);
    const gifUrl = jobResult?.gifUrl || jobResult?.gif_url || null;
    const generationId = jobResult?.generationId || jobResult?.generation_id || null;
    addBackgroundBreadcrumb('generation.completed', {
      jobId: session.jobId || null,
      generationId,
      tabId,
      resumed: true,
    });
    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'complete',
      silhouetteUrl,
      gifUrl,
      generationId,
      progress: 100
    });

    trackAnalyticsEvent('generation_completed', {
      job_id: session.jobId,
      tab_id: tabId,
      generation_id: generationId,
      elapsed_ms: Date.now() - session.startedAt,
      resumed_from_storage: true,
    });
  } catch (error) {
    if (isGenerationCancelledError(error)) {
      notifyContentScript(tabId, {
        action: 'generationUpdate',
        status: 'cancelled',
        error: 'Generation cancelled by user'
      });
      return;
    }

    trackBackgroundError('generation.failed', error, {
      jobId: session?.jobId || null,
      tabId,
      resumed: true,
      code: error?.code || null,
    });

    trackAnalyticsEvent('generation_failed', {
      job_id: session.jobId || null,
      tab_id: tabId,
      code: error?.code || null,
      reason: error?.message || 'Generation failed',
      elapsed_ms: Date.now() - session.startedAt,
      resumed_from_storage: true,
    });

    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'error',
      error: error?.message || 'Generation failed',
      code: error?.code || null
    });
  } finally {
    const activeSession = activeGenerationsByTab.get(tabId);
    if (activeSession === session) {
      releaseGenerationSlot(session);
      activeGenerationsByTab.delete(tabId);
      await mirrorActiveGenerationsState();
    }
  }
}

async function restorePersistedGenerations() {
  try {
    const stored = await chrome.storage.local.get([ACTIVE_GENERATIONS_STORAGE_KEY]);
    const persisted = stored?.[ACTIVE_GENERATIONS_STORAGE_KEY];
    if (!persisted || typeof persisted !== 'object') {
      return;
    }

    const sessionsToResume = [];
    for (const raw of Object.values(persisted)) {
      const session = hydrateGenerationSession(raw);
      if (!session) {
        continue;
      }

      const existing = activeGenerationsByTab.get(session.tabId);
      if (existing?.jobId === session.jobId) {
        continue;
      }

      activeGenerationsByTab.set(session.tabId, session);
      sessionsToResume.push(session);
    }

    if (sessionsToResume.length === 0) {
      await mirrorActiveGenerationsState();
      return;
    }

    await mirrorActiveGenerationsState();
    for (const session of sessionsToResume) {
      resumeGenerationSession(session).catch((err) => {
        console.error('[Liebs GIF] Failed to resume generation session:', err.message);
      });
    }
  } catch (err) {
    console.error('[Liebs GIF] Failed to restore persisted generations:', err.message);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === GENERATION_KEEPALIVE_ALARM_NAME) {
    // No-op: periodic alarm wake keeps service worker active while polling.
    return;
  }

  if (alarm.name !== OUTREACH_ALARM_NAME) {
    return;
  }

  try {
    await setOutreachMode(false, { reason: 'auto_timeout' });
    console.log('[Liebs GIF] Outreach Mode auto-stopped after 90 minutes');
  } catch (err) {
    console.error('[Liebs GIF] Failed to auto-stop Outreach Mode:', err.message);
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function fetchVideoProfileContextFromActiveTab() {
  const activeTab = await getActiveTab();
  if (!activeTab || !Number.isInteger(activeTab.id)) {
    return {
      success: false,
      code: 'NO_ACTIVE_TAB',
      error: 'Open a LinkedIn profile tab first.',
    };
  }

  if (!activeTab.url || !activeTab.url.includes('linkedin.com')) {
    return {
      success: false,
      code: 'NOT_LINKEDIN',
      error: 'Open a LinkedIn profile to use the video studio.',
      tabId: activeTab.id,
      tabUrl: activeTab.url || null,
    };
  }

  const profile = await chrome.tabs.sendMessage(activeTab.id, {
    action: 'getVideoProfileContext',
  }).catch(() => null);

  if (!profile?.profileUrl || !profile?.firstName || !profile?.photoUrl) {
    return {
      success: false,
      code: 'PROFILE_CONTEXT_UNAVAILABLE',
      error: 'Open a LinkedIn profile with a visible profile photo.',
      tabId: activeTab.id,
      tabUrl: activeTab.url || null,
      profile: profile || null,
    };
  }

  return {
    success: true,
    tabId: activeTab.id,
    tabUrl: activeTab.url || null,
    profile,
  };
}

async function handleFocusGifFlow(sendResponse) {
  try {
    const activeTab = await getActiveTab();
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      sendResponse({
        success: false,
        error: 'Open a LinkedIn profile tab first.',
      });
      return;
    }

    if (!activeTab.url || !activeTab.url.includes('linkedin.com')) {
      sendResponse({
        success: false,
        error: 'Open a LinkedIn profile to use the GIF flow.',
      });
      return;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'focusGifFlow',
    }).catch(() => ({ success: false }));

    sendResponse({
      success: Boolean(response?.success),
      error: response?.error || null,
    });
  } catch (error) {
    sendResponse({
      success: false,
      error: error?.message || 'Could not focus the GIF flow.',
    });
  }
}

async function handleFocusVideoFlow(sendResponse) {
  try {
    const activeTab = await getActiveTab();
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      sendResponse({
        success: false,
        error: 'Open a LinkedIn profile tab first.',
      });
      return;
    }

    if (!activeTab.url || !activeTab.url.includes('linkedin.com')) {
      sendResponse({
        success: false,
        error: 'Open a LinkedIn profile to use the video studio.',
      });
      return;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'focusVideoFlow',
    }).catch(() => ({ success: false }));

    sendResponse({
      success: Boolean(response?.success),
      error: response?.error || null,
    });
  } catch (error) {
    sendResponse({
      success: false,
      error: error?.message || 'Could not focus the video studio.',
    });
  }
}

/**
 * Handle messages from content script
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.debug('[Liebs GIF] Received message:', request.action);

  if (request.action === 'generateLiebsGif') {
    handleGenerateRequest(request, sender, sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.action === 'cancelGeneration') {
    handleCancelGeneration(sender, sendResponse);
    return true;
  }

  if (request.action === 'checkAuth') {
    handleCheckAuth(sendResponse);
    return true;
  }

  if (request.action === 'getCredits') {
    handleGetCredits(sendResponse);
    return true;
  }

  if (request.action === 'fetchUrl') {
    handleFetchUrl(request, sendResponse);
    return true;
  }

  if (request.action === 'restampText') {
    handleRestampText(request, sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.action === 'updateJobText') {
    handleUpdateJobText(request, sendResponse);
    return true;
  }

  if (request.action === 'startOutreachMode') {
    handleStartOutreachMode(sendResponse);
    return true;
  }

  if (request.action === 'stopOutreachMode') {
    handleStopOutreachMode(sendResponse);
    return true;
  }

  if (request.action === 'preProcessProfile') {
    handlePreProcessProfile(request, sendResponse);
    return true;
  }

  if (request.action === 'checkPreProcessStatus') {
    handleCheckPreProcessStatus(request, sendResponse);
    return true;
  }

  if (request.action === 'navigateAndInsertGif') {
    handleNavigateAndInsertGif(request);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'trackEvent') {
    handleTrackEventRequest(request, sender);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'focusGifFlow') {
    handleFocusGifFlow(sendResponse);
    return true;
  }

  if (request.action === 'focusVideoFlow') {
    handleFocusVideoFlow(sendResponse);
    return true;
  }

  if (request.action === 'getVideoProfileContextFromActiveTab') {
    fetchVideoProfileContextFromActiveTab()
      .then((payload) => sendResponse(payload))
      .catch((error) => sendResponse({
        success: false,
        code: 'VIDEO_PROFILE_CONTEXT_FAILED',
        error: error?.message || 'Failed to read the active LinkedIn profile.',
      }));
    return true;
  }

  if (request.action === 'vsApiRequest') {
    handleVsApiProxyRequest(request, sendResponse);
    return true;
  }

  if (request.action === 'authStateChanged') {
    handleAuthStateChanged(request)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Liebs GIF] Failed to handle authStateChanged:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

async function handleAuthStateChanged(request) {
  clearAccountSnapshotCache();

  if (request.authenticated) {
    const userId = typeof request.userId === 'string' && request.userId.trim()
      ? request.userId.trim()
      : null;
    if (userId) {
      identifyAnalyticsUser(userId, { email: userId });
    } else {
      const result = await chrome.storage.sync.get(['userEmail']);
      if (result?.userEmail) {
        identifyAnalyticsUser(result.userEmail, { email: result.userEmail });
      }
    }
  } else {
    resetAnalyticsUser();
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab || !Number.isInteger(activeTab.id)) {
    return;
  }

  if (!activeTab.url || !activeTab.url.includes('linkedin.com')) {
    return;
  }

  await chrome.tabs.sendMessage(activeTab.id, {
    action: 'authStateChanged',
    authenticated: Boolean(request.authenticated)
  }).catch(() => {});
}

/**
 * Navigate a tab to a LinkedIn profile page, wait for it to load,
 * then send insertGifToMessage to the content script.
 * Used when "Cast it" is pressed from the popup while not on the target profile.
 */
async function handleNavigateAndInsertGif(request) {
  const { profileUrl, gifUrl, firstName, lastName } = request;
  const initialDelayMs = 2000;
  const retryDelayMs = 1500;
  const maxAttempts = 6;
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  try {
    // Open a new tab so the user doesn't lose their place on the current page
    const newTab = await chrome.tabs.create({ url: profileUrl });
    if (!Number.isInteger(newTab?.id)) {
      throw new Error('Could not open profile tab');
    }
    const tabId = newTab.id;

    // Wait for the new tab to finish loading
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timed out'));
      }, 15000);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
    });

    // Wait for the content script to initialize on the new page
    await wait(initialDelayMs);

    let lastError = new Error('Insert to chat did not succeed');
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          action: 'insertGifToMessage',
          gifUrl,
          firstName,
          lastName
        });

        if (response?.success) {
          return;
        }

        lastError = new Error(response?.error || 'Insert to chat was not ready yet');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attemptIndex < maxAttempts - 1) {
        await wait(retryDelayMs);
      }
    }

    throw lastError;
  } catch (err) {
    console.error('[Liebs GIF] navigateAndInsertGif error:', err.message);
  }
}

/**
 * Re-apply text to an existing generation without re-rendering the full video.
 * Calls the restamp-text backend endpoint which runs only the ffmpeg text-stamp step.
 */
async function handleRestampText(request, sendResponse) {
  try {
    const { generationId, greeting, ctaText } = request;
    if (!generationId) {
      sendResponse({ success: false, error: 'No generation ID provided' });
      return;
    }

    const result = await chrome.storage.sync.get(['authToken']);
    if (!result.authToken) {
      sendResponse({ success: false, error: 'Not authenticated' });
      return;
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/generate/generations/${generationId}/restamp-text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${result.authToken}`,
        },
        body: JSON.stringify({ greeting, ctaText }),
      },
      60000 // 60s — text overlay + GIF conversion can take ~10–20s
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      sendResponse({ success: false, error: data.error || 'Restamp failed' });
      return;
    }

    sendResponse({ success: true, gifUrl: data.gifUrl });
  } catch (err) {
    console.error('[Liebs GIF] restampText error:', err.message);
    sendResponse({ success: false, error: err.message || 'Restamp failed' });
  }
}

/**
 * Update greeting/CTA text for an active job before compose starts.
 */
async function handleUpdateJobText(request, sendResponse) {
  try {
    const { jobId, greeting, ctaText } = request;
    if (!jobId) {
      sendResponse({ success: false, error: 'No job ID provided' });
      return;
    }

    const result = await chrome.storage.sync.get(['authToken']);
    if (!result.authToken) {
      sendResponse({ success: false, error: 'Not authenticated' });
      return;
    }

    const response = await fetchWithTimeout(
      `${API_BASE_URL}/api/generate/jobs/${jobId}/text`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${result.authToken}`,
        },
        body: JSON.stringify({ greeting, ctaText }),
      },
      15000
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const locked = response.status === 409 || data.code === 'TEXT_LOCKED' || Boolean(data.locked);
      sendResponse({
        success: false,
        locked,
        code: data.code || null,
        error: data.error || 'Failed to update job text',
      });
      return;
    }

    sendResponse({
      success: true,
      jobId: data.jobId || jobId,
      status: data.status || null,
      currentStep: data.currentStep || null,
      greeting: data.greeting || '',
      ctaText: data.ctaText || '',
    });
  } catch (err) {
    console.error('[Liebs GIF] updateJobText error:', err.message);
    sendResponse({ success: false, error: err.message || 'Failed to update job text' });
  }
}

/**
 * Check if user is authenticated
 */
async function handleCheckAuth(sendResponse) {
  try {
    const snapshot = await getCachedAccountSnapshot();
    sendResponse(snapshot);
  } catch (error) {
    console.error('[Liebs GIF] Auth check error:', error);
    sendResponse({
      authenticated: false,
      code: error?.code || null,
      error: getFriendlyApiErrorMessage(error, { context: 'auth' }),
    });
  }
}

/**
 * Get user's credit balance
 */
async function handleGetCredits(sendResponse) {
  try {
    const snapshot = await getCachedAccountSnapshot();
    if (!snapshot.authenticated) {
      sendResponse({ error: 'Not authenticated' });
      return;
    }

    sendResponse({ credits: snapshot.credits });
  } catch (error) {
    console.error('[Liebs GIF] Get credits error:', error);
    sendResponse({
      code: error?.code || null,
      error: getFriendlyApiErrorMessage(error, { context: 'credits' }),
    });
  }
}

/**
 * Fetch a URL from the background script (bypasses CORS for content scripts)
 * Returns base64-encoded data so it can be sent via messaging
 */
function isAllowedFetchUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return false;
    }

    return (
      url.hostname === 'api.liebs.app' ||
      url.hostname === 'assets.liebs.app' ||
      url.hostname === 'media.licdn.com' ||
      url.hostname === 'www.linkedin.com' ||
      url.hostname.endsWith('.amazonaws.com')
    );
  } catch (_error) {
    return false;
  }
}

async function handleFetchUrl(request, sendResponse) {
  try {
    if (!isAllowedFetchUrl(request.url)) {
      sendResponse({ success: false, error: 'URL host is not allowed' });
      return;
    }

    const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(request.url) || /video/i.test(request.url);
    const response = await fetchWithTimeout(request.url, {}, isVideo ? 60000 : 15000);
    if (!response.ok) {
      sendResponse({ success: false, error: `HTTP ${response.status}` });
      return;
    }
    const blob = await response.blob();
    const reader = new FileReader();
    reader.onloadend = () => {
      sendResponse({
        success: true,
        dataUrl: reader.result,
        mimeType: blob.type,
        size: blob.size
      });
    };
    reader.onerror = () => {
      sendResponse({ success: false, error: 'Failed to read blob' });
    };
    reader.readAsDataURL(blob);
  } catch (error) {
    console.error('[Liebs GIF] Fetch URL error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleVsApiProxyRequest(request, sendResponse) {
  try {
    const pathname = typeof request?.pathname === 'string' ? request.pathname.trim() : '';
    if (!pathname.startsWith('/api/video/')) {
      sendResponse({
        success: false,
        status: 400,
        code: 'VIDEO_PROXY_PATH_NOT_ALLOWED',
        error: 'Video Studio route is not allowed',
      });
      return;
    }

    const authToken = typeof request?.authToken === 'string' ? request.authToken.trim() : '';
    if (!authToken) {
      sendResponse({
        success: false,
        status: 401,
        code: 'AUTH_REQUIRED',
        error: 'Authentication required',
      });
      return;
    }

    const rawOptions =
      request?.options && typeof request.options === 'object' && !Array.isArray(request.options)
        ? request.options
        : {};
    const rawMethod = typeof rawOptions.method === 'string' ? rawOptions.method.trim().toUpperCase() : 'GET';
    const method = rawMethod || 'GET';
    if (method !== 'GET' && method !== 'POST') {
      sendResponse({
        success: false,
        status: 400,
        code: 'VIDEO_PROXY_METHOD_NOT_ALLOWED',
        error: 'Video Studio request method is not allowed',
      });
      return;
    }

    const rawHeaders =
      rawOptions.headers && typeof rawOptions.headers === 'object' && !Array.isArray(rawOptions.headers)
        ? rawOptions.headers
        : {};
    const headers = {};
    let hasContentTypeHeader = false;
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== 'string') {
        continue;
      }

      const normalizedKey = String(key).trim();
      const lowerKey = normalizedKey.toLowerCase();
      if (!normalizedKey || lowerKey === 'authorization') {
        continue;
      }

      if (lowerKey === 'content-type') {
        hasContentTypeHeader = true;
      }

      headers[normalizedKey] = value;
    }
    if (rawOptions.body !== undefined && !hasContentTypeHeader) {
      headers['Content-Type'] = 'application/json';
    }
    headers.Authorization = `Bearer ${authToken}`;

    const response = await fetchWithTimeout(`${API_BASE_URL}${pathname}`, {
      method,
      headers,
      ...(rawOptions.body !== undefined ? { body: rawOptions.body } : {}),
    }, 30000);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = buildApiError(response, payload, 'Video Studio request failed');
      sendResponse({
        success: false,
        status: error.status,
        code: error.code,
        error: error.message,
      });
      return;
    }

    sendResponse({
      success: true,
      status: response.status,
      payload,
    });
  } catch (error) {
    console.error('[Liebs GIF] Video Studio proxy error:', error);
    sendResponse({
      success: false,
      status: error?.status || null,
      code: error?.code || null,
      error: error?.message || 'Video Studio request failed',
    });
  }
}

/**
 * Handle cancel request from content script
 */
async function handleCancelGeneration(sender, sendResponse) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) {
    sendResponse({ success: false, error: 'Tab context unavailable' });
    return;
  }

  const session = activeGenerationsByTab.get(tabId);
  if (!session) {
    sendResponse({ success: true, cancelled: false, reason: 'NO_ACTIVE_GENERATION' });
    return;
  }

  session.cancelRequested = true;
  if (session.executionState === 'queued') {
    rejectQueuedGeneration(session, createGenerationCancelledError());
    activeGenerationsByTab.delete(tabId);
    await mirrorActiveGenerationsState();
    sendResponse({
      success: true,
      cancelled: true,
      queued: true,
      jobId: null,
    });
    return;
  }

  trackAnalyticsEvent('generation_cancelled', {
    job_id: session.jobId || null,
    tab_id: tabId,
    elapsed_ms: Number(session.startedAt) ? Date.now() - session.startedAt : null,
  });
  await mirrorActiveGenerationsState();
  await requestBackendCancel(session);
  sendResponse({
    success: true,
    cancelled: true,
    jobId: session.jobId || null
  });
}

/**
 * Handle generate GIF request
 */
async function handleGenerateRequest(request, sender, sendResponse) {
  const {
    photoUrl,
    photoBase64,
    firstName,
    lastName,
    headline,
    company,
    profileUrl,
    photoFingerprint,
    greeting: requestedGreeting,
    ctaText: requestedCtaText,
  } = request;
  const tabId = sender?.tab?.id;
  const dedupeKey = buildGenerationDedupeKey({ profileUrl, photoFingerprint });

  if (Number.isInteger(tabId) && activeGenerationsByTab.has(tabId)) {
    sendResponse({
      success: false,
      code: 'GENERATION_IN_PROGRESS',
      error: 'Generation already in progress'
    });
    return;
  }

  const duplicateSession = findActiveGenerationByDedupeKey(dedupeKey, { excludeTabId: tabId });
  if (duplicateSession) {
    sendResponse({
      success: false,
      code: 'DUPLICATE_GENERATION_IN_PROGRESS',
      error: 'This profile is already generating in another tab. Wait for it to finish or cancel it there.',
      jobId: duplicateSession.jobId || null,
    });
    return;
  }

  const generationSession = {
    tabId,
    authToken: null,
    jobId: null,
    profileUrl: profileUrl || null,
    dedupeKey,
    firstName: firstName || null,
    startedAt: Date.now(),
    cancelRequested: false,
    cancelRequestInFlight: false,
    restoredFromStorage: false,
    executionState: 'pending',
  };

  if (Number.isInteger(tabId)) {
    activeGenerationsByTab.set(tabId, generationSession);
    await mirrorActiveGenerationsState();
  }

  console.log('[Liebs GIF] Starting generation for:', firstName, lastName || '');

  try {
    // Check auth
    const authResult = await chrome.storage.sync.get(['authToken']);

    if (!authResult.authToken) {
      clearAccountSnapshotCache();
      sendResponse({
        success: false,
        error: 'Please login first. Click the extension icon to sign in.'
      });
      return;
    }
    generationSession.authToken = authResult.authToken;
    await mirrorActiveGenerationsState();

    await waitForGenerationSlot(generationSession);

    // Get greeting template and CTA
    const templateResult = await chrome.storage.local.get(['greetingTemplate', 'ctaText']);
    const greetingTemplate = templateResult.greetingTemplate || 'Hey, {name}!';
    const defaultCtaText = templateResult.ctaText || 'Open to talk?';
    const defaultGreeting = greetingTemplate
      .replace(/{name}/g, firstName || '')
      .replace(/{lastName}/g, lastName || '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const greeting =
      (typeof requestedGreeting === 'string' ? requestedGreeting.trim() : '') || defaultGreeting;
    const ctaText =
      (typeof requestedCtaText === 'string' ? requestedCtaText.trim() : '') || defaultCtaText;

    if (generationSession.cancelRequested) {
      throw createGenerationCancelledError();
    }

    // Notify content script that generation has started
    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'generating',
      step: 'Generating...',
      substage: pickStageMessage('queued', 1),
      progress: 0
    });

    // Queue generation job
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/generate/liebs-gif`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authResult.authToken}`
      },
      body: JSON.stringify({
        photoUrl,
        photoBase64,
        firstName,
        lastName,
        headline,
        company,
        greeting,
        ctaText,
        profileUrl,
        photoFingerprint: normalizeFingerprint(photoFingerprint)
      })
    }, 20000);

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 402) {
        clearAccountSnapshotCache();
        sendResponse({
          success: false,
          code: data.code || 'INSUFFICIENT_CREDITS',
          error: 'Insufficient credits. Please purchase more credits.',
          needsCredits: true
        });
        return;
      }

      throw buildApiError(response, data, 'Generation failed');
    }

    if (!data.jobId) {
      throw new Error('Generation job was not created');
    }
    generationSession.jobId = data.jobId;
    await mirrorActiveGenerationsState();

    trackAnalyticsEvent('generation_started', {
      job_id: data.jobId,
      tab_id: tabId,
      first_name: firstName || null,
      has_profile_url: Boolean(profileUrl),
    });

    if (generationSession.cancelRequested) {
      await requestBackendCancel(generationSession);
      throw createGenerationCancelledError();
    }

    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'generating',
      step: 'Generating...',
      substage: pickStageMessage('queued', 2),
      progress: 5
    });

    const jobResult = await pollGenerationJob(data.jobId, authResult.authToken, tabId, generationSession);
    await appendCompletedGenerationResult(generationSession, jobResult);
    const silhouetteUrl = extractSilhouetteUrl(jobResult);
    const liebsImageUrl = extractLiebsImageUrl(jobResult);
    const gifUrl = jobResult?.gifUrl || jobResult?.gif_url || null;
    const generationId = jobResult?.generationId || jobResult?.generation_id || null;
    updateCachedAccountCredits(jobResult?.creditsRemaining);

    console.log('[Liebs GIF] Generation complete!');
    addBackgroundBreadcrumb('generation.completed', {
      jobId: generationSession.jobId,
      generationId,
      tabId,
      resumed: false,
    });

    trackAnalyticsEvent('generation_completed', {
      job_id: generationSession.jobId,
      tab_id: tabId,
      generation_id: generationId,
      elapsed_ms: Date.now() - generationSession.startedAt,
    });

    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'complete',
      silhouetteUrl,
      liebsImageUrl,
      gifUrl,
      generationId,
      progress: 100
    });

    sendResponse({
      success: true,
      jobId: generationSession.jobId,
      gifUrl,
      silhouetteUrl,
      liebsImageUrl,
      generationId,
      creditsRemaining: jobResult.creditsRemaining
    });

  } catch (error) {
    if (isGenerationCancelledError(error)) {
      notifyContentScript(tabId, {
        action: 'generationUpdate',
        status: 'cancelled',
        error: 'Generation cancelled by user'
      });
      sendResponse({
        success: false,
        cancelled: true,
        code: GENERATION_CANCELLED_CODE,
        error: 'Generation cancelled by user'
      });
      return;
    }

    console.error('[Liebs GIF] Generation error:', error);
    trackBackgroundError('generation.failed', error, {
      jobId: generationSession?.jobId || null,
      tabId,
      code: error?.code || null,
    });

    trackAnalyticsEvent('generation_failed', {
      job_id: generationSession.jobId || null,
      tab_id: tabId,
      code: error?.code || null,
      reason: error?.message || 'Generation failed',
      elapsed_ms: Date.now() - generationSession.startedAt,
    });

    const isInsufficientCredits = error.code === 'INSUFFICIENT_CREDITS' || /insufficient credits/i.test(error.message);
    const errorMessage = error.message === 'Request timed out'
      ? 'Request timed out while queueing the job. Please try again.'
      : getFriendlyApiErrorMessage(error, { context: 'generation' });

    notifyContentScript(tabId, {
      action: 'generationUpdate',
      status: 'error',
      error: errorMessage,
      code: error.code || null
    });

    sendResponse({
      success: false,
      code: error.code || null,
      error: errorMessage,
      needsCredits: isInsufficientCredits
    });
  } finally {
    if (Number.isInteger(tabId) && activeGenerationsByTab.get(tabId) === generationSession) {
      releaseGenerationSlot(generationSession);
      activeGenerationsByTab.delete(tabId);
      await mirrorActiveGenerationsState();
    }
  }
}

/**
 * Send notification to content script
 */
function notifyContentScript(tabId, message) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  let payload = message;
  if (message?.action === 'generationUpdate' && !message.jobId) {
    const session = activeGenerationsByTab.get(tabId);
    if (session?.jobId) {
      payload = { ...message, jobId: session.jobId };
    }
  }

  chrome.tabs.sendMessage(tabId, payload).catch(err => {
    console.warn('[Liebs GIF] Failed to notify content script:', err);
  });
}

/**
 * Listen for tab updates to refresh credits
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  if (tab.url && tab.url.includes('linkedin.com')) {
    try {
      const snapshot = await getCachedAccountSnapshot();
      if (snapshot.authenticated && snapshot.credits !== null) {
        chrome.tabs.sendMessage(activeInfo.tabId, {
          action: 'creditsUpdate',
          credits: snapshot.credits
        }).catch(() => {});
      }
    } catch (error) {
      console.error('[Liebs GIF] Failed to refresh credits:', error);
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  restorePersistedGenerations();
});

chrome.runtime.onInstalled.addListener(() => {
  restorePersistedGenerations();
});

restorePersistedGenerations();
