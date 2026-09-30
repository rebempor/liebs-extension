// LinkedIn Liebs GIF Generator - Popup Script (SaaS Version)

if (typeof initExtensionSentry === 'function') {
  initExtensionSentry({
    source: 'popup',
  });
}

function trackPopupError(eventName, error, context = {}) {
  if (typeof captureExtensionError === 'function') {
    captureExtensionError(eventName, error, context);
  }
}


let outreachCountdownTimer = null;
let hasAttemptedTemplateMigration = false;
let activeHistoryTab = 'gifs';
let videoHistoryLoaded = false;
let videoHistoryLoading = false;
const PENDING_EXTENSION_AUTH_KEY = 'pendingExtensionAuth';
const GIF_HISTORY_EMPTY_HTML = '<p class="history-empty">Nothing here yet... go make some magic! ✨</p>';
const VIDEO_HISTORY_EMPTY_HTML = '<p class="history-empty">No videos yet... create your first one! 🎬</p>';
const TEXT_LIMITS = {
  greetingMax: 60,
  ctaMax: 60,
};

document.addEventListener('DOMContentLoaded', init);

function trackEvent(eventName, properties = {}) {
  if (!eventName) return;
  chrome.runtime.sendMessage({
    action: 'trackEvent',
    source: 'popup',
    eventName,
    properties,
  }).catch(() => {});
}

async function init() {
  trackEvent('popup_opened');
  setupEventListeners();
  const renderedFromCache = await renderFromCache();
  if (renderedFromCache) {
    validateWithServer(); // User already sees cached UI, validate in background
  } else {
    await validateWithServer(); // Nothing shown yet, wait for server
  }
}

/**
 * Save auth state to local storage for instant popup rendering
 */
async function updateAuthCache(email, credits, subscription = null) {
  await chrome.storage.local.set({
    authCache: { isAuthenticated: true, email, credits, subscription, cachedAt: Date.now() }
  });
}

/**
 * Mark auth cache as logged out
 */
async function clearAuthCache() {
  await chrome.storage.local.set({
    authCache: { isAuthenticated: false, cachedAt: Date.now() }
  });
}

/**
 * Notify background script that auth state changed so active LinkedIn tab can update UI immediately.
 */
async function notifyAuthStateChanged(authenticated, userId = null) {
  try {
    await chrome.runtime.sendMessage({
      action: 'authStateChanged',
      authenticated,
      userId: typeof userId === 'string' ? userId : null,
    });
  } catch (error) {
    trackPopupError('message_passing.failed', error, {
      action: 'authStateChanged',
      authenticated,
    });
    console.warn('Failed to notify auth state change:', error);
  }
}

/**
 * Instantly render the correct view from cached auth state
 */
async function renderFromCache() {
  const { authCache } = await chrome.storage.local.get('authCache');
  if (!authCache) return false; // First-time user — no cache, views stay hidden until server responds

  if (authCache.isAuthenticated) {
    // Guard 1: Verify the auth token still exists locally.
    // If it was removed (logout, prior 401 cleanup), don't trust the cache.
    const { authToken } = await chrome.storage.sync.get('authToken');
    if (!authToken) {
      await clearAuthCache();
      showView('auth');
      return true;
    }

    // Guard 2: If cache is older than 5 minutes, don't render from it.
    // Let validateWithServer() handle the UI once the server responds.
    const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
    if (authCache.cachedAt && (Date.now() - authCache.cachedAt > CACHE_MAX_AGE_MS)) {
      return false; // Don't trust stale cache; let server decide
    }

    showMainView(authCache.email, authCache.credits, authCache.subscription || null);
    await loadSavedSettings();
    return true;
  } else {
    showView('auth');
    return true;
  }
}

/**
 * Debounce helper
 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function normalizeTemplateText(value, maxLen) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function hasActiveSubscription(subscription) {
  return Boolean(
    subscription
    && ['active', 'trialing', 'past_due'].includes(subscription.status)
  );
}

function getPlanLabel(subscription) {
  if (!hasActiveSubscription(subscription)) {
    return 'Free';
  }

  return subscription.plan_id === 'starter' ? 'Starter' : 'Pro';
}

function createStateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  document.getElementById('browser-auth-btn').addEventListener('click', handleBrowserAuth);
  document.getElementById('launch-gif-btn').addEventListener('click', handleLaunchGif);
  document.getElementById('launch-video-btn').addEventListener('click', handleLaunchVideo);

  // Logout
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Buy credits
  document.getElementById('buy-credits-btn').addEventListener('click', handleBuyCredits);

  // Auto-save settings on input (debounced)
  const debouncedSave = debounce(saveSettingsQuietly, 600);
  document.getElementById('greeting-template').addEventListener('input', debouncedSave);
  document.getElementById('cta-text').addEventListener('input', debouncedSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void saveSettingsQuietly();
    }
  });

  const historyTabs = document.querySelectorAll('.history-tab');
  historyTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab === 'videos' ? 'videos' : 'gifs';
      setActiveHistoryTab(tabName);
      if (tabName === 'videos' && !videoHistoryLoaded) {
        fetchVideoHistory();
      }
    });
  });

  // Event delegation for GIF history actions
  document.getElementById('history-list').addEventListener('click', (e) => {
    const thumb = e.target.closest('.history-thumb');
    if (thumb) {
      const item = thumb.closest('.history-item');
      const generationId = item?.dataset.generationId;
      trackEvent('history_gif_clicked', {
        generation_id: generationId || null,
        has_generation_id: Boolean(generationId),
      });
      if (generationId) {
        window.open(`${WEB_APP_URL}/share/${generationId}`, '_blank');
      } else {
        // Fallback for items without a generationId
        const gifUrl = item?.dataset.gifUrl;
        if (gifUrl) {
          const firstName = item?.dataset.firstName;
          const shareUrl = `${WEB_APP_URL}/share?gif=${encodeURIComponent(gifUrl)}&name=${encodeURIComponent(firstName || '')}`;
          window.open(shareUrl, '_blank');
        }
      }
      return;
    }

    const btn = e.target.closest('.history-action-btn');
    if (!btn) return;
    e.stopPropagation();

    const item = btn.closest('.history-item');
    if (!item) return;
    const gifUrl = item.dataset.gifUrl;
    const firstName = item.dataset.firstName;
    const lastName = item.dataset.lastName;
    const profileUrl = item.dataset.profileUrl;
    const headline = item.dataset.headline;
    const company = item.dataset.company;

    if (btn.classList.contains('insert-msg-btn')) {
      handleInsertToMessage(gifUrl, firstName, lastName, btn, profileUrl);
    } else if (btn.classList.contains('copy-email-btn')) {
      const generationId = item.dataset.generationId;
      handleCopyForEmail(gifUrl, firstName, lastName, headline, company, profileUrl, generationId);
    }
  });

  // Event delegation for video history actions
  document.getElementById('video-history-list').addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;

    const projectId = item.dataset.projectId;
    if (!projectId) return;

    const thumb = e.target.closest('.history-thumb');
    if (thumb) {
      trackEvent('history_video_clicked', {
        project_id: projectId,
        has_project_id: Boolean(projectId),
      });
      openVideoSharePage(projectId);
      return;
    }

    const shareButton = e.target.closest('.share-video-btn');
    if (!shareButton) return;
    e.stopPropagation();

    trackEvent('history_video_share_clicked', {
      project_id: projectId,
      has_project_id: Boolean(projectId),
    });
    openVideoSharePage(projectId);
  });

  const outreachToggle = document.getElementById('outreach-toggle-input');
  outreachToggle.addEventListener('change', handleOutreachToggle);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (
      changes.outreachMode ||
      changes.outreachEndsAt ||
      changes.outreachCount ||
      changes.outreachActivatedAt
    ) {
      syncOutreachUiFromStorage().catch((error) => {
        console.error('Failed to sync Outreach Mode state:', error);
      });
    }
  });
}

async function handleLaunchGif() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'focusGifFlow' });
    if (!response?.success) {
      throw new Error(response?.error || 'Open a LinkedIn profile to use the GIF flow');
    }
    showStatus('Use the GIF button on the LinkedIn page', 'success');
    window.close();
  } catch (error) {
    showStatus(error.message || 'Could not focus the GIF flow', 'error');
  }
}

async function handleLaunchVideo() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'focusVideoFlow' });
    if (!response?.success) {
      throw new Error(response?.error || 'Open a LinkedIn profile to use the video studio');
    }
    window.close();
  } catch (error) {
    showStatus(error.message || 'Could not open the video studio', 'error');
  }
}

/**
 * Validate auth with server in the background and update cache
 */
async function validateWithServer() {
  const result = await chrome.storage.sync.get(['authToken', 'userEmail']);

  if (result.authToken) {
    try {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${result.authToken}`
        }
      }, 8000);
      const data = await response.json().catch(() => ({}));

      const resolvedEmail = data.user?.email || result.userEmail || null;

      if (response.ok && resolvedEmail) {
        await updateAuthCache(resolvedEmail, data.credits, data.subscription || null);
        showMainView(resolvedEmail, data.credits, data.subscription || null);
        await loadSavedSettings();
        return;
      }

      if (response.status === 401 || response.status === 403) {
        await chrome.storage.sync.remove(['authToken', 'userEmail']);
        await clearAuthCache();
        resetVideoHistoryState();
        showView('auth');
        return;
      }

      if (result.userEmail) {
        const warning = getFriendlyApiErrorMessage(
          buildApiError(response, data, 'Could not verify account'),
          { context: 'auth' }
        );
        const { authCache } = await chrome.storage.local.get('authCache');
        showMainView(
          result.userEmail,
          data.credits || authCache?.credits || 0,
          data.subscription || authCache?.subscription || null
        );
        await loadSavedSettings();
        showStatus(warning, 'warning');
        return;
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      if (result.userEmail) {
        const { authCache } = await chrome.storage.local.get('authCache');
        showMainView(
          result.userEmail,
          authCache?.credits || 0,
          authCache?.subscription || null
        );
        await loadSavedSettings();
        showStatus(
          getFriendlyApiErrorMessage(
            error.message === 'Request timed out'
              ? new Error('Request timed out. Showing saved details while we wait.')
              : error,
            { context: 'auth' }
          ),
          'warning'
        );
        return;
      }
    }
  }

  await clearAuthCache();
  resetVideoHistoryState();
  showView('auth');
}

/**
 * Open the website's Clerk flow and let it hand back an extension token.
 */
async function handleBrowserAuth() {
  const btn = document.getElementById('browser-auth-btn');
  btn.disabled = true;
  btn.textContent = 'Opening browser...';

  try {
    const state = createStateToken();
    const redirectUri = chrome.runtime.getURL('auth-callback.html');

    await chrome.storage.local.set({
      [PENDING_EXTENSION_AUTH_KEY]: {
        createdAt: Date.now(),
        redirectUri,
        state,
      }
    });

    chrome.tabs.create({
      url: `${WEB_APP_URL}/extension-auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
    });

    trackEvent('extension_browser_auth_started');
    showStatus('Finish sign-in in the browser tab that just opened.', 'success');
  } catch (error) {
    showStatus(error.message || 'Could not open browser sign-in', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue in browser';
  }
}

/**
 * Handle logout
 */
async function handleLogout() {
  try {
    await disableOutreachMode({ notifyBackground: true, suppressStatus: true });
  } catch (error) {
    console.error('Failed to disable Outreach Mode during logout:', error);
  }
  await chrome.storage.sync.remove(['authToken', 'userEmail']);
  await chrome.storage.local.remove(PENDING_EXTENSION_AUTH_KEY);
  await clearAuthCache();
  resetVideoHistoryState();
  await notifyAuthStateChanged(false);
  showStatus('Logged out', 'success');
  showView('auth');
}

/**
 * Handle buy credits button
 */
async function handleBuyCredits() {
  const result = await chrome.storage.sync.get(['authToken']);

  if (!result.authToken) {
    showStatus('Please login first', 'error');
    return;
  }

  try {
    const meResponse = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`, {
      headers: {
        'Authorization': `Bearer ${result.authToken}`
      }
    }, 8000);
    const meData = await meResponse.json().catch(() => ({}));

    if (!meResponse.ok) {
      throw new Error(meData.error || 'Failed to verify account');
    }

    if (meData.user?.email) {
      await updateAuthCache(
        meData.user.email,
        meData.credits || 0,
        meData.subscription || null
      );
    }

    if (!hasActiveSubscription(meData.subscription)) {
      chrome.tabs.create({ url: `${WEB_APP_URL}/dashboard/billing` });
      return;
    }

    const currency = meData.subscription?.currency === 'eur' ? 'eur' : 'usd';
    trackEvent('refill_clicked', { credit_pack: 'pack_50', currency });
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/credits/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${result.authToken}`
      },
      body: JSON.stringify({ packId: 'pack_50', currency })
    }, 10000);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start purchase');
    }
    if (!data.checkoutUrl) {
      throw new Error('Purchase link not returned');
    }

    // Open Stripe checkout in new tab
    chrome.tabs.create({ url: data.checkoutUrl });

  } catch (error) {
    showStatus(error.message, 'error');
  }
}

/**
 * Migrate templates from sync to local storage one time per popup open.
 */
async function migrateTemplatesFromSyncToLocal() {
  if (hasAttemptedTemplateMigration) return;
  hasAttemptedTemplateMigration = true;

  try {
    const localResult = await chrome.storage.local.get(['greetingTemplate', 'ctaText']);
    const hasLocalTemplates =
      typeof localResult.greetingTemplate === 'string' || typeof localResult.ctaText === 'string';
    if (hasLocalTemplates) return;

    const syncResult = await chrome.storage.sync.get(['greetingTemplate', 'ctaText']);
    const migrated = {};

    if (typeof syncResult.greetingTemplate === 'string') {
      migrated.greetingTemplate = normalizeTemplateText(syncResult.greetingTemplate, TEXT_LIMITS.greetingMax);
    }
    if (typeof syncResult.ctaText === 'string') {
      migrated.ctaText = normalizeTemplateText(syncResult.ctaText, TEXT_LIMITS.ctaMax);
    }

    if (Object.keys(migrated).length > 0) {
      await chrome.storage.local.set(migrated);
    }
  } catch (error) {
    console.warn('Template migration from sync to local failed:', error);
  }
}

/**
 * Load saved settings from storage
 */
async function loadSavedSettings() {
  await migrateTemplatesFromSyncToLocal();
  const result = await chrome.storage.local.get(['greetingTemplate', 'ctaText']);

  const greetingTemplate = normalizeTemplateText(result.greetingTemplate, TEXT_LIMITS.greetingMax);
  const ctaText = normalizeTemplateText(result.ctaText, TEXT_LIMITS.ctaMax);

  if (greetingTemplate) {
    document.getElementById('greeting-template').value = greetingTemplate;
  }
  if (ctaText) {
    document.getElementById('cta-text').value = ctaText;
  }
}

/**
 * Save settings quietly (no success banner)
 */
async function saveSettingsQuietly() {
  const greetingInput = document.getElementById('greeting-template');
  const ctaInput = document.getElementById('cta-text');

  const greetingTemplate = normalizeTemplateText(
    greetingInput.value,
    TEXT_LIMITS.greetingMax
  );
  const ctaText = normalizeTemplateText(
    ctaInput.value,
    TEXT_LIMITS.ctaMax
  );

  greetingInput.value = greetingTemplate;
  ctaInput.value = ctaText;

  try {
    await chrome.storage.local.set({
      greetingTemplate: greetingTemplate || 'Hey, {name}!',
      ctaText: ctaText || 'Open to talk?'
    });
    trackEvent('template_changed', {
      greeting_length: (greetingTemplate || 'Hey, {name}!').length,
      cta_length: (ctaText || 'Open to talk?').length,
    });
    const indicator = document.getElementById('template-saved');
    if (indicator) {
      indicator.classList.add('visible');
      clearTimeout(indicator._hideTimer);
      indicator._hideTimer = setTimeout(() => indicator.classList.remove('visible'), 1500);
    }
  } catch (error) {
    showStatus('Failed to save settings: ' + error.message, 'error');
  }
}

/**
 * Show a specific view
 */
function showView(viewName) {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('main-view').classList.add('hidden');

  const view = document.getElementById(`${viewName}-view`);
  view.classList.remove('animate-in');
  view.classList.remove('hidden');
  void view.offsetHeight; // Force reflow to reset animations
  view.classList.add('animate-in');

  if (viewName !== 'main') {
    clearOutreachCountdown();
  }
}

/**
 * Show main view with user info
 */
function showMainView(email, credits, subscription = null) {
  showView('main');
  const emailEl = document.getElementById('user-email');
  emailEl.textContent = email;
  emailEl.title = email;
  document.getElementById('credits-balance').textContent = credits || 0;
  const planEl = document.getElementById('plan-name');
  if (planEl) {
    planEl.textContent = getPlanLabel(subscription);
  }
  syncOutreachUiFromStorage().catch((error) => {
    console.error('Failed to load Outreach Mode state:', error);
  });
  setActiveHistoryTab('gifs');
  fetchHistory();
}

function setActiveHistoryTab(tabName) {
  activeHistoryTab = tabName === 'videos' ? 'videos' : 'gifs';

  const tabs = document.querySelectorAll('.history-tab');
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === activeHistoryTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const gifList = document.getElementById('history-list');
  const videoList = document.getElementById('video-history-list');
  if (!gifList || !videoList) return;

  gifList.classList.toggle('hidden', activeHistoryTab !== 'gifs');
  videoList.classList.toggle('hidden', activeHistoryTab !== 'videos');
}

function resetVideoHistoryState() {
  videoHistoryLoaded = false;
  videoHistoryLoading = false;

  const videoHistoryList = document.getElementById('video-history-list');
  if (videoHistoryList) {
    videoHistoryList.innerHTML = VIDEO_HISTORY_EMPTY_HTML;
  }

  setActiveHistoryTab('gifs');
}

function openVideoSharePage(projectId) {
  if (!projectId) {
    showStatus('This video is missing an ID and cannot be shared yet.', 'error');
    return;
  }

  chrome.tabs.create({ url: `${WEB_APP_URL}/share/video/${encodeURIComponent(projectId)}` });
}

function clearOutreachCountdown() {
  if (!outreachCountdownTimer) return;
  clearInterval(outreachCountdownTimer);
  outreachCountdownTimer = null;
}

function formatOutreachCountdown(remainingMs) {
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function setOutreachUiState({ outreachMode, outreachEndsAt, outreachCount }) {
  const toggle = document.getElementById('outreach-toggle-input');
  const status = document.getElementById('outreach-status');
  const stats = document.getElementById('outreach-stats');
  const countLabel = document.getElementById('outreach-count');
  const timerLabel = document.getElementById('outreach-timer');

  if (!toggle || !status || !stats || !countLabel || !timerLabel) {
    return;
  }

  toggle.checked = Boolean(outreachMode);
  status.textContent = outreachMode ? 'Active' : 'Off';
  status.classList.toggle('active', Boolean(outreachMode));

  const safeCount = Number(outreachCount) || 0;
  countLabel.textContent = `${safeCount} profile${safeCount === 1 ? '' : 's'} prepped`;

  if (!outreachMode || !outreachEndsAt) {
    stats.classList.add('hidden');
    timerLabel.textContent = '90:00';
    clearOutreachCountdown();
    return;
  }

  stats.classList.remove('hidden');
  const updateTimer = () => {
    const remainingMs = outreachEndsAt - Date.now();
    timerLabel.textContent = formatOutreachCountdown(remainingMs);
  };

  updateTimer();
  clearOutreachCountdown();
  outreachCountdownTimer = setInterval(async () => {
    const remainingMs = outreachEndsAt - Date.now();
    if (remainingMs <= 0) {
      clearOutreachCountdown();
      try {
        await disableOutreachMode({ notifyBackground: true, suppressStatus: true });
      } catch (error) {
        console.error('Failed to auto-disable Outreach Mode:', error);
      }
      showStatus('Outreach Mode auto-stopped after 90 minutes', 'warning');
      return;
    }
    timerLabel.textContent = formatOutreachCountdown(remainingMs);
  }, 1000);
}

async function syncOutreachUiFromStorage() {
  const state = await chrome.storage.local.get([
    'outreachMode',
    'outreachActivatedAt',
    'outreachEndsAt',
    'outreachCount',
  ]);

  let outreachMode = Boolean(state.outreachMode);
  let outreachEndsAt = Number(state.outreachEndsAt) || 0;

  if (outreachMode && !outreachEndsAt) {
    const activatedAt = Number(state.outreachActivatedAt) || 0;
    if (activatedAt) {
      outreachEndsAt = activatedAt + OUTREACH_DURATION_MS;
    }
  }

  if (outreachMode && outreachEndsAt && outreachEndsAt <= Date.now()) {
    outreachMode = false;
    outreachEndsAt = 0;
    await chrome.storage.local.set({
      outreachMode: false,
      outreachEndsAt: null,
    });
  }

  setOutreachUiState({
    outreachMode,
    outreachEndsAt: outreachEndsAt || null,
    outreachCount: Number(state.outreachCount) || 0,
  });
}

async function enableOutreachMode() {
  const now = Date.now();
  const outreachEndsAt = now + OUTREACH_DURATION_MS;

  await chrome.storage.local.set({
    outreachMode: true,
    outreachActivatedAt: now,
    outreachEndsAt,
    outreachCount: 0,
  });

  const response = await chrome.runtime.sendMessage({ action: 'startOutreachMode' });
  if (!response || !response.success) {
    await chrome.storage.local.set({
      outreachMode: false,
      outreachEndsAt: null,
      outreachActivatedAt: null,
    });
    throw new Error(response?.error || 'Failed to start Outreach Mode');
  }

  await chrome.storage.local.set({
    outreachMode: true,
    outreachEndsAt: Number(response.outreachEndsAt) || outreachEndsAt,
    outreachActivatedAt: now,
    outreachCount: Number(response.outreachCount) || 0,
  });

  await syncOutreachUiFromStorage();
}

async function disableOutreachMode({ notifyBackground = false, suppressStatus = false } = {}) {
  clearOutreachCountdown();

  await chrome.storage.local.set({
    outreachMode: false,
    outreachEndsAt: null,
  });

  if (notifyBackground) {
    const response = await chrome.runtime.sendMessage({ action: 'stopOutreachMode' });
    if (response && !response.success) {
      throw new Error(response.error || 'Failed to stop Outreach Mode');
    }
  }

  await syncOutreachUiFromStorage();

  if (!suppressStatus) {
    showStatus('Outreach Mode is off', 'success');
  }
}

async function handleOutreachToggle(event) {
  const toggle = event.target;
  toggle.disabled = true;

  try {
    if (toggle.checked) {
      await enableOutreachMode();
      showStatus('Outreach Mode is active for 90 minutes', 'success');
    } else {
      await disableOutreachMode({ notifyBackground: true });
    }
  } catch (error) {
    console.error('Outreach Mode toggle failed:', error);
    showStatus(error.message || 'Failed to update Outreach Mode', 'error');
    await syncOutreachUiFromStorage();
  } finally {
    toggle.disabled = false;
  }
}

/**
 * Fetch and display generation history
 */
async function fetchHistory() {
  const result = await chrome.storage.sync.get(['authToken']);

  if (!result.authToken) return;

  const historyList = document.getElementById('history-list');

  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/generate/history`, {
      headers: {
        'Authorization': `Bearer ${result.authToken}`
      }
    }, 10000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw buildApiError(response, data, 'Failed to fetch history');
    }
    const generations = data.generations || [];

    if (generations.length === 0) {
      historyList.innerHTML = GIF_HISTORY_EMPTY_HTML;
      return;
    }

    historyList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < generations.length; i++) {
      const item = buildHistoryItem(generations[i]);
      const staggerDelay = Math.min(i * 50, 400);
      item.style.animation = `history-item-in 250ms cubic-bezier(0.22, 1, 0.36, 1) ${staggerDelay}ms both`;
      fragment.appendChild(item);
    }

    historyList.appendChild(fragment);

  } catch (error) {
    console.error('Failed to fetch history:', error);
    historyList.innerHTML = `<p class="history-empty">${getFriendlyApiErrorMessage(error, { context: 'history' })}</p>`;
  }
}

/**
 * Fetch and display video history (lazy loaded when videos tab is opened)
 */
async function fetchVideoHistory() {
  if (videoHistoryLoaded || videoHistoryLoading) return;

  const result = await chrome.storage.sync.get(['authToken']);
  if (!result.authToken) return;

  const videoHistoryList = document.getElementById('video-history-list');
  if (!videoHistoryList) return;

  videoHistoryLoading = true;
  videoHistoryList.innerHTML = '<p class="history-empty">Loading videos...</p>';

  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/video/projects/history`, {
      headers: {
        'Authorization': `Bearer ${result.authToken}`
      }
    }, 10000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw buildApiError(response, data, 'Failed to fetch video history');
    }

    const projects = Array.isArray(data.projects) ? data.projects : [];
    videoHistoryLoaded = true;

    if (projects.length === 0) {
      videoHistoryList.innerHTML = VIDEO_HISTORY_EMPTY_HTML;
      return;
    }

    videoHistoryList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < projects.length; i++) {
      const item = buildVideoHistoryItem(projects[i]);
      const staggerDelay = Math.min(i * 50, 400);
      item.style.animation = `history-item-in 250ms cubic-bezier(0.22, 1, 0.36, 1) ${staggerDelay}ms both`;
      fragment.appendChild(item);
    }

    videoHistoryList.appendChild(fragment);
  } catch (error) {
    console.error('Failed to fetch video history:', error);
    videoHistoryLoaded = false;
    videoHistoryList.innerHTML = `<p class="history-empty">${getFriendlyApiErrorMessage(error, { context: 'history' })}</p>`;
  } finally {
    videoHistoryLoading = false;
  }
}

function buildHistoryItem(generation) {
  const item = document.createElement('div');
  item.className = 'history-item';

  const gifUrl = typeof generation.gif_url === 'string' ? generation.gif_url : '';
  const firstName = typeof generation.first_name === 'string' ? generation.first_name : '';
  const lastName = typeof generation.last_name === 'string' ? generation.last_name : '';
  const profileUrl = typeof generation.linkedin_profile_url === 'string' ? generation.linkedin_profile_url : '';
  const headline = typeof generation.headline === 'string' ? generation.headline : '';
  const company = typeof generation.company === 'string' ? generation.company : '';
  const generationId = generation.id || generation.generation_id || generation.generationId || '';

  item.dataset.gifUrl = gifUrl;
  item.dataset.firstName = firstName;
  item.dataset.lastName = lastName;
  item.dataset.generationId = generationId ? String(generationId) : '';
  item.dataset.profileUrl = profileUrl;
  item.dataset.headline = headline;
  item.dataset.company = company;

  if (gifUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'history-thumb';
    thumb.src = gifUrl;
    thumb.alt = firstName || 'Generated GIF';
    item.appendChild(thumb);
  }

  const info = document.createElement('div');
  info.className = 'history-info';

  const name = document.createElement('div');
  name.className = 'history-name';

  const fullName = (firstName || 'Unknown') + (lastName ? ' ' + lastName : '');

  if (profileUrl && profileUrl.includes('linkedin.com/')) {
    const nameLink = document.createElement('a');
    nameLink.href = profileUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.title = 'View LinkedIn profile';
    nameLink.textContent = fullName;
    name.appendChild(nameLink);
  } else {
    const nameText = document.createElement('span');
    nameText.textContent = fullName;
    name.appendChild(nameText);
  }

  const normalizedHeadline = headline.trim();
  const normalizedCompany = company.trim();
  const isDuplicate =
    normalizedHeadline &&
    normalizedCompany &&
    normalizedHeadline.toLowerCase() === normalizedCompany.toLowerCase();

  info.appendChild(name);
  if (normalizedHeadline) {
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    detail.textContent = normalizedHeadline;
    detail.title = normalizedHeadline;
    info.appendChild(detail);
  }
  if (normalizedCompany && !isDuplicate) {
    const companyEl = document.createElement('div');
    companyEl.className = 'history-company';
    companyEl.textContent = normalizedCompany;
    companyEl.title = normalizedCompany;
    info.appendChild(companyEl);
  }
  item.appendChild(info);

  if (gifUrl) {
    const insertButton = document.createElement('button');
    insertButton.className = 'history-action-btn insert-msg-btn';
    insertButton.type = 'button';
    insertButton.textContent = 'Open in chat';

    const copyButton = document.createElement('button');
    copyButton.className = 'history-action-btn copy-email-btn';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy for email';

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.appendChild(insertButton);
    actions.appendChild(copyButton);
    item.appendChild(actions);
  }

  return item;
}

function buildVideoHistoryItem(project) {
  const item = document.createElement('div');
  item.className = 'history-item';

  const projectId = project?.id ? String(project.id) : '';
  const firstName = typeof project?.first_name === 'string' ? project.first_name : '';
  const lastName = typeof project?.last_name === 'string' ? project.last_name : '';
  const headline = typeof project?.headline === 'string' ? project.headline : '';
  const company = typeof project?.company === 'string' ? project.company : '';
  const profileUrl = typeof project?.source_profile_url === 'string' ? project.source_profile_url : '';
  const posterUrl = typeof project?.final_video_poster_url === 'string' ? project.final_video_poster_url : '';

  item.dataset.projectId = projectId;

  if (posterUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'history-thumb';
    thumb.src = posterUrl;
    thumb.alt = firstName || 'Video poster';
    item.appendChild(thumb);
  }

  const info = document.createElement('div');
  info.className = 'history-info';

  const name = document.createElement('div');
  name.className = 'history-name';

  const fullName = (firstName || 'Unknown') + (lastName ? ` ${lastName}` : '');
  if (profileUrl && profileUrl.includes('linkedin.com/')) {
    const nameLink = document.createElement('a');
    nameLink.href = profileUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.title = 'View LinkedIn profile';
    nameLink.textContent = fullName;
    name.appendChild(nameLink);
  } else {
    const nameText = document.createElement('span');
    nameText.textContent = fullName;
    name.appendChild(nameText);
  }

  const normalizedHeadline = headline.trim();
  const normalizedCompany = company.trim();
  const isDuplicate =
    normalizedHeadline &&
    normalizedCompany &&
    normalizedHeadline.toLowerCase() === normalizedCompany.toLowerCase();

  info.appendChild(name);
  if (normalizedHeadline) {
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    detail.textContent = normalizedHeadline;
    detail.title = normalizedHeadline;
    info.appendChild(detail);
  }
  if (normalizedCompany && !isDuplicate) {
    const companyEl = document.createElement('div');
    companyEl.className = 'history-company';
    companyEl.textContent = normalizedCompany;
    companyEl.title = normalizedCompany;
    info.appendChild(companyEl);
  }
  item.appendChild(info);

  const shareButton = document.createElement('button');
  shareButton.className = 'history-action-btn share-video-btn';
  shareButton.type = 'button';
  shareButton.textContent = 'Share';

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.appendChild(shareButton);
  item.appendChild(actions);

  return item;
}

/**
 * Handle "Copy for Email" — opens share page in new tab
 */
function handleCopyForEmail(gifUrl, firstName, lastName, headline, company, profileUrl, generationId) {
  if (!gifUrl) {
    showStatus('No GIF available for this generation', 'error');
    return;
  }

  // Prefer short URL when generationId is available
  if (generationId) {
    chrome.tabs.create({ url: `${WEB_APP_URL}/share/${generationId}` });
    return;
  }

  // Fallback to query params for older generations
  const params = new URLSearchParams();
  if (gifUrl) params.set('gif', gifUrl);
  if (firstName) params.set('firstName', firstName);
  if (lastName) params.set('lastName', lastName);
  if (headline) params.set('headline', headline);
  if (company) params.set('company', company);
  if (profileUrl) params.set('linkedinUrl', profileUrl);
  const shareUrl = `${WEB_APP_URL}/share?${params.toString()}`;
  chrome.tabs.create({ url: shareUrl });
}

/**
 * Handle "Insert to Message" — auto-attaches GIF to LinkedIn chat via content script
 */
async function handleInsertToMessage(gifUrl, firstName, lastName, buttonElement, profileUrl) {
  if (!gifUrl) {
    showStatus('No GIF available for this generation', 'error');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('linkedin.com')) {
    showStatus('Navigate to a LinkedIn page first', 'error');
    return;
  }

  // Check if we're already on the right profile page
  const profileSlug = profileUrl ? profileUrl.match(/\/in\/([^/?#]+)/)?.[1] : null;
  const onCorrectProfile = profileSlug && tab.url.includes(`/in/${profileSlug}`);

  if (!onCorrectProfile) {
    // Not on the right profile — delegate to background script which will
    // navigate to the profile, wait for page load, then attempt auto-attach.
    // We use the background script because the popup may close during navigation.
    if (!profileUrl || !profileUrl.includes('/in/')) {
      showStatus('No profile link saved for this GIF — visit their profile manually', 'error');
      return;
    }

    buttonElement.textContent = 'Redirecting...';
    buttonElement.disabled = true;

    try {
      await chrome.runtime.sendMessage({
        action: 'navigateAndInsertGif',
        tabId: tab.id,
        profileUrl,
        gifUrl,
        firstName,
        lastName
      });
      showStatus('Opening profile — GIF will be attached to chat', 'success');
      setTimeout(() => window.close(), 1200);
    } catch (error) {
      console.error('Navigate and insert failed:', error);
      buttonElement.textContent = 'Failed';
      showStatus('Something went wrong — try again', 'error');
      setTimeout(() => {
        buttonElement.textContent = 'Open in chat';
        buttonElement.disabled = false;
      }, 2000);
    }
    return;
  }

  // Already on the right profile — run auto-attach directly
  const originalText = buttonElement.textContent;
  buttonElement.textContent = 'Opening...';
  buttonElement.disabled = true;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'insertGifToMessage',
      gifUrl: gifUrl,
      firstName: firstName,
      lastName: lastName
    });

    if (response && response.success) {
      if (response.method === 'sidecar_fallback') {
        buttonElement.textContent = 'Panel opened';
        showStatus('Could not auto-attach — use the in-page panel to send the GIF', 'warning');
        setTimeout(() => window.close(), 1200);
      } else if (response.method === 'urlText') {
        buttonElement.textContent = 'Link inserted';
        showStatus('GIF link inserted into the chat text box', 'warning');
        setTimeout(() => window.close(), 1000);
      } else {
        buttonElement.textContent = 'Attached';
        showStatus('GIF attached to chat', 'success');
        setTimeout(() => window.close(), 900);
      }
    } else {
      buttonElement.textContent = response?.error || 'Failed';
      setTimeout(() => {
        buttonElement.textContent = originalText;
        buttonElement.disabled = false;
      }, 2000);
    }
  } catch (error) {
    console.error('Insert to message failed:', error);
    buttonElement.textContent = 'Failed';
    showStatus('Refresh the LinkedIn page and try again', 'error');
    setTimeout(() => {
      buttonElement.textContent = originalText;
      buttonElement.disabled = false;
    }, 2000);
  }
}

/**
 * Refresh credits display
 */
async function refreshCredits() {
  const result = await chrome.storage.sync.get(['authToken']);

  if (!result.authToken) return;

  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`, {
      headers: {
        'Authorization': `Bearer ${result.authToken}`
      }
    }, 8000);

    if (response.ok) {
      const data = await response.json();
      document.getElementById('credits-balance').textContent = data.credits || 0;
      const planEl = document.getElementById('plan-name');
      if (planEl) {
        planEl.textContent = getPlanLabel(data.subscription || null);
      }

      if (data.user?.email) {
        await updateAuthCache(data.user.email, data.credits || 0, data.subscription || null);
      }
    }
  } catch (error) {
    console.error('Failed to refresh credits:', error);
  }
}

/**
 * Show status banner
 */
function showStatus(message, type = 'success') {
  const banner = document.getElementById('status-banner');
  const text = banner.querySelector('.status-text');

  banner.className = `status-banner ${type}`;
  text.textContent = message;

  // Auto-hide success messages
  if (type === 'success') {
    setTimeout(() => {
      banner.classList.add('hidden');
    }, 5000);
  }
}

// Refresh credits when popup opens (if logged in)
let lastCreditsRefresh = 0;
window.addEventListener('focus', () => {
  const now = Date.now();
  if (now - lastCreditsRefresh < 30000) return;
  lastCreditsRefresh = now;
  refreshCredits();
});
