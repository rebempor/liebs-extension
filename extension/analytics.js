// Central analytics wrapper for the extension background worker.
// Service workers do not expose page globals like document.referrer, so this
// uses direct HTTP events instead of the browser SDK.

const POSTHOG_API_KEY = 'phc_HZz7uMKBDFQxwVlnqu22sYoJ89QwJ1aOs1cRCFBEsgB';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const ANALYTICS_STORAGE_KEY = 'liebsAnalyticsStateV1';

let analyticsClient = null;
let analyticsInitialized = false;

function isPostHogConfigured() {
  return (
    typeof POSTHOG_API_KEY === 'string' &&
    POSTHOG_API_KEY.startsWith('phc_') &&
    !POSTHOG_API_KEY.includes('REPLACE')
  );
}

function createAnonymousDistinctId() {
  if (globalThis.crypto?.randomUUID) {
    return `anon_${globalThis.crypto.randomUUID()}`;
  }

  return `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAnalyticsProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined) {
      continue;
    }

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

function buildAnalyticsClient() {
  const manifest = chrome.runtime?.getManifest?.();
  const state = {
    anonymousDistinctId: createAnonymousDistinctId(),
    identifiedDistinctId: null,
    superProperties: {
      app: 'liebs_chrome_extension',
      extension_version: manifest?.version || 'unknown',
    },
  };

  let stateHydrated = false;
  let persistStatePromise = Promise.resolve();

  async function hydrateState() {
    if (stateHydrated) {
      return;
    }

    stateHydrated = true;
    try {
      const stored = await chrome.storage.local.get([ANALYTICS_STORAGE_KEY]);
      const rawState = stored?.[ANALYTICS_STORAGE_KEY];
      if (!rawState || typeof rawState !== 'object') {
        return;
      }

      if (typeof rawState.anonymousDistinctId === 'string' && rawState.anonymousDistinctId.trim()) {
        state.anonymousDistinctId = rawState.anonymousDistinctId;
      }
      if (typeof rawState.identifiedDistinctId === 'string' && rawState.identifiedDistinctId.trim()) {
        state.identifiedDistinctId = rawState.identifiedDistinctId;
      }
      if (rawState.superProperties && typeof rawState.superProperties === 'object') {
        state.superProperties = {
          ...state.superProperties,
          ...normalizeAnalyticsProperties(rawState.superProperties),
        };
      }
    } catch (error) {
      console.warn('[Analytics] Failed to restore analytics state:', error?.message || error);
    }
  }

  async function persistState() {
    persistStatePromise = Promise.resolve(persistStatePromise)
      .catch(() => {})
      .then(() => (
        chrome.storage.local.set({
          [ANALYTICS_STORAGE_KEY]: {
            anonymousDistinctId: state.anonymousDistinctId,
            identifiedDistinctId: state.identifiedDistinctId,
            superProperties: state.superProperties,
          },
        })
      ))
      .catch((error) => {
        console.warn('[Analytics] Failed to persist analytics state:', error?.message || error);
      });

    return persistStatePromise;
  }

  function getDistinctId() {
    return state.identifiedDistinctId || state.anonymousDistinctId;
  }

  async function postEvent(eventName, properties = {}) {
    await hydrateState();

    const response = await fetchWithTimeout(
      `${POSTHOG_HOST}/batch/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          batch: [
            {
              event: eventName,
              properties: {
                ...state.superProperties,
                ...normalizeAnalyticsProperties(properties),
                distinct_id: getDistinctId(),
                $lib: 'liebs_extension_worker',
                $lib_version: state.superProperties.extension_version || 'unknown',
              },
              timestamp: new Date().toISOString(),
            },
          ],
          sent_at: new Date().toISOString(),
        }),
      },
      10000
    );

    if (!response.ok) {
      throw new Error(`Analytics request failed (${response.status})`);
    }
  }

  return {
    register(properties = {}) {
      void (async () => {
        await hydrateState();
        state.superProperties = {
          ...state.superProperties,
          ...normalizeAnalyticsProperties(properties),
        };
        await persistState();
      })();
    },

    capture(eventName, properties = {}) {
      if (!eventName) {
        return;
      }

      void postEvent(eventName, properties).catch((error) => {
        console.warn(`[Analytics] Failed to capture "${eventName}":`, error?.message || error);
      });
    },

    identify(userId, properties = {}) {
      if (!userId) {
        return;
      }

      void (async () => {
        await hydrateState();
        const nextDistinctId = String(userId);
        const previousDistinctId = getDistinctId();
        state.identifiedDistinctId = nextDistinctId;
        await persistState();

        const normalizedProperties = normalizeAnalyticsProperties(properties);
        await postEvent('$identify', {
          ...normalizedProperties,
          $set: normalizedProperties,
          $anon_distinct_id: previousDistinctId !== nextDistinctId ? previousDistinctId : undefined,
        });
      })().catch((error) => {
        console.warn('[Analytics] Failed to identify user:', error?.message || error);
      });
    },

    reset() {
      void (async () => {
        await hydrateState();
        state.identifiedDistinctId = null;
        state.anonymousDistinctId = createAnonymousDistinctId();
        await persistState();
      })().catch((error) => {
        console.warn('[Analytics] Failed to reset user:', error?.message || error);
      });
    },
  };
}

function initializeAnalytics() {
  if (analyticsInitialized) {
    return Boolean(analyticsClient);
  }
  analyticsInitialized = true;

  if (!isPostHogConfigured()) {
    console.info('[Analytics] PostHog disabled. Set POSTHOG_API_KEY in analytics.js to enable tracking.');
    return false;
  }

  analyticsClient = buildAnalyticsClient();
  return true;
}

function trackAnalyticsEvent(eventName, properties = {}) {
  if (!analyticsClient || !eventName) {
    return;
  }

  analyticsClient.capture(eventName, properties);
}

function identifyAnalyticsUser(userId, properties = {}) {
  if (!analyticsClient || !userId) {
    return;
  }

  analyticsClient.identify(String(userId), properties);
}

function resetAnalyticsUser() {
  if (!analyticsClient) {
    return;
  }

  analyticsClient.reset();
}
