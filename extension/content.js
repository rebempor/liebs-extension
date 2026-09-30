// LinkedIn Liebs GIF Generator - Content Script (SaaS Version)
// Works with backend API for generation

(function() {
  'use strict';

  function isSalesNavigatorPath(pathname = window.location.pathname) {
    return pathname === '/sales' || pathname.startsWith('/sales/');
  }

  // Sales Navigator is excluded in the manifest, but keep a runtime guard
  // as a fallback in case LinkedIn serves a variant the manifest misses.
  if (isSalesNavigatorPath()) {
    return;
  }

  if (typeof initExtensionSentry === 'function') {
    initExtensionSentry({
      source: 'content',
    });
  }

  console.log('[Liebs GIF] SaaS content script loaded on:', window.location.href);

  // Sentry helpers (trackContentError, trackContentErrorOnce, addContentBreadcrumb)
  // are defined in content-shared.js and available globally.

  // ============================================================
  // STATE
  // ============================================================

  let userCredits = null;
  let isAuthenticated = false;
  let profileObserver = null;
  let observedMain = null;
  let observerCheckHandle = null;
  let observerCheckMode = null;
  let lastKnownPath = window.location.pathname;
  let outreachPreProcessDebounceTimer = null;
  const outreachPreProcessedPaths = new Set();
  let pendingGenerationNotice = null;
  let liebsInsertInFlight = false;
  let lastAuthCheckAt = 0;
  const AUTH_CHECK_THROTTLE_MS = 60_000;

  // ============================================================
  // SIDECAR STATE MACHINE
  // ============================================================

  const GM_STATES = {
    Idle: 'Idle',
    Bootstrapping: 'Bootstrapping',
    StylisePending: 'StylisePending',
    PreviewReady: 'PreviewReady',
    AnimatePending: 'AnimatePending',
    ComposePending: 'ComposePending',
    DeliverReady: 'DeliverReady',
    DeliverSuccess: 'DeliverSuccess',
    ErrorCapture: 'ErrorCapture',
    ErrorStylise: 'ErrorStylise',
    ErrorAnimate: 'ErrorAnimate',
    ErrorAnimateTimeout: 'ErrorAnimateTimeout',
    ErrorDeliver: 'ErrorDeliver',
    CancelledWithOriginal: 'CancelledWithOriginal',
    CancelledWithStylised: 'CancelledWithStylised',
  };

  // Rail indices: 0=Snap, 1=Glow-Up, 2=Magic, 3=Ta-da ✨
  const GM_STAGE_MAP = {
    [GM_STATES.Idle]: -1,
    [GM_STATES.Bootstrapping]: 0,        // Snap
    [GM_STATES.StylisePending]: 0,        // Snap
    [GM_STATES.PreviewReady]: 1,          // Glow-Up
    [GM_STATES.AnimatePending]: 2,        // Magic
    [GM_STATES.ComposePending]: 2,        // Magic
    [GM_STATES.DeliverReady]: 3,          // Ta-da ✨
    [GM_STATES.DeliverSuccess]: 3,        // Ta-da ✨
    [GM_STATES.ErrorCapture]: 0,
    [GM_STATES.ErrorStylise]: 1,
    [GM_STATES.ErrorAnimate]: 2,
    [GM_STATES.ErrorAnimateTimeout]: 2,
    [GM_STATES.ErrorDeliver]: 3,
    [GM_STATES.CancelledWithOriginal]: 0,
    [GM_STATES.CancelledWithStylised]: 1,
  };

  const STYLISED_THUMB_STATES = new Set([
    GM_STATES.StylisePending,
    GM_STATES.PreviewReady,
    GM_STATES.AnimatePending,
    GM_STATES.ComposePending,
  ]);
  const GM_SIDECAR_ID = 'gm-sidecar-panel';
  const GM_SIDECAR_POSITION_KEY = 'gmSidecarPositionV1';
  const GM_TRAY_TUTORIAL_CYCLE_MS = 7500;
  const GM_TRAY_OPEN_HAND = '\u{1F590}\uFE0F';
  const GM_TRAY_GRAB_HAND = '\u270A';

  const OUTLINE_LIGHT_STATES = new Set([
    GM_STATES.StylisePending,
    GM_STATES.PreviewReady,
    GM_STATES.AnimatePending,
    GM_STATES.ComposePending,
  ]);

  const ACTIVE_GENERATION_STATES = new Set([
    GM_STATES.Bootstrapping,
    GM_STATES.StylisePending,
    GM_STATES.PreviewReady,
    GM_STATES.AnimatePending,
    GM_STATES.ComposePending,
  ]);

  const LIEBS_INSERT_HASH_PREFIX = '#liebs-insert=';
  const LIEBS_INSERT_MAX_PAYLOAD_CHARS = 8192;

  const gmState = {
    current: GM_STATES.Idle,
    hidden: false,
    timers: [],
    animateInterval: null,
    panelHideTimeout: null,
    // DOM refs (set by createSidecar)
    sidecarEl: null,
    announcerEl: null,
    contentEl: null,
    filmstripEl: null,
    sweepEl: null,
    captureFlashEl: null,
    thumbStylisedEl: null,
    thumbSilhouetteEl: null,
    thumbOutlineTraceEl: null,
    thumbOutlineImgEl: null,
    thumbLiebsEl: null,
    thumbLiebsSparkleEl: null,
    thumbEl: null,
    thumbOriginalEl: null,
    footerEl: null,
    minimizeBtnEl: null,
    trayEl: null,
    trayGifEl: null,
    trayHandEl: null,
    trayEmojiHandEl: null,
    trayHintEl: null,
    trayDropZoneEl: null,
    trayDropZoneCleanup: null,
    trayFile: null,
    trayFilePromise: null,
    trayFileReady: false,
    trayConversation: null,
    trayEmojiCycleTimers: [],
    trayEmojiCycleInterval: null,
    traySessionId: 0,
    _trayCleanupFns: [],
    _composerObserver: null,
    // Positioning ref
    _triggerRef: null,
    _cardRef: null,
    _photoRef: null,
    manualPosition: null,
    manualPositionPath: null,
    isDragging: false,
    _dragCleanup: null,
    // Backend state
    gifUrl: null,
    silhouetteUrl: null,
    liebsImageUrl: null,
    firstName: null,
    lastName: null,
    headline: null,
    company: null,
    jobId: null,
    generationId: null,
    profilePhotoUrl: null,
    profileUrl: null,
    backendDone: false,
    backendError: null,
    cancelRequested: false,
    generationStartedAt: 0,
    liebsPreviewRevealed: false,
    liebsRevealTimeout: null,
    silhouetteVisibleAt: 0,
    currentPipelineStage: null,
    stageTimeHints: {},
    shownStageTimeHints: {},
    activeStageTimeHint: null,
    glowUpStartedAt: 0,
    styliseStartedAt: 0,
    errorReason: null,
    lastAnimateStatusText: null,
    lastAnimateStatusUpdatedAt: 0,
    // Text overlay state — tracks what text the user wants on the GIF
    greetingText: null,
    ctaText: null,
    textSyncPending: false,
    textSyncInFlight: false,
    textAutoSaveTimer: null,
    textLocked: false,
    // Edit timer state
    editTimerInterval: null,
    editTimerExpired: false,
    editTimerSeconds: EDIT_TIMER_DURATION,
  };

  const VS_UI_STATES = {
    READY: 'READY',
    GENERATING: 'GENERATING',
    REVIEW_IMAGES: 'REVIEW_IMAGES',
    RENDERING_VIDEO: 'RENDERING_VIDEO',
    FINAL_VIDEO: 'FINAL_VIDEO',
    SCENE_RECOVERY: 'SCENE_RECOVERY',
    SCENE_PREVIEW: 'SCENE_PREVIEW',
    REDOING_VIDEO: 'REDOING_VIDEO',
    ERROR_GENERATE: 'ERROR_GENERATE',
    ERROR_RENDER: 'ERROR_RENDER',
  };

  const VS_REVIEW_ASSET_TYPES = new Set([
    'portrait',
    'full_body',
    'scene_starting_frame',
  ]);
  const VS_RENDER_JOB_TYPES = new Set(['render_video', 'video_redo', 'scene_apply']);
  const VS_SIDECAR_ID = 'vs-sidecar';
  const VS_SIDECAR_POSITION_KEY = 'vsVideoSidecarPositionV1';
  const VS_POLL_STOPPED_MESSAGE = 'We stopped auto-checking because this is taking unusually long. Your project may still finish. Use Refresh to check again.';

  const vsState = {
    current: VS_UI_STATES.READY,
    authToken: null,
    activeProfile: null,
    project: null,
    assets: [],
    activeJobs: [],
    pendingRegenAssetIds: new Set(),
    assetPromptDrafts: {},
    assetRegenerateDependentsDrafts: {},
    scenePromptDrafts: {},
    latestJob: null,
    scenes: [],
    pendingScenePreview: null,
    recovery: null,
    hidden: true,
    minimized: false,
    loading: false,
    activeMutation: false,
    insertingVideo: false,
    openAssetEditorId: null,
    openSceneEditorId: null,
    imageEditorOpen: false,
    errorMessage: null,
    statusMessage: null,
    statusTone: 'success',
    rotateStageMessageIndex: 0,
    rotateStageMessageTimer: null,
    pollTimer: null,
    pollStartedAt: 0,
    pollFailureCount: 0,
    pollRequestVersion: 0,
    pollStoppedReason: null,
    pollTargetProjectId: null,
    pollTargetJobType: null,
    pollTargetJobId: null,
    verificationDebuggerEnabled: false,
    reverifyingKey: null,
    applyingWindowKey: null,
    applyingManualTimingKey: null,
    reverifyResultsByKey: {},
    manualTimingDraftsByKey: {},
    optimisticTimingByKey: {},
    videoBlobUrls: {},
    videoBlobUrlsPending: {},
    panelHideTimeout: null,
    sidecarEl: null,
    contentEl: null,
    footerEl: null,
    progressRailEl: null,
    refreshBtnEl: null,
    minimizeBtnEl: null,
    closeBtnEl: null,
    manualPosition: null,
    manualPositionPath: null,
    isDragging: false,
    _dragCleanup: null,
    _triggerRef: null,
    _cardRef: null,
    _photoRef: null,
    lastRenderedUiState: null,
  };

  // ============================================================
  // UTILITY HELPERS
  // ============================================================

  function isValidManualSidecarPosition(value) {
    return Boolean(
      value &&
      Number.isFinite(value.left) &&
      Number.isFinite(value.top)
    );
  }

  function loadSavedSidecarPosition() {
    chrome.storage.local.get([GM_SIDECAR_POSITION_KEY], (result) => {
      const saved = result?.[GM_SIDECAR_POSITION_KEY];
      if (!isValidManualSidecarPosition(saved)) return;
      gmState.manualPosition = {
        left: Math.round(saved.left),
        top: Math.round(saved.top),
      };
      gmState.manualPositionPath = typeof saved.path === 'string' ? saved.path : null;
      // If sidecar already exists (e.g. hot reload/dev), apply immediately.
      if (gmState.sidecarEl) {
        positionSidecar();
      }
    });
  }

  function persistManualSidecarPosition() {
    if (!isValidManualSidecarPosition(gmState.manualPosition)) return;
    chrome.storage.local.set({
      [GM_SIDECAR_POSITION_KEY]: {
        left: Math.round(gmState.manualPosition.left),
        top: Math.round(gmState.manualPosition.top),
        path: gmState.manualPositionPath || window.location.pathname,
      },
    });
  }

  function sendMessageWithTimeout(message, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        trackContentError('message_passing.failed', new Error('Request timed out'), {
          action: message?.action || null,
          timeoutMs,
          reason: 'timeout',
        });
        reject(new Error('Request timed out'));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            const messageError = new Error(chrome.runtime.lastError.message || 'Message request failed');
            trackContentError('message_passing.failed', messageError, {
              action: message?.action || null,
              timeoutMs,
              reason: 'runtime_last_error',
            });
            reject(messageError);
            return;
          }

          resolve(response);
        });
      } catch (error) {
        clearTimeout(timeoutId);
        if (!settled) {
          settled = true;
          trackContentError('message_passing.failed', error, {
            action: message?.action || null,
            timeoutMs,
            reason: 'send_throw',
          });
          reject(error);
        }
      }
    });
  }

  function isAllowedLiebsInsertGifUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return false;

      return (
        url.hostname === 'assets.liebs.app' ||
        url.hostname === 'media.licdn.com' ||
        url.hostname.endsWith('.amazonaws.com')
      );
    } catch (_error) {
      return false;
    }
  }

  function decodeLiebsInsertPayload(encodedValue) {
    if (!encodedValue || encodedValue.length > LIEBS_INSERT_MAX_PAYLOAD_CHARS) {
      return null;
    }

    let normalizedValue = encodedValue;
    try {
      normalizedValue = decodeURIComponent(encodedValue);
    } catch (_error) {
      normalizedValue = encodedValue;
    }

    try {
      const paddedValue = normalizedValue.padEnd(Math.ceil(normalizedValue.length / 4) * 4, '=');
      const binary = atob(paddedValue);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const json = new TextDecoder().decode(bytes);
      const payload = JSON.parse(json);
      const gifUrl = typeof payload?.gifUrl === 'string' ? payload.gifUrl.trim() : '';
      const firstName = typeof payload?.firstName === 'string' ? payload.firstName.trim() : null;
      const lastName = typeof payload?.lastName === 'string' ? payload.lastName.trim() : null;

      if (!gifUrl || !isAllowedLiebsInsertGifUrl(gifUrl)) {
        return null;
      }

      return {
        gifUrl,
        firstName: firstName || null,
        lastName: lastName || null,
      };
    } catch (_error) {
      return null;
    }
  }

  function clearLiebsInsertHash() {
    if (!window.location.hash) return;

    const nextUrl = `${window.location.pathname}${window.location.search}`;
    history.replaceState(history.state, document.title, nextUrl);
  }

  function findVisibleProfileMessageButton() {
    for (const selector of SELECTORS.messageButton || []) {
      const buttons = document.querySelectorAll(selector);
      for (const button of buttons) {
        if (button.offsetParent !== null) {
          return button;
        }
      }
    }

    const fallbackButtons = document.querySelectorAll('button, a[role="button"], a[aria-label], a[href*="messaging"]');
    for (const button of fallbackButtons) {
      const text = button.textContent?.trim();
      if (text !== 'Message' || button.offsetParent === null) continue;

      const rect = button.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.7 && rect.width > 0) {
        return button;
      }
    }

    return null;
  }

  function hasVisibleMessagingForm() {
    for (const selector of SELECTORS.msgFormContainer || ['.msg-form']) {
      const forms = typeof deepQueryAll === 'function'
        ? deepQueryAll(selector)
        : Array.from(document.querySelectorAll(selector));

      for (const form of forms) {
        if (form?.offsetParent !== null) {
          return true;
        }
      }
    }

    return false;
  }

  async function waitForLiebsInsertReady(timeoutMs = LIEBS_INSERT_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!window.location.pathname.startsWith('/in/')) {
        return false;
      }

      if (hasVisibleMessagingForm() || findVisibleProfileMessageButton()) {
        return true;
      }

      await sleep(LIEBS_INSERT_POLL_INTERVAL_MS);
    }

    return false;
  }

  function trackEvent(eventName, properties = {}) {
    if (!eventName) return;
    chrome.runtime.sendMessage({
      action: 'trackEvent',
      source: 'content',
      eventName,
      properties,
    }).catch(() => {});
  }

  async function requestGenerationCancel() {
    try {
      const response = await sendMessageWithTimeout({ action: 'cancelGeneration' }, 10000);
      return response || { success: false };
    } catch (error) {
      debugWarn('cancel', 'Failed to request backend cancellation:', error.message);
      return { success: false, error: error.message };
    }
  }

  async function urlToGifFile(gifUrl, firstName) {
    console.log('[Liebs GIF] Fetching GIF from URL via background script...');
    // Content scripts can't fetch cross-origin URLs (CORS).
    // Route through background script which has host_permissions.
    const result = await chrome.runtime.sendMessage({
      action: 'fetchUrl',
      url: gifUrl
    });

    if (!result || !result.success) {
      throw new Error('Failed to fetch GIF: ' + (result?.error || 'unknown error'));
    }

    // Convert data URL back to blob/file
    const response = await fetch(result.dataUrl);
    const blob = await response.blob();
    const file = new File([blob], `${firstName}.gif`, { type: 'image/gif' });
    console.log('[Liebs GIF] File created:', file.name, file.size, 'bytes');
    return file;
  }

  async function blobUrlToVideoFile(blobUrl, firstName = 'video') {
    if (!blobUrl || typeof blobUrl !== 'string' || !blobUrl.startsWith('blob:')) {
      throw new Error('Video file is not ready yet.');
    }

    let response;
    try {
      response = await fetch(blobUrl);
    } catch (_error) {
      throw new Error('Could not load the video from cache.');
    }

    if (!response.ok) {
      throw new Error(`Could not load the video from cache (HTTP ${response.status}).`);
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (_error) {
      throw new Error('Could not prepare the video file.');
    }

    const safeBaseName = String(firstName || 'video')
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      || 'video';

    return new File([blob], `${safeBaseName}.mp4`, { type: blob.type || 'video/mp4' });
  }

  // ============================================================
  // PROFILE DATA EXTRACTION
  // ============================================================

  function isGenerationActive() {
    return gmState.current !== GM_STATES.Idle;
  }

  async function maybePreProcessProfile() {
    try {
      const currentPath = window.location.pathname;
      if (!currentPath.startsWith('/in/')) return;

      const outreachState = await chrome.storage.local.get([
        'outreachMode',
        'outreachEndsAt',
      ]);

      if (!outreachState.outreachMode) return;

      const outreachEndsAt = Number(outreachState.outreachEndsAt) || 0;
      if (outreachEndsAt && outreachEndsAt <= Date.now()) {
        await chrome.storage.local.set({
          outreachMode: false,
          outreachEndsAt: null,
        });
        return;
      }

      if (outreachPreProcessedPaths.has(currentPath)) return;
      if (isGenerationActive()) return;

      const photoUrl = extractProfilePhoto();
      const firstName = extractFirstName();
      if (!photoUrl || !firstName) return;

      const photoFingerprint = await computePhotoFingerprint(photoUrl);
      if (!photoFingerprint) return;

      const photoBase64 = await imageUrlToBase64(photoUrl);
      if (!photoBase64) return;

      outreachPreProcessedPaths.add(currentPath);

      const response = await sendMessageWithTimeout({
        action: 'preProcessProfile',
        photoUrl,
        photoBase64,
        firstName,
        profileUrl: window.location.href,
        photoFingerprint,
      }, 25000);

      if (!response?.success) {
        outreachPreProcessedPaths.delete(currentPath);
        debugWarn('outreach', 'Pre-process failed:', response?.error || 'unknown error');
        return;
      }

      debugLog('outreach', `Pre-process queued for ${currentPath}:`, response.status || 'processing');
    } catch (error) {
      debugWarn('outreach', 'Pre-process request error:', error.message);
    }
  }

  function scheduleOutreachPreProcess(delayMs = 2000) {
    if (outreachPreProcessDebounceTimer) {
      clearTimeout(outreachPreProcessDebounceTimer);
      outreachPreProcessDebounceTimer = null;
    }

    outreachPreProcessDebounceTimer = setTimeout(() => {
      outreachPreProcessDebounceTimer = null;
      maybePreProcessProfile();
    }, delayMs);
  }

  // ============================================================
  // DIAGNOSTICS
  // ============================================================

  // --- Diagnostic function: callable via window.__liebsDiag() ---
  window.__liebsDiag = function() {
    const result = {
      url: window.location.href,
      timestamp: new Date().toISOString(),
      messageButtons: [],
      composers: [],
      attachButtons: [],
      fileInputs: [],
      attachmentPreviews: []
    };

    for (const selector of SELECTORS.messageButton) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        result.messageButtons.push({
          selector, tagName: el.tagName,
          ariaLabel: el.getAttribute('aria-label'),
          text: el.textContent?.trim().substring(0, 50),
          visible: el.offsetParent !== null
        });
      }
    }

    // Also check text-content fallback
    const allBtns = document.querySelectorAll('button, a[role="button"]');
    for (const btn of allBtns) {
      if (btn.textContent?.trim() === 'Message' && btn.offsetParent !== null) {
        result.messageButtons.push({
          selector: '(text fallback)', tagName: btn.tagName,
          ariaLabel: btn.getAttribute('aria-label'),
          text: 'Message', visible: true
        });
      }
    }

    for (const selector of SELECTORS.messageComposer) {
      const elements = deepQueryAll(selector);
      for (const el of elements) {
        result.composers.push({
          selector, tagName: el.tagName,
          contentEditable: el.contentEditable,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          className: el.className?.substring?.(0, 100) || '',
          visible: el.offsetParent !== null,
          inShadow: !!getShadowRoot()?.contains(el)
        });
      }
    }

    for (const selector of SELECTORS.attachButton) {
      const elements = deepQueryAll(selector);
      for (const el of elements) {
        result.attachButtons.push({
          selector, tagName: el.tagName,
          ariaLabel: el.getAttribute('aria-label'),
          visible: el.offsetParent !== null,
          inShadow: !!getShadowRoot()?.contains(el)
        });
      }
    }

    for (const selector of SELECTORS.fileInput) {
      const elements = deepQueryAll(selector);
      for (const el of elements) {
        result.fileInputs.push({
          selector, accept: el.accept, multiple: el.multiple,
          hasReactFiber: !!Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')),
          inShadow: !!getShadowRoot()?.contains(el)
        });
      }
    }

    const msgForm = deepQuery('.msg-form');
    result.msgFormPresent = !!msgForm;
    if (msgForm) {
      result.msgFormHTML = msgForm.innerHTML.substring(0, 2000);
    }

    const msgOverlay = deepQuery('.msg-overlay-list-bubble') || deepQuery('.msg-overlay-conversation-bubble');
    result.msgOverlayPresent = !!msgOverlay;
    result.gmState = {
      state: gmState.current,
      silhouetteUrl: gmState.silhouetteUrl,
      thumbSilhouetteSrc: gmState.thumbSilhouetteEl?.getAttribute('src') || null,
      thumbSilhouetteLoaded: !!(
        gmState.thumbSilhouetteEl &&
        gmState.thumbSilhouetteEl.complete &&
        gmState.thumbSilhouetteEl.naturalWidth > 0
      ),
      thumbStylisedVisible: !!gmState.thumbStylisedEl?.classList?.contains('visible'),
      thumbOutlineTraceActive: !!gmState.thumbOutlineTraceEl?.classList?.contains('active'),
    };

    // === BROAD DISCOVERY: find what LinkedIn actually uses now ===
    result.discovery = {};

    // Find all contenteditable elements
    const editables = document.querySelectorAll('[contenteditable="true"]');
    result.discovery.contenteditables = Array.from(editables).map(el => ({
      tagName: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className?.substring?.(0, 120) || '',
      parentClass: el.parentElement?.className?.substring?.(0, 120) || '',
      grandparentClass: el.parentElement?.parentElement?.className?.substring?.(0, 120) || '',
      visible: el.offsetParent !== null,
      text: el.textContent?.substring(0, 50) || ''
    }));

    // Find all role="textbox" elements
    const textboxes = document.querySelectorAll('[role="textbox"]');
    result.discovery.textboxes = Array.from(textboxes).map(el => ({
      tagName: el.tagName,
      contentEditable: el.contentEditable,
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className?.substring?.(0, 120) || '',
      parentClass: el.parentElement?.className?.substring?.(0, 120) || '',
      visible: el.offsetParent !== null
    }));

    // Find all file inputs
    const allFileInputs = document.querySelectorAll('input[type="file"]');
    result.discovery.allFileInputs = Array.from(allFileInputs).map(el => ({
      accept: el.accept,
      className: el.className?.substring?.(0, 80) || '',
      parentClass: el.parentElement?.className?.substring?.(0, 80) || '',
      visible: el.offsetParent !== null,
      hasReactFiber: !!Object.keys(el).find(k => k.startsWith('__reactFiber$'))
    }));

    // Find elements with "msg" or "message" in class names
    const msgElements = document.querySelectorAll('[class*="msg-"], [class*="message"], [class*="messaging"]');
    result.discovery.msgClassElements = Array.from(msgElements).slice(0, 30).map(el => ({
      tagName: el.tagName,
      className: el.className?.substring?.(0, 150) || '',
      role: el.getAttribute('role'),
      visible: el.offsetParent !== null
    }));

    // Find overlay/modal/dialog elements
    const overlays = document.querySelectorAll('[role="dialog"], [class*="overlay"], [class*="modal"], [class*="convo"]');
    result.discovery.overlays = Array.from(overlays).map(el => ({
      tagName: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className?.substring?.(0, 150) || '',
      visible: el.offsetParent !== null,
      childCount: el.children.length
    }));

    // Find buttons with attach/image/file related labels
    const attachLike = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    result.discovery.attachLikeButtons = Array.from(attachLike).filter(el => {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('attach') || label.includes('image') || label.includes('file') ||
             label.includes('photo') || label.includes('media') || label.includes('gif') ||
             label.includes('add a') || label.includes('upload');
    }).map(el => ({
      tagName: el.tagName,
      ariaLabel: el.getAttribute('aria-label'),
      className: el.className?.substring?.(0, 100) || '',
      visible: el.offsetParent !== null
    }));

    // Find iframes (messaging might be inside one)
    const iframes = document.querySelectorAll('iframe');
    result.discovery.iframes = Array.from(iframes).map(el => {
      let accessible = false;
      let innerContenteditables = 0;
      let innerTextboxes = 0;
      try {
        const doc = el.contentDocument;
        if (doc) {
          accessible = true;
          innerContenteditables = doc.querySelectorAll('[contenteditable="true"]').length;
          innerTextboxes = doc.querySelectorAll('[role="textbox"]').length;
        }
      } catch (e) { /* cross-origin */ }
      return {
        src: (el.src || '').substring(0, 150),
        id: el.id,
        className: el.className?.substring?.(0, 100) || '',
        width: el.width || el.style?.width,
        height: el.height || el.style?.height,
        visible: el.offsetParent !== null,
        accessible,
        innerContenteditables,
        innerTextboxes
      };
    });

    // Find elements with open shadow roots
    result.discovery.shadowHosts = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        let shadowContenteditables = 0;
        let shadowTextboxes = 0;
        let shadowMsgElements = 0;
        try {
          shadowContenteditables = el.shadowRoot.querySelectorAll('[contenteditable="true"]').length;
          shadowTextboxes = el.shadowRoot.querySelectorAll('[role="textbox"]').length;
          shadowMsgElements = el.shadowRoot.querySelectorAll('[class*="msg"], [class*="message"]').length;
        } catch (e) {}
        result.discovery.shadowHosts.push({
          tagName: el.tagName,
          id: el.id,
          className: el.className?.substring?.(0, 100) || '',
          visible: el.offsetParent !== null,
          shadowContenteditables,
          shadowTextboxes,
          shadowMsgElements
        });
      }
    }

    // Count total elements on page (sanity check)
    result.discovery.totalElements = allElements.length;

    // Find bottom-right positioned elements (messaging overlays are usually there)
    result.discovery.bottomRightElements = [];
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    for (const el of document.body.children) {
      const rect = el.getBoundingClientRect();
      if (rect.right > viewportWidth * 0.5 && rect.bottom > viewportHeight * 0.5 &&
          rect.width > 50 && rect.height > 50 && rect.width < viewportWidth * 0.6) {
        result.discovery.bottomRightElements.push({
          tagName: el.tagName,
          id: el.id,
          className: el.className?.substring?.(0, 150) || '',
          rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
          childCount: el.children.length
        });
      }
    }

    console.log('[Liebs GIF] Diagnostic results:', JSON.stringify(result, null, 2));
    return result;
  };

  // ============================================================
  // AUTH CHECK & NOTIFICATIONS
  // ============================================================

  async function copyImageUrlToClipboard(imageUrl) {
    if (!imageUrl) {
      return { ok: false, mode: 'none' };
    }

    try {
      // Fetch via background script to avoid CORS
      const result = await chrome.runtime.sendMessage({
        action: 'fetchUrl',
        url: imageUrl
      });
      if (!result || !result.success) {
        throw new Error(result?.error || 'fetch failed');
      }
      const response = await fetch(result.dataUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      return { ok: true, mode: 'image' };
    } catch (e) {
      try {
        await navigator.clipboard.writeText(imageUrl);
        return { ok: true, mode: 'url' };
      } catch (_fallbackErr) {
        debugWarn('clipboard', 'Failed to copy image to clipboard:', e.message);
        return { ok: false, mode: 'none' };
      }
    }
  }

  async function copyGifToClipboard(gifUrl) {
    const result = await copyImageUrlToClipboard(gifUrl);
    if (!result.ok) {
      return false;
    }

    debugLog('clipboard', `GIF copied via ${result.mode} mode`);
    return true;
  }

  function getStillSourceUrl(hasStylised) {
    if (hasStylised && gmState.silhouetteUrl) {
      return gmState.silhouetteUrl;
    }
    return gmState.profilePhotoUrl || gmState.thumbOriginalEl?.src || null;
  }

  async function copyStillToClipboard(hasStylised) {
    const stillUrl = getStillSourceUrl(hasStylised);
    return copyImageUrlToClipboard(stillUrl);
  }

  async function checkAuth() {
    try {
      const response = await sendMessageWithTimeout({ action: 'checkAuth' }, 8000);
      if (response && response.authenticated) {
        isAuthenticated = true;
        userCredits = response.credits;
        return true;
      }
      isAuthenticated = false;
      userCredits = null;
      return false;
    } catch (error) {
      isAuthenticated = false;
      userCredits = null;
      throw error;
    }
  }

  function showNotification(message, type = 'info') {
    const existing = document.getElementById('liebs-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.id = 'liebs-notification';
    notification.className = `liebs-notification ${type}`;
    notification.innerHTML = `
      <span>${message}</span>
      <button class="liebs-notification-close">&times;</button>
    `;

    document.body.appendChild(notification);
    const notificationPosition = getNotificationPosition({
      width: notification.offsetWidth,
      height: notification.offsetHeight,
    });
    notification.style.top = `${notificationPosition.top}px`;
    notification.style.right = `${notificationPosition.right}px`;

    notification.querySelector('.liebs-notification-close').addEventListener('click', () => {
      notification.remove();
    });

    if (type === 'success') {
      setTimeout(() => notification.remove(), 5000);
    }
  }

  function updateInlineStatusText(text) {
    const nextText = typeof text === 'string' ? text.trim() : '';
    if (!nextText || !gmState.contentEl) return;

    const statusText = gmState.contentEl.querySelector('.gm-status-text');
    if (statusText) {
      statusText.textContent = nextText;
    }
  }

  // ============================================================
  // SIDECAR: HELPERS
  // ============================================================

  function clearGmTimers() {
    gmState.timers.forEach(clearTimeout);
    gmState.timers = [];
    gmState.trayEmojiCycleTimers.forEach(clearTimeout);
    gmState.trayEmojiCycleTimers = [];
    if (gmState.animateInterval) {
      clearInterval(gmState.animateInterval);
      gmState.animateInterval = null;
    }
    if (gmState.trayEmojiCycleInterval) {
      clearInterval(gmState.trayEmojiCycleInterval);
      gmState.trayEmojiCycleInterval = null;
    }
    if (gmState.editTimerInterval) {
      clearInterval(gmState.editTimerInterval);
      gmState.editTimerInterval = null;
    }
    if (gmState.liebsRevealTimeout) {
      clearTimeout(gmState.liebsRevealTimeout);
      gmState.liebsRevealTimeout = null;
    }
    if (gmState.textAutoSaveTimer) {
      clearTimeout(gmState.textAutoSaveTimer);
      gmState.textAutoSaveTimer = null;
    }
  }

  function gmSleep(ms) {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      gmState.timers.push(t);
    });
  }

  function escapeHtmlAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function announce(msg) {
    if (gmState.announcerEl) {
      gmState.announcerEl.textContent = msg;
    }
  }

  function getNotificationPosition(options = {}) {
    const width = Number.isFinite(options.width) ? options.width : 200;
    const height = Number.isFinite(options.height) ? options.height : 60;
    const margin = 16;
    const gap = 8;
    const fallbackTop = 420;
    let top = fallbackTop;
    let right = margin;

    const sidecar = document.getElementById(GM_SIDECAR_ID);
    if (sidecar) {
      const sidecarRect = sidecar.getBoundingClientRect();
      const sidecarStyle = window.getComputedStyle(sidecar);
      const sidecarVisible =
        sidecarStyle.display !== 'none' &&
        sidecarStyle.visibility !== 'hidden' &&
        sidecarRect.width > 0 &&
        sidecarRect.height > 0;

      if (sidecarVisible) {
        top = sidecarRect.bottom + gap;
        right = window.innerWidth - sidecarRect.right;
      }
    }

    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    const maxRight = Math.max(margin, window.innerWidth - width - margin);

    return {
      top: Math.min(Math.max(top, margin), maxTop),
      right: Math.min(Math.max(right, margin), maxRight),
    };
  }

  function showGmToast(message) {
    document.querySelectorAll('.gm-toast').forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = 'gm-toast';
    toast.innerHTML = '<span class="gm-toast-icon">\u2713</span><span>' + message + '</span>';
    document.body.appendChild(toast);
    const toastPosition = getNotificationPosition({
      width: toast.offsetWidth,
      height: toast.offsetHeight,
    });
    toast.style.top = `${toastPosition.top}px`;
    toast.style.right = `${toastPosition.right}px`;
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  const GM_COMPOSER_SURFACE_STYLE_ID = 'gm-composer-surface-styles';
  const GM_COMPOSER_SURFACE_STYLES = `
.gm-composer-tray,
.gm-composer-drop-zone {
  --gm-primary: #e8614d;
  --li-border: #f0ddd4;
  --li-text: #2d1f1a;
  --li-muted: #8c7268;
  --li-bg-warm: #fdf8f4;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
.gm-composer-tray,
.gm-composer-tray *,
.gm-composer-drop-zone,
.gm-composer-drop-zone * {
  box-sizing: border-box;
}
.gm-composer-tray {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 76px;
  padding: 10px 12px;
  border-top: 1px solid var(--li-border);
  border-left: 3px solid var(--gm-primary);
  background: linear-gradient(180deg, #fffdfb 0%, var(--li-bg-warm) 100%);
  color: var(--li-text);
  font-family: var(--font);
  overflow: visible;
  z-index: 4;
  animation: gm-tray-enter 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.gm-composer-tray.gm-tray-collapsed {
  pointer-events: none;
  animation: gm-tray-exit 240ms ease both;
}
.gm-composer-tray.gm-tray-dimmed {
  opacity: 0.72;
}
.gm-tray-gif-wrapper {
  position: relative;
  flex-shrink: 0;
}
.gm-tray-gif {
  width: 56px;
  height: 56px;
  border-radius: 10px;
  border: 1.5px solid rgba(232, 97, 77, 0.18);
  background: linear-gradient(135deg, #fde8e3 0%, #fef3e2 52%, #f5e3df 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  cursor: grab;
  box-shadow: 0 6px 18px rgba(232, 97, 77, 0.12);
}
.gm-tray-gif.gm-tray-gif-animated {
  animation: gm-gif-bounce 7.5s ease-in-out infinite;
}
.gm-tray-gif:hover {
  border-color: rgba(232, 97, 77, 0.45);
  box-shadow: 0 0 0 3px rgba(232, 97, 77, 0.12);
}
.gm-tray-gif:active {
  cursor: grabbing;
}
.gm-tray-gif.gm-tray-gif-disabled {
  cursor: not-allowed;
  opacity: 0.72;
  box-shadow: none;
}
.gm-tray-gif img {
  width: 100%;
  height: 100%;
  max-width: none;
  object-fit: cover;
  display: block;
}
.gm-tray-gif-grip {
  position: absolute;
  inset: 0;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.74);
  opacity: 0;
  transition: opacity 150ms ease;
  pointer-events: none;
}
.gm-tray-gif:hover .gm-tray-gif-grip {
  opacity: 1;
}
.gm-tray-gif.gm-tray-gif-disabled .gm-tray-gif-grip {
  opacity: 0;
}
.gm-grip-dots {
  display: grid;
  grid-template-columns: repeat(2, 4px);
  gap: 3px;
}
.gm-grip-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--gm-primary);
}
.gm-hand-tutorial {
  position: absolute;
  top: 0;
  left: 0;
  width: 56px;
  height: 144px;
  overflow: visible;
  pointer-events: none;
  z-index: 8;
}
.gm-hand-hidden {
  display: none;
}
.gm-emoji-hand {
  position: absolute;
  left: 50%;
  top: 28%;
  font-size: 22px;
  line-height: 1;
  transform: translate(-50%, -50%);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
  animation: gm-tap-hand 7.5s ease-in-out infinite;
  user-select: none;
  z-index: 25;
}
.gm-select-ring {
  position: absolute;
  top: -2px;
  left: -2px;
  width: 60px;
  height: 60px;
  border-radius: 10px;
  border: 2px solid var(--gm-primary);
  opacity: 0;
  z-index: 2;
  box-shadow: 0 0 12px rgba(232, 97, 77, 0.4);
  animation: gm-ring 7.5s ease-in-out infinite;
}
.gm-particle {
  position: absolute;
  left: 50%;
  top: 56px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gm-primary);
  transform: translateX(-50%);
  opacity: 0;
  z-index: 22;
  filter: blur(0.5px);
  animation: gm-particle 7.5s ease-in-out infinite;
}
.gm-particle-2 {
  width: 5px;
  height: 5px;
  animation-delay: 0.15s;
}
.gm-particle-3 {
  width: 4px;
  height: 4px;
  animation-delay: 0.3s;
}
.gm-particle-4 {
  width: 3px;
  height: 3px;
  animation-delay: 0.45s;
}
.gm-whoosh-ghost {
  position: absolute;
  left: 50%;
  top: 10px;
  transform: translate(-50%, 0);
  width: 36px;
  height: 36px;
  border-radius: 6px;
  border: 1.5px solid rgba(232, 97, 77, 0.35);
  background: linear-gradient(135deg, #fde8e3 0%, #fef3e2 52%, #f5e3df 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  opacity: 0;
  z-index: 23;
  animation: gm-whoosh 7.5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  box-shadow: 0 0 16px rgba(232, 97, 77, 0.25);
}
.gm-magnet-pulse {
  position: absolute;
  left: 50%;
  bottom: -8px;
  transform: translateX(-50%);
  width: 56px;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(90deg, transparent, rgba(232, 97, 77, 0.5), transparent);
  opacity: 0;
  z-index: 18;
  filter: blur(3px);
  animation: gm-magnet 7.5s ease-in-out infinite;
}
.gm-burst {
  position: absolute;
  left: 50%;
  bottom: -4px;
  transform: translateX(-50%);
  font-size: 18px;
  opacity: 0;
  z-index: 24;
  animation: gm-burst 7.5s ease infinite;
}
.gm-tray-info {
  flex: 1;
  min-width: 0;
  padding-right: 16px;
}
.gm-tray-info-hint {
  font-size: 11px;
  line-height: 1.35;
  color: var(--li-muted);
  transition: color 150ms ease;
}
.gm-tray-info-hint.gm-tray-hint-highlight {
  color: var(--gm-primary);
  font-weight: 600;
}
.gm-tray-dismiss {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--li-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}
.gm-composer-drop-zone {
  position: absolute;
  inset: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 2px dashed rgba(232, 97, 77, 0.35);
  background: rgba(232, 97, 77, 0.06);
  pointer-events: auto;
  z-index: 9;
}
.gm-composer-drop-zone.gm-drop-zone-solid {
  border-style: solid;
  background: rgba(232, 97, 77, 0.12);
}
.gm-composer-drop-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--gm-primary);
  background: rgba(255, 255, 255, 0.94);
  border-radius: 999px;
  padding: 4px 10px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 150ms ease, transform 150ms ease;
}
.gm-composer-drop-zone.gm-drop-zone-solid .gm-composer-drop-label {
  opacity: 1;
  transform: translateY(0);
}
.gm-tray-shake {
  animation: gm-tray-shake 400ms ease;
}
@keyframes gm-tray-enter {
  from { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; transform: translateY(-8px); }
  to { opacity: 1; max-height: 110px; padding-top: 10px; padding-bottom: 10px; transform: translateY(0); }
}
@keyframes gm-tray-exit {
  from { opacity: 1; max-height: 110px; padding-top: 10px; padding-bottom: 10px; transform: translateY(0); }
  to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; transform: translateY(-6px); }
}
@keyframes gm-tap-hand {
  0% { top: 18%; opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
  6% { top: 18%; opacity: 1; transform: translate(-50%, -50%) scale(1); }
  12% { top: 36%; opacity: 1; transform: translate(-50%, -50%) scale(1); }
  14% { top: 40%; opacity: 1; transform: translate(-50%, -50%) scale(0.88); }
  16% { top: 36%; opacity: 1; transform: translate(-50%, -50%) scale(1); }
  18% { top: 38%; opacity: 1; transform: translate(-50%, -50%) scale(0.93); }
  21% { top: 38%; opacity: 1; transform: translate(calc(-50% - 5px), -50%) scale(0.93) rotate(-3deg); }
  24% { top: 38%; opacity: 1; transform: translate(calc(-50% + 5px), -50%) scale(0.93) rotate(3deg); }
  27% { top: 38%; opacity: 1; transform: translate(calc(-50% - 3px), -50%) scale(0.93) rotate(-2deg); }
  30% { top: 38%; opacity: 1; transform: translate(calc(-50% + 3px), -50%) scale(0.93) rotate(2deg); }
  33% { top: 38%; opacity: 1; transform: translate(-50%, -50%) scale(0.93) rotate(0deg); }
  40% { top: 38%; opacity: 0; transform: translate(-50%, -50%) scale(0.93); }
  100% { top: 38%; opacity: 0; transform: translate(-50%, -50%) scale(0.93); }
}
@keyframes gm-gif-bounce {
  0% { transform: scale(1) rotate(0deg); }
  12% { transform: scale(1) rotate(0deg); }
  14% { transform: scale(0.9) rotate(0deg); }
  16% { transform: scale(1.05) rotate(0deg); }
  18% { transform: scale(1) rotate(0deg); }
  21% { transform: scale(1.03) rotate(-2deg); }
  24% { transform: scale(1.03) rotate(2deg); }
  27% { transform: scale(1.02) rotate(-1.5deg); }
  30% { transform: scale(1.02) rotate(1.5deg); }
  33% { transform: scale(1) rotate(0deg); }
  100% { transform: scale(1) rotate(0deg); }
}
@keyframes gm-ring {
  0% { opacity: 0; transform: scale(0.9); }
  16% { opacity: 0; transform: scale(0.9); }
  20% { opacity: 1; transform: scale(1); }
  60% { opacity: 1; transform: scale(1); }
  68% { opacity: 0; transform: scale(1.05); }
  100% { opacity: 0; transform: scale(1.05); }
}
@keyframes gm-magnet {
  0% { opacity: 0; transform: translateX(-50%) scaleX(0.3); }
  32% { opacity: 0; transform: translateX(-50%) scaleX(0.3); }
  36% { opacity: 0.6; transform: translateX(-50%) scaleX(1); }
  40% { opacity: 0.3; transform: translateX(-50%) scaleX(0.7); }
  44% { opacity: 0.6; transform: translateX(-50%) scaleX(1.1); }
  48% { opacity: 0.3; transform: translateX(-50%) scaleX(0.8); }
  52% { opacity: 0.6; transform: translateX(-50%) scaleX(1); }
  60% { opacity: 1; transform: translateX(-50%) scaleX(1.3); }
  68% { opacity: 0; transform: translateX(-50%) scaleX(0.5); }
  100% { opacity: 0; transform: translateX(-50%) scaleX(0.5); }
}
@keyframes gm-particle {
  0% { top: 56px; opacity: 0; }
  38% { top: 56px; opacity: 0; }
  42% { top: 56px; opacity: 0.8; }
  54% { top: 125px; opacity: 0.3; }
  58% { top: 130px; opacity: 0; }
  100% { top: 130px; opacity: 0; }
}
@keyframes gm-whoosh {
  0% { top: 10px; opacity: 0; transform: translate(-50%, 0) scale(0.8); }
  50% { top: 10px; opacity: 0; transform: translate(-50%, 0) scale(0.8); }
  54% { top: 10px; opacity: 0.7; transform: translate(-50%, 0) scale(1); }
  62% { top: 118px; opacity: 0.5; transform: translate(-50%, 0) scale(0.7); }
  67% { top: 122px; opacity: 0; transform: translate(-50%, 0) scale(0.4); }
  100% { top: 122px; opacity: 0; transform: translate(-50%, 0) scale(0.4); }
}
@keyframes gm-burst {
  0% { opacity: 0; transform: translateX(-50%) scale(0.3); }
  60% { opacity: 0; transform: translateX(-50%) scale(0.3); }
  64% { opacity: 1; transform: translateX(-50%) scale(1.4); }
  69% { opacity: 1; transform: translateX(-50%) scale(1); }
  76% { opacity: 0; transform: translateX(-50%) scale(0.6); }
  100% { opacity: 0; transform: translateX(-50%) scale(0.6); }
}
@keyframes gm-tray-shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-3px); }
  40%, 80% { transform: translateX(3px); }
}`;

  function ensureComposerSurfaceStyles(rootNode) {
    if (!(rootNode instanceof ShadowRoot)) return;
    if (rootNode.querySelector('#' + GM_COMPOSER_SURFACE_STYLE_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = GM_COMPOSER_SURFACE_STYLE_ID;
    styleEl.textContent = GM_COMPOSER_SURFACE_STYLES;
    rootNode.appendChild(styleEl);
  }

  function runTrayCleanupFns() {
    const cleanupFns = Array.isArray(gmState._trayCleanupFns) ? gmState._trayCleanupFns.splice(0) : [];
    cleanupFns.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        debugWarn('tray', 'Cleanup failed:', error.message);
      }
    });
  }

  function getTrayIdentityOptions() {
    return {
      firstName: gmState.firstName || null,
      lastName: gmState.lastName || null,
      profileSlug: gmState.profileUrl || window.location.pathname,
    };
  }

  function resolveLiveConversation(targetConversation = null) {
    const identity = buildExpectedConversationIdentity(getTrayIdentityOptions());
    const resolved = findTargetConversation(identity, {
      allowLooseFallback: false,
      source: targetConversation?.source || 'existing_match',
    });

    if (resolved) {
      return resolved;
    }

    if (targetConversation?.msgFormEl?.isConnected) {
      return buildTargetConversation(targetConversation.msgFormEl, identity, targetConversation.source) || targetConversation;
    }

    return null;
  }

  function updateTrayHint(text, highlighted = false) {
    if (!gmState.trayHintEl) return;
    gmState.trayHintEl.textContent = text;
    gmState.trayHintEl.classList.toggle('gm-tray-hint-highlight', highlighted);
  }

  function clearTrayEmojiCycle() {
    gmState.trayEmojiCycleTimers.forEach(clearTimeout);
    gmState.trayEmojiCycleTimers = [];

    if (gmState.trayEmojiCycleInterval) {
      clearInterval(gmState.trayEmojiCycleInterval);
      gmState.trayEmojiCycleInterval = null;
    }

    if (gmState.trayEmojiHandEl) {
      gmState.trayEmojiHandEl.textContent = GM_TRAY_OPEN_HAND;
    }
  }

  function startTrayEmojiCycle() {
    const emojiHandEl = gmState.trayEmojiHandEl;
    if (!emojiHandEl) return;

    clearTrayEmojiCycle();

    const runCycle = () => {
      gmState.trayEmojiCycleTimers.forEach(clearTimeout);
      gmState.trayEmojiCycleTimers = [];
      emojiHandEl.textContent = GM_TRAY_OPEN_HAND;

      const grabTimer = setTimeout(() => {
        if (gmState.trayEmojiHandEl === emojiHandEl) {
          emojiHandEl.textContent = GM_TRAY_GRAB_HAND;
        }
      }, GM_TRAY_TUTORIAL_CYCLE_MS * 0.18);

      const resetTimer = setTimeout(() => {
        if (gmState.trayEmojiHandEl === emojiHandEl) {
          emojiHandEl.textContent = GM_TRAY_OPEN_HAND;
        }
      }, GM_TRAY_TUTORIAL_CYCLE_MS * 0.42);

      gmState.trayEmojiCycleTimers = [grabTimer, resetTimer];
    };

    runCycle();
    gmState.trayEmojiCycleInterval = setInterval(runCycle, GM_TRAY_TUTORIAL_CYCLE_MS);
  }

  function setTrayTutorialVisible(isVisible) {
    const shouldShow = Boolean(isVisible) && gmState.trayFileReady;

    if (gmState.trayGifEl) {
      gmState.trayGifEl.classList.toggle('gm-tray-gif-animated', shouldShow);
    }

    if (gmState.trayHandEl) {
      gmState.trayHandEl.classList.toggle('gm-hand-hidden', !shouldShow);
      gmState.trayHandEl.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    }

    if (shouldShow) {
      startTrayEmojiCycle();
      return;
    }

    clearTrayEmojiCycle();
  }

  function setTrayDragReadyState(isReady) {
    gmState.trayFileReady = Boolean(isReady);

    if (gmState.trayGifEl) {
      gmState.trayGifEl.draggable = Boolean(isReady);
      gmState.trayGifEl.setAttribute('aria-disabled', isReady ? 'false' : 'true');
      gmState.trayGifEl.classList.toggle('gm-tray-gif-disabled', !isReady);
    }

    setTrayTutorialVisible(isReady);
  }

  function hideComposerDropZone() {
    if (typeof gmState.trayDropZoneCleanup === 'function') {
      gmState.trayDropZoneCleanup();
    }
    gmState.trayDropZoneCleanup = null;
    gmState.trayDropZoneEl = null;
  }

  function removeTray() {
    gmState.traySessionId += 1;
    hideComposerDropZone();
    clearTrayEmojiCycle();

    const existing = document.getElementById('gm-composer-tray') || deepQuery('#gm-composer-tray');
    if (existing) existing.remove();

    if (gmState._composerObserver) {
      gmState._composerObserver.disconnect();
      gmState._composerObserver = null;
    }

    runTrayCleanupFns();

    gmState.trayEl = null;
    gmState.trayGifEl = null;
    gmState.trayHandEl = null;
    gmState.trayEmojiHandEl = null;
    gmState.trayHintEl = null;
    gmState.trayFile = null;
    gmState.trayFilePromise = null;
    gmState.trayFileReady = false;
    gmState.trayConversation = null;
    gmState.trayEmojiCycleTimers = [];
    gmState.trayEmojiCycleInterval = null;
  }

  async function showDeliverReadySidecar() {
    if (!gmState.sidecarEl) {
      createSidecar();
    }
    await gmTransition(GM_STATES.DeliverReady);
    showSidecar();
  }

  function checkAndHandleLiebsInsertHash(timeoutMs = LIEBS_INSERT_READY_TIMEOUT_MS) {
    if (!window.location.hash.startsWith(LIEBS_INSERT_HASH_PREFIX)) {
      return false;
    }

    const encodedPayload = window.location.hash.slice(LIEBS_INSERT_HASH_PREFIX.length);
    clearLiebsInsertHash();

    if (liebsInsertInFlight) {
      debugWarn('liebsInsert', 'Ignoring duplicate insert request while another one is already running');
      return true;
    }

    const payload = decodeLiebsInsertPayload(encodedPayload);
    if (!payload) {
      debugWarn('liebsInsert', 'Ignored invalid insert payload');
      return true;
    }

    liebsInsertInFlight = true;
    (async () => {
      try {
        const isReady = await waitForLiebsInsertReady(timeoutMs);
        if (!isReady) {
          debugWarn('liebsInsert', 'LinkedIn messaging UI was not ready in time');
          return;
        }

        const deliveryResult = await autoAttachGif({
          gifUrl: payload.gifUrl,
          firstName: payload.firstName || 'gif',
          lastName: payload.lastName || null,
          profileSlug: window.location.pathname,
        });

        if (deliveryResult.success) {
          if (deliveryResult.method === 'sidecar_fallback') {
            showGmToast('Use the panel to deliver the GIF');
          }
          return;
        }

        debugWarn('liebsInsert', 'Could not open chat delivery:', deliveryResult.error || 'unknown error');
      } catch (error) {
        debugWarn('liebsInsert', 'Failed to handle insert hash:', error.message);
      } finally {
        liebsInsertInFlight = false;
      }
    })();

    return true;
  }

  async function autoAttachGif(options = {}) {
    const gifUrl = options.gifUrl || gmState.gifUrl;
    const firstName = options.firstName || gmState.firstName || 'gif';
    const lastName = options.lastName !== undefined ? options.lastName : (gmState.lastName || null);
    const profileSlug = options.profileSlug || gmState.profileUrl || window.location.pathname;

    if (!gifUrl) {
      return { success: false, error: 'No GIF URL provided' };
    }

    gmState.gifUrl = gifUrl;
    gmState.firstName = firstName;
    gmState.lastName = lastName;
    gmState.backendDone = true;
    gmState.backendError = null;

    const composerResult = await ensureComposerOpen({
      firstName,
      lastName,
      profileSlug,
    });
    if (!composerResult.success) {
      return {
        success: false,
        error: composerResult.error || 'Could not open composer',
      };
    }

    const targetConversation = composerResult.targetConversation || null;
    if (!targetConversation) {
      await showDeliverReadySidecar();
      return {
        success: true,
        method: 'sidecar_fallback',
        error: 'Could not target the active chat composer',
        targetConversation,
      };
    }

    let file = null;
    try {
      file = await urlToGifFile(gifUrl, firstName);
    } catch (error) {
      debugWarn('autoAttach', 'Failed to fetch GIF file:', error.message);
    }

    if (file) {
      let attachResult = { success: false, method: 'none' };
      try {
        attachResult = await attachGifFileToComposer(file, targetConversation, gifUrl);
      } catch (error) {
        debugWarn('autoAttach', 'Attachment attempt crashed:', error.message);
      }
      if (attachResult.success) {
        trackEvent('gif_inserted_to_chat', {
          method: attachResult.method || 'unknown',
          generation_id: gmState.generationId || null,
        });
        showGmToast('Cast into chat! \ud83e\ude84');
        if (gmState.sidecarEl || gmState.current !== GM_STATES.Idle) {
          await gmTransition(GM_STATES.DeliverSuccess);
        }
        return {
          success: true,
          method: attachResult.method || 'unknown',
          targetConversation,
        };
      }
    }

    await showDeliverReadySidecar();
    if (gmState.sidecarEl) {
      return {
        success: true,
        method: 'sidecar_fallback',
        error: 'Auto-attach failed, showing panel',
        targetConversation,
      };
    }

    return {
      success: false,
      error: 'Could not open chat delivery UI',
      targetConversation,
    };
  }

  async function autoAttachVideo(options = {}) {
    const finalVideoUrl = options.finalVideoUrl || vsState.project?.finalVideoUrl || null;
    const projectId = options.projectId || vsState.project?.id || null;
    const videoBlobUrl = options.videoBlobUrl || getVsVideoBlobUrl(finalVideoUrl);
    const firstName = options.firstName || vsState.activeProfile?.firstName || 'video';
    const lastName = options.lastName !== undefined ? options.lastName : (vsState.activeProfile?.lastName || null);
    const profileSlug = options.profileSlug || vsState.activeProfile?.profileUrl || window.location.pathname;

    const fail = (error, reason) => {
      trackEvent('video_insert_failed', {
        project_id: projectId,
        reason: reason || 'unknown_error',
      });
      return { success: false, error };
    };

    if (!projectId) {
      return fail('Video is not ready to share yet.', 'missing_project_id');
    }
    if (!finalVideoUrl) {
      return fail('Video is still processing.', 'missing_final_video_url');
    }
    if (!videoBlobUrl) {
      return fail('Preparing video for insert. Try again in a moment.', 'missing_video_blob_url');
    }

    const composerResult = await ensureComposerOpen({
      firstName,
      lastName,
      profileSlug,
    });
    if (!composerResult.success) {
      return fail(composerResult.error || 'Could not open composer', 'composer_open_failed');
    }

    const targetConversation = composerResult.targetConversation || null;
    if (!targetConversation) {
      return fail('Could not target the active chat composer', 'missing_target_conversation');
    }

    const shareUrl = `${WEB_APP_URL}/v/${encodeURIComponent(projectId)}`;

    let file = null;
    try {
      file = await blobUrlToVideoFile(videoBlobUrl, firstName);
    } catch (error) {
      return fail(error?.message || 'Could not prepare the video file.', 'video_file_prepare_failed');
    }

    let attachResult = { success: false, method: 'none' };
    try {
      attachResult = await attachGifFileToComposer(file, targetConversation, shareUrl);
    } catch (error) {
      return fail(error?.message || 'Attachment attempt crashed.', 'attach_crashed');
    }

    if (attachResult.success) {
      trackEvent('video_inserted_to_chat', {
        method: attachResult.method || 'unknown',
        project_id: projectId,
      });
      return {
        success: true,
        method: attachResult.method || 'unknown',
        targetConversation,
      };
    }

    trackEvent('video_insert_failed', {
      project_id: projectId,
      reason: attachResult.method || 'attach_failed',
    });
    return {
      success: false,
      error: 'Could not attach video to chat.',
      method: attachResult.method || 'none',
      targetConversation,
    };
  }

  async function handleTraySuccess() {
    if (gmState.trayEl) {
      gmState.trayEl.classList.add('gm-tray-collapsed');
    }

    showGmToast('Cast into chat! \ud83e\ude84');
    trackEvent('gif_inserted_to_chat', {
      method: 'tray_drag',
      generation_id: gmState.generationId || null,
    });

    await gmTransition(GM_STATES.DeliverSuccess);

    const cleanupTimer = setTimeout(() => {
      removeTray();
    }, 320);
    gmState.timers.push(cleanupTimer);
  }

  function watchForComposerRemoval(targetConversation) {
    if (gmState._composerObserver) {
      gmState._composerObserver.disconnect();
      gmState._composerObserver = null;
    }

    const observedRootCandidate = targetConversation?.conversationContainerEl?.getRootNode?.() || getShadowRoot() || document.body;
    const observedRoot = observedRootCandidate instanceof ShadowRoot
      ? observedRootCandidate
      : (observedRootCandidate?.body || observedRootCandidate || document.body);

    if (!observedRoot || typeof MutationObserver === 'undefined') {
      return;
    }

    const identity = buildExpectedConversationIdentity(getTrayIdentityOptions());

    gmState._composerObserver = new MutationObserver(() => {
      if (!gmState.trayEl) return;

      const liveConversation = resolveLiveConversation(gmState.trayConversation || targetConversation);
      if (!liveConversation?.msgFormEl?.isConnected || !liveConversation?.composerContainerEl?.isConnected) {
        removeTray();
        return;
      }

      if (
        (identity.profileSlug || identity.fullNameCandidates.length > 0) &&
        liveConversation.matchedName &&
        scoreConversationMatch(liveConversation, identity) <= 0
      ) {
        removeTray();
        return;
      }

      gmState.trayConversation = liveConversation;
    });

    gmState._composerObserver.observe(observedRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function showComposerDropZone(targetConversation) {
    hideComposerDropZone();

    const liveConversation = resolveLiveConversation(targetConversation);
    const composerContainer = liveConversation?.composerContainerEl;
    if (!composerContainer?.isConnected) {
      return null;
    }

    ensureComposerSurfaceStyles(composerContainer.getRootNode());

    const dropZone = document.createElement('div');
    dropZone.className = 'gm-composer-drop-zone';
    dropZone.innerHTML = '<span class="gm-composer-drop-label">Drop GIF here</span>';

    const originalInlinePosition = composerContainer.style.position;
    const shouldRestorePosition = getComputedStyle(composerContainer).position === 'static';
    if (shouldRestorePosition) {
      composerContainer.style.position = 'relative';
    }

    const activateDropZone = () => {
      dropZone.classList.add('gm-drop-zone-solid');
      updateTrayHint('Drop it into the chat box below', true);
    };

    const resetDropZone = () => {
      dropZone.classList.remove('gm-drop-zone-solid');
    };

    const onDragEnter = (event) => {
      event.preventDefault();
      activateDropZone();
    };

    const onDragOver = (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      activateDropZone();
    };

    const onDragLeave = (event) => {
      event.preventDefault();
      if (event.target === dropZone) {
        resetDropZone();
      }
    };

    const onDrop = async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentConversation = resolveLiveConversation(gmState.trayConversation || liveConversation);
      if (!currentConversation) {
        updateTrayHint('That chat closed. Use the panel instead.', true);
        hideComposerDropZone();
        await showDeliverReadySidecar();
        return;
      }

      gmState.trayConversation = currentConversation;

      let trayFile = gmState.trayFile;
      if (!trayFile && gmState.trayFilePromise) {
        updateTrayHint('Finishing the GIF...', true);
        try {
          trayFile = await gmState.trayFilePromise;
          gmState.trayFile = trayFile;
          setTrayDragReadyState(true);
        } catch (error) {
          updateTrayHint('Could not prepare the GIF. Use the panel instead.', true);
          hideComposerDropZone();
          await showDeliverReadySidecar();
          return;
        }
      }

      if (!trayFile) {
        updateTrayHint('Could not prepare the GIF. Use the panel instead.', true);
        hideComposerDropZone();
        await showDeliverReadySidecar();
        return;
      }

      const attachResult = await attachGifFileToComposer(trayFile, currentConversation, gmState.gifUrl);
      hideComposerDropZone();

      if (attachResult.success) {
        await handleTraySuccess();
        return;
      }

      updateTrayHint('LinkedIn still blocked it. Use the panel instead.', true);
      await showDeliverReadySidecar();
    };

    dropZone.addEventListener('dragenter', onDragEnter);
    dropZone.addEventListener('dragover', onDragOver);
    dropZone.addEventListener('dragleave', onDragLeave);
    dropZone.addEventListener('drop', onDrop);
    composerContainer.appendChild(dropZone);

    gmState.trayDropZoneEl = dropZone;
    gmState.trayDropZoneCleanup = () => {
      dropZone.removeEventListener('dragenter', onDragEnter);
      dropZone.removeEventListener('dragover', onDragOver);
      dropZone.removeEventListener('dragleave', onDragLeave);
      dropZone.removeEventListener('drop', onDrop);
      if (dropZone.isConnected) {
        dropZone.remove();
      }
      if (shouldRestorePosition) {
        composerContainer.style.position = originalInlinePosition;
      }
    };

    return dropZone;
  }

  function setupTrayDragDrop(targetConversation) {
    const trayGifEl = gmState.trayGifEl;
    if (!trayGifEl) return;

    const onDragStart = (event) => {
      if (!gmState.trayFileReady) {
        event.preventDefault();
        updateTrayHint('Preparing GIF...', true);
        return;
      }

      if (event.dataTransfer) {
        event.dataTransfer.setData('text/uri-list', gmState.gifUrl || '');
        event.dataTransfer.effectAllowed = 'copy';
      }

      setTrayTutorialVisible(false);
      gmState.trayEl?.classList.add('gm-tray-dimmed');
      showComposerDropZone(targetConversation);
    };

    const onDragEnd = (event) => {
      gmState.trayEl?.classList.remove('gm-tray-dimmed');

      const dropped = Boolean(event.dataTransfer?.dropEffect) && event.dataTransfer.dropEffect !== 'none';
      hideComposerDropZone();

      if (dropped) {
        return;
      }

      trayGifEl.classList.add('gm-tray-shake');
      const shakeTimer = setTimeout(() => {
        trayGifEl.classList.remove('gm-tray-shake');
      }, 400);
      gmState.timers.push(shakeTimer);

      updateTrayHint('Missed! Drag onto the text area below', true);
      const resetHintTimer = setTimeout(() => {
        if (!gmState.trayEl) return;
        if (gmState.trayFileReady) {
          setTrayTutorialVisible(true);
        }
        updateTrayHint('Drag the magic into the chat below...', false);
      }, 2500);
      gmState.timers.push(resetHintTimer);
    };

    trayGifEl.addEventListener('dragstart', onDragStart);
    trayGifEl.addEventListener('dragend', onDragEnd);
    gmState._trayCleanupFns.push(() => {
      trayGifEl.removeEventListener('dragstart', onDragStart);
      trayGifEl.removeEventListener('dragend', onDragEnd);
    });
  }

  function createComposerTray(targetConversation) {
    removeTray();

    const liveConversation = resolveLiveConversation(targetConversation);
    if (!gmState.gifUrl || !liveConversation?.msgFormEl || !liveConversation?.composerContainerEl?.parentElement) {
      return { success: false };
    }

    ensureComposerSurfaceStyles(liveConversation.composerContainerEl.getRootNode());

    const parentEl = liveConversation.composerContainerEl.parentElement;
    const tray = document.createElement('div');
    tray.id = 'gm-composer-tray';
    tray.className = 'gm-composer-tray';
    tray.innerHTML = `
      <div class="gm-tray-gif-wrapper">
        <div class="gm-tray-gif gm-tray-gif-disabled" draggable="false" aria-disabled="true">
          <img src="${escapeHtmlAttr(gmState.gifUrl)}" alt="Generated GIF for ${escapeHtmlAttr(gmState.firstName || 'recipient')}" />
          <div class="gm-tray-gif-grip" aria-hidden="true">
            <div class="gm-grip-dots">
              <span></span><span></span>
              <span></span><span></span>
              <span></span><span></span>
            </div>
          </div>
        </div>
        <div class="gm-hand-tutorial gm-hand-hidden" aria-hidden="true">
          <div class="gm-select-ring"></div>
          <div class="gm-emoji-hand">\u{1F590}\uFE0F</div>
          <div class="gm-particle"></div>
          <div class="gm-particle gm-particle-2"></div>
          <div class="gm-particle gm-particle-3"></div>
          <div class="gm-particle gm-particle-4"></div>
          <div class="gm-whoosh-ghost">\u2728</div>
          <div class="gm-magnet-pulse"></div>
          <div class="gm-burst">\u2728</div>
        </div>
      </div>
      <div class="gm-tray-info">
        <div class="gm-tray-info-hint">Preparing GIF...</div>
      </div>
      <button class="gm-tray-dismiss" type="button" aria-label="Close tray and use the panel">\u00d7</button>
    `;

    parentEl.insertBefore(tray, liveConversation.composerContainerEl);

    gmState.trayEl = tray;
    gmState.trayGifEl = tray.querySelector('.gm-tray-gif');
    gmState.trayHandEl = tray.querySelector('.gm-hand-tutorial');
    gmState.trayEmojiHandEl = tray.querySelector('.gm-emoji-hand');
    gmState.trayHintEl = tray.querySelector('.gm-tray-info-hint');
    gmState.trayConversation = liveConversation;
    gmState.trayFile = null;
    gmState.trayFilePromise = null;
    gmState.trayDropZoneEl = null;
    gmState.trayDropZoneCleanup = null;
    gmState.trayEmojiCycleTimers = [];
    gmState.trayEmojiCycleInterval = null;
    gmState._trayCleanupFns = [];

    setTrayDragReadyState(false);
    updateTrayHint('Preparing GIF...', false);

    const dismissBtn = tray.querySelector('.gm-tray-dismiss');
    const onDismiss = async () => {
      removeTray();
      await showDeliverReadySidecar();
    };
    dismissBtn.addEventListener('click', onDismiss);
    gmState._trayCleanupFns.push(() => dismissBtn.removeEventListener('click', onDismiss));

    setupTrayDragDrop(liveConversation);
    watchForComposerRemoval(liveConversation);

    const traySessionId = gmState.traySessionId + 1;
    gmState.traySessionId = traySessionId;
    gmState.trayFilePromise = urlToGifFile(gmState.gifUrl, gmState.firstName || 'gif')
      .then((file) => {
        if (gmState.traySessionId !== traySessionId || !gmState.trayEl) {
          return file;
        }

        gmState.trayFile = file;
        setTrayDragReadyState(true);
        updateTrayHint('Drag the magic into the chat below...', false);
        return file;
      })
      .catch(async (error) => {
        if (gmState.traySessionId !== traySessionId || !gmState.trayEl) {
          return null;
        }

        gmState.trayFile = null;
        setTrayDragReadyState(false);
        updateTrayHint('Could not prepare the GIF. Use the panel instead.', true);
        await showDeliverReadySidecar();
        debugWarn('tray', 'Failed to prepare tray GIF file:', error.message);
        return null;
      });

    return { success: true, targetConversation: liveConversation };
  }

  // ============================================================
  // SIDECAR: DOM CREATION
  // ============================================================

  function createSidecar() {
    // Remove existing sidecar DOM
    if (gmState.sidecarEl) gmState.sidecarEl.remove();
    if (gmState.announcerEl) gmState.announcerEl.remove();
    if (gmState._dragCleanup) {
      gmState._dragCleanup();
      gmState._dragCleanup = null;
    }

    const photoUrl = extractProfilePhoto() || '';

    // Create announcer
    const announcer = document.createElement('div');
    announcer.className = 'gm-sr-only';
    announcer.setAttribute('aria-live', 'polite');

    // Create sidecar
    const sidecar = document.createElement('div');
    sidecar.id = GM_SIDECAR_ID;
    sidecar.className = 'gm-sidecar';
    sidecar.setAttribute('aria-label', 'GIF Magic generation panel');
    sidecar.innerHTML = `
      <div class="gm-header">
        <span class="gm-title">GIF Magic</span>
        <div class="gm-header-controls">
          <button class="gm-icon-btn gm-minimize-btn" title="Close" aria-label="Close panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"/></svg>
          </button>
        </div>
      </div>
      <div class="gm-thumb-wrap">
        <div class="gm-thumb">
          <img class="gm-thumb-original" src="${photoUrl}" alt="Profile photo" />
          <div class="gm-thumb-stylised">
            <img class="gm-thumb-silhouette" alt="" />
            <div class="gm-thumb-outline-trace" aria-hidden="true">
              <img class="gm-thumb-outline-img" alt="" />
            </div>
          </div>
          <img class="gm-thumb-liebs" alt="" />
          <div class="gm-liebs-sparkle" aria-hidden="true">
            <div class="gm-liebs-sparkle-dots gm-liebs-sparkle-dots-a"></div>
            <div class="gm-liebs-sparkle-dots gm-liebs-sparkle-dots-b"></div>
          </div>
          <div class="gm-sweep"></div>
          <div class="gm-capture-flash"></div>
        </div>
        <div class="gm-filmstrip">
          <div class="gm-film-frame"></div>
          <div class="gm-film-frame"></div>
          <div class="gm-film-frame"></div>
          <div class="gm-film-frame"></div>
          <div class="gm-film-frame"></div>
        </div>
      </div>
      <div class="gm-rail" role="progressbar" aria-label="Generation progress">
        <div class="gm-rail-node"><div class="gm-rail-dot"></div><span class="gm-rail-label">Snap</span></div>
        <div class="gm-rail-connector"></div>
        <div class="gm-rail-node"><div class="gm-rail-dot"></div><span class="gm-rail-label">Glow-Up</span></div>
        <div class="gm-rail-connector"></div>
        <div class="gm-rail-node"><div class="gm-rail-dot"></div><span class="gm-rail-label">Magic</span></div>
        <div class="gm-rail-connector"></div>
        <div class="gm-rail-node"><div class="gm-rail-dot"></div><span class="gm-rail-label">Ta-da \u2728</span></div>
      </div>
      <div class="gm-content"></div>
      <div class="gm-footer">
        <button class="gm-btn-ghost gm-footer-cancel">Cancel magic</button>
      </div>
    `;

    // Store refs
    gmState.sidecarEl = sidecar;
    gmState.announcerEl = announcer;
    gmState.contentEl = sidecar.querySelector('.gm-content');
    gmState.filmstripEl = sidecar.querySelector('.gm-filmstrip');
    gmState.sweepEl = sidecar.querySelector('.gm-sweep');
    gmState.captureFlashEl = sidecar.querySelector('.gm-capture-flash');
    gmState.thumbStylisedEl = sidecar.querySelector('.gm-thumb-stylised');
    gmState.thumbSilhouetteEl = sidecar.querySelector('.gm-thumb-silhouette');
    gmState.thumbOutlineTraceEl = sidecar.querySelector('.gm-thumb-outline-trace');
    gmState.thumbOutlineImgEl = sidecar.querySelector('.gm-thumb-outline-img');
    gmState.thumbLiebsEl = sidecar.querySelector('.gm-thumb-liebs');
    gmState.thumbLiebsSparkleEl = sidecar.querySelector('.gm-liebs-sparkle');
    gmState.thumbEl = sidecar.querySelector('.gm-thumb');
    gmState.thumbOriginalEl = sidecar.querySelector('.gm-thumb-original');
    gmState.footerEl = sidecar.querySelector('.gm-footer');
    gmState.minimizeBtnEl = sidecar.querySelector('.gm-minimize-btn');

    // Rehydrate existing silhouette state if sidecar is recreated mid-generation.
    if (gmState.silhouetteUrl) {
      applySilhouetteUrl(gmState.silhouetteUrl);
    }
    if (isStylisedThumbState()) {
      showStylisedThumb();
    }
    if (gmState.liebsPreviewRevealed && gmState.liebsImageUrl) {
      showLiebsThumb(gmState.liebsImageUrl);
    }
    if (gmState.gifUrl) {
      showGifThumb(gmState.gifUrl);
    }

    // Event listeners
    sidecar.querySelector('.gm-minimize-btn').addEventListener('click', handleMinimize);
    sidecar.querySelector('.gm-footer-cancel').addEventListener('click', handleGmCancel);
    gmState._dragCleanup = enableSidecarDragging(sidecar);
    updateSidecarControls(gmState.current);

    // Always append to body to avoid overflow:hidden clipping on LinkedIn cards
    sidecar.style.position = 'fixed';
    document.body.appendChild(sidecar);
    document.body.appendChild(announcer);

    // Store trigger/photo/card refs for positioning
    gmState._triggerRef = document.getElementById('liebs-gif-btn');
    const photoImg = findProfilePhotoImg();
    gmState._photoRef = photoImg || null;
    gmState._cardRef = photoImg ? findCardContainer(photoImg) : null;

    positionSidecar();
  }

  /**
   * Position sidecar relative to the trigger button (or fallback to photo/top-right).
   * Called on show, scroll, resize.
   */
  function positionSidecar() {
    if (!gmState.sidecarEl) return;
    if (gmState.isDragging) return;

    const sidecar = gmState.sidecarEl;
    const scWidth = sidecar.offsetWidth || 200;
    const scHeight = sidecar.offsetHeight || 320;

    if (gmState.manualPosition) {
      const maxLeft = Math.max(8, window.innerWidth - scWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - scHeight - 8);
      const clampedLeft = Math.max(8, Math.min(gmState.manualPosition.left, maxLeft));
      const clampedTop = Math.max(8, Math.min(gmState.manualPosition.top, maxTop));

      gmState.manualPosition = { left: clampedLeft, top: clampedTop };
      sidecar.style.left = clampedLeft + 'px';
      sidecar.style.top = clampedTop + 'px';
      sidecar.style.right = 'auto';
      sidecar.classList.add('gm-sidecar--manual');
      sidecar.classList.remove('gm-sidecar--from-right');
      sidecar.classList.add('gm-sidecar--from-left');
      return;
    }

    sidecar.classList.remove('gm-sidecar--manual');
    const triggerBtn = document.getElementById('liebs-gif-btn');
    if (triggerBtn && triggerBtn.isConnected) {
      gmState._triggerRef = triggerBtn;
    } else if (gmState._triggerRef && !gmState._triggerRef.isConnected) {
      gmState._triggerRef = null;
    }

    const anchor = gmState._triggerRef || gmState._photoRef;
    const gap = 10;

    if (anchor && anchor.isConnected) {
      const anchorRect = anchor.getBoundingClientRect();
      const anchoredToTrigger = anchor === gmState._triggerRef;
      let topOffset = anchoredToTrigger
        ? anchorRect.top + (anchorRect.height / 2) - 24
        : anchorRect.top - 2;
      topOffset = Math.max(8, Math.min(topOffset, window.innerHeight - scHeight - 8));

      // Prefer right of trigger; if not enough room, slide out to the left.
      let left = anchorRect.right + gap;
      let slideFromRight = false;
      if (left + scWidth > window.innerWidth - 8) {
        left = anchorRect.left - scWidth - gap;
        slideFromRight = true;
      }
      // If still off-screen, pin to viewport edge.
      if (left < 8) {
        left = Math.max(8, window.innerWidth - scWidth - 16);
        slideFromRight = left < anchorRect.left;
      }

      sidecar.style.top = topOffset + 'px';
      sidecar.style.left = left + 'px';
      sidecar.style.right = 'auto';
      sidecar.classList.toggle('gm-sidecar--from-left', !slideFromRight);
      sidecar.classList.toggle('gm-sidecar--from-right', slideFromRight);
    } else {
      // Fallback: top-right corner
      sidecar.style.top = '80px';
      sidecar.style.right = '16px';
      sidecar.style.left = 'auto';
      sidecar.classList.remove('gm-sidecar--from-right');
      sidecar.classList.add('gm-sidecar--from-left');
    }
  }

  function enableSidecarDragging(sidecar) {
    const header = sidecar.querySelector('.gm-header');
    if (!header) return null;

    let dragState = null;

    function onPointerDown(event) {
      if (event.button !== 0) return;
      if (event.target.closest('.gm-icon-btn, button, input, textarea, a')) return;

      event.preventDefault();
      const rect = sidecar.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      gmState.isDragging = true;
      sidecar.classList.add('gm-sidecar--dragging');
      if (header.setPointerCapture) {
        header.setPointerCapture(event.pointerId);
      }
    }

    function onPointerMove(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      const scWidth = sidecar.offsetWidth || 200;
      const scHeight = sidecar.offsetHeight || 320;
      const maxLeft = Math.max(8, window.innerWidth - scWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - scHeight - 8);
      const left = Math.max(8, Math.min(dragState.startLeft + dx, maxLeft));
      const top = Math.max(8, Math.min(dragState.startTop + dy, maxTop));

      gmState.manualPosition = { left, top };
      gmState.manualPositionPath = window.location.pathname;
      sidecar.style.left = left + 'px';
      sidecar.style.top = top + 'px';
      sidecar.style.right = 'auto';
      sidecar.classList.add('gm-sidecar--manual');
      sidecar.classList.remove('gm-sidecar--from-right');
      sidecar.classList.add('gm-sidecar--from-left');
    }

    function stopDragging(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (header.releasePointerCapture) {
        header.releasePointerCapture(event.pointerId);
      }
      dragState = null;
      gmState.isDragging = false;
      sidecar.classList.remove('gm-sidecar--dragging');
      persistManualSidecarPosition();
    }

    header.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    return () => {
      header.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      gmState.isDragging = false;
      sidecar.classList.remove('gm-sidecar--dragging');
    };
  }

  // ============================================================
  // SIDECAR: SHOW / HIDE
  // ============================================================

  function showSidecar() {
    if (!gmState.sidecarEl) return;
    if (gmState.panelHideTimeout) {
      clearTimeout(gmState.panelHideTimeout);
      gmState.panelHideTimeout = null;
    }
    gmState.sidecarEl.style.display = 'flex';
    positionSidecar();
    // Force reflow for transition
    gmState.sidecarEl.offsetHeight;
    gmState.sidecarEl.classList.add('visible');
    setTriggerButtonExpanded(true);
    setTriggerButtonVisible(false);
    gmState.hidden = false;
  }

  function hideSidecar() {
    if (!gmState.sidecarEl) return;
    if (gmState.panelHideTimeout) {
      clearTimeout(gmState.panelHideTimeout);
      gmState.panelHideTimeout = null;
    }
    gmState.sidecarEl.classList.remove('visible');
    setTriggerButtonExpanded(false);
    setTriggerButtonVisible(true);
    positionTriggerButtonAfterSidecarCollapse(gmState);
    gmState.panelHideTimeout = setTimeout(() => {
      if (gmState.sidecarEl) gmState.sidecarEl.style.display = 'none';
      gmState.panelHideTimeout = null;
    }, 300);
  }

  function collapseSidecar() {
    gmState.hidden = true;
    hideSidecar();
  }

  function isActiveGenerationState(state = gmState.current) {
    return ACTIVE_GENERATION_STATES.has(state);
  }

  function shouldMinimizeWithoutReset(state = gmState.current) {
    return (
      isActiveGenerationState(state) ||
      state === GM_STATES.DeliverReady ||
      state === GM_STATES.DeliverSuccess
    );
  }

  function updateSidecarControls(state = gmState.current) {
    const isActiveGeneration = isActiveGenerationState(state);
    const shouldMinimize = shouldMinimizeWithoutReset(state);

    if (gmState.footerEl) {
      gmState.footerEl.style.display = isActiveGeneration ? 'flex' : 'none';
    }

    if (gmState.minimizeBtnEl) {
      const minimizeTitle = shouldMinimize ? 'Minimize' : 'Close';
      gmState.minimizeBtnEl.title = minimizeTitle;
      gmState.minimizeBtnEl.setAttribute('aria-label', `${minimizeTitle} panel`);
    }
  }

  function handleMinimize() {
    if (shouldMinimizeWithoutReset()) {
      collapseSidecar();
      return;
    }

    gmTransition(GM_STATES.Idle);
  }

  function expandSidecarFromTrigger() {
    gmState.hidden = false;
    showSidecar();
  }

  // ============================================================
  // SIDECAR: RAIL UPDATE
  // ============================================================

  function updateRail(activeIdx, isError) {
    if (!gmState.sidecarEl) return;
    const nodes = gmState.sidecarEl.querySelectorAll('.gm-rail-node');
    const conns = gmState.sidecarEl.querySelectorAll('.gm-rail-connector');
    nodes.forEach((n, i) => {
      n.classList.remove('active', 'done');
      if (i < activeIdx) n.classList.add('done');
      else if (i === activeIdx) n.classList.add('active');
    });
    conns.forEach((c, i) => {
      c.classList.toggle('done', i < activeIdx);
    });
  }

  function isStylisedThumbState(state = gmState.current) {
    return STYLISED_THUMB_STATES.has(state);
  }

  function isOutlineLightState(state = gmState.current) {
    return OUTLINE_LIGHT_STATES.has(state);
  }

  function isSilhouetteImageLoaded() {
    return Boolean(
      gmState.thumbSilhouetteEl &&
      gmState.thumbSilhouetteEl.complete &&
      gmState.thumbSilhouetteEl.naturalWidth > 0
    );
  }

  function isSilhouetteImageLoading() {
    if (!gmState.silhouetteUrl || !gmState.thumbSilhouetteEl) return false;
    const currentSrc = gmState.thumbSilhouetteEl.getAttribute('src');
    if (currentSrc !== gmState.silhouetteUrl) return true;
    return !gmState.thumbSilhouetteEl.complete;
  }

  function markSilhouetteVisible() {
    if (!gmState.silhouetteVisibleAt) {
      gmState.silhouetteVisibleAt = Date.now();
    }
  }

  function syncOutlineTrace() {
    if (!gmState.thumbOutlineTraceEl) return;

    const shouldEnable =
      isOutlineLightState() &&
      Boolean(gmState.thumbStylisedEl?.classList.contains('visible')) &&
      !Boolean(gmState.thumbLiebsEl?.classList.contains('visible')) &&
      isSilhouetteImageLoaded();

    gmState.thumbOutlineTraceEl.classList.toggle('active', shouldEnable);
  }

  function applySilhouetteUrl(silhouetteUrl) {
    if (!silhouetteUrl) return false;

    const isFirstSilhouette = !gmState.silhouetteUrl;
    const changed = gmState.silhouetteUrl !== silhouetteUrl;
    gmState.silhouetteUrl = silhouetteUrl;
    if (changed) {
      gmState.silhouetteVisibleAt = 0;
    }

    if (!gmState.thumbSilhouetteEl) {
      return isFirstSilhouette;
    }

    if (changed || gmState.thumbSilhouetteEl.getAttribute('src') !== silhouetteUrl) {
      gmState.thumbSilhouetteEl.src = silhouetteUrl;
    }
    if (gmState.thumbOutlineImgEl && (changed || gmState.thumbOutlineImgEl.getAttribute('src') !== silhouetteUrl)) {
      gmState.thumbOutlineImgEl.src = silhouetteUrl;
    }

    if (!isSilhouetteImageLoaded()) {
      gmState.thumbSilhouetteEl.addEventListener('load', () => {
        if (isStylisedThumbState() && gmState.thumbStylisedEl) {
          gmState.thumbStylisedEl.classList.add('visible');
          markSilhouetteVisible();
        }
        syncOutlineTrace();
        maybeRevealLiebsPreview();
        maybeAdvanceFromSnapStage();
      }, { once: true });

      gmState.thumbSilhouetteEl.addEventListener('error', () => {
        debugWarn('silhouette', 'Failed to load silhouette image URL');
        syncOutlineTrace();
        maybeAdvanceFromSnapStage();
      }, { once: true });
    } else {
      syncOutlineTrace();
    }

    return isFirstSilhouette;
  }

  function updateAnimatePreviewImage(previewUrl) {
    showLiebsThumb(previewUrl);
  }

  function isPreviewStageActive() {
    return (
      gmState.current === GM_STATES.PreviewReady ||
      gmState.current === GM_STATES.AnimatePending ||
      gmState.current === GM_STATES.ComposePending
    );
  }

  function isMagicPipelineStage(stage = gmState.currentPipelineStage) {
    return stage === 'video' || stage === 'compose';
  }

  function getMagicPendingState() {
    return gmState.currentPipelineStage === 'compose'
      ? GM_STATES.ComposePending
      : GM_STATES.AnimatePending;
  }

  function isMagicAnimationState(state = gmState.current) {
    return state === GM_STATES.AnimatePending || state === GM_STATES.ComposePending;
  }

  function maybeAdvanceFromSnapStage() {
    if (gmState.current !== GM_STATES.StylisePending) return;

    // If we already have a silhouette URL, wait until that image finishes loading
    // (or errors) so Snap doesn't skip visually straight to Liebs.
    if (gmState.silhouetteUrl && isSilhouetteImageLoading()) {
      return;
    }

    const styliseStartedAt = Number(gmState.styliseStartedAt) || 0;
    if (styliseStartedAt && Date.now() - styliseStartedAt < SNAP_MIN_DWELL_MS) {
      return;
    }

    // Leave Snap as soon as the silhouette can be shown.
    if (gmState.silhouetteVisibleAt || gmState.liebsImageUrl) {
      gmTransition(GM_STATES.PreviewReady);
      return;
    }

    if (gmState.backendDone) {
      if (gmState.backendError) {
        gmTransition(GM_STATES.ErrorStylise);
      } else if (gmState.gifUrl) {
        gmTransition(GM_STATES.DeliverReady);
      }
      return;
    }

    if (isMagicPipelineStage()) {
      gmTransition(getMagicPendingState());
    }
  }

  function maybeAdvanceFromGlowUpStage() {
    if (gmState.current !== GM_STATES.PreviewReady) return;

    const startedAt = Number(gmState.glowUpStartedAt) || 0;
    if (!startedAt) return;
    if (Date.now() - startedAt < GLOW_UP_PREVIEW_DWELL_MS) return;

    if (gmState.backendDone) {
      if (gmState.backendError) {
        const errResp = gmState.backendError;
        if (errResp?.code === 'JOB_TIMEOUT') {
          gmTransition(GM_STATES.ErrorAnimateTimeout);
        } else {
          gmTransition(GM_STATES.ErrorAnimate);
        }
      } else if (gmState.gifUrl) {
        gmTransition(GM_STATES.DeliverReady);
      }
      return;
    }

    // Keep Glow-Up visible until the Liebs preview has actually revealed.
    // This prevents Magic from starting "ahead" of the visual reveal.
    if (gmState.liebsImageUrl && !gmState.liebsPreviewRevealed) {
      return;
    }

    if (isMagicPipelineStage()) {
      gmTransition(getMagicPendingState());
    }
  }

  function maybeRevealLiebsPreview() {
    if (!gmState.liebsImageUrl) {
      updateAnimatePreviewImage(null);
      return;
    }

    // If we have a silhouette URL, wait until silhouette is actually visible first.
    if (gmState.silhouetteUrl && !gmState.silhouetteVisibleAt) {
      if (isPreviewStageActive()) {
        updateAnimatePreviewImage(null);
      }
      if (gmState.liebsRevealTimeout) {
        clearTimeout(gmState.liebsRevealTimeout);
        gmState.liebsRevealTimeout = null;
      }
      return;
    }

    const revealAnchor = gmState.silhouetteUrl
      ? Number(gmState.silhouetteVisibleAt) || 0
      : Number(gmState.generationStartedAt) || 0;
    const elapsedMs = revealAnchor > 0 ? Date.now() - revealAnchor : MIN_LIEBS_PREVIEW_REVEAL_MS;
    const remainingMs = Math.max(0, MIN_LIEBS_PREVIEW_REVEAL_MS - elapsedMs);

    if (remainingMs <= 0) {
      gmState.liebsPreviewRevealed = true;
      if (gmState.liebsRevealTimeout) {
        clearTimeout(gmState.liebsRevealTimeout);
        gmState.liebsRevealTimeout = null;
      }
      if (isPreviewStageActive()) {
        updateAnimatePreviewImage(gmState.liebsImageUrl);
      }
      maybeAdvanceFromGlowUpStage();
      return;
    }

    if (isPreviewStageActive()) {
      updateAnimatePreviewImage(null);
    }

    if (gmState.liebsRevealTimeout) {
      clearTimeout(gmState.liebsRevealTimeout);
    }
    gmState.liebsRevealTimeout = setTimeout(() => {
      gmState.liebsRevealTimeout = null;
      gmState.liebsPreviewRevealed = true;
      if (isPreviewStageActive() && gmState.liebsImageUrl) {
        updateAnimatePreviewImage(gmState.liebsImageUrl);
      }
      maybeAdvanceFromGlowUpStage();
    }, remainingMs);
  }

  function setAnimateTimeHint(text) {
    const hintEl = gmState.contentEl?.querySelector('.gm-animate-time-hint');
    if (!hintEl) return;

    if (!text) {
      hintEl.textContent = '';
      hintEl.classList.remove('visible');
      return;
    }

    hintEl.textContent = text;
    hintEl.classList.add('visible');
  }

  function updateAnimateStatusText(nextText, { force = false } = {}) {
    if (!nextText) return;
    const statusEl = gmState.contentEl?.querySelector('.gm-animate-status');
    if (!statusEl || !statusEl.isConnected) return;

    const previousText = gmState.lastAnimateStatusText || '';
    if (nextText === previousText) {
      return;
    }

    const now = Date.now();
    const elapsedMs = now - (Number(gmState.lastAnimateStatusUpdatedAt) || 0);
    if (!force && previousText && elapsedMs < ANIMATE_STATUS_MIN_MS) {
      return;
    }

    statusEl.style.opacity = '0';
    setTimeout(() => {
      if (!statusEl.isConnected) return;
      statusEl.textContent = nextText;
      statusEl.style.opacity = '1';
    }, 200);

    gmState.lastAnimateStatusText = nextText;
    gmState.lastAnimateStatusUpdatedAt = now;
  }

  function maybeShowStageTimeHint(stage) {
    if (!stage) return;

    const hint = gmState.stageTimeHints?.[stage];
    if (!hint) {
      return;
    }

    if (!gmState.shownStageTimeHints[stage]) {
      gmState.shownStageTimeHints[stage] = true;
      gmState.activeStageTimeHint = hint;
      setAnimateTimeHint(hint);
      return;
    }

    if (gmState.currentPipelineStage === stage && gmState.activeStageTimeHint === hint) {
      setAnimateTimeHint(hint);
    }
  }

  // ============================================================
  // SIDECAR: THUMBNAIL MANAGEMENT
  // ============================================================

  function triggerLiebsSparkle() {
    const sparkleEl = gmState.thumbLiebsSparkleEl;
    if (!sparkleEl) return;
    sparkleEl.classList.remove('active');
    // Force reflow so rapid repeated reveals restart the animation reliably.
    void sparkleEl.offsetWidth;
    sparkleEl.classList.add('active');
  }

  function showLiebsThumb(liebsUrl) {
    const liebsEl = gmState.thumbLiebsEl;
    if (!liebsEl) return;

    if (!liebsUrl) {
      liebsEl.classList.remove('visible');
      liebsEl.onload = null;
      liebsEl.onerror = null;
      liebsEl.removeAttribute('src');
      if (gmState.thumbLiebsSparkleEl) gmState.thumbLiebsSparkleEl.classList.remove('active');
      syncOutlineTrace();
      return;
    }

    const revealLiebsThumb = () => {
      if (!gmState.thumbLiebsEl || gmState.thumbLiebsEl !== liebsEl) return;
      if (liebsEl.getAttribute('src') !== liebsUrl) return;
      const wasVisible = liebsEl.classList.contains('visible');
      liebsEl.classList.add('visible');
      if (!wasVisible) triggerLiebsSparkle();
      if (gmState.thumbOutlineTraceEl) gmState.thumbOutlineTraceEl.classList.remove('active');
      syncOutlineTrace();
    };

    if (liebsEl.getAttribute('src') === liebsUrl) {
      if (liebsEl.complete && liebsEl.naturalWidth > 0) {
        revealLiebsThumb();
        return;
      }
      // Same URL is already loading: let existing onload/onerror handlers finish.
      if (!liebsEl.complete) {
        return;
      }
    }

    liebsEl.classList.remove('visible');
    liebsEl.onload = revealLiebsThumb;
    liebsEl.onerror = () => {
      if (liebsEl.getAttribute('src') !== liebsUrl) return;
      liebsEl.classList.remove('visible');
      debugWarn('liebsThumb', 'Failed to load Liebs preview image');
      syncOutlineTrace();
    };
    liebsEl.src = liebsUrl;

    if (liebsEl.complete && liebsEl.naturalWidth > 0) {
      revealLiebsThumb();
    }
  }

  function showOriginalThumb() {
    if (gmState.thumbStylisedEl) gmState.thumbStylisedEl.classList.remove('visible');
    if (gmState.thumbOutlineTraceEl) gmState.thumbOutlineTraceEl.classList.remove('active');
    showLiebsThumb(null);
    if (gmState.sweepEl) gmState.sweepEl.classList.remove('active');
    if (gmState.captureFlashEl) gmState.captureFlashEl.classList.remove('active');
    if (gmState.filmstripEl) gmState.filmstripEl.classList.remove('visible');
    // Remove any GIF thumb
    if (gmState.thumbEl) {
      const gif = gmState.thumbEl.querySelector('.gm-thumb-gif');
      if (gif) gif.remove();
      const badge = gmState.thumbEl.querySelector('.gm-gif-badge');
      if (badge) badge.remove();
      const replay = gmState.thumbEl.querySelector('.gm-replay-overlay');
      if (replay) replay.remove();
    }
  }

  function showStylisedThumb() {
    if (gmState.silhouetteUrl) {
      applySilhouetteUrl(gmState.silhouetteUrl);
    }
    // Only show dark overlay when silhouette image is actually loaded
    if (gmState.thumbStylisedEl) {
      if (gmState.silhouetteUrl && isSilhouetteImageLoaded()) {
        gmState.thumbStylisedEl.classList.add('visible');
        markSilhouetteVisible();
      } else {
        gmState.thumbStylisedEl.classList.remove('visible');
      }
    }
    if (gmState.liebsPreviewRevealed && gmState.liebsImageUrl) {
      showLiebsThumb(gmState.liebsImageUrl);
    } else {
      showLiebsThumb(null);
    }
    syncOutlineTrace();
    if (gmState.sweepEl) gmState.sweepEl.classList.remove('active');
    if (gmState.captureFlashEl) gmState.captureFlashEl.classList.remove('active');
    if (gmState.filmstripEl && !isMagicAnimationState()) gmState.filmstripEl.classList.remove('visible');
    // Remove any GIF thumb
    if (gmState.thumbEl) {
      const gif = gmState.thumbEl.querySelector('.gm-thumb-gif');
      if (gif) gif.remove();
      const badge = gmState.thumbEl.querySelector('.gm-gif-badge');
      if (badge) badge.remove();
      const replay = gmState.thumbEl.querySelector('.gm-replay-overlay');
      if (replay) replay.remove();
    }
  }

  function showGifThumb(gifUrl) {
    if (!gmState.thumbEl) return;
    if (gmState.thumbOutlineTraceEl) gmState.thumbOutlineTraceEl.classList.remove('active');
    if (gmState.thumbStylisedEl) gmState.thumbStylisedEl.classList.remove('visible');
    if (gmState.thumbLiebsEl) gmState.thumbLiebsEl.classList.remove('visible');
    if (gmState.sweepEl) gmState.sweepEl.classList.remove('active');
    if (gmState.captureFlashEl) gmState.captureFlashEl.classList.remove('active');
    if (gmState.filmstripEl) gmState.filmstripEl.classList.remove('visible');

    // Remove existing GIF elements
    const existing = gmState.thumbEl.querySelector('.gm-thumb-gif');
    if (existing) existing.remove();
    const existingBadge = gmState.thumbEl.querySelector('.gm-gif-badge');
    if (existingBadge) existingBadge.remove();
    const existingReplay = gmState.thumbEl.querySelector('.gm-replay-overlay');
    if (existingReplay) existingReplay.remove();

    // Create GIF image
    const gifImg = document.createElement('img');
    gifImg.className = 'gm-thumb-gif';
    gifImg.src = gifUrl;
    gifImg.alt = 'Generated GIF';
    gmState.thumbEl.appendChild(gifImg);

    // GIF badge
    const badge = document.createElement('div');
    badge.className = 'gm-gif-badge';
    badge.textContent = 'GIF';
    gmState.thumbEl.appendChild(badge);

  }

  // ============================================================
  // SIDECAR: CONTENT RENDERERS
  // ============================================================

  function buildTextInputBlock(options = {}) {
    const disabled = options.disabled ? 'disabled' : '';
    const firstName = gmState.firstName || 'there';
    const alreadyExpired = gmState.editTimerExpired;
    const timerSeconds = gmState.editTimerSeconds;
    const shouldShowCountdown = alreadyExpired || timerSeconds <= 5;

    // When showTimer is true, the "Greeting" label and countdown sit in a flex row
    const greetingLabel = options.showTimer
      ? `<div class="gm-text-preview-header">
           <div class="gm-text-preview-label">Greeting</div>
           <span class="gm-edit-timer-countdown${alreadyExpired ? ' expired' : ''}${shouldShowCountdown ? ' visible' : ''}">${shouldShowCountdown ? (alreadyExpired ? '0s' : timerSeconds + 's') : ''}</span>
         </div>`
      : '<div class="gm-text-preview-label">Greeting</div>';

    return `
      <div class="gm-text-preview">
        ${greetingLabel}
        <input class="gm-text-input gm-greeting-input" type="text"
          placeholder="Hey, ${firstName}!" maxlength="60" ${disabled} />
        <div class="gm-text-preview-label" style="margin-top:8px;">Conjure the ask</div>
        <input class="gm-text-input gm-cta-input" type="text"
          placeholder="Open to talk?" maxlength="60" ${disabled} />
        <div class="gm-text-preview-hint">${
          disabled
            ? 'Sealing it with a kiss... \ud83d\udc8c'
            : 'Edit your message \u2014 changes save automatically \u2728'
        }</div>
        ${!disabled ? '<button class="gm-btn-primary gm-inline-save-btn">Save</button>' : ''}
      </div>
    `;
  }

  async function syncSidecarTextToActiveJob() {
    if (gmState.textLocked) {
      gmState.textSyncPending = false;
      return { success: false, locked: true };
    }

    const greeting = (gmState.greetingText || '').trim();
    const ctaText = (gmState.ctaText || '').trim();
    if (!greeting && !ctaText) {
      gmState.textSyncPending = false;
      return { success: false, error: 'At least one text field is required' };
    }

    gmState.textSyncPending = true;

    if (!gmState.jobId) {
      return { success: false, queued: true };
    }

    if (gmState.textSyncInFlight) {
      return { success: false, queued: true };
    }

    gmState.textSyncInFlight = true;
    try {
      const response = await sendMessageWithTimeout({
        action: 'updateJobText',
        jobId: gmState.jobId,
        greeting,
        ctaText,
      }, 15000);

      if (response?.success) {
        gmState.textSyncPending = false;
        if (typeof response.greeting === 'string') {
          gmState.greetingText = response.greeting;
        }
        if (typeof response.ctaText === 'string') {
          gmState.ctaText = response.ctaText;
        }
        return { success: true };
      }

      if (response?.locked) {
        gmState.textSyncPending = false;
        gmState.textLocked = true;
        return { success: false, locked: true };
      }

      return { success: false, error: response?.error || 'Failed to save text' };
    } catch (error) {
      debugWarn('textSync', 'Failed to sync sidecar text:', error.message);
      return { success: false, error: error.message };
    } finally {
      gmState.textSyncInFlight = false;
    }
  }

  async function performTextSave(method) {
    const container = gmState.contentEl;
    if (!container) return;

    const greetingInput = container.querySelector('.gm-greeting-input');
    const ctaInput = container.querySelector('.gm-cta-input');
    const saveBtn = container.querySelector('.gm-inline-save-btn');
    if (!greetingInput || greetingInput.disabled) return;

    const greeting = (greetingInput.value || '').trim();
    const cta = (ctaInput?.value || '').trim();
    if (!greeting && !cta) return;

    gmState.greetingText = greeting;
    gmState.ctaText = cta;
    trackEvent('text_edited', {
      method,
      greeting_length: greeting.length,
      cta_length: cta.length,
      generation_id: gmState.generationId || null,
    });

    if (saveBtn && saveBtn.isConnected) saveBtn.textContent = 'Saving...';

    const syncResult = await syncSidecarTextToActiveJob();
    if (!saveBtn || !saveBtn.isConnected) return;

    if (syncResult.locked) {
      saveBtn.textContent = 'Locked';
      showGmToast('Text locked for this run');
      return;
    }

    saveBtn.textContent = syncResult.success ? 'Saved!' : 'Will apply';
    saveBtn.classList.add('saved');
    setTimeout(() => {
      if (!saveBtn.isConnected) return;
      saveBtn.textContent = 'Save';
      saveBtn.classList.remove('saved');
    }, 1500);
  }

  function scheduleAutoSave() {
    if (gmState.textAutoSaveTimer) clearTimeout(gmState.textAutoSaveTimer);
    gmState.textAutoSaveTimer = setTimeout(() => {
      gmState.textAutoSaveTimer = null;
      performTextSave('auto_save');
    }, 1200);
  }

  function wireTextInputs(container) {
    const greetingInput = container.querySelector('.gm-greeting-input');
    const ctaInput = container.querySelector('.gm-cta-input');
    const saveBtn = container.querySelector('.gm-inline-save-btn');
    if (!greetingInput) return;
    if (gmState.textAutoSaveTimer) {
      clearTimeout(gmState.textAutoSaveTimer);
      gmState.textAutoSaveTimer = null;
    }

    // Pre-fill from in-memory state whenever we've already initialized once.
    if (gmState.greetingText !== null || gmState.ctaText !== null) {
      greetingInput.value = gmState.greetingText || '';
      if (ctaInput) ctaInput.value = gmState.ctaText || '';
    } else {
      chrome.storage.local.get(['greetingTemplate', 'ctaText'], (settings) => {
        // If user typed while storage was loading, never clobber that input.
        if (gmState.greetingText !== null || gmState.ctaText !== null) return;
        const template = settings.greetingTemplate || 'Hey, {name}!';
        const cta = settings.ctaText || 'Open to talk?';
        const resolved = template
          .replace(/{name}/g, gmState.firstName || '')
          .replace(/{lastName}/g, gmState.lastName || '')
          .replace(/\s+/g, ' ').trim();
        gmState.greetingText = resolved;
        gmState.ctaText = cta;
        if (greetingInput.isConnected) greetingInput.value = resolved;
        if (ctaInput && ctaInput.isConnected) ctaInput.value = cta;
      });
    }

    function cancelAutoSaveDebounce() {
      if (gmState.textAutoSaveTimer) {
        clearTimeout(gmState.textAutoSaveTimer);
        gmState.textAutoSaveTimer = null;
      }
    }

    // Sync to state on input and debounce server sync.
    greetingInput.addEventListener('input', () => {
      gmState.greetingText = greetingInput.value;
      scheduleAutoSave();
    });
    if (ctaInput) {
      ctaInput.addEventListener('input', () => {
        gmState.ctaText = ctaInput.value;
        scheduleAutoSave();
      });
    }

    function wireImmediateSave(inputEl) {
      inputEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        cancelAutoSaveDebounce();
        performTextSave('enter_key');
      });
      inputEl.addEventListener('blur', () => {
        cancelAutoSaveDebounce();
        performTextSave('blur');
      });
    }

    wireImmediateSave(greetingInput);
    if (ctaInput) wireImmediateSave(ctaInput);

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        cancelAutoSaveDebounce();
        performTextSave('inline_save');
      });
    }
  }

  function isEditableTextInputState(state) {
    return state === GM_STATES.Bootstrapping ||
      state === GM_STATES.StylisePending ||
      state === GM_STATES.PreviewReady ||
      state === GM_STATES.AnimatePending;
  }

  function captureFocusedTextInput() {
    if (!gmState.contentEl) return null;

    const activeEl = document.activeElement;
    if (!activeEl || !gmState.contentEl.contains(activeEl)) return null;

    let field = null;
    if (activeEl.classList?.contains('gm-greeting-input')) {
      field = 'greeting';
    } else if (activeEl.classList?.contains('gm-cta-input')) {
      field = 'cta';
    }

    if (!field) return null;

    const valueLength = typeof activeEl.value === 'string' ? activeEl.value.length : 0;
    const start = Number.isFinite(activeEl.selectionStart) ? activeEl.selectionStart : valueLength;
    const end = Number.isFinite(activeEl.selectionEnd) ? activeEl.selectionEnd : valueLength;

    return { field, start, end };
  }

  function restoreFocusedTextInput(snapshot) {
    if (!snapshot || !gmState.contentEl) return;

    const selector = snapshot.field === 'cta' ? '.gm-cta-input' : '.gm-greeting-input';
    const input = gmState.contentEl.querySelector(selector);
    if (!input || input.disabled) return;

    input.focus({ preventScroll: true });

    const valueLength = typeof input.value === 'string' ? input.value.length : 0;
    const start = Math.max(0, Math.min(snapshot.start, valueLength));
    const end = Math.max(start, Math.min(snapshot.end, valueLength));
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(start, end);
    }
  }

  function renderBootstrapping() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <div class="gm-heartbeat"></div>
        <span class="gm-status-text">Taking a photo... \ud83d\udcf8</span>
      </div>
      ${buildTextInputBlock()}
    `;
    wireTextInputs(gmState.contentEl);
    announce('Capturing profile photo');

    // Delay slightly so the user first sees the profile photo, then the capture flash.
    if (gmState.captureFlashEl) {
      gmState.captureFlashEl.classList.remove('active');
      const flashTimer = setTimeout(() => {
        if (!gmState.captureFlashEl || gmState.current !== GM_STATES.Bootstrapping) return;
        gmState.captureFlashEl.classList.remove('active');
        gmState.captureFlashEl.offsetHeight;
        gmState.captureFlashEl.classList.add('active');
      }, 180);
      gmState.timers.push(flashTimer);
    }
  }

  function renderCaptureDone() {
    if (!gmState.contentEl) return;
    // Only update the status row — preserve the text input block so it
    // doesn't flash away and back during the Snap → Glow-Up transition.
    const statusRow = gmState.contentEl.querySelector('.gm-status-row');
    if (statusRow) {
      statusRow.innerHTML = `
        <div class="gm-done-icon">\u2713</div>
        <span class="gm-status-text">Ooh, they're looking good... \ud83d\ude0d</span>
      `;
    }
    announce('Photo captured');
  }

  function renderStylisePending() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <div class="gm-heartbeat"></div>
        <span class="gm-status-text">Conjuring away the background... \u2728</span>
      </div>
      ${buildTextInputBlock()}
    `;
    wireTextInputs(gmState.contentEl);
    announce('Stylising portrait');
    // Trigger sweep
    if (gmState.sweepEl) {
      gmState.sweepEl.classList.remove('active');
      gmState.sweepEl.offsetHeight;
      gmState.sweepEl.classList.add('active');
    }
  }

  function renderPreviewReady() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <div class="gm-done-icon">\u2713</div>
        <span class="gm-status-text">Wait til they see this... \ud83d\udc40</span>
      </div>
      ${buildTextInputBlock()}
    `;
    wireTextInputs(gmState.contentEl);
    announce('Preview ready.');
  }

  function renderAnimatePending() {
    if (!gmState.contentEl) return;
    const alreadyExpired = gmState.editTimerExpired;

    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <div class="gm-heartbeat"></div>
        <span class="gm-status-text gm-animate-status">Warming up the studio...</span>
      </div>
      <div class="gm-status-helper gm-animate-time-hint"></div>
      ${buildTextInputBlock({ showTimer: true })}
    `;
    gmState.lastAnimateStatusText = 'Warming up the studio...';
    gmState.lastAnimateStatusUpdatedAt = Date.now();
    wireTextInputs(gmState.contentEl);
    maybeRevealLiebsPreview();
    setAnimateTimeHint(gmState.activeStageTimeHint);
    maybeShowStageTimeHint(gmState.currentPipelineStage);
    announce('Animating');

    // If timer already expired, lock inputs immediately
    if (alreadyExpired) {
      const gInput = gmState.contentEl?.querySelector('.gm-greeting-input');
      const cInput = gmState.contentEl?.querySelector('.gm-cta-input');
      const saveBtn = gmState.contentEl?.querySelector('.gm-inline-save-btn');
      if (gInput) gInput.disabled = true;
      if (cInput) cInput.disabled = true;
      if (saveBtn) saveBtn.style.display = 'none';
    }

    if (gmState.filmstripEl) gmState.filmstripEl.classList.add('visible');

    // Start edit timer countdown
    if (!alreadyExpired) {
      const countdownEl = gmState.contentEl.querySelector('.gm-edit-timer-countdown');
      gmState.editTimerInterval = setInterval(() => {
        gmState.editTimerSeconds--;
        if (countdownEl && countdownEl.isConnected) {
          if (gmState.editTimerSeconds <= 5) {
            countdownEl.classList.add('visible');
            countdownEl.textContent = gmState.editTimerSeconds + 's';
          } else {
            countdownEl.classList.remove('visible');
            countdownEl.textContent = '';
          }
        }
        if (gmState.editTimerSeconds <= 0) {
          clearInterval(gmState.editTimerInterval);
          gmState.editTimerInterval = null;
          gmState.editTimerExpired = true;
          if (countdownEl && countdownEl.isConnected) {
            countdownEl.classList.add('visible', 'expired');
            countdownEl.textContent = '0s';
          }
          // Lock the inputs
          const gInput = gmState.contentEl?.querySelector('.gm-greeting-input');
          const cInput = gmState.contentEl?.querySelector('.gm-cta-input');
          const saveBtn = gmState.contentEl?.querySelector('.gm-inline-save-btn');
          if (gInput) gInput.disabled = true;
          if (cInput) cInput.disabled = true;
          if (saveBtn) saveBtn.style.display = 'none';
        }
      }, 1000);
    }
  }

  function renderComposePending() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <div class="gm-heartbeat"></div>
        <span class="gm-status-text gm-animate-status">Putting the finishing touches...</span>
      </div>
      <div class="gm-status-helper gm-animate-time-hint"></div>
      ${buildTextInputBlock({ disabled: true })}
    `;
    gmState.lastAnimateStatusText = 'Putting the finishing touches...';
    gmState.lastAnimateStatusUpdatedAt = Date.now();
    // Pre-fill the disabled inputs with current values
    const greetingInput = gmState.contentEl.querySelector('.gm-greeting-input');
    const ctaInput = gmState.contentEl.querySelector('.gm-cta-input');
    if (greetingInput) greetingInput.value = gmState.greetingText || '';
    if (ctaInput) ctaInput.value = gmState.ctaText || '';
    maybeRevealLiebsPreview();
    setAnimateTimeHint(gmState.activeStageTimeHint);
    maybeShowStageTimeHint(gmState.currentPipelineStage);
    announce('Composing text');
    if (gmState.filmstripEl) gmState.filmstripEl.classList.add('visible');
  }

  function renderDeliverReady() {
    if (!gmState.contentEl) return;

    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <span class="gm-status-text">Your charm is ready! \u2728</span>
      </div>
      <button class="gm-btn-primary gm-full-width gm-insert-btn">Cast it in chat</button>
      <button class="gm-btn-secondary gm-full-width gm-copy-email-btn">Copy for email</button>
      <div class="gm-deliver-footer">
        <button class="gm-btn-link gm-change-text-btn">Edit the ask</button>
        <span class="gm-link-sep">\u00b7</span>
        <button class="gm-btn-link gm-regenerate-btn">Try again</button>
      </div>
    `;
    announce('Your charm is ready!');

    gmState.contentEl.querySelector('.gm-insert-btn').addEventListener('click', handleInsertToChat);
    gmState.contentEl.querySelector('.gm-copy-email-btn').addEventListener('click', handleCopyForEmail);
    gmState.contentEl.querySelector('.gm-change-text-btn').addEventListener('click', renderRestampText);
    gmState.contentEl.querySelector('.gm-regenerate-btn').addEventListener('click', () => {
      runBootstrap();
    });
  }

  function renderRestampText() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <span class="gm-status-text">Edit your charm</span>
      </div>
      <div class="gm-text-preview">
        <div class="gm-text-preview-label">Greeting</div>
        <input class="gm-text-input gm-greeting-input" type="text" value="${escapeHtmlAttr(gmState.greetingText || '')}" maxlength="60" />
        <div class="gm-text-preview-label" style="margin-top:8px;">Conjure the ask</div>
        <input class="gm-text-input gm-cta-input" type="text" value="${escapeHtmlAttr(gmState.ctaText || '')}" maxlength="60" />
      </div>
      <button class="gm-btn-primary gm-full-width gm-apply-text-btn">Recast it</button>
      <div class="gm-deliver-footer">
        <button class="gm-btn-link gm-back-btn">Back</button>
      </div>
    `;

    const greetingInput = gmState.contentEl.querySelector('.gm-greeting-input');
    const ctaInput = gmState.contentEl.querySelector('.gm-cta-input');

    gmState.contentEl.querySelector('.gm-back-btn').addEventListener('click', renderDeliverReady);

    gmState.contentEl.querySelector('.gm-apply-text-btn').addEventListener('click', async () => {
      const newGreeting = greetingInput.value.trim();
      const newCta = ctaInput.value.trim();
      if (!newGreeting) return;

      gmState.contentEl.innerHTML = `
        <div class="gm-status-row">
          <div class="gm-heartbeat"></div>
          <span class="gm-status-text">Recasting your charm... \ud83e\ude84</span>
        </div>
        <div class="gm-text-preview-hint" style="margin-top:8px;">Just a moment \u2014 the pixels are listening \u2728</div>
      `;

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'restampText',
          generationId: gmState.generationId,
          greeting: newGreeting,
          ctaText: newCta,
        });

        if (response && response.success && response.gifUrl) {
          gmState.greetingText = newGreeting;
          gmState.ctaText = newCta;
          gmState.gifUrl = response.gifUrl;
          trackEvent('text_edited', {
            method: 'recast',
            greeting_length: newGreeting.length,
            cta_length: newCta.length,
            generation_id: gmState.generationId || null,
          });
          showGifThumb(response.gifUrl);
          renderDeliverReady();
        } else {
          gmState.contentEl.innerHTML = `
            <div class="gm-error-banner">
              <div class="gm-error-icon">!</div>
              <div class="gm-error-text"><strong>Recast hit a snag \ud83d\udca8</strong><span>The pixels weren\u2019t ready \u2014 give it another go \u2728</span></div>
            </div>
            <button class="gm-btn-ghost gm-full-width gm-back-btn">Back</button>
          `;
          gmState.contentEl.querySelector('.gm-back-btn').addEventListener('click', renderDeliverReady);
        }
      } catch (err) {
        gmState.contentEl.innerHTML = `
          <div class="gm-error-banner">
            <div class="gm-error-icon">!</div>
            <div class="gm-error-text"><strong>Recast hit a snag \ud83d\udca8</strong><span>The pixels weren\u2019t ready \u2014 give it another go \u2728</span></div>
          </div>
          <button class="gm-btn-ghost gm-full-width gm-back-btn">Back</button>
        `;
        gmState.contentEl.querySelector('.gm-back-btn').addEventListener('click', renderDeliverReady);
      }
    });
  }

  function renderDeliverSuccess() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-status-row">
        <span class="gm-status-text">Your charm is ready! \u2728</span>
      </div>
      <button class="gm-btn-primary gm-full-width gm-insert-btn">Cast it in chat</button>
      <button class="gm-btn-secondary gm-full-width gm-copy-email-btn">Copy for email</button>
      <div class="gm-deliver-footer">
        <button class="gm-btn-link gm-change-text-btn">Edit the ask</button>
        <span class="gm-link-sep">\u00b7</span>
        <button class="gm-btn-link gm-regenerate-btn">Try again</button>
      </div>
    `;
    gmState.contentEl.querySelector('.gm-insert-btn').addEventListener('click', handleInsertToChat);
    gmState.contentEl.querySelector('.gm-copy-email-btn').addEventListener('click', handleCopyForEmail);
    gmState.contentEl.querySelector('.gm-change-text-btn').addEventListener('click', renderRestampText);
    gmState.contentEl.querySelector('.gm-regenerate-btn').addEventListener('click', () => {
      runBootstrap();
    });
  }

  function renderErrorCapture() {
    if (!gmState.contentEl) return;

    const isNoPhoto = gmState.errorReason === 'no-photo';
    const title = isNoPhoto
      ? 'This profile has no photo'
      : 'Couldn’t find your photo 🔍';
    const description = isNoPhoto
      ? 'This person doesn’t have a profile photo, so we can’t create a GIF. Try someone with a photo.'
      : 'Head to a LinkedIn profile and try the snap again';

    gmState.contentEl.innerHTML = `
      <div class="gm-error-banner">
        <div class="gm-error-icon">!</div>
        <div class="gm-error-text">
          <strong>${title}</strong>
          <span>${description}</span>
        </div>
      </div>
      ${isNoPhoto ? '' : `
      <div class="gm-action-row">
        <button class="gm-btn-secondary gm-retry-btn">Try again</button>
      </div>`}
    `;
    announce(isNoPhoto ? 'Error: This profile has no photo' : 'Error: Couldn\u2019t find your photo');
    const retryBtn = gmState.contentEl.querySelector('.gm-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => runBootstrap());
    }
  }

  function renderErrorStylise() {
    if (!gmState.contentEl) return;
    const errorCode = gmState.backendError?.code || null;
    const errorMessage = gmState.backendError?.error || null;
    const isRateLimited = isRateLimitCode(errorCode);
    const isBackendBusy = errorCode === 'JOB_QUEUE_NOT_READY' || errorCode === 'PRE_PROCESS_NOT_READY';

    if (isRateLimited || isBackendBusy) {
      gmState.contentEl.innerHTML = `
        <div class="gm-error-banner">
          <div class="gm-error-icon">!</div>
          <div class="gm-error-text">
            <strong>${isBackendBusy ? 'The backend is waking up' : 'Too many requests right now'}</strong>
            <span>${errorMessage || 'Give it a moment, then try again.'}</span>
          </div>
        </div>
        <div class="gm-action-row">
          <button class="gm-btn-primary gm-retry-btn">Try again</button>
        </div>
      `;
      announce('Error: Too many requests right now.');
      gmState.contentEl.querySelector('.gm-retry-btn').addEventListener('click', () => runBootstrap());
      return;
    }

    gmState.contentEl.innerHTML = `
      <div class="gm-error-banner">
        <div class="gm-error-icon">!</div>
        <div class="gm-error-text">
          <strong>Stylising didn't work this time.</strong>
          <span>You can retry or use the original photo instead.</span>
        </div>
      </div>
      <button class="gm-btn-primary gm-full-width gm-retry-btn">Retry</button>
      <button class="gm-btn-secondary gm-full-width gm-use-original-btn">Use original photo</button>
    `;
    announce('Error: Stylising did not work this time.');
    gmState.contentEl.querySelector('.gm-retry-btn').addEventListener('click', () => runBootstrap());
    gmState.contentEl.querySelector('.gm-use-original-btn').addEventListener('click', () => {
      showOriginalThumb();
      gmTransition(GM_STATES.CancelledWithOriginal);
    });
  }

  function renderErrorAnimate() {
    if (!gmState.contentEl) return;

    const isAuthExpired = gmState.backendError?.code === 'AUTH_EXPIRED';
    if (isAuthExpired) {
      gmState.contentEl.innerHTML = `
        <div class="gm-error-banner">
          <div class="gm-error-icon">!</div>
          <div class="gm-error-text">
            <strong>Your session expired</strong>
            <span>Your GIF may still have finished. Check your generation history.</span>
          </div>
        </div>
        <div class="gm-action-row">
          <button class="gm-btn-primary gm-view-history-btn">View history</button>
        </div>
      `;
      announce('Session expired. Check history for your generation.');
      gmState.contentEl.querySelector('.gm-view-history-btn').addEventListener('click', () => {
        window.open(`${WEB_APP_URL}/dashboard`, '_blank');
      });
      return;
    }

    const errorCode = gmState.backendError?.code || null;
    const errorMessage = gmState.backendError?.error || null;
    if (isRateLimitCode(errorCode) || errorCode === 'JOB_QUEUE_NOT_READY') {
      const showHistory = errorCode === 'JOB_POLL_RATE_LIMITED' || errorCode === 'API_RATE_LIMITED';
      const title = errorCode === 'JOB_QUEUE_NOT_READY'
        ? 'The backend is waking up'
        : 'Too many requests right now';
      gmState.contentEl.innerHTML = `
        <div class="gm-error-banner">
          <div class="gm-error-icon">!</div>
          <div class="gm-error-text">
            <strong>${title}</strong>
            <span>${errorMessage || 'Your GIF may still finish — check history in a minute.'}</span>
          </div>
        </div>
        <div class="gm-action-row">
          <button class="gm-btn-primary gm-retry-btn">Try again</button>
          ${showHistory ? '<button class="gm-btn-secondary gm-view-history-btn">View history</button>' : ''}
        </div>
      `;
      announce('Error: Too many requests right now.');
      gmState.contentEl.querySelector('.gm-retry-btn').addEventListener('click', () => runBootstrap());
      const historyBtn = gmState.contentEl.querySelector('.gm-view-history-btn');
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          window.open(`${WEB_APP_URL}/dashboard`, '_blank');
        });
      }
      return;
    }

    gmState.contentEl.innerHTML = `
      <div class="gm-error-banner">
        <div class="gm-error-icon">!</div>
        <div class="gm-error-text">
          <strong>The charm fizzled \ud83d\udca8</strong>
          <span>Something interrupted the magic \u2014 worth another go</span>
        </div>
      </div>
      <div class="gm-action-row">
        <button class="gm-btn-primary gm-retry-btn">Try again</button>
      </div>
    `;
    announce('Error: The charm fizzled');
    gmState.contentEl.querySelector('.gm-retry-btn').addEventListener('click', () => runBootstrap());
  }

  function renderErrorDeliver() {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-error-banner">
        <div class="gm-error-icon">!</div>
        <div class="gm-error-text">
          <strong>The charm bounced back \ud83d\udca8</strong>
          <span>LinkedIn\u2019s chat didn\u2019t accept the GIF. Copy or download it instead.</span>
        </div>
      </div>
      <button class="gm-btn-secondary gm-full-width gm-copy-gif-btn">Copy GIF</button>
      <button class="gm-btn-secondary gm-full-width gm-download-gif-btn">Download</button>
      <button class="gm-btn-primary gm-full-width gm-copy-email-btn">Bottle it</button>
      <div class="gm-deliver-footer">
        <button class="gm-btn-link gm-regenerate-btn">Try again</button>
      </div>
    `;
    announce('Error: The charm bounced back');
    gmState.contentEl.querySelector('.gm-copy-gif-btn').addEventListener('click', async () => {
      if (!gmState.gifUrl) return;
      const copied = await copyGifToClipboard(gmState.gifUrl);
      showGmToast(copied ? 'Copied!' : 'Could not copy GIF');
    });
    gmState.contentEl.querySelector('.gm-download-gif-btn').addEventListener('click', () => {
      if (!gmState.gifUrl) return;
      const downloadLink = document.createElement('a');
      const safeFirstName = (gmState.firstName || 'gif').replace(/[^a-z0-9_-]/gi, '');
      downloadLink.href = gmState.gifUrl;
      downloadLink.download = `character-${safeFirstName || 'gif'}.gif`;
      downloadLink.rel = 'noopener';
      downloadLink.target = '_blank';
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
    });
    gmState.contentEl.querySelector('.gm-copy-email-btn').addEventListener('click', handleCopyForEmail);
    gmState.contentEl.querySelector('.gm-regenerate-btn').addEventListener('click', () => {
      runBootstrap();
    });
  }

  function renderCancelled(hasStylised) {
    if (!gmState.contentEl) return;
    gmState.contentEl.innerHTML = `
      <div class="gm-cancel-banner">
        <div class="gm-cancel-icon">\u2715</div>
        <div class="gm-cancel-text">
          <strong>Charm cancelled</strong>
          <span>Whenever you\u2019re ready, the magic is waiting \u2728</span>
        </div>
      </div>
      <button class="gm-btn-secondary gm-full-width gm-retry-btn">Try again</button>
    `;
    announce('Charm cancelled');
    gmState.contentEl.querySelector('.gm-retry-btn').addEventListener('click', () => runBootstrap());
  }

  function showStageWarningBanner() {
    if (!gmState.contentEl) return;
    if (gmState.contentEl.querySelector('.gm-warning-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'gm-warning-banner';
    banner.innerHTML = `
      <div class="gm-warning-icon">\u23f3</div>
      <div class="gm-warning-text">
        <strong>The wand is working overtime</strong>
        <span>Sorry about the wait \u2014 we\u2019ll refund your charm</span>
      </div>
    `;

    const statusRow = gmState.contentEl.querySelector('.gm-status-row');
    if (statusRow && statusRow.nextSibling) {
      gmState.contentEl.insertBefore(banner, statusRow.nextSibling);
    } else {
      gmState.contentEl.appendChild(banner);
    }
  }

  // ============================================================
  // SIDECAR: STATE MACHINE — TRANSITION
  // ============================================================

  async function gmTransition(nextState) {
    const focusedTextInput = captureFocusedTextInput();

    // If leaving AnimatePending, attempt one last text sync before compose
    // potentially locks edits.
    if (gmState.current === GM_STATES.AnimatePending && nextState !== GM_STATES.AnimatePending && !gmState.editTimerExpired) {
      const gInput = gmState.contentEl?.querySelector('.gm-greeting-input');
      const cInput = gmState.contentEl?.querySelector('.gm-cta-input');
      if (gInput && !gInput.disabled) {
        const curGreeting = gInput.value?.trim() || '';
        const curCta = cInput?.value?.trim() || '';
        if (curGreeting) {
          const greetingChanged = curGreeting !== (gmState.greetingText || '');
          const ctaChanged = curCta !== (gmState.ctaText || '');
          if (greetingChanged || ctaChanged) {
            gmState.greetingText = curGreeting;
            gmState.ctaText = curCta;
          }
          gmState.textSyncPending = true;
          syncSidecarTextToActiveJob().catch((err) => {
            debugWarn('textSync', 'Failed to sync text while leaving AnimatePending:', err.message);
          });
        }
      }
    }

    clearGmTimers();

    const shouldClearTray = (
      nextState === GM_STATES.Idle ||
      nextState === GM_STATES.Bootstrapping ||
      nextState === GM_STATES.StylisePending ||
      nextState === GM_STATES.PreviewReady ||
      nextState === GM_STATES.AnimatePending ||
      nextState === GM_STATES.ComposePending ||
      nextState === GM_STATES.CancelledWithOriginal ||
      nextState === GM_STATES.CancelledWithStylised ||
      nextState.startsWith('Error')
    );
    if (shouldClearTray && gmState.trayEl) {
      removeTray();
    }

    gmState.current = nextState;

    const stageIdx = GM_STAGE_MAP[nextState] !== undefined ? GM_STAGE_MAP[nextState] : -1;
    const isError = nextState.startsWith('Error');

    // Update rail
    if (stageIdx >= 0) {
      updateRail(stageIdx, isError);
    } else {
      updateRail(-1, false);
    }

    if (gmState.sidecarEl) {
      gmState.sidecarEl.classList.toggle('gm-animating', isMagicAnimationState(nextState));
    }
    updateSidecarControls(nextState);

    if (nextState === GM_STATES.Idle) {
      // Reset to idle
      setTriggerButtonBusy(false);
      hideSidecar();
      showOriginalThumb();
      if (gmState.contentEl) gmState.contentEl.innerHTML = '';
      gmState.hidden = false;
      gmState.gifUrl = null;
      gmState.silhouetteUrl = null;
      gmState.liebsImageUrl = null;
      if (gmState.thumbSilhouetteEl) gmState.thumbSilhouetteEl.src = '';
      if (gmState.thumbOutlineImgEl) gmState.thumbOutlineImgEl.src = '';
      if (gmState.thumbLiebsEl) gmState.thumbLiebsEl.removeAttribute('src');
      gmState.backendDone = false;
      gmState.backendError = null;
      gmState.cancelRequested = false;
      gmState.generationStartedAt = 0;
      gmState.liebsPreviewRevealed = false;
      if (gmState.liebsRevealTimeout) {
        clearTimeout(gmState.liebsRevealTimeout);
        gmState.liebsRevealTimeout = null;
      }
      gmState.silhouetteVisibleAt = 0;
      gmState.currentPipelineStage = null;
      gmState.stageTimeHints = {};
      gmState.shownStageTimeHints = {};
      gmState.activeStageTimeHint = null;
      gmState.glowUpStartedAt = 0;
      gmState.styliseStartedAt = 0;
      gmState.errorReason = null;
      gmState.lastAnimateStatusText = null;
      gmState.lastAnimateStatusUpdatedAt = 0;
      gmState.greetingText = null;
      gmState.ctaText = null;
      gmState.jobId = null;
      gmState.textSyncPending = false;
      gmState.textSyncInFlight = false;
      gmState.textLocked = false;
      gmState.editTimerExpired = false;
      gmState.editTimerSeconds = EDIT_TIMER_DURATION;
      return;
    }

    // Non-idle: keep button clickable so it can toggle panel visibility.
    setTriggerButtonBusy(true);

    if (!gmState.hidden) {
      showSidecar();
    }

    // Filmstrip only appears during AnimatePending/ComposePending and is
    // re-enabled by those renderers.
    if (gmState.filmstripEl) gmState.filmstripEl.classList.remove('visible');

    switch (nextState) {
      case GM_STATES.Bootstrapping:
        showOriginalThumb();
        renderBootstrapping();
        break;

      case GM_STATES.StylisePending:
        gmState.styliseStartedAt = Date.now();
        showStylisedThumb();
        renderStylisePending();
        maybeRevealLiebsPreview();
        maybeAdvanceFromSnapStage();
        break;

      case GM_STATES.PreviewReady:
        showStylisedThumb();
        renderPreviewReady();
        maybeRevealLiebsPreview();
        gmState.glowUpStartedAt = Date.now();
        const glowUpDwell = setTimeout(() => {
          maybeAdvanceFromGlowUpStage();
        }, GLOW_UP_PREVIEW_DWELL_MS);
        gmState.timers.push(glowUpDwell);
        maybeAdvanceFromGlowUpStage();
        break;

      case GM_STATES.AnimatePending:
        showStylisedThumb();
        renderAnimatePending();
        // Check if backend already completed
        if (gmState.backendDone) {
          if (gmState.backendError) {
            const errResp = gmState.backendError;
            if (errResp.code === 'JOB_TIMEOUT') {
              gmTransition(GM_STATES.ErrorAnimateTimeout);
            } else {
              gmTransition(GM_STATES.ErrorAnimate);
            }
          } else if (gmState.gifUrl) {
            gmTransition(GM_STATES.DeliverReady);
          }
        }
        // Otherwise wait for backend promise to trigger transition
        break;

      case GM_STATES.ComposePending:
        showStylisedThumb();
        renderComposePending();
        break;

      case GM_STATES.DeliverReady:
        if (gmState.gifUrl) {
          showGifThumb(gmState.gifUrl);
        }
        renderDeliverReady();
        // Keep button active as the only open/close control.
        setTriggerButtonBusy(false);
        break;

      case GM_STATES.DeliverSuccess:
        if (gmState.gifUrl) {
          showGifThumb(gmState.gifUrl);
        }
        renderDeliverSuccess();
        setTriggerButtonBusy(false);
        break;

      case GM_STATES.ErrorCapture:
        showOriginalThumb();
        renderErrorCapture();
        break;

      case GM_STATES.ErrorStylise:
        showOriginalThumb();
        renderErrorStylise();
        break;

      case GM_STATES.ErrorAnimate:
      case GM_STATES.ErrorAnimateTimeout:
        showStylisedThumb();
        renderErrorAnimate();
        break;

      case GM_STATES.ErrorDeliver:
        if (gmState.gifUrl) {
          showGifThumb(gmState.gifUrl);
        }
        renderErrorDeliver();
        break;

      case GM_STATES.CancelledWithOriginal:
        showOriginalThumb();
        renderCancelled(false);
        break;

      case GM_STATES.CancelledWithStylised:
        showStylisedThumb();
        renderCancelled(true);
        break;
    }

    if (isEditableTextInputState(nextState)) {
      restoreFocusedTextInput(focusedTextInput);
    }
  }

  // ============================================================
  // SIDECAR: BOOTSTRAP (backend integration)
  // ============================================================

  async function runBootstrap() {
    // Reset backend state
    gmState.gifUrl = null;
    gmState.jobId = null;
    gmState.generationId = null;
    gmState.backendDone = false;
    gmState.backendError = null;
    gmState.cancelRequested = false;
    gmState.generationStartedAt = Date.now();
    gmState.silhouetteUrl = null;
    gmState.liebsImageUrl = null;
    gmState.liebsPreviewRevealed = false;
    if (gmState.liebsRevealTimeout) {
      clearTimeout(gmState.liebsRevealTimeout);
      gmState.liebsRevealTimeout = null;
    }
    gmState.silhouetteVisibleAt = 0;
    if (gmState.thumbSilhouetteEl) gmState.thumbSilhouetteEl.removeAttribute('src');
    if (gmState.thumbOutlineImgEl) gmState.thumbOutlineImgEl.removeAttribute('src');
    if (gmState.thumbStylisedEl) gmState.thumbStylisedEl.classList.remove('visible');
    if (gmState.thumbOutlineTraceEl) gmState.thumbOutlineTraceEl.classList.remove('active');
    gmState.currentPipelineStage = null;
    gmState.stageTimeHints = {};
    gmState.shownStageTimeHints = {};
    gmState.activeStageTimeHint = null;
    gmState.glowUpStartedAt = 0;
    gmState.styliseStartedAt = 0;
    gmState.errorReason = null;
    gmState.lastAnimateStatusText = null;
    gmState.lastAnimateStatusUpdatedAt = 0;
    gmState.textSyncPending = false;
    gmState.textSyncInFlight = false;
    gmState.textLocked = false;

    // Extract profile data early so the greeting template can resolve {name}
    // before the sidecar appears. These are synchronous DOM reads — instant.
    const profileData = extractProfileData();
    if (!profileData.photoUrl && profileData.firstName) {
      gmState.errorReason = 'no-photo';
      gmTransition(GM_STATES.ErrorCapture);
      return;
    }
    if (!profileData.photoUrl || !profileData.firstName) {
      gmState.errorReason = 'extraction-failed';
      gmTransition(GM_STATES.ErrorCapture);
      return;
    }

    gmState.firstName = profileData.firstName;
    gmState.lastName = profileData.lastName;
    gmState.headline = profileData.headline;
    gmState.company = profileData.company;
    gmState.profilePhotoUrl = profileData.photoUrl;
    gmState.profileUrl = profileData.profileUrl;

    gmTransition(GM_STATES.Bootstrapping);
    const bootstrappingShownAt = Date.now();

    // Auth check
    try {
      const authenticated = await checkAuth();
      if (!authenticated) {
        showNotification('You\u2019ll need to sign in first \u2014 click the extension icon to get started \ud83d\udd11', 'warning');
        gmTransition(GM_STATES.Idle);
        return;
      }
      if (userCredits !== null && userCredits < 1) {
        showNotification('You\u2019re running low on sparks \u2014 time to refill! \ud83e\ude84', 'warning');
        gmTransition(GM_STATES.Idle);
        return;
      }
    } catch (e) {
      debugWarn('runBootstrap', 'Auth check failed:', e.message);
    }

    // Update thumbnail with actual profile photo
    if (gmState.thumbOriginalEl) {
      gmState.thumbOriginalEl.src = profileData.photoUrl;
    }

    const [imageBase64, photoFingerprint] = await Promise.all([
      imageUrlToBase64(profileData.photoUrl).catch((error) => {
        debugWarn('runBootstrap', 'Failed to convert image to base64:', error.message);
        return null;
      }),
      computePhotoFingerprint(profileData.photoUrl).catch((error) => {
        debugWarn('runBootstrap', 'Failed to compute photo fingerprint:', error.message);
        return null;
      }),
    ]);

    if (!imageBase64) {
      debugWarn('runBootstrap', 'Failed to convert image to base64');
    }

    if (gmState.current !== GM_STATES.Bootstrapping) return;

    // Start backend generation first so frontend pacing doesn't delay the pipeline.
    const generationResponsePromise = chrome.runtime.sendMessage({
      action: 'generateLiebsGif',
      photoUrl: profileData.photoUrl,
      photoBase64: imageBase64,
      firstName: profileData.firstName,
      lastName: profileData.lastName,
      headline: profileData.headline,
      company: profileData.company,
      profileUrl: profileData.profileUrl,
      photoFingerprint,
      greeting: gmState.greetingText,
      ctaText: gmState.ctaText,
    });

    // Keep message 1 visible long enough to read.
    const captureElapsedMs = Date.now() - bootstrappingShownAt;
    const captureRemainingMs = Math.max(0, CAPTURE_STATUS_MIN_MS - captureElapsedMs);
    if (captureRemainingMs > 0) {
      await gmSleep(captureRemainingMs);
    }
    if (gmState.current !== GM_STATES.Bootstrapping) return;

    // Show message 2 for a minimum dwell before transitioning to Snap.
    renderCaptureDone();
    updateRail(0, false);
    await gmSleep(CAPTURE_DONE_DWELL_MS);
    if (gmState.current !== GM_STATES.Bootstrapping) return;

    // Advance to Snap's background-removal/silhouette phase.
    gmTransition(GM_STATES.StylisePending);

    try {
      const response = await generationResponsePromise;

      if (!response.success) {
        if (response.cancelled || response.code === 'GENERATION_CANCELLED' || gmState.cancelRequested) {
          gmState.backendDone = true;
          gmState.backendError = null;
          return;
        }

        if (response.code === 'AUTH_EXPIRED') {
          gmState.backendError = response;
          gmState.backendDone = true;
          gmTransition(GM_STATES.ErrorAnimate);
          return;
        }

        if (response.needsCredits) {
          showNotification('You\u2019re running low on sparks \u2014 time to refill! \ud83e\ude84', 'warning');
          gmTransition(GM_STATES.Idle);
          return;
        }
        gmState.backendError = response;
        gmState.backendDone = true;

        // If we're already in AnimatePending, transition to error
        if (gmState.current === GM_STATES.AnimatePending) {
          gmTransition(GM_STATES.ErrorAnimate);
        } else if (
          gmState.current === GM_STATES.StylisePending ||
          gmState.current === GM_STATES.Bootstrapping ||
          gmState.current === GM_STATES.PreviewReady
        ) {
          gmTransition(GM_STATES.ErrorStylise);
        }
        return;
      }

      if (response.creditsRemaining !== undefined) {
        userCredits = response.creditsRemaining;
      }

      const responseSilhouetteUrl = extractSilhouetteUrl(response);
      const gotFirstSilhouetteFromResponse = responseSilhouetteUrl
        ? applySilhouetteUrl(responseSilhouetteUrl)
        : false;
      const responseLiebsImageUrl = extractLiebsImageUrl(response);
      if (responseLiebsImageUrl) {
        gmState.liebsImageUrl = responseLiebsImageUrl;
        maybeRevealLiebsPreview();
      }
      maybeAdvanceFromSnapStage();
      maybeAdvanceFromGlowUpStage();
      if (responseSilhouetteUrl && isStylisedThumbState()) {
        showStylisedThumb();
      }

      const responseGifUrl = response.gifUrl || response.gif_url || null;
      gmState.gifUrl = responseGifUrl;
      if (response.jobId) {
        gmState.jobId = response.jobId;
      }
      gmState.generationId = response.generationId || response.generation_id || null;
      gmState.backendDone = true;

      // If we're in AnimatePending/ComposePending, transition to DeliverReady
      if (gmState.current === GM_STATES.AnimatePending || gmState.current === GM_STATES.ComposePending) {
        // If silhouette arrives only with the final response, let it render briefly.
        if (gotFirstSilhouetteFromResponse) {
          await gmSleep(700);
          if (gmState.current !== GM_STATES.AnimatePending) return;
        }
        gmTransition(GM_STATES.DeliverReady);
      }
      // If still in Snap/Glow-Up, stage handlers advance when their
      // visual dwell and backend stage signals are satisfied.
    } catch (error) {
      console.error('[Liebs GIF] Generation failed:', error);

      if (error.code === 'GENERATION_CANCELLED' || gmState.cancelRequested) {
        gmState.backendDone = true;
        gmState.backendError = null;
        return;
      }

      if (error.code === 'AUTH_EXPIRED') {
        gmState.backendError = { error: error.message, code: error.code };
        gmState.backendDone = true;
        gmTransition(GM_STATES.ErrorAnimate);
        return;
      }

      gmState.backendError = { error: error.message, code: error.code };
      gmState.backendDone = true;

      // Determine error state based on current visual state
      const isEarlyStage = [GM_STATES.Bootstrapping, GM_STATES.StylisePending, GM_STATES.PreviewReady].includes(gmState.current);
      if (gmState.current === GM_STATES.Idle || gmState.current.startsWith('Error') || gmState.current.startsWith('Cancelled')) {
        // Already transitioned away, don't override
        return;
      }
      if (error.code === 'JOB_TIMEOUT') {
        gmTransition(GM_STATES.ErrorAnimateTimeout);
      } else if (isEarlyStage) {
        gmTransition(GM_STATES.ErrorStylise);
      } else {
        gmTransition(GM_STATES.ErrorAnimate);
      }
    }
  }

  // ============================================================
  // SIDECAR: CANCEL HANDLER
  // ============================================================

  function handleGmCancel() {
    if (!isActiveGenerationState()) return;

    if (!gmState.cancelRequested) {
      gmState.cancelRequested = true;
      requestGenerationCancel().then((response) => {
        if (!response?.success && response?.reason !== 'NO_ACTIVE_GENERATION') {
          debugWarn('cancel', 'Backend cancel request did not confirm success');
        }
      });
    }

    const hasStylised = [
      GM_STATES.PreviewReady,
      GM_STATES.AnimatePending,
      GM_STATES.ComposePending,
    ].includes(gmState.current);

    gmTransition(hasStylised ? GM_STATES.CancelledWithStylised : GM_STATES.CancelledWithOriginal);
  }

  // ============================================================
  // SIDECAR: PROFILE-CHANGE RESET
  // ============================================================

  function resetForProfileChange() {
    if (isActiveGenerationState()) {
      pendingGenerationNotice = {
        firstName: gmState.firstName || null,
        capturedAt: Date.now(),
      };
    }

    // Transition to Idle — this hides the sidecar, restores the original
    // profile thumbnail, clears timers, and resets generation state
    gmTransition(GM_STATES.Idle);

    // Clear the hide-animation timeout before removing the sidecar DOM
    if (gmState.panelHideTimeout) {
      clearTimeout(gmState.panelHideTimeout);
      gmState.panelHideTimeout = null;
    }

    // Remove old sidecar DOM entirely (its overlays point to the old profile photo)
    if (gmState.sidecarEl) gmState.sidecarEl.remove();
    if (gmState.announcerEl) gmState.announcerEl.remove();
    removeTray();
    if (gmState._dragCleanup) {
      gmState._dragCleanup();
      gmState._dragCleanup = null;
    }

    // Null out all DOM refs so createSidecar() builds fresh ones
    gmState.sidecarEl = null;
    gmState.announcerEl = null;
    gmState.contentEl = null;
    gmState.filmstripEl = null;
    gmState.sweepEl = null;
    gmState.captureFlashEl = null;
    gmState.thumbStylisedEl = null;
    gmState.thumbSilhouetteEl = null;
    gmState.thumbOutlineTraceEl = null;
    gmState.thumbOutlineImgEl = null;
    gmState.thumbLiebsEl = null;
    gmState.thumbLiebsSparkleEl = null;
    gmState.thumbEl = null;
    gmState.thumbOriginalEl = null;
    gmState.footerEl = null;
    gmState.minimizeBtnEl = null;
    gmState.trayEl = null;
    gmState.trayGifEl = null;
    gmState.trayHandEl = null;
    gmState.trayEmojiHandEl = null;
    gmState.trayHintEl = null;
    gmState.trayDropZoneEl = null;
    gmState.trayDropZoneCleanup = null;
    gmState.trayFile = null;
    gmState.trayFilePromise = null;
    gmState.trayFileReady = false;
    gmState.trayConversation = null;
    gmState.trayEmojiCycleTimers = [];
    gmState.trayEmojiCycleInterval = null;
    gmState._trayCleanupFns = [];
    gmState._composerObserver = null;
    gmState._triggerRef = null;
    gmState._cardRef = null;
    gmState._photoRef = null;
    gmState.manualPosition = null;
    gmState.manualPositionPath = null;

    // Clear stale profile data (will be extracted fresh on next generation)
    gmState.firstName = null;
    gmState.lastName = null;
    gmState.headline = null;
    gmState.company = null;
    gmState.jobId = null;
    gmState.profilePhotoUrl = null;
    gmState.profileUrl = null;
    gmState.generationId = null;
    gmState.textSyncPending = false;
    gmState.textSyncInFlight = false;
    gmState.textLocked = false;
  }

  // ============================================================
  // SIDECAR: ACTION HANDLERS
  // ============================================================

  async function handleInsertToChat() {
    if (!gmState.gifUrl || !gmState.firstName) return;

    const deliveryResult = await autoAttachGif({
      profileSlug: gmState.profileUrl || window.location.pathname,
    });
    if (!deliveryResult.success) {
      gmTransition(GM_STATES.ErrorDeliver);
      return;
    }

    if (deliveryResult.method === 'sidecar_fallback') {
      showGmToast('Use the panel to deliver the GIF');
    }
  }

  function handleCopyForEmail() {
    if (!gmState.gifUrl) return;

    trackEvent('gif_copied_for_email', {
      generation_id: gmState.generationId || null,
    });

    // Prefer short URL when generationId is available
    if (gmState.generationId) {
      const shareUrl = `${WEB_APP_URL}/share/${gmState.generationId}`;
      window.open(shareUrl, '_blank');
      showGmToast('Charm bottled! \ud83e\uddea');
      return;
    }

    // Fallback to query params for older generations
    const params = new URLSearchParams();
    if (gmState.gifUrl) params.set('gif', gmState.gifUrl);
    if (gmState.firstName) params.set('firstName', gmState.firstName);
    if (gmState.lastName) params.set('lastName', gmState.lastName);
    if (gmState.headline) params.set('headline', gmState.headline);
    if (gmState.company) params.set('company', gmState.company);
    if (gmState.profileUrl) params.set('linkedinUrl', gmState.profileUrl);
    const shareUrl = `${WEB_APP_URL}/share?${params.toString()}`;
    window.open(shareUrl, '_blank');
    showGmToast('Charm bottled! \ud83e\uddea');
  }

  function handleGmClick() {
    if (gmState.current !== GM_STATES.Idle) {
      if (gmState.hidden) {
        expandSidecarFromTrigger();
      } else {
        collapseSidecar();
      }
      return;
    }

    // Lock state immediately to prevent fast double-clicks from opening
    // two generation requests before async bootstrap starts.
    trackEvent('generate_button_clicked', {
      path: window.location.pathname,
      profile_url: window.location.href,
    });
    gmState.current = GM_STATES.Bootstrapping;
    runBootstrap();
  }

  // ============================================================
  // BUTTON PLACEMENT & MAIN FLOW
  // ============================================================

  function buildButtonElement() {
    const button = document.createElement('button');
    button.id = 'liebs-gif-btn';
    button.innerHTML = getTriggerButtonIdleMarkup();
    button.title = 'Generate Liebs greeting GIF';
    button.setAttribute('aria-controls', GM_SIDECAR_ID);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', handleGmClick);
    return button;
  }

  function createLiebsButton() {
    if (isSalesNavigatorPath()) return;

    const existing = document.getElementById('liebs-gif-btn');
    if (existing) existing.remove();
    const existingLegacyWrapper = document.getElementById('liebs-gif-btn-wrapper');
    if (existingLegacyWrapper) existingLegacyWrapper.remove();
    unwrapNameAnchorWrapper(gmState);

    const button = buildButtonElement();

    // Try anchored placement above the profile photo
    const placed = placeButtonAbovePhoto(button, gmState);

    if (!placed) {
      gmState._photoRef = null;
      gmState._cardRef = null;

      // Fallback: fixed-position floating button.
      button.classList.add('liebs-gif-btn--floating');
      document.body.appendChild(button);

      // Try to upgrade to anchored placement when the profile photo loads
      waitForElement(() => findProfilePhotoImg(), 8000, 500)
        .then(() => {
          const currentBtn = document.getElementById('liebs-gif-btn');
          if (currentBtn && currentBtn.classList.contains('liebs-gif-btn--floating') && gmState.current === GM_STATES.Idle) {
            createLiebsButton();
          }
        })
        .catch(() => {
          debugLog('createButton', 'Profile photo never appeared, keeping floating button');
        });
    }

    gmState._triggerRef = button;

    // Only (re)create sidecar when idle — during generation the sidecar is
    // already visible and destroying it would make the panel disappear.
    if (gmState.current === GM_STATES.Idle) {
      createSidecar();
    }

    // Check auth status (throttled to avoid message spam on dynamic pages)
    const now = Date.now();
    if (now - lastAuthCheckAt >= AUTH_CHECK_THROTTLE_MS) {
      lastAuthCheckAt = now;
      checkAuth()
        .then((authenticated) => {
          if (!authenticated) {
            button.classList.add('not-authenticated');
            button.title = 'Click to login first';
          }
        })
        .catch((error) => {
          debugWarn('checkAuth', 'Auth check failed while creating button:', error.message);
          button.classList.add('not-authenticated');
          button.title = 'Auth check failed. Please retry.';
        });
    } else if (!isAuthenticated) {
      button.classList.add('not-authenticated');
      button.title = 'Click to login first';
    }
  }

  // ============================================================
  // VIDEO STUDIO SIDECAR
  // ============================================================

  const VS_STAGE_MESSAGES = {
    ready: [
      'Setting the stage... 🎬',
      'Prepping the spotlight...',
    ],
    images: [
      'Sculpting their look... ✨',
      'Mixing the character palette... 🎨',
      'Ooh, this is going to be good... 😍',
    ],
    render: [
      'Bringing them to life... 🎥',
      'Teaching them to move...',
      'Animating frame by frame... 🎞️',
      'The magic is happening...',
    ],
    compose: [
      'Putting the finishing touches... 💫',
      'Wrapping up your masterpiece...',
      'Almost showtime... 🍿',
    ],
    delay: [
      'Taking a bit longer than usual...',
      'Good things take a moment... ⏳',
      'Hang tight, still working on it...',
    ],
  };

  function escapeVsHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clearVsPoll() {
    if (vsState.pollTimer) {
      clearTimeout(vsState.pollTimer);
      vsState.pollTimer = null;
    }
  }

  function clearVsStageMessageRotation() {
    if (vsState.rotateStageMessageTimer) {
      clearInterval(vsState.rotateStageMessageTimer);
      vsState.rotateStageMessageTimer = null;
    }
  }

  function revokeAllVsVideoBlobUrls() {
    for (const blobUrl of Object.values(vsState.videoBlobUrls)) {
      try { URL.revokeObjectURL(blobUrl); } catch (_e) { /* ignore */ }
    }
    vsState.videoBlobUrls = {};
    vsState.videoBlobUrlsPending = {};
  }

  function getVsVideoBlobUrl(originalUrl) {
    if (!originalUrl) return null;
    return vsState.videoBlobUrls[originalUrl] || null;
  }

  function fetchVsVideoBlobUrl(originalUrl) {
    if (!originalUrl || vsState.videoBlobUrls[originalUrl] || vsState.videoBlobUrlsPending[originalUrl]) {
      return;
    }
    vsState.videoBlobUrlsPending[originalUrl] = true;
    chrome.runtime.sendMessage({ action: 'fetchUrl', url: originalUrl }, async (result) => {
      delete vsState.videoBlobUrlsPending[originalUrl];
      if (!result?.success || !result?.dataUrl) {
        console.warn('[Video Studio] Failed to proxy video URL:', originalUrl, result?.error);
        return;
      }
      try {
        const response = await fetch(result.dataUrl);
        const blob = await response.blob();
        const oldBlobUrl = vsState.videoBlobUrls[originalUrl];
        if (oldBlobUrl) {
          try { URL.revokeObjectURL(oldBlobUrl); } catch (_e) { /* ignore */ }
        }
        vsState.videoBlobUrls[originalUrl] = URL.createObjectURL(blob);
        renderVideoStudio();
      } catch (err) {
        console.warn('[Video Studio] Failed to create blob URL for video:', err.message);
      }
    });
  }

  function clearVsRuntimeState() {
    clearVsPoll();
    clearVsStageMessageRotation();
    revokeAllVsVideoBlobUrls();
    vsState.loading = false;
    vsState.activeMutation = false;
    vsState.insertingVideo = false;
    vsState.openAssetEditorId = null;
    vsState.openSceneEditorId = null;
    vsState.imageEditorOpen = false;
    vsState.errorMessage = null;
    vsState.statusMessage = null;
    vsState.project = null;
    vsState.assets = [];
    vsState.latestJob = null;
    vsState.activeJobs = [];
    vsState.pendingRegenAssetIds = new Set();
    vsState.assetPromptDrafts = {};
    vsState.assetRegenerateDependentsDrafts = {};
    vsState.scenePromptDrafts = {};
    vsState.scenes = [];
    vsState.pendingScenePreview = null;
    vsState.recovery = null;
    vsState.pollStartedAt = 0;
    vsState.pollFailureCount = 0;
    vsState.pollStoppedReason = null;
    vsState.pollTargetProjectId = null;
    vsState.pollTargetJobType = null;
    vsState.pollTargetJobId = null;
    vsState.verificationDebuggerEnabled = false;
    vsState.reverifyingKey = null;
    vsState.applyingWindowKey = null;
    vsState.applyingManualTimingKey = null;
    vsState.reverifyResultsByKey = {};
    vsState.manualTimingDraftsByKey = {};
    vsState.optimisticTimingByKey = {};
    vsState.current = VS_UI_STATES.READY;
    vsState.lastRenderedUiState = null;
  }

  function loadSavedVideoSidecarPosition() {
    chrome.storage.local.get([VS_SIDECAR_POSITION_KEY], (result) => {
      const saved = result?.[VS_SIDECAR_POSITION_KEY];
      if (!isValidManualSidecarPosition(saved)) return;
      vsState.manualPosition = {
        left: Math.round(saved.left),
        top: Math.round(saved.top),
      };
      vsState.manualPositionPath = typeof saved.path === 'string' ? saved.path : null;
      if (vsState.sidecarEl) {
        positionVideoStudioSidecar();
      }
    });
  }

  function persistVideoSidecarPosition() {
    if (!isValidManualSidecarPosition(vsState.manualPosition)) return;
    chrome.storage.local.set({
      [VS_SIDECAR_POSITION_KEY]: {
        left: Math.round(vsState.manualPosition.left),
        top: Math.round(vsState.manualPosition.top),
        path: vsState.manualPositionPath || window.location.pathname,
      },
    });
  }

  async function getVsAuthToken() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['authToken'], (result) => {
        resolve(result?.authToken || null);
      });
    });
  }

  async function getVideoProfileContextPayload() {
    const profileData = extractProfileData();
    if (!profileData?.photoUrl || !profileData?.firstName) {
      return {
        ...profileData,
        photoBase64: null,
        photoFingerprint: null,
      };
    }

    const [photoBase64, photoFingerprint] = await Promise.all([
      imageUrlToBase64(profileData.photoUrl).catch(() => null),
      computePhotoFingerprint(profileData.photoUrl).catch(() => null),
    ]);

    return {
      ...profileData,
      photoBase64,
      photoFingerprint,
    };
  }

  function hasVsActiveJob() {
    if (vsState.activeJobs && vsState.activeJobs.length > 0) {
      return true;
    }
    const status = String(vsState.latestJob?.status || '').toLowerCase();
    return status === 'queued' || status === 'processing';
  }

  function getVsAssetActiveRegenJob(asset) {
    if (!asset?.id) {
      return null;
    }
    return vsState.activeJobs.find((job) => (
      String(job?.jobType || '').toLowerCase() === 'asset_regenerate'
      && job.targetAssetId === asset.id
    )) || null;
  }

  function getVsDependentAssetIds(asset) {
    if (asset.assetType === 'portrait') {
      return new Set(vsState.assets
        .filter((a) => a.assetType === 'portrait' || a.assetType === 'full_body' || a.assetType === 'scene_starting_frame')
        .map((a) => a.id));
    }
    if (asset.assetType === 'full_body') {
      return new Set(vsState.assets
        .filter((a) => a.assetType === 'full_body' || a.assetType === 'scene_starting_frame')
        .map((a) => a.id));
    }
    return new Set([asset.id]);
  }

  function isVsAssetRegenerationBlocked(assetId) {
    if (vsState.pendingRegenAssetIds.has(assetId)) {
      return true;
    }

    const requestedAsset = vsState.assets.find((a) => a.id === assetId);
    if (!requestedAsset) {
      return true;
    }

    const requestedIds = getVsDependentAssetIds(requestedAsset);

    for (const activeJob of vsState.activeJobs) {
      if (activeJob.jobType !== 'asset_regenerate') {
        return true;
      }
      const activeAsset = vsState.assets.find((a) => a.id === activeJob.targetAssetId);
      if (!activeAsset) {
        continue;
      }
      const activeIds = getVsDependentAssetIds(activeAsset);
      for (const id of requestedIds) {
        if (activeIds.has(id)) {
          return true;
        }
      }
    }

    return false;
  }

  function getVsLatestJobType() {
    return String(vsState.latestJob?.jobType || '').toLowerCase();
  }

  function getVsRenderableAssets() {
    return vsState.assets.filter((asset) => VS_REVIEW_ASSET_TYPES.has(asset.assetType));
  }

  function getVsGroupedAssets() {
    return {
      portrait: vsState.assets.find((asset) => asset.assetType === 'portrait') || null,
      fullBody: vsState.assets.find((asset) => asset.assetType === 'full_body') || null,
      sceneFrames: vsState.assets
        .filter((asset) => asset.assetType === 'scene_starting_frame')
        .sort((left, right) => (Number(left.metadata?.sceneIndex) || 0) - (Number(right.metadata?.sceneIndex) || 0)),
    };
  }

  function getVsFinalVideoAsset() {
    return vsState.assets.find((asset) => asset.assetKey === 'final_video' || asset.assetType === 'final_video') || null;
  }

  function isVsSceneRecoveryProject() {
    return String(vsState.project?.status || '').toLowerCase() === 'scene_recovery';
  }

  function getVsPendingSceneManualReviewScenes() {
    return vsState.scenes
      .filter((scene) => scene?.manualReview?.status === 'pending')
      .sort((left, right) => (Number(left.sceneIndex) || 0) - (Number(right.sceneIndex) || 0));
  }

  function hasVsPendingSceneManualReviews() {
    return getVsPendingSceneManualReviewScenes().length > 0;
  }

  function areVsReviewAssetsReady() {
    const assets = getVsRenderableAssets();
    return assets.length > 0 && assets.every((asset) => asset.status === 'ready');
  }

  function hasVsReusableReviewAssets() {
    return getVsRenderableAssets().some((asset) => Boolean(asset.outputUrl));
  }

  function getVsAssetStatusMeta(asset) {
    const activeRegenJob = getVsAssetActiveRegenJob(asset);
    const activeJobStatus = String(activeRegenJob?.status || '').toLowerCase();
    if (activeRegenJob && activeJobStatus === 'queued') {
      return {
        label: 'Queued',
        className: 'vs-status-processing',
        isProcessing: true,
        needsRetry: false,
      };
    }
    if (activeRegenJob && activeJobStatus === 'processing') {
      const isImageEdit = Boolean(activeRegenJob?.payload?.isImageEdit);
      return {
        label: isImageEdit ? 'Editing…' : 'Generating…',
        className: 'vs-status-processing',
        isProcessing: true,
        needsRetry: false,
      };
    }

    const status = String(asset?.status || '').toLowerCase();
    if (status === 'ready') {
      return {
        label: 'Ready',
        className: 'vs-status-ready',
        isProcessing: false,
        needsRetry: false,
      };
    }

    if (status === 'failed' || status === 'stale') {
      return {
        label: 'Needs retry',
        className: 'vs-status-needs-retry',
        isProcessing: false,
        needsRetry: true,
      };
    }

    return {
      label: 'Processing…',
      className: 'vs-status-processing',
      isProcessing: true,
      needsRetry: false,
    };
  }

  function getVsProgressStageKey() {
    if (!hasVsActiveJob()) return 'ready';

    const step = String(vsState.latestJob?.progressStep || '').toLowerCase();
    if (step) {
      if (step.includes('compose') || step.includes('final') || step.includes('mux')) {
        return 'compose';
      }
      if (step.includes('render') || step.includes('animate') || step.includes('video')) {
        return 'render';
      }
      if (
        step.includes('image')
        || step.includes('draft')
        || step.includes('portrait')
        || step.includes('scene')
        || step.includes('frame')
      ) {
        return 'images';
      }
    }

    const latestJobType = getVsLatestJobType();
    if (latestJobType === 'draft_generate' || latestJobType === 'asset_regenerate') {
      return 'images';
    }

    if (VS_RENDER_JOB_TYPES.has(latestJobType) || latestJobType === 'scene_preview' || latestJobType === 'render_video') {
      const percent = Number.isFinite(Number(vsState.latestJob?.progressPercent))
        ? Number(vsState.latestJob.progressPercent)
        : 0;
      return percent >= 85 ? 'compose' : 'render';
    }

    return 'images';
  }

  function pickVsStageMessage(stageKey) {
    const bucket = VS_STAGE_MESSAGES[stageKey] || VS_STAGE_MESSAGES.images;
    return bucket[vsState.rotateStageMessageIndex % bucket.length];
  }

  function isVsDelayPhase() {
    return Boolean(vsState.pollStartedAt && (Date.now() - vsState.pollStartedAt) > 15000);
  }

  function getVsActiveStageMessage() {
    if (!hasVsActiveJob()) {
      return null;
    }
    return isVsDelayPhase()
      ? pickVsStageMessage('delay')
      : pickVsStageMessage(getVsProgressStageKey());
  }

  function getVsUiState() {
    const project = vsState.project;
    if (!project) {
      return VS_UI_STATES.READY;
    }

    const projectStatus = String(project.status || '').toLowerCase();
    const latestJobType = getVsLatestJobType();

    if (hasVsActiveJob()) {
      if (latestJobType === 'draft_generate') {
        return VS_UI_STATES.GENERATING;
      }
      if (latestJobType === 'scene_preview') {
        return VS_UI_STATES.REDOING_VIDEO;
      }
      if (VS_RENDER_JOB_TYPES.has(latestJobType)) {
        return latestJobType === 'render_video'
          ? VS_UI_STATES.RENDERING_VIDEO
          : VS_UI_STATES.REDOING_VIDEO;
      }
    }

    if (projectStatus === 'scene_recovery') {
      return vsState.pendingScenePreview ? VS_UI_STATES.SCENE_PREVIEW : VS_UI_STATES.SCENE_RECOVERY;
    }

    if (projectStatus === 'failed') {
      if (project.finalVideoUrl) {
        return vsState.pendingScenePreview ? VS_UI_STATES.SCENE_PREVIEW : VS_UI_STATES.FINAL_VIDEO;
      }
      return areVsReviewAssetsReady() || project.finalVideoUrl
        ? VS_UI_STATES.ERROR_RENDER
        : VS_UI_STATES.ERROR_GENERATE;
    }

    if (projectStatus === 'cancelled') {
      if (project.finalVideoUrl) {
        return vsState.pendingScenePreview ? VS_UI_STATES.SCENE_PREVIEW : VS_UI_STATES.FINAL_VIDEO;
      }
      if (getVsRenderableAssets().some((asset) => asset.outputUrl)) {
        return VS_UI_STATES.REVIEW_IMAGES;
      }
      return VS_UI_STATES.READY;
    }

    if (
      project.lastError
      && projectStatus === 'awaiting_approval'
      && !areVsReviewAssetsReady()
    ) {
      return latestJobType === 'draft_generate' && !hasVsReusableReviewAssets()
        ? VS_UI_STATES.ERROR_GENERATE
        : VS_UI_STATES.REVIEW_IMAGES;
    }

    if (projectStatus === 'draft_processing' || projectStatus === 'awaiting_approval') {
      return VS_UI_STATES.REVIEW_IMAGES;
    }

    if (projectStatus === 'render_processing') {
      return project.finalVideoUrl ? VS_UI_STATES.REDOING_VIDEO : VS_UI_STATES.RENDERING_VIDEO;
    }

    if (projectStatus === 'completed') {
      return vsState.pendingScenePreview ? VS_UI_STATES.SCENE_PREVIEW : VS_UI_STATES.FINAL_VIDEO;
    }

    return VS_UI_STATES.READY;
  }

  function getVsProgressConfig(uiState = getVsUiState()) {
    const progressByState = {
      [VS_UI_STATES.READY]: { stage: 0, done: [] },
      [VS_UI_STATES.GENERATING]: { stage: 1, done: [0] },
      [VS_UI_STATES.REVIEW_IMAGES]: { stage: 1, done: [0] },
      [VS_UI_STATES.RENDERING_VIDEO]: { stage: 2, done: [0, 1] },
      [VS_UI_STATES.REDOING_VIDEO]: { stage: 2, done: [0, 1] },
      [VS_UI_STATES.SCENE_RECOVERY]: { stage: 2, done: [0, 1] },
      [VS_UI_STATES.FINAL_VIDEO]: { stage: 3, done: [0, 1, 2] },
      [VS_UI_STATES.SCENE_PREVIEW]: { stage: 3, done: [0, 1, 2] },
      [VS_UI_STATES.ERROR_GENERATE]: { stage: 1, done: [0] },
      [VS_UI_STATES.ERROR_RENDER]: { stage: 2, done: [0, 1] },
    };
    return progressByState[uiState] || progressByState[VS_UI_STATES.READY];
  }

  function renderVsProgressRail(uiState = getVsUiState()) {
    if (!vsState.progressRailEl) return;

    const labels = ['Ready', 'Images', 'Render', 'Ready ✨'];
    const progress = getVsProgressConfig(uiState);

    vsState.progressRailEl.innerHTML = labels.map((label, index) => {
      const isActive = index === progress.stage;
      const isDone = progress.done.includes(index);
      const dotColor = isActive ? '#e8614d' : isDone ? '#22c55e' : '#f0ddd4';
      const labelColor = isActive ? '#e8614d' : isDone ? '#22c55e' : '#c0a89e';
      const line = index < labels.length - 1
        ? `<div class="vs-rail-line" style="background:${progress.done.includes(index) ? '#22c55e' : '#f0ddd4'};"></div>`
        : '';

      return `
        <div class="vs-rail-step">
          <div class="vs-rail-dot" style="background:${dotColor};"></div>
          <span class="vs-rail-label" style="color:${labelColor};">${label}</span>
        </div>
        ${line}
      `;
    }).join('');
  }

  function renderVsBanner() {
    if (!vsState.statusMessage) {
      return '';
    }

    return `
      <div class="vs-banner vs-banner--${escapeVsHtml(vsState.statusTone)}">
        ${escapeVsHtml(vsState.statusMessage)}
      </div>
    `;
  }

  function renderVsHeartbeat() {
    return `
      <span class="vs-heartbeat" aria-hidden="true"></span>
    `;
  }

  function renderVsProfileCard() {
    const profile = vsState.activeProfile;
    if (!profile) {
      return '';
    }

    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    const subtitle = [profile.headline, profile.company].filter(Boolean).join(' · ') || 'LinkedIn profile detected';
    const avatar = profile.photoUrl
      ? `<img class="vs-avatar-img" src="${escapeVsHtml(profile.photoUrl)}" alt="${escapeVsHtml(fullName || 'Profile photo')}">`
      : `<span>${escapeVsHtml((profile.firstName || '?').slice(0, 1))}</span>`;

    return `
      <div class="vs-profile-card">
        <div class="vs-avatar">${avatar}</div>
        <div class="vs-profile-copy">
          <p class="vs-profile-name">${escapeVsHtml(fullName || 'LinkedIn profile')}</p>
          <p class="vs-profile-sub">${escapeVsHtml(subtitle)}</p>
        </div>
      </div>
    `;
  }

  function renderVsProgressBlock() {
    const percent = Number.isFinite(Number(vsState.latestJob?.progressPercent))
      ? Math.max(0, Math.min(100, Number(vsState.latestJob.progressPercent)))
      : 0;
    const stageKey = getVsProgressStageKey();
    const hintByStage = {
      images: 'Usually takes ~15s',
      render: 'Usually takes ~30s',
      compose: 'Almost done - ~5s left',
    };
    const hint = hasVsActiveJob()
      ? (isVsDelayPhase() ? pickVsStageMessage('delay') : (hintByStage[stageKey] || 'Working on it...'))
      : '';
    const showSweep = hasVsActiveJob() && stageKey === 'images';
    const showFilmstrip = hasVsActiveJob() && (stageKey === 'render' || stageKey === 'compose');

    return `
      <div class="vs-progress-block">
        <div class="vs-progress-header">
          <span class="vs-progress-message">
            <span class="vs-status-row">${renderVsHeartbeat()}<span>${escapeVsHtml(getVsActiveStageMessage() || 'Working...')}</span></span>
          </span>
          <span class="vs-progress-pct">${percent}%</span>
        </div>
        <div class="vs-progress-track">
          <div class="vs-progress-fill" style="width:${percent}%;"></div>
        </div>
        <div class="vs-stage-visual" aria-hidden="true">
          <div class="vs-sweep ${showSweep ? 'active' : ''}"></div>
          <div class="vs-filmstrip ${showFilmstrip ? 'visible' : ''}">
            <div class="vs-film-frame"></div>
            <div class="vs-film-frame"></div>
            <div class="vs-film-frame"></div>
            <div class="vs-film-frame"></div>
            <div class="vs-film-frame"></div>
          </div>
        </div>
        ${hint ? `<p class="vs-progress-hint">${escapeVsHtml(hint)}</p>` : ''}
      </div>
    `;
  }

  function renderVsAssetCard(asset) {
    if (!asset) {
      return '';
    }

    const statusMeta = getVsAssetStatusMeta(asset);
    const isOpen = vsState.openAssetEditorId === asset.id;
    const canEdit = !statusMeta.isProcessing;
    const canSubmit = !isVsAssetRegenerationBlocked(asset.id);
    const canRevert = asset.canRevert === true;
    const canRevertNow = canRevert && !isVsAssetRegenerationBlocked(asset.id);
    const preview = asset.outputUrl
      ? `<img src="${escapeVsHtml(asset.outputUrl)}" alt="${escapeVsHtml(asset.label)}">`
      : statusMeta.isProcessing
        ? renderVsHeartbeat()
        : '<div class="vs-asset-placeholder"><span>Retry needed</span></div>';
    const buttonLabel = statusMeta.needsRetry ? 'Retry ↻' : 'Regenerate ↻';
    const isEditingExistingImage = Boolean(asset.outputUrl);
    const isFullBodyEdit = asset.assetType === 'full_body' && isEditingExistingImage;
    const regenPlaceholder = isEditingExistingImage ? 'Describe what to change…' : 'Adjust prompt…';
    const submitLabel = isEditingExistingImage ? 'Apply edit' : 'Regenerate image';
    const textareaValue = Object.prototype.hasOwnProperty.call(vsState.assetPromptDrafts, asset.id)
      ? vsState.assetPromptDrafts[asset.id]
      : (asset.promptText || '');
    const regenerateDependentsChecked = Boolean(vsState.assetRegenerateDependentsDrafts[asset.id]);

    return `
      <div class="vs-asset-card">
        <div class="vs-asset-header">
          <span class="vs-asset-name">${escapeVsHtml(asset.label)}</span>
          <span class="vs-status-pill ${statusMeta.className}">● ${escapeVsHtml(statusMeta.label)}</span>
        </div>
        <div class="vs-asset-preview">${preview}</div>
        ${canEdit ? `
          <button class="vs-btn-regen" type="button" data-action="toggle-asset-editor" data-asset-id="${escapeVsHtml(asset.id)}">
            ${isOpen ? 'Close ✕' : buttonLabel}
          </button>
          <div class="vs-regen-form" style="display:${isOpen ? 'block' : 'none'};">
            <textarea class="vs-regen-textarea" name="promptText" rows="3" data-draft-type="asset" data-asset-id="${escapeVsHtml(asset.id)}" placeholder="${escapeVsHtml(regenPlaceholder)}">${escapeVsHtml(textareaValue)}</textarea>
            ${isFullBodyEdit ? `
              <label class="vs-checkbox-label">
                <input type="checkbox" class="vs-regen-dependents-toggle" data-asset-id="${escapeVsHtml(asset.id)}" ${regenerateDependentsChecked ? 'checked' : ''}>
                <span>Also refresh all scene images</span>
              </label>
            ` : ''}
            <button class="vs-btn-regen-submit" type="button" data-action="submit-asset-regeneration" data-asset-id="${escapeVsHtml(asset.id)}" ${canSubmit ? '' : 'disabled'}>${escapeVsHtml(submitLabel)}</button>
          </div>
        ` : ''}
        ${canRevert ? `
          <button class="vs-btn-secondary" type="button" data-action="revert-asset" data-asset-id="${escapeVsHtml(asset.id)}" ${canRevertNow ? '' : 'disabled'}>Undo last change</button>
        ` : ''}
        ${asset.metadata?.lastError ? `<p class="vs-inline-error">${escapeVsHtml(asset.metadata.lastError)}</p>` : ''}
      </div>
    `;
  }

  function renderVsReadyScreen() {
    if (!vsState.authToken) {
      return `
        ${renderVsBanner()}
        <div class="vs-empty-state">
          <h2>Sign in first</h2>
          <p>Open the extension popup and connect your account first. The video studio uses that same login.</p>
        </div>
      `;
    }

    if (!vsState.activeProfile?.photoUrl || !vsState.activeProfile?.firstName) {
      return `
        ${renderVsBanner()}
        <div class="vs-empty-state">
          <h2>Open a LinkedIn profile</h2>
          <p>Video Studio needs a visible profile photo on a LinkedIn profile page.</p>
        </div>
      `;
    }

    return `
      ${renderVsBanner()}
      ${renderVsProfileCard()}
      <p class="vs-center-copy">Profile loaded and ready</p>
      <button class="vs-btn-primary" type="button" data-action="generate-project" ${vsState.activeMutation || vsState.loading ? 'disabled' : ''}>Generate Preview Images</button>
    `;
  }

  function renderVsGeneratingScreen() {
    return `
      ${renderVsBanner()}
      ${renderVsProfileCard()}
      ${renderVsProgressBlock()}
      <div class="vs-stack">
        ${getVsRenderableAssets().map(renderVsAssetCard).join('')}
      </div>
    `;
  }

  function renderVsReviewScreen() {
    const grouped = getVsGroupedAssets();
    const reviewAssets = [
      grouped.portrait,
      grouped.fullBody,
      ...grouped.sceneFrames,
    ].filter(Boolean);
    const canApprove = areVsReviewAssetsReady() && !vsState.activeMutation && !hasVsActiveJob();
    const waitingAsset = reviewAssets.find((asset) => asset.status !== 'ready');
    const waitingAssetStatus = String(waitingAsset?.status || '').toLowerCase();
    const waitingHint = waitingAsset
      ? (waitingAssetStatus === 'failed' || waitingAssetStatus === 'stale'
        ? `Retry ${waitingAsset.label} to continue.`
        : `Waiting for ${waitingAsset.label}…`)
      : null;

    return `
      ${renderVsBanner()}
      ${renderVsProfileCard()}
      <p class="vs-center-copy">Review all images before starting the final render.</p>
      <div class="vs-stack">
        ${reviewAssets.map(renderVsAssetCard).join('')}
      </div>
      <button class="vs-btn-primary" type="button" data-action="approve-project" ${canApprove ? '' : 'disabled'}>Approve &amp; Generate Video</button>
      ${waitingHint ? `<p class="vs-progress-hint">${escapeVsHtml(waitingHint)}</p>` : ''}
    `;
  }

  function renderVsScenePreviewCard() {
    if (!vsState.pendingScenePreview?.previewClipUrl) {
      return '';
    }

    if (vsState.pendingScenePreview?.manualReview?.status === 'pending') {
      return renderVsManualReviewCard({
        title: 'Scene preview needs manual review',
        sceneId: vsState.pendingScenePreview.sceneId,
        jobId: vsState.pendingScenePreview.jobId,
        clipUrl: vsState.pendingScenePreview.previewClipUrl,
        promptUsed: vsState.pendingScenePreview.manualReview.promptUsed || vsState.pendingScenePreview.promptUsed || null,
        manualReview: vsState.pendingScenePreview.manualReview,
        manualReviewSource: 'preview_job',
        videoRole: 'scene-preview',
      });
    }

    const previewClipUrl = vsState.pendingScenePreview.previewClipUrl;
    const previewBlobUrl = getVsVideoBlobUrl(previewClipUrl);
    if (!previewBlobUrl) {
      fetchVsVideoBlobUrl(previewClipUrl);
    }

    return `
      <div class="vs-scene-preview-card">
        <p class="vs-scene-preview-title">Scene preview ready</p>
        <div class="vs-scene-preview-player" data-video-role="scene-preview">
          ${previewBlobUrl
            ? `<video controls src="${escapeVsHtml(previewBlobUrl)}"></video>`
            : renderVsHeartbeat()}
        </div>
        <p class="vs-scene-preview-hint">Review this scene before it replaces the final video.</p>
        <div class="vs-scene-preview-actions">
          <button class="vs-btn-apply" type="button" data-action="apply-scene-preview" data-job-id="${escapeVsHtml(vsState.pendingScenePreview.jobId)}" data-scene-id="${escapeVsHtml(vsState.pendingScenePreview.sceneId)}" ${vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>Apply</button>
          <button class="vs-btn-discard" type="button" data-action="discard-scene-preview" data-job-id="${escapeVsHtml(vsState.pendingScenePreview.jobId)}" data-scene-id="${escapeVsHtml(vsState.pendingScenePreview.sceneId)}" ${vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>Discard</button>
        </div>
      </div>
    `;
  }

  function renderVsDirectionForm(options = {}) {
    return `
      <div class="vs-direction-form">
        <p class="vs-direction-hint">Additional direction:</p>
        <textarea class="vs-regen-textarea" name="promptText" rows="2" data-draft-type="scene" data-scene-id="${escapeVsHtml(options.sceneId || '')}" placeholder="${escapeVsHtml(options.placeholder || 'e.g. Make it more professional…')}">${escapeVsHtml(options.value || '')}</textarea>
        <button class="vs-btn-direction-submit" type="submit" ${options.disabled ? 'disabled' : ''}>${escapeVsHtml(options.label || 'Generate preview')}</button>
      </div>
    `;
  }

  function getVsSceneRecoveryStatusMeta(scene) {
    const manualReviewStatus = String(scene?.manualReview?.status || '').toLowerCase();
    if (manualReviewStatus === 'pending') {
      return {
        label: 'Review needed',
        className: 'vs-status-needs-retry',
      };
    }

    if (manualReviewStatus === 'rejected') {
      return {
        label: 'Redo needed',
        className: 'vs-status-needs-retry',
      };
    }

    const status = String(scene?.sceneClipStatus || '').toLowerCase();
    if (status === 'ready' && scene?.sceneClipUrl) {
      return {
        label: 'Loaded',
        className: 'vs-status-ready',
      };
    }

    if (status === 'stale') {
      return {
        label: 'Stale',
        className: 'vs-status-needs-retry',
      };
    }

    return {
      label: 'Missing',
      className: 'vs-status-needs-retry',
    };
  }

  function getVsManualReviewSource(source) {
    return source === 'preview_job' ? 'preview_job' : 'scene_asset';
  }

  function getVsManualReviewKey({ source, sceneId, jobId }) {
    return `${getVsManualReviewSource(source)}:${sceneId || ''}:${jobId || ''}`;
  }

  function normalizeVsManualReviewValue(value) {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
      return null;
    }
    return trimmed;
  }

  function isVsStrictUuid(value) {
    return typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function getVsManualReviewActionContext(input = {}) {
    const projectId = normalizeVsManualReviewValue(input.projectId != null ? String(input.projectId) : '');
    const jobId = normalizeVsManualReviewValue(input.jobId != null ? String(input.jobId) : '');
    const sceneId = normalizeVsManualReviewValue(input.sceneId != null ? String(input.sceneId) : '');
    const source = getVsManualReviewSource(input.source);
    const manualReviewKey = getVsManualReviewKey({ source, sceneId, jobId });
    const isValid = isVsStrictUuid(projectId) && isVsStrictUuid(jobId) && Boolean(sceneId);
    return {
      projectId,
      jobId,
      sceneId,
      source,
      manualReviewKey,
      isValid,
      hintMessage: 'This review card is out of sync. Refresh Video Studio and try again.',
    };
  }

  function getVsManualReviewActionContextFromTarget(target) {
    return getVsManualReviewActionContext({
      projectId: vsState.project?.id,
      jobId: target?.dataset?.jobId,
      sceneId: target?.dataset?.sceneId,
      source: target?.dataset?.source,
    });
  }

  function ensureVsManualReviewActionContext(context) {
    if (context?.isValid) {
      return true;
    }
    setVsStatus('This review card is out of sync. Refresh Video Studio and try again.', 'error');
    return false;
  }

  function hasVsOptimisticTimingInFlight() {
    return Object.keys(vsState.optimisticTimingByKey || {}).length > 0;
  }

  function cloneVsSnapshotValue(value) {
    if (value === undefined) {
      return undefined;
    }
    return JSON.parse(JSON.stringify(value));
  }

  function buildVsOptimisticSnapshot() {
    return {
      project: cloneVsSnapshotValue(vsState.project),
      assets: cloneVsSnapshotValue(vsState.assets),
      latestJob: cloneVsSnapshotValue(vsState.latestJob),
      activeJobs: cloneVsSnapshotValue(vsState.activeJobs),
      scenes: cloneVsSnapshotValue(vsState.scenes),
      pendingScenePreview: cloneVsSnapshotValue(vsState.pendingScenePreview),
      recovery: cloneVsSnapshotValue(vsState.recovery),
    };
  }

  function applyVsOptimisticManualTimingCommit(context) {
    if (context.source === 'preview_job') {
      if (vsState.pendingScenePreview?.manualReview) {
        vsState.pendingScenePreview.manualReview.status = 'approved';
      }
      return;
    }
    const scene = (vsState.scenes || []).find((candidate) => candidate.sceneId === context.sceneId);
    if (scene?.manualReview) {
      scene.manualReview.status = 'approved';
    }
  }

  function restoreVsOptimisticSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }
    vsState.project = cloneVsSnapshotValue(snapshot.project);
    vsState.assets = cloneVsSnapshotValue(snapshot.assets) || [];
    vsState.latestJob = cloneVsSnapshotValue(snapshot.latestJob);
    vsState.activeJobs = cloneVsSnapshotValue(snapshot.activeJobs) || [];
    vsState.scenes = cloneVsSnapshotValue(snapshot.scenes) || [];
    vsState.pendingScenePreview = cloneVsSnapshotValue(snapshot.pendingScenePreview);
    vsState.recovery = cloneVsSnapshotValue(snapshot.recovery);
    syncVsReverifyResultsFromProjectPayload();
  }

  function normalizeVsFrameToSeconds(frame, fps) {
    if (!Number.isFinite(Number(frame)) || !Number.isFinite(Number(fps)) || Number(fps) <= 0) {
      return null;
    }

    return Number(frame) / Number(fps);
  }

  function formatVsSeconds(seconds) {
    if (!Number.isFinite(Number(seconds))) {
      return null;
    }

    return `${Number(seconds).toFixed(2)}s`;
  }

  function getVsVideoElementByRole(videoRole) {
    if (!videoRole) {
      return null;
    }
    return document.querySelector(`[data-video-role="${CSS.escape(videoRole)}"] video`);
  }

  function getVsRequiredManualTimingCues(manualReview) {
    if (!Array.isArray(manualReview?.cues)) {
      return [];
    }
    return manualReview.cues.filter((cue) => (
      String(cue?.importance || '').toLowerCase() !== 'soft'
    ));
  }

  function getVsManualTimingDraft(manualReviewKey, cueId, manualReview) {
    const rawDraft = vsState.manualTimingDraftsByKey?.[manualReviewKey]?.[cueId];
    const fromDraft = Number(rawDraft);
    if (rawDraft !== null && rawDraft !== undefined && Number.isFinite(fromDraft) && fromDraft >= 0) {
      return fromDraft;
    }
    const persisted = Array.isArray(manualReview?.manualTiming?.cueMarks)
      ? manualReview.manualTiming.cueMarks.find((mark) => mark?.cueId === cueId)
      : null;
    const persistedSec = Number(persisted?.timeSec);
    if (Number.isFinite(persistedSec) && persistedSec >= 0) {
      return persistedSec;
    }
    return null;
  }

  function setVsManualTimingDraft(manualReviewKey, cueId, seconds) {
    if (!vsState.manualTimingDraftsByKey[manualReviewKey]) {
      vsState.manualTimingDraftsByKey[manualReviewKey] = {};
    }
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
      delete vsState.manualTimingDraftsByKey[manualReviewKey][cueId];
      return;
    }
    vsState.manualTimingDraftsByKey[manualReviewKey][cueId] = Math.max(0, Number(seconds));
  }

  function renderVsManualTimingPanel(options) {
    const actionContext = getVsManualReviewActionContext({
      projectId: vsState.project?.id,
      jobId: options.jobId,
      sceneId: options.sceneId,
      source: options.manualReviewSource,
    });
    const manualReviewKey = actionContext.manualReviewKey;
    const modelFps = Number(options.manualReview?.debugVerification?.initial?.modelFps) || null;
    const windowDurationFrames = Number(options.manualReview?.debugVerification?.initial?.windowDurationFrames);
    const requiredCues = getVsRequiredManualTimingCues(options.manualReview);
    if (!Number.isFinite(windowDurationFrames) || windowDurationFrames <= 0 || requiredCues.length === 0) {
      return '';
    }

    const rowMarkup = requiredCues.map((cue) => {
      const draftSec = getVsManualTimingDraft(manualReviewKey, cue.cueId, options.manualReview);
      return `
        <div class="vs-manual-timing-row">
          <label class="vs-manual-timing-label">${escapeVsHtml(cue.label || cue.cueId || 'Scene cue')}</label>
          <input
            class="vs-manual-timing-input"
            type="number"
            min="0"
            step="0.01"
            value="${Number.isFinite(draftSec) ? escapeVsHtml(draftSec.toFixed(2)) : ''}"
            data-action="manual-timing-input"
            data-manual-review-key="${escapeVsHtml(manualReviewKey)}"
            data-cue-id="${escapeVsHtml(cue.cueId)}"
          />
          <div class="vs-manual-timing-buttons">
            <button class="vs-btn-secondary" type="button" data-action="manual-timing-use-playhead" data-video-role="${escapeVsHtml(options.videoRole || '')}" data-manual-review-key="${escapeVsHtml(manualReviewKey)}" data-cue-id="${escapeVsHtml(cue.cueId)}">Use current playhead</button>
            <button class="vs-btn-secondary" type="button" data-action="manual-timing-nudge" data-manual-review-key="${escapeVsHtml(manualReviewKey)}" data-cue-id="${escapeVsHtml(cue.cueId)}" data-delta="-0.1">-0.1s</button>
            <button class="vs-btn-secondary" type="button" data-action="manual-timing-nudge" data-manual-review-key="${escapeVsHtml(manualReviewKey)}" data-cue-id="${escapeVsHtml(cue.cueId)}" data-delta="0.1">+0.1s</button>
            <button class="vs-btn-secondary vs-timing-jump-btn" type="button" data-action="manual-timing-jump" data-video-role="${escapeVsHtml(options.videoRole || '')}" data-manual-review-key="${escapeVsHtml(manualReviewKey)}" data-cue-id="${escapeVsHtml(cue.cueId)}">Jump</button>
          </div>
        </div>
      `;
    }).join('');

    const canApply = requiredCues.every((cue) => {
      const sec = getVsManualTimingDraft(manualReviewKey, cue.cueId, options.manualReview);
      return Number.isFinite(sec) && sec >= 0;
    });
    const firstCue = requiredCues[0];
    const firstCueSec = getVsManualTimingDraft(manualReviewKey, firstCue.cueId, options.manualReview);
    const firstCueFrame = Number(firstCue?.frameNumber);
    const firstCueAbsFrame = Number.isFinite(firstCueSec) && Number.isFinite(modelFps)
      ? Math.round(firstCueSec * modelFps)
      : null;
    const computedStartFrame = Number.isFinite(firstCueAbsFrame) && Number.isFinite(firstCueFrame)
      ? Math.max(0, firstCueAbsFrame - firstCueFrame)
      : null;
    const computedStartSec = normalizeVsFrameToSeconds(computedStartFrame, modelFps);
    const computedEndSec = Number.isFinite(computedStartSec)
      ? computedStartSec + normalizeVsFrameToSeconds(windowDurationFrames, modelFps)
      : null;
    const isApplying = vsState.applyingManualTimingKey === manualReviewKey;
    const blockedByOptimistic = hasVsOptimisticTimingInFlight();
    const disabled = !actionContext.isValid || !canApply || isApplying || blockedByOptimistic || vsState.activeMutation || hasVsActiveJob();

    return `
      <div class="vs-manual-timing-panel">
        <p class="vs-manual-review-title">Manual timing</p>
        ${rowMarkup}
        <p class="vs-manual-review-copy"><strong>Final clip will be:</strong> ${formatVsSeconds(computedStartSec) || 'n/a'} → ${formatVsSeconds(computedEndSec) || 'n/a'}</p>
        ${!actionContext.isValid ? `<p class="vs-warning-note">${escapeVsHtml(actionContext.hintMessage)}</p>` : ''}
        <button class="vs-btn-apply" type="button" data-action="apply-manual-timing" data-manual-review-key="${escapeVsHtml(manualReviewKey)}" data-scene-id="${escapeVsHtml(options.sceneId)}" data-job-id="${escapeVsHtml(options.jobId)}" data-source="${escapeVsHtml(options.manualReviewSource)}" ${disabled ? 'disabled' : ''}>${isApplying ? 'Saving...' : 'Save & approve'}</button>
      </div>
    `;
  }

  function getVsManualReviewReverifyEntry(options) {
    const key = getVsManualReviewKey({
      source: options?.manualReviewSource,
      sceneId: options?.sceneId,
      jobId: options?.jobId,
    });
    const localEntry = vsState.reverifyResultsByKey[key];
    if (localEntry?.verificationResult) {
      return localEntry;
    }

    const latest = options?.manualReview?.debugVerification?.latestReverify;
    if (!latest || typeof latest !== 'object' || !latest.verificationResult) {
      return null;
    }

    return {
      reverifyToken: latest.token || null,
      verificationResult: latest.verificationResult,
      sceneId: options?.sceneId || latest.sceneId || null,
      jobId: options?.jobId || latest.jobId || null,
      source: getVsManualReviewSource(options?.manualReviewSource || latest.source),
      usedAt: latest.usedAt || null,
      expiresAt: latest.expiresAt || null,
    };
  }

  function syncVsReverifyResultsFromProjectPayload() {
    const nextEntries = {};

    const addEntry = (options) => {
      const latest = options?.manualReview?.debugVerification?.latestReverify;
      if (!latest || typeof latest !== 'object' || !latest.verificationResult) {
        return;
      }

      const key = getVsManualReviewKey({
        source: options.source,
        sceneId: options.sceneId,
        jobId: options.jobId,
      });
      nextEntries[key] = {
        reverifyToken: latest.token || null,
        verificationResult: latest.verificationResult,
        sceneId: options.sceneId,
        jobId: options.jobId,
        source: getVsManualReviewSource(options.source),
        usedAt: latest.usedAt || null,
        expiresAt: latest.expiresAt || null,
      };
    };

    if (vsState.pendingScenePreview?.manualReview?.status === 'pending') {
      addEntry({
        source: 'preview_job',
        sceneId: vsState.pendingScenePreview.sceneId,
        jobId: vsState.pendingScenePreview.jobId,
        manualReview: vsState.pendingScenePreview.manualReview,
      });
    }

    (vsState.scenes || []).forEach((scene) => {
      if (scene?.manualReview?.status !== 'pending') {
        return;
      }
      addEntry({
        source: 'scene_asset',
        sceneId: scene.sceneId,
        jobId: scene.manualReview?.sourceJobId,
        manualReview: scene.manualReview,
      });
    });

    vsState.reverifyResultsByKey = nextEntries;
  }

  function renderVsManualReviewCue(cue, options = {}) {
    if (!cue) {
      return '';
    }

    const isPassed = cue.passed === true;
    const requirementLabel = String(cue.importance || '').toLowerCase() === 'soft'
      ? 'Nice to have'
      : 'Required';
    const cueSecond = normalizeVsFrameToSeconds(cue.resolvedFrameNumber, options.modelFps);
    const cueSecondLabel = formatVsSeconds(cueSecond);

    return `
      <div class="vs-manual-review-cue ${isPassed ? 'vs-manual-review-cue--passed' : 'vs-manual-review-cue--failed'}">
        <div class="vs-manual-review-cue-head">
          <span class="vs-manual-review-cue-title">${escapeVsHtml(cue.label || cue.cueId || 'Scene cue')}</span>
          <span class="vs-manual-review-cue-status">${isPassed ? 'Pass' : 'Needs review'}</span>
          <span class="vs-manual-review-badge">${escapeVsHtml(requirementLabel)}</span>
        </div>
        ${vsState.verificationDebuggerEnabled && cueSecondLabel
          ? `<p class="vs-manual-review-copy"><strong>Resolved timing:</strong> ${escapeVsHtml(cueSecondLabel)} (frame ${escapeVsHtml(String(cue.resolvedFrameNumber))})</p>`
          : ''}
        ${cue.description ? `<p class="vs-manual-review-copy">${escapeVsHtml(cue.description)}</p>` : ''}
        ${cue.payoffState ? `<p class="vs-manual-review-copy"><strong>Success looks like:</strong> ${escapeVsHtml(cue.payoffState)}</p>` : ''}
        ${cue.observation ? `<p class="vs-manual-review-copy"><strong>Verifier note:</strong> ${escapeVsHtml(cue.observation)}</p>` : ''}
      </div>
    `;
  }

  function renderVsStepRail() {
    return `
      <div class="vs-step-rail" aria-label="Review stage">
        <span class="vs-step-rail-dot vs-step-rail-dot--done">Generate</span>
        <span class="vs-step-rail-dot vs-step-rail-dot--done">Auto-check</span>
        <span class="vs-step-rail-dot vs-step-rail-dot--active">Your review</span>
        <span class="vs-step-rail-dot">Assemble</span>
      </div>
    `;
  }

  function getVsManualReviewSummaryData() {
    const pendingSceneManualReviews = getVsPendingSceneManualReviewScenes();
    const hasPreviewManualReview = vsState.pendingScenePreview?.manualReview?.status === 'pending';
    const allPendingCount = pendingSceneManualReviews.length + (hasPreviewManualReview ? 1 : 0);
    return {
      pendingSceneManualReviews,
      hasPreviewManualReview,
      allPendingCount,
    };
  }

  function renderVsManualReviewQueueSummary() {
    const summary = getVsManualReviewSummaryData();
    if (summary.allPendingCount === 0) {
      return '';
    }

    const currentSceneLabel = summary.pendingSceneManualReviews[0]?.label || (summary.hasPreviewManualReview ? 'Scene preview' : null);
    return `
      <div class="vs-manual-review-summary">
        <p class="vs-manual-review-summary-title">Manual review needed</p>
        <p class="vs-manual-review-summary-copy">${escapeVsHtml(`${summary.allPendingCount} scene${summary.allPendingCount === 1 ? '' : 's'} need your decision before Generate Video is available.`)}</p>
        ${currentSceneLabel ? `<p class="vs-manual-review-summary-copy"><strong>Current:</strong> ${escapeVsHtml(currentSceneLabel)}</p>` : ''}
      </div>
    `;
  }

  function renderVsVerificationDebugPanel(options = {}) {
    if (!vsState.verificationDebuggerEnabled) {
      return '';
    }

    const reverifyEntry = getVsManualReviewReverifyEntry(options);
    const verificationResult = reverifyEntry?.verificationResult;
    if (!verificationResult) {
      return '';
    }

    const actionContext = getVsManualReviewActionContext({
      projectId: vsState.project?.id,
      jobId: options.jobId,
      sceneId: options.sceneId,
      source: options.manualReviewSource,
    });
    const manualReviewKey = actionContext.manualReviewKey;
    const modelFps = Number(options.manualReview?.debugVerification?.initial?.modelFps)
      || Number(verificationResult?.clipInfo?.fps)
      || null;
    const startFrame = Number(verificationResult.windowStartFrame);
    const durationFrames = Number(verificationResult.windowDurationFrames);
    const endFrame = Number.isFinite(startFrame) && Number.isFinite(durationFrames)
      ? startFrame + durationFrames
      : null;
    const startSecondLabel = formatVsSeconds(normalizeVsFrameToSeconds(startFrame, modelFps));
    const endSecondLabel = formatVsSeconds(normalizeVsFrameToSeconds(endFrame, modelFps));
    const isApplying = vsState.applyingWindowKey === manualReviewKey;
    const isDisabled = (
      vsState.activeMutation
      || hasVsActiveJob()
      || hasVsOptimisticTimingInFlight()
      || !actionContext.isValid
      || !reverifyEntry?.reverifyToken
      || Boolean(reverifyEntry?.usedAt)
      || isApplying
    );

    return `
      <div class="vs-reverify-panel">
        <p class="vs-manual-review-title">Re-verification Result</p>
        <div class="vs-reverify-info">
          <p class="vs-manual-review-copy"><strong>Overall:</strong> ${verificationResult.overallPassed ? 'PASSED' : 'FAILED'}</p>
          <p class="vs-manual-review-copy"><strong>Window:</strong> ${startSecondLabel || 'n/a'} → ${endSecondLabel || 'n/a'} (frame ${escapeVsHtml(String(startFrame))}${endFrame != null ? ` → ${escapeVsHtml(String(endFrame))}` : ''})</p>
          <p class="vs-manual-review-copy"><strong>Mode:</strong> ${escapeVsHtml(verificationResult.verificationMode || 'unknown')}</p>
          ${verificationResult.reason ? `<p class="vs-manual-review-copy"><strong>Reason:</strong> ${escapeVsHtml(verificationResult.reason)}</p>` : ''}
        </div>
        ${(verificationResult.cueResults || []).map((cueResult) => `
          <details class="vs-reverify-sub-result">
            <summary>${escapeVsHtml(cueResult.cueId || 'Cue')} - ${cueResult.passed ? 'PASSED' : 'FAILED'}</summary>
            ${cueResult.observation ? `<p class="vs-manual-review-copy">${escapeVsHtml(cueResult.observation)}</p>` : ''}
            ${(cueResult.subResults || []).map((subResult) => `
              <p class="vs-manual-review-copy">${subResult.answer ? '✓' : '✗'} ${escapeVsHtml(subResult.question || '')}</p>
            `).join('')}
          </details>
        `).join('')}
        ${Array.isArray(verificationResult.bucketTraces) && verificationResult.bucketTraces.length > 0 ? `
          <details class="vs-reverify-sub-result">
            <summary>Bucket traces</summary>
            ${verificationResult.bucketTraces.map((trace) => `
              <p class="vs-manual-review-copy">${escapeVsHtml(trace.cueId || 'cue')} - pass1: ${escapeVsHtml(trace.pass1?.status || 'n/a')}${trace.pass2 ? `, pass2: ${escapeVsHtml(trace.pass2?.status || 'n/a')}` : ''}</p>
            `).join('')}
          </details>
        ` : ''}
        ${!actionContext.isValid ? `<p class="vs-warning-note">${escapeVsHtml(actionContext.hintMessage)}</p>` : ''}
        <button
          class="vs-btn-reverify"
          type="button"
          data-action="apply-reverified-window"
          data-manual-review-key="${escapeVsHtml(manualReviewKey)}"
          data-job-id="${escapeVsHtml(options.jobId || '')}"
          data-scene-id="${escapeVsHtml(options.sceneId || '')}"
          data-source="${escapeVsHtml(getVsManualReviewSource(options.manualReviewSource))}"
          ${isDisabled ? 'disabled' : ''}
        >${isApplying ? 'Applying...' : 'Apply this window'}</button>
      </div>
    `;
  }

  function renderVsManualReviewCard(options) {
    if (!options?.manualReview || !options?.clipUrl) {
      return '';
    }

    const manualReviewSource = getVsManualReviewSource(options.manualReviewSource);
    const actionContext = getVsManualReviewActionContext({
      projectId: vsState.project?.id,
      jobId: options.jobId,
      sceneId: options.sceneId,
      source: manualReviewSource,
    });
    const manualReviewKey = actionContext.manualReviewKey;
    const initialDebug = options.manualReview?.debugVerification?.initial;
    const initialModelFps = Number(initialDebug?.modelFps) || null;
    const initialWindowStart = Number(initialDebug?.windowStartFrame);
    const initialWindowDuration = Number(initialDebug?.windowDurationFrames);
    const initialWindowEnd = Number.isFinite(initialWindowStart) && Number.isFinite(initialWindowDuration)
      ? initialWindowStart + initialWindowDuration
      : null;
    const initialWindowStartSec = formatVsSeconds(normalizeVsFrameToSeconds(initialWindowStart, initialModelFps));
    const initialWindowEndSec = formatVsSeconds(normalizeVsFrameToSeconds(initialWindowEnd, initialModelFps));
    const isReverifying = vsState.reverifyingKey === manualReviewKey;

    const previewBlobUrl = getVsVideoBlobUrl(options.clipUrl);
    if (!previewBlobUrl) {
      fetchVsVideoBlobUrl(options.clipUrl);
    }

    const cues = Array.isArray(options.manualReview.cues) ? options.manualReview.cues : [];
    const requiredCues = cues.filter((cue) => String(cue?.importance || '').toLowerCase() !== 'soft');
    const niceToHaveCues = cues.filter((cue) => String(cue?.importance || '').toLowerCase() === 'soft');

    const blockedByOptimistic = hasVsOptimisticTimingInFlight();
    return `
      <div class="vs-manual-review-card">
        <div class="vs-manual-review-header">
          <p class="vs-manual-review-title">${escapeVsHtml(options.title || 'Needs your approval')}</p>
          <span class="vs-manual-review-chip">Decision needed</span>
        </div>
        ${renderVsStepRail()}
        <div class="vs-manual-review-layout">
          <div class="vs-scene-preview-player" data-video-role="${escapeVsHtml(options.videoRole || 'scene-manual-review')}">
            ${previewBlobUrl
              ? `<video controls src="${escapeVsHtml(previewBlobUrl)}"></video>`
              : renderVsHeartbeat()}
          </div>
          <div class="vs-manual-review-decision vs-decision-card">
            ${options.manualReview.latestObservation
              ? `<p class="vs-manual-review-copy"><strong>What happened:</strong> ${escapeVsHtml(options.manualReview.latestObservation)}</p>`
              : '<p class="vs-manual-review-copy"><strong>What happened:</strong> We were not fully confident this scene matched the goal.</p>'}
            ${options.promptUsed
              ? `<p class="vs-manual-review-copy"><strong>What success looks like:</strong> ${escapeVsHtml(options.promptUsed)}</p>`
              : ''}
            <p class="vs-manual-review-copy">Choose the safest next step: approve if this looks good, or redo this scene.</p>
            ${requiredCues.length > 0 ? `
              <p class="vs-manual-review-subtitle">Must-haves</p>
              <div class="vs-manual-review-cues">
                ${requiredCues.map((cue) => renderVsManualReviewCue(cue, {
                  modelFps: initialModelFps,
                })).join('')}
              </div>
            ` : ''}
            ${niceToHaveCues.length > 0 ? `
              <p class="vs-manual-review-subtitle">Nice-to-haves</p>
              <div class="vs-manual-review-cues">
                ${niceToHaveCues.map((cue) => renderVsManualReviewCue(cue, {
                  modelFps: initialModelFps,
                })).join('')}
              </div>
            ` : ''}
            ${!actionContext.isValid ? `<p class="vs-warning-note">${escapeVsHtml(actionContext.hintMessage)}</p>` : ''}
            <div class="vs-scene-preview-actions">
              <button class="vs-btn-apply" type="button" data-action="approve-scene-manual-review" data-job-id="${escapeVsHtml(options.jobId)}" data-scene-id="${escapeVsHtml(options.sceneId)}" ${!actionContext.isValid || blockedByOptimistic || vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>Approve as-is</button>
              <button class="vs-btn-discard" type="button" data-action="reject-scene-manual-review" data-job-id="${escapeVsHtml(options.jobId)}" data-scene-id="${escapeVsHtml(options.sceneId)}" ${!actionContext.isValid || blockedByOptimistic || vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>Redo scene</button>
            </div>
            <div class="vs-fix-timing-card">
              <p class="vs-manual-review-title">Fix timing</p>
              <p class="vs-manual-review-copy">Clip is good but timing is off. Mark the cue moment and save.</p>
              ${renderVsManualTimingPanel({
                ...options,
                manualReviewSource,
              })}
            </div>
            ${vsState.verificationDebuggerEnabled ? `
              <details class="vs-manual-review-advanced">
                <summary>Debug tools</summary>
                ${initialDebug ? `
                  <div class="vs-reverify-info">
                    <p class="vs-manual-review-copy"><strong>Window:</strong> ${escapeVsHtml(initialWindowStartSec || 'n/a')} → ${escapeVsHtml(initialWindowEndSec || 'n/a')} (frame ${escapeVsHtml(String(initialWindowStart))}${initialWindowEnd != null ? ` → ${escapeVsHtml(String(initialWindowEnd))}` : ''})</p>
                    <p class="vs-manual-review-copy"><strong>Mode:</strong> ${escapeVsHtml(initialDebug.verificationMode || 'unknown')}</p>
                  </div>
                ` : ''}
                <button
                  class="vs-btn-reverify"
                  type="button"
                  data-action="reverify-scene-manual-review"
                  data-manual-review-key="${escapeVsHtml(manualReviewKey)}"
                  data-job-id="${escapeVsHtml(options.jobId)}"
                  data-scene-id="${escapeVsHtml(options.sceneId)}"
                  data-source="${escapeVsHtml(manualReviewSource)}"
                  ${!actionContext.isValid || blockedByOptimistic || isReverifying || vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}
                >${isReverifying ? 'Running automated check...' : 'Run automated check again'}</button>
                ${renderVsVerificationDebugPanel({
                  ...options,
                  manualReviewSource,
                }).replace('Re-verification Result', 'Automated check details').replace('Apply this window', 'Use suggested timing')}
              </details>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  function renderVsFinalScreen() {
    const projectId = vsState.project?.id;
    const finalVideoUrl = vsState.project?.finalVideoUrl;
    const finalVideoAsset = getVsFinalVideoAsset();
    const isSceneRecovery = isVsSceneRecoveryProject() && !finalVideoUrl;
    const pendingSceneManualReviews = getVsPendingSceneManualReviewScenes();
    const recovery = vsState.recovery;
    const isFinalVideoStale = String(finalVideoAsset?.status || '').toLowerCase() === 'stale';
    const canShareVideo = Boolean(projectId && finalVideoUrl && !isFinalVideoStale && !hasVsActiveJob());
    const showRerenderFailure = Boolean(finalVideoUrl && vsState.project?.lastError && !hasVsActiveJob());
    const recoveryMissingScenes = isSceneRecovery
      ? vsState.scenes.filter((scene) => String(scene.sceneClipStatus || '').toLowerCase() !== 'ready')
      : [];
    const recoveryMissingLabels = recoveryMissingScenes.map((scene) => scene.label).join(', ');
    const canAssembleRecoveryVideo = Boolean(
      isSceneRecovery
      && recovery?.canAssembleVideo
      && pendingSceneManualReviews.length === 0
      && !vsState.activeMutation
      && !hasVsActiveJob()
    );
    const grouped = getVsGroupedAssets();
    const editableAssets = [
      grouped.portrait,
      grouped.fullBody,
      ...grouped.sceneFrames,
    ].filter(Boolean);

    const videoBlobUrl = getVsVideoBlobUrl(finalVideoUrl);
    const canInsertVideo = Boolean(canShareVideo && videoBlobUrl && !vsState.insertingVideo);
    if (finalVideoUrl && !videoBlobUrl) {
      fetchVsVideoBlobUrl(finalVideoUrl);
    }

    return `
      ${renderVsBanner()}
      ${hasVsActiveJob() ? renderVsProgressBlock() : ''}
      ${!hasVsActiveJob()
        ? `<p class="vs-video-ready-copy">${isSceneRecovery
          ? (pendingSceneManualReviews.length > 0
            ? 'Review the flagged scenes before generating the video.'
            : 'Your saved scenes are ready for recovery.')
          : 'Your video is ready! 🎬✨'}</p>`
        : ''}
      ${isSceneRecovery ? `
        <p class="vs-center-copy">${escapeVsHtml(`${recovery?.readySceneCount || 0} of ${recovery?.totalSceneCount || vsState.scenes.length} scenes saved.`)}</p>
      ` : `
        <div class="vs-video-card">
          <div class="vs-sparkle-burst" aria-hidden="true">
            <div class="vs-sparkle-dots vs-sparkle-dots-a"></div>
            <div class="vs-sparkle-dots vs-sparkle-dots-b"></div>
          </div>
          ${videoBlobUrl
            ? `<div class="vs-video-player" data-video-role="final"><video controls src="${escapeVsHtml(videoBlobUrl)}"></video></div>`
            : `<div class="vs-video-player vs-video-player--loading">${renderVsHeartbeat()}</div>`}
        </div>
      `}
      ${showRerenderFailure
    ? `<p class="vs-warning-note vs-warning-note--error">Re-render failed. You are still seeing the previous video.</p>`
    : ''}
      ${isSceneRecovery && vsState.project?.lastError
    ? '<p class="vs-warning-note vs-warning-note--error">Final video generation stopped, but your saved scenes are still loaded below.</p>'
    : ''}
      ${isFinalVideoStale
    ? '<p class="vs-warning-note">This video is out of date after your scene edit. Click Re-render Video to update it.</p>'
    : ''}
      ${renderVsScenePreviewCard()}
      ${renderVsManualReviewQueueSummary()}
      ${pendingSceneManualReviews.length > 0 ? `
        <p class="vs-section-label">Review Queue</p>
        <div class="vs-stack">
          ${pendingSceneManualReviews.map((scene) => renderVsManualReviewCard({
            title: scene.label,
            sceneId: scene.sceneId,
            jobId: scene.manualReview?.sourceJobId || '',
            clipUrl: scene.manualReview?.candidateClipUrl || scene.sceneClipUrl || null,
            promptUsed: scene.manualReview?.promptUsed || null,
            manualReview: scene.manualReview,
            manualReviewSource: 'scene_asset',
            videoRole: `manual-review-${scene.sceneId}`,
          })).join('')}
        </div>
      ` : ''}
      ${(canShareVideo || pendingSceneManualReviews.length > 0) ? `<p class="vs-section-label">${pendingSceneManualReviews.length > 0 ? 'Other Project Actions' : 'Share'}</p>` : ''}
      ${canShareVideo ? `
        <div class="vs-stack">
          <button class="vs-btn-primary" type="button" data-action="insert-video-to-chat" ${canInsertVideo ? '' : 'disabled'}>${vsState.insertingVideo ? 'Inserting video...' : 'Insert video'}</button>
          ${!videoBlobUrl ? '<p class="vs-progress-hint">Preparing video for insert...</p>' : ''}
          <button class="vs-btn-secondary" type="button" data-action="share-video">Sharing page</button>
          <button class="vs-btn-secondary" type="button" data-action="copy-video-link">Copy sharing link</button>
        </div>
      ` : ''}
      <p class="vs-section-label">Edit Images</p>
      <button class="vs-btn-secondary" type="button" data-action="toggle-image-editor" ${vsState.activeMutation ? 'disabled' : ''}>${vsState.imageEditorOpen ? 'Close image editor' : 'Edit Images'}</button>
      ${vsState.imageEditorOpen ? `
        <p class="vs-progress-hint">Regenerate images, then re-render the video to apply.</p>
        <div class="vs-stack">
          ${editableAssets.map(renderVsAssetCard).join('')}
        </div>
      ` : ''}
      <p class="vs-section-label">${isSceneRecovery ? 'Generate Video' : 'Edit Video'}</p>
      ${isSceneRecovery
        ? `<button class="vs-btn-primary" type="button" data-action="assemble-video" ${canAssembleRecoveryVideo ? '' : 'disabled'}>Generate Video</button>`
        : `<button class="vs-btn-secondary" type="button" data-action="rerender-video" ${vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>Re-render Video</button>`}
      ${isSceneRecovery && pendingSceneManualReviews.length > 0
        ? `<p class="vs-progress-hint">Generate Video unlocks after all flagged scenes are approved or redone.</p>`
        : ''}
      ${isSceneRecovery && recoveryMissingLabels
        ? `<p class="vs-progress-hint">Waiting on: ${escapeVsHtml(recoveryMissingLabels)}</p>`
        : ''}
      <p class="vs-section-label">Redo One Scene</p>
      <div class="vs-stack">
        ${vsState.scenes.map((scene) => {
          const isOpen = vsState.openSceneEditorId === scene.sceneId;
          const recoveryStatusMeta = getVsSceneRecoveryStatusMeta(scene);
          return `
            <div class="vs-scene-row-wrap">
              <div class="vs-scene-row">
                <span class="vs-scene-label">${escapeVsHtml(scene.label)}</span>
                <button class="vs-btn-redo-scene ${isOpen ? 'vs-active' : ''}" type="button" data-action="toggle-scene-editor" data-scene-id="${escapeVsHtml(scene.sceneId)}" ${vsState.activeMutation || hasVsActiveJob() ? 'disabled' : ''}>${isOpen
                  ? 'Close'
                  : `${isSceneRecovery ? `<span class="vs-scene-dot ${recoveryStatusMeta.className}"></span> ` : ''}Redo scene`}</button>
              </div>
              ${isOpen ? `
                <form data-action="preview-scene" data-scene-id="${escapeVsHtml(scene.sceneId)}">
                  ${renderVsDirectionForm({
                    label: 'Generate preview',
                    disabled: vsState.activeMutation || hasVsActiveJob(),
                    placeholder: 'Describe what should change in this scene',
                    sceneId: scene.sceneId,
                    value: vsState.scenePromptDrafts[scene.sceneId] || '',
                  })}
                </form>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function collectVsVideoPreservation(contentEl) {
    const preserved = new Map();
    contentEl.querySelectorAll('[data-video-role]').forEach((container) => {
      const role = container.getAttribute('data-video-role');
      const video = container.querySelector('video');
      if (!role || !video || !video.src) {
        return;
      }
      preserved.set(role, {
        element: video,
        src: video.src,
        state: {
          currentTime: video.currentTime,
          paused: video.paused,
          muted: video.muted,
          playbackRate: video.playbackRate,
        },
      });
      container.removeChild(video);
    });
    return preserved;
  }

  function restoreVsPreservedVideos(contentEl, preservedVideos) {
    if (!preservedVideos || preservedVideos.size === 0) {
      return;
    }
    contentEl.querySelectorAll('[data-video-role]').forEach((container) => {
      const role = container.getAttribute('data-video-role');
      const nextVideo = container.querySelector('video');
      const preserved = role ? preservedVideos.get(role) : null;
      if (!nextVideo || !preserved || preserved.src !== nextVideo.src) {
        return;
      }

      container.replaceChild(preserved.element, nextVideo);
      const restoredVideo = preserved.element;
      restoredVideo.muted = preserved.state.muted;
      restoredVideo.playbackRate = preserved.state.playbackRate;
      try {
        restoredVideo.currentTime = preserved.state.currentTime;
      } catch (error) {
        // Ignore currentTime set failures (for example, media not seekable yet).
      }
      if (!preserved.state.paused) {
        restoredVideo.play().catch(() => {});
      }
    });
  }

  function captureVsTextareaFocus(contentEl) {
    const activeEl = document.activeElement;
    if (!contentEl || !activeEl || !(activeEl instanceof HTMLTextAreaElement) || !activeEl.classList.contains('vs-regen-textarea')) {
      return null;
    }

    const draftType = activeEl.dataset.draftType;
    if (draftType !== 'asset' && draftType !== 'scene') {
      return null;
    }

    return {
      draftType,
      assetId: activeEl.dataset.assetId || null,
      sceneId: activeEl.dataset.sceneId || null,
      selectionStart: Number.isFinite(activeEl.selectionStart) ? activeEl.selectionStart : null,
      selectionEnd: Number.isFinite(activeEl.selectionEnd) ? activeEl.selectionEnd : null,
    };
  }

  function restoreVsTextareaFocus(contentEl, preservedFocus) {
    if (!contentEl || !preservedFocus) {
      return;
    }

    const textareas = Array.from(contentEl.querySelectorAll('.vs-regen-textarea'));
    const nextEl = textareas.find((textarea) => (
      (preservedFocus.draftType === 'asset' && textarea.dataset.draftType === 'asset' && textarea.dataset.assetId === preservedFocus.assetId)
      || (preservedFocus.draftType === 'scene' && textarea.dataset.draftType === 'scene' && textarea.dataset.sceneId === preservedFocus.sceneId)
    )) || null;
    if (!nextEl) {
      return;
    }

    nextEl.focus({ preventScroll: true });
    if (Number.isFinite(preservedFocus.selectionStart) && Number.isFinite(preservedFocus.selectionEnd)) {
      try {
        nextEl.setSelectionRange(preservedFocus.selectionStart, preservedFocus.selectionEnd);
      } catch (_error) {
        // Ignore selection restore errors for detached or unsupported textareas.
      }
    }
  }

  function renderVsErrorScreen(kind) {
    const isGenerateError = kind === VS_UI_STATES.ERROR_GENERATE;
    return `
      ${renderVsBanner()}
      <div class="vs-error-banner" role="alert">
        <p class="vs-error-title">${escapeVsHtml(isGenerateError ? "The scene didn't come together 🎬" : 'The reel snapped 💨')}</p>
        <p class="vs-error-detail">${escapeVsHtml(isGenerateError ? 'Worth another take - try again?' : 'Check your connection and give it another go.')}</p>
      </div>
      <div class="vs-stack">
        ${isGenerateError
          ? '<button class="vs-btn-primary" type="button" data-action="retry-generate">Start over</button>'
          : `
            <button class="vs-btn-primary" type="button" data-action="retry-render">Retry render</button>
            <button class="vs-btn-secondary" type="button" data-action="back-to-images">Back to images</button>
          `}
        <button class="vs-btn-secondary" type="button" data-action="refresh-status">Refresh status</button>
      </div>
    `;
  }

  function renderVideoStudio() {
    if (!vsState.sidecarEl || !vsState.contentEl || !vsState.footerEl) {
      return;
    }

    vsState.current = getVsUiState();
    renderVsProgressRail(vsState.current);

    if (vsState.minimized) {
      vsState.sidecarEl.classList.add('vs-minimized');
      vsState.footerEl.style.display = 'none';
      vsState.contentEl.innerHTML = '';
      return;
    }

    vsState.sidecarEl.classList.remove('vs-minimized');

    let contentHtml = '';
    if (vsState.loading && !vsState.project && !vsState.activeProfile) {
      contentHtml = `
        ${renderVsBanner()}
        <div class="vs-empty-state">
          <h2>Loading profile…</h2>
          ${renderVsHeartbeat()}
        </div>
      `;
    } else if (vsState.current === VS_UI_STATES.READY) {
      contentHtml = renderVsReadyScreen();
    } else if (vsState.current === VS_UI_STATES.GENERATING) {
      contentHtml = renderVsGeneratingScreen();
    } else if (vsState.current === VS_UI_STATES.REVIEW_IMAGES) {
      contentHtml = renderVsReviewScreen();
    } else if (vsState.current === VS_UI_STATES.ERROR_GENERATE || vsState.current === VS_UI_STATES.ERROR_RENDER) {
      contentHtml = renderVsErrorScreen(vsState.current);
    } else {
      contentHtml = renderVsFinalScreen();
    }

    const previousUiState = vsState.lastRenderedUiState;
    const preservedTextareaFocus = captureVsTextareaFocus(vsState.contentEl);
    const preservedVideos = vsState.current === VS_UI_STATES.FINAL_VIDEO
      ? collectVsVideoPreservation(vsState.contentEl)
      : null;
    vsState.contentEl.innerHTML = contentHtml;
    restoreVsTextareaFocus(vsState.contentEl, preservedTextareaFocus);
    if (vsState.current === VS_UI_STATES.FINAL_VIDEO) {
      restoreVsPreservedVideos(vsState.contentEl, preservedVideos);
    }
    if (vsState.current === VS_UI_STATES.FINAL_VIDEO && previousUiState !== VS_UI_STATES.FINAL_VIDEO && !hasVsActiveJob()) {
      const sparkle = vsState.contentEl.querySelector('.vs-sparkle-burst');
      if (sparkle) {
        sparkle.classList.remove('active');
        // Force reflow so the burst animation can restart.
        // eslint-disable-next-line no-unused-expressions
        sparkle.offsetHeight;
        sparkle.classList.add('active');
      }
    }
    vsState.lastRenderedUiState = vsState.current;

    const showFooterCancel = hasVsActiveJob();
    const showStartOver = vsState.current !== VS_UI_STATES.READY;
    vsState.footerEl.style.display = showFooterCancel || showStartOver ? 'flex' : 'none';
    vsState.footerEl.innerHTML = [
      showFooterCancel
        ? `<button class="vs-btn-link" type="button" data-action="cancel-project" ${vsState.activeMutation ? 'disabled' : ''}>Cancel</button>`
        : '',
      showStartOver
        ? '<button class="vs-btn-link" type="button" data-action="start-over">Start over</button>'
        : '',
    ].filter(Boolean).join('');
  }

  function setVsStatus(message, tone = 'success') {
    vsState.statusMessage = message || null;
    vsState.statusTone = tone;
    renderVideoStudio();
  }

  function startVsStageMessageRotation() {
    clearVsStageMessageRotation();
    if (!hasVsActiveJob()) {
      return;
    }

    vsState.rotateStageMessageTimer = setInterval(() => {
      if (!hasVsActiveJob()) {
        clearVsStageMessageRotation();
        return;
      }
      vsState.rotateStageMessageIndex += 1;
      renderVideoStudio();
    }, 2500);
  }

  async function vsApiRequest(pathname, options = {}) {
    if (!vsState.authToken) {
      throw new Error('Authentication required');
    }

    const response = await sendMessageWithTimeout({
      action: 'vsApiRequest',
      pathname,
      options: {
        method: options.method,
        headers: options.headers,
        body: options.body,
      },
      authToken: vsState.authToken,
    }, 35000);

    if (!response?.success) {
      const error = new Error(response?.error || 'Video Studio request failed');
      error.status = response?.status || null;
      error.code = response?.code || null;
      throw error;
    }

    return response.payload;
  }

  function bumpVsPollRequestVersion() {
    vsState.pollRequestVersion += 1;
    return vsState.pollRequestVersion;
  }

  function isVsRequestStale(requestVersion) {
    return Number.isFinite(Number(requestVersion))
      && Number(requestVersion) !== Number(vsState.pollRequestVersion);
  }

  function getVsPollTargetSignature() {
    const projectId = vsState.project?.id || null;
    const projectStatus = String(vsState.project?.status || '').toLowerCase();
    const jobId = vsState.latestJob?.id || null;
    const jobType = getVsLatestJobType() || null;
    return `${projectId || 'none'}|${projectStatus || 'none'}|${jobId || 'none'}|${jobType || 'none'}`;
  }

  function stopVsAutoPolling(message = VS_POLL_STOPPED_MESSAGE) {
    clearVsPoll();
    vsState.pollStoppedReason = 'stopped';
    setVsStatus(message, 'error');
  }

  function shouldVsPoll() {
    if (!vsState.project || vsState.activeMutation) {
      return false;
    }

    const projectStatus = String(vsState.project.status || '').toLowerCase();
    return hasVsActiveJob() || projectStatus === 'draft_processing' || projectStatus === 'render_processing';
  }

  function applyVsProjectPayload(payload) {
    const previousSignature = getVsPollTargetSignature();
    vsState.project = payload?.project || null;
    vsState.assets = payload?.assets || [];
    vsState.latestJob = payload?.latestJob || null;
    vsState.activeJobs = payload?.activeJobs || [];
    vsState.scenes = payload?.scenes || [];
    vsState.pendingScenePreview = payload?.pendingScenePreview || null;
    vsState.recovery = payload?.recovery || null;
    vsState.verificationDebuggerEnabled = payload?.verificationDebuggerEnabled === true;
    vsState.errorMessage = null;
    syncVsReverifyResultsFromProjectPayload();
    const nextSignature = getVsPollTargetSignature();
    if (previousSignature !== nextSignature) {
      vsState.pollStartedAt = Date.now();
      vsState.pollFailureCount = 0;
      vsState.pollStoppedReason = null;
      vsState.pollTargetProjectId = vsState.project?.id || null;
      vsState.pollTargetJobType = getVsLatestJobType() || null;
      vsState.pollTargetJobId = vsState.latestJob?.id || null;
    } else if (!vsState.pollStartedAt && shouldVsPoll()) {
      vsState.pollStartedAt = Date.now();
    }
    startVsStageMessageRotation();
    renderVideoStudio();
    scheduleVsPollIfNeeded();
  }

  async function loadLatestVideoProjectForActiveProfile(options = {}) {
    const {
      requestVersion = null,
      showLoading = true,
    } = options;

    if (showLoading) {
      vsState.loading = true;
      renderVideoStudio();
    }

    try {
      vsState.authToken = await getVsAuthToken();
      vsState.activeProfile = await getVideoProfileContextPayload();
      if (isVsRequestStale(requestVersion)) {
        return;
      }

      if (!vsState.authToken || !vsState.activeProfile?.profileUrl) {
        clearVsPoll();
        clearVsRuntimeState();
        vsState.authToken = await getVsAuthToken();
        vsState.activeProfile = await getVideoProfileContextPayload();
        if (isVsRequestStale(requestVersion)) {
          return;
        }
        renderVideoStudio();
        return;
      }

      const payload = await vsApiRequest(`/api/video/projects/latest?profileUrl=${encodeURIComponent(vsState.activeProfile.profileUrl)}`);
      if (isVsRequestStale(requestVersion)) {
        return;
      }
      applyVsProjectPayload(payload);
    } finally {
      if (showLoading) {
        vsState.loading = false;
        renderVideoStudio();
      }
    }
  }

  async function reloadCurrentVideoProject(options = {}) {
    const {
      requestVersion = null,
      showLoading = true,
    } = options;

    if (showLoading) {
      vsState.loading = true;
      renderVideoStudio();
    }

    try {
      vsState.authToken = await getVsAuthToken();
      vsState.activeProfile = await getVideoProfileContextPayload();
      if (isVsRequestStale(requestVersion)) {
        return;
      }

      if (!vsState.authToken || !vsState.activeProfile?.profileUrl) {
        clearVsPoll();
        clearVsRuntimeState();
        vsState.authToken = await getVsAuthToken();
        vsState.activeProfile = await getVideoProfileContextPayload();
        if (isVsRequestStale(requestVersion)) {
          return;
        }
        renderVideoStudio();
        return;
      }

      if (!vsState.project?.id) {
        await loadLatestVideoProjectForActiveProfile({ requestVersion, showLoading });
        return;
      }

      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}`);
      if (isVsRequestStale(requestVersion)) {
        return;
      }
      applyVsProjectPayload(payload);
    } finally {
      if (showLoading) {
        vsState.loading = false;
        renderVideoStudio();
      }
    }
  }

  async function runVsPollTick(requestVersionSnapshot, intervalMs) {
    if (isVsRequestStale(requestVersionSnapshot)) {
      return;
    }

    try {
      await reloadCurrentVideoProject({
        requestVersion: requestVersionSnapshot,
        showLoading: false,
      });
      if (isVsRequestStale(requestVersionSnapshot)) {
        return;
      }
      vsState.pollFailureCount = 0;
      vsState.pollStoppedReason = null;
    } catch (error) {
      if (isVsRequestStale(requestVersionSnapshot)) {
        return;
      }
      if (error?.status === 401) {
        clearVsPoll();
        vsState.authToken = null;
        clearVsRuntimeState();
        renderVideoStudio();
        return;
      }

      vsState.pollFailureCount += 1;
      if (vsState.pollFailureCount >= VIDEO_POLL_MAX_FAILURES) {
        stopVsAutoPolling(VS_POLL_STOPPED_MESSAGE);
        return;
      }

      const retryDelayMs = resolveVideoPollRetryDelayMs(error, vsState.pollFailureCount, intervalMs);
      scheduleVsPollIfNeeded(retryDelayMs);
      return;
    }

    scheduleVsPollIfNeeded();
  }

  function scheduleVsPollIfNeeded(delayOverrideMs = null) {
    clearVsPoll();
    if (!shouldVsPoll()) {
      return;
    }

    const signature = getVsPollTargetSignature();
    if (
      vsState.pollTargetProjectId !== (vsState.project?.id || null)
      || vsState.pollTargetJobType !== (getVsLatestJobType() || null)
      || vsState.pollTargetJobId !== (vsState.latestJob?.id || null)
    ) {
      vsState.pollStartedAt = Date.now();
      vsState.pollFailureCount = 0;
      vsState.pollStoppedReason = null;
      vsState.pollTargetProjectId = vsState.project?.id || null;
      vsState.pollTargetJobType = getVsLatestJobType() || null;
      vsState.pollTargetJobId = vsState.latestJob?.id || null;
    } else if (!vsState.pollStartedAt && signature) {
      vsState.pollStartedAt = Date.now();
    }

    if (vsState.pollStartedAt && (Date.now() - vsState.pollStartedAt) > VIDEO_POLL_PHASE_TIMEOUT_MS) {
      stopVsAutoPolling(VS_POLL_STOPPED_MESSAGE);
      return;
    }

    const intervalMs = Number.isFinite(Number(delayOverrideMs))
      ? Math.max(1000, Number(delayOverrideMs))
      : ((VS_RENDER_JOB_TYPES.has(getVsLatestJobType()) || getVsLatestJobType() === 'scene_preview') ? 3000 : 2000);
    const requestVersionSnapshot = vsState.pollRequestVersion;
    vsState.pollTimer = setTimeout(() => {
      runVsPollTick(requestVersionSnapshot, intervalMs).catch((error) => {
        setVsStatus(getFriendlyApiErrorMessage(error, { context: 'generation' }), 'error');
      });
    }, intervalMs);
  }

  async function withVsMutation(task, successMessage = null) {
    const mutationVersion = bumpVsPollRequestVersion();
    clearVsPoll();
    vsState.activeMutation = true;
    renderVideoStudio();
    try {
      const result = await task();
      if (isVsRequestStale(mutationVersion)) {
        return result;
      }
      if (successMessage) {
        setVsStatus(successMessage, 'success');
      }
      return result;
    } catch (error) {
      if (isVsRequestStale(mutationVersion)) {
        throw error;
      }
      if (error?.status === 401) {
        clearVsPoll();
        vsState.authToken = null;
      }
      setVsStatus(getFriendlyApiErrorMessage(error, { context: 'generation' }), 'error');
      throw error;
    } finally {
      vsState.activeMutation = false;
      renderVideoStudio();
      if (!isVsRequestStale(mutationVersion)) {
        scheduleVsPollIfNeeded();
      }
    }
  }

  async function handleVsAssetRegeneration(assetId, promptText, regenerateDependents = false) {
    vsState.pendingRegenAssetIds.add(assetId);
    renderVideoStudio();
    try {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/assets/${assetId}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ promptText, regenerateDependents }),
      });
      delete vsState.assetPromptDrafts[assetId];
      delete vsState.assetRegenerateDependentsDrafts[assetId];
      if (vsState.openAssetEditorId === assetId) {
        vsState.openAssetEditorId = null;
      }
      applyVsProjectPayload(payload);
      setVsStatus('Regenerating image…', 'success');
    } catch (error) {
      if (error?.status === 401) {
        vsState.authToken = null;
      }
      setVsStatus(getFriendlyApiErrorMessage(error, { context: 'generation' }), 'error');
    } finally {
      vsState.pendingRegenAssetIds.delete(assetId);
      renderVideoStudio();
      scheduleVsPollIfNeeded();
    }
  }

  async function createVsProjectFromActiveProfile() {
    await withVsMutation(async () => {
      const payload = await vsApiRequest('/api/video/projects', {
        method: 'POST',
        body: JSON.stringify({ profile: vsState.activeProfile }),
      });
      applyVsProjectPayload(payload);
    }, 'Generating preview images…');
  }

  async function retryVsFullVideoRender({ successMessage = 'Re-rendering video…' } = {}) {
    await withVsMutation(async () => {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/regenerate-video`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      applyVsProjectPayload(payload);
    }, successMessage);
  }

  async function retryVsFailedRender({ successMessage = 'Retrying video render…' } = {}) {
    await withVsMutation(async () => {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/retry-render`, {
        method: 'POST',
      });
      applyVsProjectPayload(payload);
    }, successMessage);
  }

  async function assembleVsRecoveredVideo({ successMessage = 'Generating video from saved scenes…' } = {}) {
    await withVsMutation(async () => {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/assemble-video`, {
        method: 'POST',
      });
      applyVsProjectPayload(payload);
    }, successMessage);
  }

  async function resetVsProjectToReview() {
    await withVsMutation(async () => {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/reset-to-review`, {
        method: 'POST',
      });
      applyVsProjectPayload(payload);
    }, 'Returning to image review…');
  }

  async function cancelVideoProject() {
    await withVsMutation(async () => {
      const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/cancel`, {
        method: 'POST',
      });
      applyVsProjectPayload(payload);
    }, 'Video job cancelled.');
  }

  async function handleVsAction(action, target) {
    if (hasVsOptimisticTimingInFlight() && action !== 'apply-manual-timing' && action !== 'manual-timing-jump') {
      setVsStatus('Please wait. We are still finalizing a timing save.', 'error');
      return;
    }

    if (action === 'manual-timing-use-playhead') {
      const manualReviewKey = target.dataset.manualReviewKey;
      const cueId = target.dataset.cueId;
      const video = getVsVideoElementByRole(target.dataset.videoRole);
      if (!manualReviewKey || !cueId || !video) {
        setVsStatus('Could not read the preview playhead time.', 'error');
        return;
      }
      setVsManualTimingDraft(manualReviewKey, cueId, Math.max(0, Number(video.currentTime) || 0));
      renderVideoStudio();
      return;
    }

    if (action === 'manual-timing-jump') {
      const manualReviewKey = target.dataset.manualReviewKey;
      const cueId = target.dataset.cueId;
      const video = getVsVideoElementByRole(target.dataset.videoRole);
      const seconds = Number(vsState.manualTimingDraftsByKey?.[manualReviewKey]?.[cueId]);
      if (!video || !Number.isFinite(seconds) || seconds < 0) {
        setVsStatus('Enter a valid cue time before jumping.', 'error');
        return;
      }
      video.currentTime = seconds;
      video.play().catch(() => {});
      return;
    }

    if (action === 'manual-timing-nudge') {
      const manualReviewKey = target.dataset.manualReviewKey;
      const cueId = target.dataset.cueId;
      const delta = Number(target.dataset.delta);
      if (!manualReviewKey || !cueId || !Number.isFinite(delta)) {
        return;
      }
      const current = Number(vsState.manualTimingDraftsByKey?.[manualReviewKey]?.[cueId] || 0);
      setVsManualTimingDraft(manualReviewKey, cueId, Math.max(0, current + delta));
      renderVideoStudio();
      return;
    }

    if (action === 'apply-manual-timing') {
      const context = getVsManualReviewActionContextFromTarget(target);
      if (!ensureVsManualReviewActionContext(context)) {
        return;
      }
      const sceneId = context.sceneId;
      const jobId = context.jobId;
      const source = context.source;
      const manualReviewKey = target.dataset.manualReviewKey || context.manualReviewKey;
      const projectId = context.projectId;
      const scene = (vsState.scenes || []).find((candidate) => candidate.sceneId === sceneId);
      const manualReview = source === 'preview_job'
        ? vsState.pendingScenePreview?.manualReview
        : scene?.manualReview;
      const requiredCues = getVsRequiredManualTimingCues(manualReview);
      const cueMarks = requiredCues.map((cue) => ({
        cueId: cue.cueId,
        timeSec: Number(vsState.manualTimingDraftsByKey?.[manualReviewKey]?.[cue.cueId]),
      })).filter((mark) => Number.isFinite(mark.timeSec) && mark.timeSec >= 0);

      if (cueMarks.length !== requiredCues.length) {
        setVsStatus('Please fill all required cue times first.', 'error');
        return;
      }

      if (hasVsOptimisticTimingInFlight()) {
        setVsStatus('Please wait. A timing save is already in progress.', 'error');
        return;
      }

      const snapshot = buildVsOptimisticSnapshot();
      vsState.applyingManualTimingKey = manualReviewKey;
      vsState.optimisticTimingByKey[manualReviewKey] = {
        snapshot,
        cueMarks: cueMarks.map((mark) => ({ ...mark })),
        startedAt: Date.now(),
      };
      applyVsOptimisticManualTimingCommit(context);
      setVsStatus('Saved. Finalizing timing...', 'success');
      renderVideoStudio();
      try {
        const payload = await vsApiRequest(`/api/video/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/manual-review/apply-manual-timing`, {
          method: 'POST',
          body: JSON.stringify({
            jobId,
            source,
            cueMarks: cueMarks.map((mark) => ({
              ...mark,
              inputMethod: 'typed_seconds',
            })),
          }),
        });
        delete vsState.optimisticTimingByKey[manualReviewKey];
        applyVsProjectPayload(payload);
        setVsStatus('Timing saved.', 'success');
      } catch (error) {
        const entry = vsState.optimisticTimingByKey[manualReviewKey];
        restoreVsOptimisticSnapshot(entry?.snapshot || snapshot);
        cueMarks.forEach((mark) => {
          setVsManualTimingDraft(manualReviewKey, mark.cueId, mark.timeSec);
        });
        delete vsState.optimisticTimingByKey[manualReviewKey];
        setVsStatus('Timing could not be saved. Your values were restored.', 'error');
        renderVideoStudio();
      } finally {
        vsState.applyingManualTimingKey = null;
        renderVideoStudio();
      }
      return;
    }

    if (action === 'generate-project') {
      await createVsProjectFromActiveProfile();
      return;
    }

    if (action === 'approve-project') {
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/approve`, {
          method: 'POST',
        });
        applyVsProjectPayload(payload);
      }, 'Starting video generation…');
      return;
    }

    if (action === 'toggle-asset-editor') {
      const assetId = target.dataset.assetId;
      const previousAssetId = vsState.openAssetEditorId;
      vsState.openAssetEditorId = previousAssetId === assetId ? null : assetId;
      renderVideoStudio();
      return;
    }

    if (action === 'submit-asset-regeneration') {
      const assetId = target.dataset.assetId;
      const card = target.closest('.vs-asset-card');
      const promptText = card?.querySelector('textarea[name="promptText"]')?.value || '';
      const regenerateDependents = Boolean(card?.querySelector('.vs-regen-dependents-toggle')?.checked);
      await handleVsAssetRegeneration(assetId, promptText, regenerateDependents);
      return;
    }

    if (action === 'toggle-image-editor') {
      vsState.imageEditorOpen = !vsState.imageEditorOpen;
      renderVideoStudio();
      return;
    }

    if (action === 'revert-asset') {
      const assetId = target.dataset.assetId;
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/assets/${assetId}/revert`, {
          method: 'POST',
        });
        applyVsProjectPayload(payload);
      }, 'Reverted image to previous version.');
      return;
    }

    if (action === 'rerender-video') {
      await retryVsFullVideoRender();
      return;
    }

    if (action === 'share-video') {
      const projectId = vsState.project?.id;
      if (!projectId) {
        setVsStatus('Video is not ready to share yet.', 'error');
        return;
      }

      const shareUrl = `${WEB_APP_URL}/share/video/${encodeURIComponent(projectId)}`;
      window.open(shareUrl, '_blank');
      trackEvent('video_shared', {
        project_id: projectId,
      });
      return;
    }

    if (action === 'copy-video-link') {
      const projectId = vsState.project?.id;
      if (!projectId) {
        setVsStatus('Video is not ready to share yet.', 'error');
        return;
      }

      const shareUrl = `${WEB_APP_URL}/v/${encodeURIComponent(projectId)}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        setVsStatus('Link copied!', 'success');
        trackEvent('video_link_copied', {
          project_id: projectId,
          copy_success: true,
          fallback_opened: false,
        });
      } catch (_error) {
        window.open(shareUrl, '_blank');
        setVsStatus('Could not copy. Opened share page instead.', 'error');
        trackEvent('video_link_copied', {
          project_id: projectId,
          copy_success: false,
          fallback_opened: true,
        });
      }
      return;
    }

    if (action === 'insert-video-to-chat') {
      if (vsState.insertingVideo) {
        return;
      }

      const projectId = vsState.project?.id || null;
      const finalVideoUrl = vsState.project?.finalVideoUrl || null;
      const videoBlobUrl = getVsVideoBlobUrl(finalVideoUrl);
      if (!projectId || !finalVideoUrl) {
        setVsStatus('Video is not ready to share yet.', 'error');
        return;
      }
      if (!videoBlobUrl) {
        setVsStatus('Preparing video for insert. Try again in a moment.', 'error');
        return;
      }

      vsState.insertingVideo = true;
      setVsStatus('Inserting video...', 'success');
      try {
        const insertResult = await autoAttachVideo({
          projectId,
          finalVideoUrl,
          videoBlobUrl,
        });
        if (insertResult.success) {
          setVsStatus('Video attached to chat!', 'success');
        } else {
          setVsStatus(insertResult.error || 'Could not attach video to chat.', 'error');
        }
      } finally {
        vsState.insertingVideo = false;
        renderVideoStudio();
      }
      return;
    }

    if (action === 'toggle-scene-editor') {
      const sceneId = target.dataset.sceneId;
      const previousSceneId = vsState.openSceneEditorId;
      vsState.openSceneEditorId = previousSceneId === sceneId ? null : sceneId;
      renderVideoStudio();
      return;
    }

    if (action === 'apply-scene-preview') {
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/scenes/${encodeURIComponent(target.dataset.sceneId)}/apply-preview`, {
          method: 'POST',
          body: JSON.stringify({ jobId: target.dataset.jobId }),
        });
        applyVsProjectPayload(payload);
      }, 'Applying scene preview…');
      return;
    }

    if (action === 'discard-scene-preview') {
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/scenes/${encodeURIComponent(target.dataset.sceneId)}/discard-preview`, {
          method: 'POST',
          body: JSON.stringify({ jobId: target.dataset.jobId }),
        });
        applyVsProjectPayload(payload);
      }, 'Scene preview discarded.');
      return;
    }

    if (action === 'approve-scene-manual-review') {
      const context = getVsManualReviewActionContextFromTarget(target);
      if (!ensureVsManualReviewActionContext(context)) {
        return;
      }
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${context.projectId}/scenes/${encodeURIComponent(context.sceneId)}/manual-review/approve`, {
          method: 'POST',
          body: JSON.stringify({ jobId: context.jobId }),
        });
        applyVsProjectPayload(payload);
      }, 'Saving approved clip…');
      return;
    }

    if (action === 'reject-scene-manual-review') {
      const context = getVsManualReviewActionContextFromTarget(target);
      if (!ensureVsManualReviewActionContext(context)) {
        return;
      }
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${context.projectId}/scenes/${encodeURIComponent(context.sceneId)}/manual-review/reject`, {
          method: 'POST',
          body: JSON.stringify({ jobId: context.jobId }),
        });
        vsState.openSceneEditorId = context.sceneId || null;
        applyVsProjectPayload(payload);
      }, 'Clip rejected. Redo this scene when ready.');
      return;
    }

    if (action === 'reverify-scene-manual-review') {
      const context = getVsManualReviewActionContextFromTarget(target);
      if (!ensureVsManualReviewActionContext(context)) {
        return;
      }
      const manualReviewKey = target.dataset.manualReviewKey || context.manualReviewKey;

      vsState.reverifyingKey = manualReviewKey;
      setVsStatus('Running automated check again...', 'success');
      renderVideoStudio();
      try {
        const payload = await vsApiRequest(`/api/video/projects/${context.projectId}/scenes/${encodeURIComponent(context.sceneId)}/manual-review/reverify`, {
          method: 'POST',
          body: JSON.stringify({
            jobId: context.jobId,
            source: context.source,
          }),
        });
        vsState.reverifyResultsByKey[manualReviewKey] = {
          reverifyToken: payload.reverifyToken || null,
          verificationResult: payload.verificationResult || null,
          sceneId: payload.sceneId || context.sceneId,
          jobId: payload.jobId || context.jobId,
          source: getVsManualReviewSource(payload.source || context.source),
          usedAt: null,
          expiresAt: null,
        };
        setVsStatus('Automated check complete. Review details in Debug tools.', 'success');
      } catch (error) {
        setVsStatus(getVsErrorMessage(error, 'Re-verify failed.'), 'error');
      } finally {
        vsState.reverifyingKey = null;
        renderVideoStudio();
      }
      return;
    }

    if (action === 'apply-reverified-window') {
      const context = getVsManualReviewActionContextFromTarget(target);
      if (!ensureVsManualReviewActionContext(context)) {
        return;
      }
      const manualReviewKey = target.dataset.manualReviewKey || context.manualReviewKey;
      const reverifyEntry = vsState.reverifyResultsByKey[manualReviewKey];
      if (!reverifyEntry?.reverifyToken) {
        setVsStatus('Run re-verify first before applying a window.', 'error');
        return;
      }

      vsState.applyingWindowKey = manualReviewKey;
      try {
        await withVsMutation(async () => {
          const payload = await vsApiRequest(`/api/video/projects/${context.projectId}/scenes/${encodeURIComponent(context.sceneId)}/manual-review/apply-window`, {
            method: 'POST',
            body: JSON.stringify({
              jobId: context.jobId,
              source: context.source,
              reverifyToken: reverifyEntry.reverifyToken,
            }),
          });
          applyVsProjectPayload(payload);
        }, 'Applying re-verified window…');
      } finally {
        vsState.applyingWindowKey = null;
        renderVideoStudio();
      }
      return;
    }

    if (action === 'cancel-project') {
      await cancelVideoProject();
      return;
    }

    if (action === 'start-over') {
      clearVsRuntimeState();
      renderVideoStudio();
      return;
    }

    if (action === 'refresh-status') {
      const requestVersion = bumpVsPollRequestVersion();
      setVsStatus(null);
      await reloadCurrentVideoProject({ requestVersion, showLoading: true });
      return;
    }

    if (action === 'retry-generate') {
      await createVsProjectFromActiveProfile();
      return;
    }

    if (action === 'retry-render') {
      await retryVsFailedRender({ successMessage: 'Retrying video render…' });
      return;
    }

    if (action === 'assemble-video') {
      await assembleVsRecoveredVideo();
      return;
    }

    if (action === 'back-to-images') {
      await resetVsProjectToReview();
      return;
    }
  }

  async function handleVsFormSubmit(form) {
    const action = form.dataset.action;

    if (action === 'preview-scene') {
      const sceneId = form.dataset.sceneId;
      const promptText = form.querySelector('textarea[name="promptText"]')?.value || '';
      delete vsState.scenePromptDrafts[sceneId];
      await withVsMutation(async () => {
        const payload = await vsApiRequest(`/api/video/projects/${vsState.project.id}/scenes/${encodeURIComponent(sceneId)}/preview-regenerate`, {
          method: 'POST',
          body: JSON.stringify({ promptText }),
        });
        vsState.openSceneEditorId = null;
        applyVsProjectPayload(payload);
      }, 'Generating scene preview…');
    }
  }

  function positionVideoStudioSidecar() {
    if (!vsState.sidecarEl || vsState.isDragging) return;

    const sidecar = vsState.sidecarEl;
    const scWidth = sidecar.offsetWidth || 420;
    const scHeight = sidecar.offsetHeight || 360;

    if (vsState.manualPosition) {
      const maxLeft = Math.max(8, window.innerWidth - scWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - scHeight - 8);
      const left = Math.max(8, Math.min(vsState.manualPosition.left, maxLeft));
      const top = Math.max(8, Math.min(vsState.manualPosition.top, maxTop));

      vsState.manualPosition = { left, top };
      sidecar.style.left = left + 'px';
      sidecar.style.top = top + 'px';
      sidecar.style.right = 'auto';
      return;
    }

    const triggerBtn = document.getElementById('liebs-video-btn');
    if (triggerBtn && triggerBtn.isConnected) {
      vsState._triggerRef = triggerBtn;
    }

    const anchor = vsState._triggerRef || vsState._photoRef;
    const gap = 10;

    if (anchor && anchor.isConnected) {
      const rect = anchor.getBoundingClientRect();
      let top = rect.top + (rect.height / 2) - 24;
      top = Math.max(8, Math.min(top, window.innerHeight - scHeight - 8));

      let left = rect.right + gap;
      if (left + scWidth > window.innerWidth - 8) {
        left = rect.left - scWidth - gap;
      }
      if (left < 8) {
        left = Math.max(8, window.innerWidth - scWidth - 16);
      }

      sidecar.style.top = top + 'px';
      sidecar.style.left = left + 'px';
      sidecar.style.right = 'auto';
      return;
    }

    sidecar.style.top = '80px';
    sidecar.style.right = '16px';
    sidecar.style.left = 'auto';
  }

  function enableVideoStudioDragging(sidecar) {
    const header = sidecar.querySelector('.vs-header');
    if (!header) return null;

    let dragState = null;

    function onPointerDown(event) {
      if (event.button !== 0) return;
      if (event.target.closest('button, input, textarea, a')) return;

      event.preventDefault();
      const rect = sidecar.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      vsState.isDragging = true;
      sidecar.classList.add('vs-sidecar--dragging');
      if (header.setPointerCapture) {
        header.setPointerCapture(event.pointerId);
      }
    }

    function onPointerMove(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;

      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      const scWidth = sidecar.offsetWidth || 420;
      const scHeight = sidecar.offsetHeight || 360;
      const maxLeft = Math.max(8, window.innerWidth - scWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - scHeight - 8);
      const left = Math.max(8, Math.min(dragState.startLeft + dx, maxLeft));
      const top = Math.max(8, Math.min(dragState.startTop + dy, maxTop));

      vsState.manualPosition = { left, top };
      vsState.manualPositionPath = window.location.pathname;
      sidecar.style.left = left + 'px';
      sidecar.style.top = top + 'px';
      sidecar.style.right = 'auto';
    }

    function stopDragging(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      if (header.releasePointerCapture) {
        header.releasePointerCapture(event.pointerId);
      }
      dragState = null;
      vsState.isDragging = false;
      sidecar.classList.remove('vs-sidecar--dragging');
      persistVideoSidecarPosition();
    }

    header.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    return () => {
      header.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      vsState.isDragging = false;
      sidecar.classList.remove('vs-sidecar--dragging');
    };
  }

  function showVideoStudioSidecar() {
    if (!vsState.sidecarEl) return;
    if (vsState.panelHideTimeout) {
      clearTimeout(vsState.panelHideTimeout);
      vsState.panelHideTimeout = null;
    }
    vsState.sidecarEl.style.display = 'flex';
    positionVideoStudioSidecar();
    void vsState.sidecarEl.offsetHeight;
    vsState.sidecarEl.classList.add('vs-visible');
    vsState.hidden = false;
    setVideoTriggerButtonExpanded(!vsState.minimized);
    setVideoTriggerButtonVisible(vsState.minimized);
  }

  function destroyVideoStudioSidecar() {
    clearVsPoll();
    clearVsStageMessageRotation();
    if (vsState.panelHideTimeout) {
      clearTimeout(vsState.panelHideTimeout);
      vsState.panelHideTimeout = null;
    }
    if (vsState._dragCleanup) {
      vsState._dragCleanup();
      vsState._dragCleanup = null;
    }
    if (vsState.sidecarEl) {
      vsState.sidecarEl.remove();
    }
    vsState.sidecarEl = null;
    vsState.contentEl = null;
    vsState.footerEl = null;
    vsState.progressRailEl = null;
    vsState.refreshBtnEl = null;
    vsState.minimizeBtnEl = null;
    vsState.closeBtnEl = null;
    vsState.hidden = true;
    vsState.minimized = false;
    setVideoTriggerButtonExpanded(false);
    setVideoTriggerButtonVisible(true);
  }

  function minimizeVideoStudioSidecar() {
    vsState.minimized = true;
    renderVideoStudio();
    setVideoTriggerButtonExpanded(false);
    setVideoTriggerButtonVisible(true);
    positionVideoTriggerButtonAfterSidecarCollapse(vsState);
  }

  function expandVideoStudioSidecar() {
    vsState.minimized = false;
    renderVideoStudio();
    showVideoStudioSidecar();
  }

  async function handleVideoStudioClose() {
    if (hasVsOptimisticTimingInFlight()) {
      const confirmedPendingSave = window.confirm('A timing save is still finalizing. Close anyway?');
      if (!confirmedPendingSave) {
        return;
      }
    }
    if (hasVsActiveJob() && vsState.project?.id) {
      const confirmed = window.confirm('Cancel the current video job and close Video Studio?');
      if (!confirmed) {
        return;
      }
      await cancelVideoProject();
    }
    destroyVideoStudioSidecar();
  }

  function createVideoStudioSidecar() {
    if (vsState.sidecarEl) {
      return;
    }

    const sidecar = document.createElement('div');
    sidecar.id = VS_SIDECAR_ID;
    sidecar.className = 'vs-sidecar';
    sidecar.innerHTML = `
      <div class="vs-header">
        <span class="vs-title">Video Studio</span>
        <div class="vs-header-controls">
          <button class="vs-btn-icon" id="vs-refresh" title="Refresh" aria-label="Refresh">↻</button>
          <button class="vs-btn-icon" id="vs-minimize" title="Minimize" aria-label="Minimize">—</button>
          <button class="vs-btn-icon" id="vs-close" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="vs-progress-rail" id="vs-progress-rail"></div>
      <div class="vs-content" id="vs-content"></div>
      <div class="vs-footer" id="vs-footer"></div>
    `;

    document.body.appendChild(sidecar);
    vsState.sidecarEl = sidecar;
    vsState.contentEl = sidecar.querySelector('#vs-content');
    vsState.footerEl = sidecar.querySelector('#vs-footer');
    vsState.progressRailEl = sidecar.querySelector('#vs-progress-rail');
    vsState.refreshBtnEl = sidecar.querySelector('#vs-refresh');
    vsState.minimizeBtnEl = sidecar.querySelector('#vs-minimize');
    vsState.closeBtnEl = sidecar.querySelector('#vs-close');

    vsState.refreshBtnEl.addEventListener('click', () => {
      const requestVersion = bumpVsPollRequestVersion();
      setVsStatus(null);
      reloadCurrentVideoProject({ requestVersion, showLoading: true }).catch((error) => {
        setVsStatus(getFriendlyApiErrorMessage(error, { context: 'generation' }), 'error');
      });
    });
    vsState.minimizeBtnEl.addEventListener('click', () => {
      if (vsState.minimized) {
        expandVideoStudioSidecar();
      } else {
        minimizeVideoStudioSidecar();
      }
    });
    vsState.closeBtnEl.addEventListener('click', () => {
      handleVideoStudioClose().catch((error) => {
        setVsStatus(getFriendlyApiErrorMessage(error, { context: 'generation' }), 'error');
      });
    });

    sidecar.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) {
        return;
      }
      handleVsAction(actionEl.dataset.action, actionEl).catch(() => {});
    });

    sidecar.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-action]');
      if (!form) {
        return;
      }
      event.preventDefault();
      handleVsFormSubmit(form).catch(() => {});
    });
    vsState.contentEl.addEventListener('input', (event) => {
      const manualTimingInput = event.target.closest('.vs-manual-timing-input');
      if (manualTimingInput) {
        const manualReviewKey = manualTimingInput.dataset.manualReviewKey;
        const cueId = manualTimingInput.dataset.cueId;
        const value = Number(manualTimingInput.value);
        if (manualReviewKey && cueId) {
          setVsManualTimingDraft(
            manualReviewKey,
            cueId,
            Number.isFinite(value) && value >= 0 ? value : null
          );
          renderVideoStudio();
        }
        return;
      }

      const textarea = event.target.closest('.vs-regen-textarea');
      if (!textarea) return;

      const draftType = textarea.dataset.draftType;
      if (draftType === 'asset') {
        const assetId = textarea.dataset.assetId;
        if (!assetId) return;
        vsState.assetPromptDrafts[assetId] = textarea.value;
        return;
      }

      if (draftType === 'scene') {
        const sceneId = textarea.dataset.sceneId;
        if (!sceneId) return;
        vsState.scenePromptDrafts[sceneId] = textarea.value;
      }
    });

    vsState.contentEl.addEventListener('change', (event) => {
      const checkbox = event.target.closest('.vs-regen-dependents-toggle');
      if (!checkbox) return;
      const assetId = checkbox.dataset.assetId;
      if (!assetId) return;
      vsState.assetRegenerateDependentsDrafts[assetId] = Boolean(checkbox.checked);
    });

    vsState._dragCleanup = enableVideoStudioDragging(sidecar);
    vsState._triggerRef = document.getElementById('liebs-video-btn');
    const photoImg = findProfilePhotoImg();
    vsState._photoRef = photoImg || null;
    vsState._cardRef = photoImg ? findCardContainer(photoImg) : null;
    renderVideoStudio();
  }

  function buildVideoButtonElement() {
    const button = document.createElement('button');
    button.id = 'liebs-video-btn';
    button.className = 'liebs-video-btn';
    button.type = 'button';
    button.innerHTML = '<span aria-hidden="true">🎬</span>';
    button.title = 'Open Video Studio';
    button.setAttribute('aria-controls', VS_SIDECAR_ID);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => {
      openVideoStudioSidecar().catch((error) => {
        showNotification(error?.message || 'Could not open Video Studio', 'error');
      });
    });
    return button;
  }

  function createVideoButton() {
    if (isSalesNavigatorPath() || !window.location.pathname.startsWith('/in/')) return;

    const existing = document.getElementById('liebs-video-btn');
    if (existing) existing.remove();
    const existingWrapper = document.getElementById('liebs-video-btn-wrapper');
    if (existingWrapper) existingWrapper.remove();

    const button = buildVideoButtonElement();
    const placed = typeof placeFloatingProfileButton === 'function'
      ? placeFloatingProfileButton(button, vsState, {
        wrapperId: 'liebs-video-btn-wrapper',
        anchoredClassName: 'liebs-video-btn--anchored',
        horizontalOffset: 36,
      })
      : false;

    if (!placed) {
      vsState._photoRef = null;
      vsState._cardRef = null;
      button.classList.add('liebs-video-btn--floating');
      document.body.appendChild(button);

      waitForElement(() => findProfilePhotoImg(), 8000, 500)
        .then(() => {
          const currentBtn = document.getElementById('liebs-video-btn');
          if (currentBtn && currentBtn.classList.contains('liebs-video-btn--floating')) {
            createVideoButton();
          }
        })
        .catch(() => {
          debugLog('createVideoButton', 'Profile photo never appeared, keeping floating button');
        });
    }

    vsState._triggerRef = button;
    if (vsState.sidecarEl && !vsState.hidden) {
      positionVideoStudioSidecar();
    }
  }

  async function openVideoStudioSidecar({ forceRefresh = false } = {}) {
    if (!window.location.pathname.startsWith('/in/')) {
      throw new Error('Open a LinkedIn profile to use the video studio.');
    }

    if (vsState.minimized) {
      expandVideoStudioSidecar();
    }

    createVideoStudioSidecar();
    showVideoStudioSidecar();

    const currentProfile = await getVideoProfileContextPayload();
    const shouldRefresh =
      forceRefresh
      || !vsState.activeProfile
      || !vsState.project
      || currentProfile?.profileUrl !== vsState.activeProfile?.profileUrl;

    if (shouldRefresh) {
      const requestVersion = bumpVsPollRequestVersion();
      await loadLatestVideoProjectForActiveProfile({ requestVersion, showLoading: true });
    } else {
      renderVideoStudio();
    }
  }

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'getProfileData') {
      sendResponse(extractProfileData());
      return false;
    }

    if (message.action === 'getVideoProfileContext') {
      (async () => {
        try {
          sendResponse(await getVideoProfileContextPayload());
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || 'Failed to read profile context',
          });
        }
      })();
      return true;
    }

    if (message.action === 'focusVideoFlow') {
      (async () => {
        try {
          if (!window.location.pathname.startsWith('/in/')) {
            sendResponse({
              success: false,
              error: 'Open a LinkedIn profile to use the video studio.',
            });
            return;
          }

          createVideoButton();
          await openVideoStudioSidecar({ forceRefresh: true });
          showNotification('Video Studio is ready on the page', 'success');
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || 'Could not focus the video studio.',
          });
        }
      })();
      return true;
    }

    if (message.action === 'focusGifFlow') {
      try {
        if (window.location.pathname.startsWith('/in/')) {
          createLiebsButton();
          const trigger = document.getElementById('liebs-gif-btn');
          if (trigger) {
            trigger.classList.add('success');
            setTimeout(() => trigger.classList.remove('success'), 1200);
          }
          showNotification('Use the GIF button on the page ✨', 'success');
          sendResponse({ success: true });
          return false;
        }

        sendResponse({
          success: false,
          error: 'Open a LinkedIn profile to use the GIF flow.',
        });
        return false;
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || 'Could not focus the GIF flow.',
        });
        return false;
      }
    }

    if (message.action === 'authStateChanged') {
      isAuthenticated = Boolean(message.authenticated);
      if (!isAuthenticated) {
        userCredits = null;
        vsState.authToken = null;
      } else {
        getVsAuthToken()
          .then((token) => {
            vsState.authToken = token;
            if (vsState.sidecarEl) {
              renderVideoStudio();
            }
          })
          .catch(() => {});
      }
      // Only recreate button when idle — during generation, createLiebsButton
      // would destroy and recreate the sidecar, causing it to disappear.
      if (gmState.current === GM_STATES.Idle) {
        createLiebsButton();
      }
      createVideoButton();
      if (vsState.sidecarEl) {
        renderVideoStudio();
      }
      return false;
    }

    if (message.action === 'creditsUpdate') {
      userCredits = message.credits;
      // Only recreate button when idle — during generation, createLiebsButton
      // would destroy and recreate the sidecar, causing it to disappear.
      if (gmState.current === GM_STATES.Idle) {
        createLiebsButton();
      }
      return false;
    }

    if (message.action === 'generationUpdate') {
      const messageJobId = message.jobId || null;
      if (messageJobId) {
        gmState.jobId = messageJobId;
      }

      const messageGenerationId = message.generationId || message.generation_id || null;
      if (messageGenerationId) {
        gmState.generationId = messageGenerationId;
      }

      const previousPipelineStage = gmState.currentPipelineStage;
      let stageChanged = false;
      if (message.stage) {
        gmState.currentPipelineStage = message.stage;
        stageChanged = message.stage !== previousPipelineStage;
        if (stageChanged && !gmState.stageTimeHints[message.stage]) {
          gmState.activeStageTimeHint = null;
          if (gmState.current === GM_STATES.AnimatePending || gmState.current === GM_STATES.ComposePending) {
            setAnimateTimeHint(null);
          }
        }
      }
      if (message.stage && message.timeHint) {
        gmState.stageTimeHints[message.stage] = message.timeHint;
      }

      // Show silhouette in thumbnail when available from backend
      const messageSilhouetteUrl = extractSilhouetteUrl(message);
      if (messageSilhouetteUrl) {
        applySilhouetteUrl(messageSilhouetteUrl);
        // If we're in a state where the stylised thumb should show, trigger it
        if (isStylisedThumbState()) {
          showStylisedThumb();
        }
      }

      const messageLiebsImageUrl = extractLiebsImageUrl(message);
      if (messageLiebsImageUrl && messageLiebsImageUrl !== gmState.liebsImageUrl) {
        gmState.liebsImageUrl = messageLiebsImageUrl;
      }
      if (messageLiebsImageUrl) {
        maybeRevealLiebsPreview();
      }
      maybeAdvanceFromSnapStage();
      maybeAdvanceFromGlowUpStage();

      const messageGifUrl = message.gifUrl || message.gif_url || null;
      if (messageGifUrl) {
        gmState.gifUrl = messageGifUrl;
        gmState.backendDone = true;

        if (gmState.current === GM_STATES.AnimatePending || gmState.current === GM_STATES.ComposePending) {
          gmTransition(GM_STATES.DeliverReady);
        } else if (
          gmState.current === GM_STATES.DeliverReady ||
          gmState.current === GM_STATES.DeliverSuccess ||
          gmState.current === GM_STATES.ErrorDeliver
        ) {
          showGifThumb(messageGifUrl);
        }
      }
      maybeAdvanceFromSnapStage();
      maybeAdvanceFromGlowUpStage();

      // Transition to ComposePending when backend starts the text overlay step.
      if (message.currentStep === 'compose' && gmState.current === GM_STATES.AnimatePending) {
        gmTransition(GM_STATES.ComposePending);
      }

      const messageStatus = typeof message.status === 'string' ? message.status.toLowerCase() : '';
      const textWindowOpen = (
        message.currentStep !== 'compose' &&
        !['completed', 'failed', 'cancelled', 'error'].includes(messageStatus)
      );
      if (!textWindowOpen) {
        gmState.textLocked = true;
        gmState.textSyncPending = false;
      } else if (gmState.textSyncPending && gmState.jobId && !gmState.textSyncInFlight && !gmState.textLocked) {
        syncSidecarTextToActiveJob().catch((err) => {
          debugWarn('textSync', 'Failed to sync pending text from generationUpdate:', err.message);
        });
      }

      // Update sub-stage text while animation/composition is in progress.
      if (
        message.substage &&
        (gmState.current === GM_STATES.AnimatePending || gmState.current === GM_STATES.ComposePending)
      ) {
        updateAnimateStatusText(message.substage, { force: stageChanged });
      }
      if (
        message.substage &&
        (
          gmState.current === GM_STATES.Bootstrapping ||
          gmState.current === GM_STATES.StylisePending ||
          gmState.current === GM_STATES.PreviewReady
        )
      ) {
        updateInlineStatusText(message.substage);
      }
      if (gmState.current === GM_STATES.AnimatePending || gmState.current === GM_STATES.ComposePending) {
        maybeShowStageTimeHint(gmState.currentPipelineStage);
      }

      // Show slow-step warning banner when backend signals a stage delay.
      if (message.stageDelayed && gmState.current === GM_STATES.AnimatePending) {
        showStageWarningBanner();
      }
      return false;
    }

    if (message.action === 'outreachModeUpdate') {
      if (message.outreachMode) {
        scheduleOutreachPreProcess(2000);
      } else if (outreachPreProcessDebounceTimer) {
        clearTimeout(outreachPreProcessDebounceTimer);
        outreachPreProcessDebounceTimer = null;
      }
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'runDiagnostics') {
      LIEBS_DEBUG = true;
      chrome.storage.sync.set({ liebsDebug: true });
      const diag = window.__liebsDiag();
      sendResponse({ success: true, debug: diag });
      return false;
    }

    if (message.action === 'insertGifToMessage') {
      (async () => {
        try {
          const { gifUrl, firstName, lastName } = message;
          if (!gifUrl) {
            sendResponse({ success: false, error: 'No GIF URL provided' });
            return;
          }

          const deliveryResult = await autoAttachGif({
            gifUrl,
            firstName: firstName || 'gif',
            lastName: lastName || null,
            profileSlug: window.location.pathname,
          });

          if (deliveryResult.success) {
            sendResponse({
              success: true,
              method: deliveryResult.method || 'unknown',
              error: deliveryResult.error || null,
            });
            return;
          }

          sendResponse({
            success: false,
            error: deliveryResult.error || 'Could not open chat delivery',
          });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    }

    return false;
  });

  // ============================================================
  // INIT
  // ============================================================

  function init() {
    loadSavedSidecarPosition();
    loadSavedVideoSidecarPosition();

    // Only show button on profile pages
    if (window.location.pathname.startsWith('/in/')) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          createLiebsButton();
          createVideoButton();
        });
      } else {
        createLiebsButton();
        createVideoButton();
      }
    }

    checkAndHandleLiebsInsertHash();

    function cancelScheduledObserverCheck() {
      if (observerCheckHandle === null) return;

      if (observerCheckMode === 'idle' && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(observerCheckHandle);
      } else {
        clearTimeout(observerCheckHandle);
      }

      observerCheckHandle = null;
      observerCheckMode = null;
    }

    function reconnectObserverIfNeeded() {
      if (!profileObserver) return;
      const nextMain = document.querySelector('main');
      if (nextMain === observedMain) return;

      observedMain = nextMain;
      profileObserver.disconnect();

      if (observedMain) {
        profileObserver.observe(observedMain, { childList: true, subtree: true });
        // Watch top-level body children only to detect main remounts.
        profileObserver.observe(document.body, { childList: true, subtree: false });
      } else {
        profileObserver.observe(document.body, { childList: true, subtree: true });
      }
    }

    function runObserverCheck() {
      observerCheckHandle = null;
      observerCheckMode = null;

      reconnectObserverIfNeeded();

      const currentPath = window.location.pathname;
      const pathChanged = currentPath !== lastKnownPath;
      if (pathChanged) {
        lastKnownPath = currentPath;
        lastAuthCheckAt = 0; // fresh auth check on new profile
      }

      if (!currentPath.startsWith('/in/')) {
        if (outreachPreProcessDebounceTimer) {
          clearTimeout(outreachPreProcessDebounceTimer);
          outreachPreProcessDebounceTimer = null;
        }
        const existingButton = document.getElementById('liebs-gif-btn');
        if (existingButton) existingButton.remove();
        const existingWrapper = document.getElementById('liebs-gif-btn-wrapper');
        if (existingWrapper) existingWrapper.remove();
        const existingVideoButton = document.getElementById('liebs-video-btn');
        if (existingVideoButton) existingVideoButton.remove();
        const existingVideoWrapper = document.getElementById('liebs-video-btn-wrapper');
        if (existingVideoWrapper) existingVideoWrapper.remove();
        unwrapNameAnchorWrapper(gmState);
        if (gmState.panelHideTimeout) {
          clearTimeout(gmState.panelHideTimeout);
          gmState.panelHideTimeout = null;
        }
        // Clean up sidecar on navigation away
        if (gmState.sidecarEl) gmState.sidecarEl.remove();
        if (gmState.announcerEl) gmState.announcerEl.remove();
        if (gmState._dragCleanup) {
          gmState._dragCleanup();
          gmState._dragCleanup = null;
        }
        clearGmTimers();
        clearVsRuntimeState();
        destroyVideoStudioSidecar();
        gmState.liebsImageUrl = null;
        gmState.generationStartedAt = 0;
        gmState.liebsPreviewRevealed = false;
        gmState.glowUpStartedAt = 0;
        gmState.current = GM_STATES.Idle;
        return;
      }

      // If we navigated to a different profile while a generation was active
      // or a completed GIF was showing, fully reset for the new profile.
      if (pathChanged && gmState.current !== GM_STATES.Idle) {
        resetForProfileChange();
      }
      if (pathChanged) {
        clearVsRuntimeState();
        destroyVideoStudioSidecar();
      }

      const hasButton = !!document.getElementById('liebs-gif-btn');
      const hasVideoButton = !!document.getElementById('liebs-video-btn');
      if (pathChanged || !hasButton) {
        createLiebsButton();
      }
      if (pathChanged || !hasVideoButton) {
        createVideoButton();
      }

      checkAndHandleLiebsInsertHash();

      if (pathChanged && pendingGenerationNotice) {
        const targetName = pendingGenerationNotice.firstName || 'that person';
        showGmToast(`GIF for ${targetName} is still cooking — check your history.`);
        pendingGenerationNotice = null;
      }

      scheduleOutreachPreProcess(2000);
    }

    function scheduleObserverCheck() {
      if (observerCheckHandle !== null) return;

      if (typeof requestIdleCallback === 'function') {
        observerCheckMode = 'idle';
        observerCheckHandle = requestIdleCallback(runObserverCheck, { timeout: 300 });
      } else {
        observerCheckMode = 'timeout';
        observerCheckHandle = setTimeout(runObserverCheck, 120);
      }
    }

    function cleanup() {
      // Don't tear down during active generation — Chrome fires pagehide
      // on tab freeze / bfcache, not just real unloads.
      if (gmState.current !== GM_STATES.Idle) return;

      if (outreachPreProcessDebounceTimer) {
        clearTimeout(outreachPreProcessDebounceTimer);
        outreachPreProcessDebounceTimer = null;
      }

      cancelScheduledObserverCheck();
      if (profileObserver) {
        profileObserver.disconnect();
        profileObserver = null;
      }
      // Clean up sidecar state
      clearGmTimers();
      if (gmState.panelHideTimeout) {
        clearTimeout(gmState.panelHideTimeout);
        gmState.panelHideTimeout = null;
      }
      if (gmState.sidecarEl) gmState.sidecarEl.remove();
      if (gmState.announcerEl) gmState.announcerEl.remove();
      if (gmState._dragCleanup) {
        gmState._dragCleanup();
        gmState._dragCleanup = null;
      }
      gmState.current = GM_STATES.Idle;
      gmState.sidecarEl = null;
      gmState.announcerEl = null;
      gmState.contentEl = null;
      gmState.filmstripEl = null;
      gmState.sweepEl = null;
      gmState.captureFlashEl = null;
      gmState.thumbStylisedEl = null;
      gmState.thumbSilhouetteEl = null;
      gmState.thumbOutlineTraceEl = null;
      gmState.thumbOutlineImgEl = null;
      gmState.thumbLiebsEl = null;
      gmState.thumbEl = null;
      gmState.thumbOriginalEl = null;
      gmState._triggerRef = null;
      gmState._cardRef = null;
      gmState._photoRef = null;
      gmState.manualPosition = null;
      gmState.manualPositionPath = null;
      gmState.isDragging = false;
      gmState.gifUrl = null;
      gmState.silhouetteUrl = null;
      gmState.liebsImageUrl = null;
      gmState.generationStartedAt = 0;
      gmState.liebsPreviewRevealed = false;
      gmState.glowUpStartedAt = 0;
      clearVsRuntimeState();
      destroyVideoStudioSidecar();
      if (gmState.liebsRevealTimeout) {
        clearTimeout(gmState.liebsRevealTimeout);
        gmState.liebsRevealTimeout = null;
      }
    }

    // Reposition sidecar on scroll/resize (throttled)
    let repositionRaf = null;
    function onScrollOrResize() {
      if (repositionRaf) return;
      repositionRaf = requestAnimationFrame(() => {
        repositionRaf = null;
        positionSidecar();
        positionVideoStudioSidecar();
      });
    }
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize, { passive: true });

    // Re-create button on SPA navigation (only show on profile pages)
    profileObserver = new MutationObserver(scheduleObserverCheck);
    reconnectObserverIfNeeded();
    window.addEventListener('popstate', scheduleObserverCheck);
    window.addEventListener('hashchange', scheduleObserverCheck);
    window.addEventListener('beforeunload', (event) => {
      if (!hasVsOptimisticTimingInFlight()) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('pagehide', cleanup);
  }

  init();
})();
