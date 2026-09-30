// Shared helpers for content scripts only.
// This file may use DOM/window APIs and should not be loaded in the background worker.

let LIEBS_DEBUG = false;

chrome.storage.sync.get(['liebsDebug'], (result) => {
  LIEBS_DEBUG = !!result.liebsDebug;
});

// Toggle debug mode from console: window.__liebsDebugToggle()
window.__liebsDebugToggle = () => {
  LIEBS_DEBUG = !LIEBS_DEBUG;
  chrome.storage.sync.set({ liebsDebug: LIEBS_DEBUG });
  console.log(`[Liebs GIF] Debug mode: ${LIEBS_DEBUG ? 'ON' : 'OFF'}`);
  return LIEBS_DEBUG;
};

// Sentry helpers for content scripts (profile.js, composer.js, content.js)
const _sentryOnceKeys = new Set();

function trackContentError(eventName, error, context = {}) {
  if (typeof captureExtensionError === 'function') {
    captureExtensionError(eventName, error, context);
  }
}

function trackContentErrorOnce(key, eventName, error, context = {}) {
  if (_sentryOnceKeys.has(key)) return;
  _sentryOnceKeys.add(key);
  trackContentError(eventName, error, context);
}

function addContentBreadcrumb(message, data = {}, level = 'info') {
  if (typeof addExtensionBreadcrumb === 'function') {
    addExtensionBreadcrumb(message, data, level);
  }
}

function debugLog(method, ...args) {
  if (LIEBS_DEBUG) {
    console.log(`[Liebs GIF][${method}]`, ...args);
  }
}

function debugWarn(method, ...args) {
  console.warn(`[Liebs GIF][${method}]`, ...args);
}

const PROFILE_PHOTO_TOP_CARD_SELECTORS = [
  '[aria-label="Profile photo"] img',
  'img.pv-top-card-profile-picture__image--show',
  'img.pv-top-card-profile-picture__image',
  'img.profile-photo-edit__preview',
  '[data-generated-suggestion-target*="profile-photo"] img',
  '.pv-top-card--photo img',
  'img.evi-image'
];

const PROFILE_PHOTO_FALLBACK_SELECTORS = [
  'img[src*="profile-displayphoto"]',
  'img[src*="profile-framedphoto"]',
  'img[class*="profile-picture"]'
];

// Selectors for LinkedIn profile elements
const SELECTORS = {
  profilePhotoTopCard: PROFILE_PHOTO_TOP_CARD_SELECTORS,
  profilePhotoFallback: PROFILE_PHOTO_FALLBACK_SELECTORS,
  profilePhoto: [
    ...PROFILE_PHOTO_TOP_CARD_SELECTORS,
    ...PROFILE_PHOTO_FALLBACK_SELECTORS,
  ],
  firstName: [
    '.pv-text-details__left-panel h1',
    '.pv-text-details__left-panel h2',
    '.pv-top-card--list h1',
    'h1.inline.t-24.v-align-middle.break-words',
    'h1[class*="text-heading"]',
    'h1.text-heading-xlarge',
    'h2[class*="text-heading"]',
    '[data-anonymize="person-name"]'
  ],
  messageButton: [
    'a[href*="messaging/compose"]',
    'button[aria-label*="Message"]',
    'a[aria-label*="Message"]',
    '.message-anywhere-button',
    '.pvs-profile-actions button[aria-label*="Message"]',
    'button.artdeco-button--primary[aria-label*="Message"]',
    '[data-control-name="message"]'
  ],
  messageComposer: [
    '.msg-form__contenteditable',
    'div[data-artdeco-is-focused]',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form__message-texteditor div[contenteditable="true"]',
    '[role="textbox"][aria-label*="message" i]',
    '.msg-form div[contenteditable="true"]'
  ],
  msgFormContainer: [
    '.msg-overlay-conversation-bubble .msg-form',
    '.msg-overlay-list-bubble .msg-form',
    '.msg-form',
  ],
  msgFormComposerArea: [
    '.msg-form__msg-content-container',
    '.msg-form__message-texteditor',
    '.msg-form__contenteditable',
  ],
  msgConversationContainer: [
    '.msg-overlay-conversation-bubble',
    '.msg-overlay-list-bubble',
    '.msg-thread',
    '.msg-s-message-list-container',
  ],
  msgConversationTitle: [
    '.msg-overlay-bubble-header__title',
    '.msg-conversation-card__participant-names',
    '.msg-thread__link-to-profile strong',
    '.msg-thread__link-to-profile',
    '[data-anonymize="person-name"]',
  ],
  attachButton: [
    'button[aria-label*="Attach"]',
    'button[aria-label*="attach"]',
    'button[aria-label*="image"]',
    'button[aria-label*="Image"]',
    'button[aria-label*="photo"]',
    '.msg-form__footer button[type="button"]',
    '.msg-form__left-actions button'
  ],
  fileInput: [
    '.msg-form input[type="file"]',
    '.msg-form__footer input[type="file"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ],
  attachmentPreview: [
    '.msg-form__attachment',
    '.msg-media-attachment',
    '.msg-form img[src*="blob"]',
    '.msg-form__media-attachments'
  ],
  profilePhotoContainer: [
    'button.pv-top-card-profile-picture',
    'a.pv-top-card-profile-picture',
    '.pv-top-card-profile-picture',
    '.profile-photo-edit',
    'button[aria-label*="profile photo" i]',
    'a[aria-label*="profile photo" i]',
    '.pv-top-card--photo',
  ],
  topCard: [
    '.pv-top-card',
    'section.pv-top-card',
    '.scaffold-layout__main .artdeco-card:first-child',
    'main .artdeco-card:first-child',
  ]
};

function waitForElement(getter, timeoutMs = 5000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const element = getter();
      if (element) {
        resolve(element);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error('Element not found within timeout'));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// LinkedIn renders messaging inside a Shadow DOM (#interop-outlet).
function getShadowRoot() {
  const host = document.getElementById('interop-outlet');
  return host?.shadowRoot || null;
}

// querySelector that also searches inside LinkedIn's shadow DOM
function deepQuery(selector) {
  const result = document.querySelector(selector);
  if (result) return result;

  const shadow = getShadowRoot();
  if (shadow) {
    return shadow.querySelector(selector);
  }
  return null;
}

// querySelectorAll that also searches inside LinkedIn's shadow DOM
function deepQueryAll(selector) {
  const results = Array.from(document.querySelectorAll(selector));
  const shadow = getShadowRoot();
  if (shadow) {
    results.push(...Array.from(shadow.querySelectorAll(selector)));
  }
  return results;
}

/**
 * Check if an element is inside the main profile content area (not the nav bar).
 * The nav bar contains a small avatar that can falsely match profile photo selectors.
 */
function isInMainContent(el) {
  // Reject elements inside the nav/header
  if (el.closest('nav, header, [role="navigation"], #global-nav, .global-nav')) {
    return false;
  }
  // Accept elements inside main content areas
  if (el.closest('main, [role="main"], .scaffold-layout__main, .profile-detail, .pv-top-card')) {
    return true;
  }
  // Fallback: stay viewport-based so scrolling does not make fixed header avatars
  // look like real profile content.
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const isVisibleInViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  const isBelowNavBar = rect.bottom > 60;
  return isVisibleInViewport && isBelowNavBar && style.position !== 'fixed';
}
