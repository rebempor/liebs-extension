// LinkedIn Liebs GIF Generator - Composer helpers
// Content-script-only utilities for opening LinkedIn messaging composer and attaching GIFs.

function isElementVisible(element) {
  return Boolean(element && element.offsetParent !== null);
}

function isDomElement(value) {
  return typeof Element !== 'undefined' && value instanceof Element;
}

function uniqueElements(elements) {
  const seen = new Set();
  const result = [];
  for (const element of elements) {
    if (!element || seen.has(element)) continue;
    seen.add(element);
    result.push(element);
  }
  return result;
}

function queryFirstWithin(root, selectors) {
  if (!root || !selectors?.length || typeof root.querySelector !== 'function') return null;
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function queryAllWithin(root, selectors) {
  if (!root || !selectors?.length || typeof root.querySelectorAll !== 'function') return [];
  const results = [];
  for (const selector of selectors) {
    results.push(...Array.from(root.querySelectorAll(selector)));
  }
  return uniqueElements(results);
}

function normalizeConversationText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeProfileSlug(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/?in\//i, '')
    .replace(/\/.*$/, '')
    .replace(/[?#].*$/, '')
    .toLowerCase();
}

function tokenizeConversationText(value) {
  return normalizeConversationText(value)
    .split(' ')
    .filter(Boolean);
}

function isUsefulConversationLabel(value) {
  const normalized = normalizeConversationText(value);
  if (!normalized) return false;
  if (normalized.length < 2) return false;
  return ![
    'write a message',
    'type a message',
    'message',
    'messaging',
    'new message',
    'attach a file',
    'attach file',
    'active now',
    'you',
  ].includes(normalized);
}

function extractProfileSlug(pathname = window.location.pathname) {
  const match = pathname.match(/\/in\/([^/?#]+)/i);
  return match ? normalizeProfileSlug(match[1]) : '';
}

function getCurrentProfileDisplayName() {
  for (const selector of SELECTORS.firstName || []) {
    const element = document.querySelector(selector);
    const text = element?.textContent?.trim();
    if (isUsefulConversationLabel(text)) {
      return text.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function buildExpectedConversationIdentity(options = {}) {
  const currentProfileName = getCurrentProfileDisplayName();
  const providedFullName = [options.firstName, options.lastName].filter(Boolean).join(' ').trim();
  const fallbackFullName = currentProfileName || providedFullName || options.firstName || '';

  const fullNameCandidates = new Set();
  const firstNameCandidates = new Set();

  for (const value of [providedFullName, currentProfileName, fallbackFullName]) {
    const normalized = normalizeConversationText(value);
    if (!normalized) continue;
    fullNameCandidates.add(normalized);
    const firstToken = normalized.split(' ')[0];
    if (firstToken) firstNameCandidates.add(firstToken);
  }

  const providedFirstName = normalizeConversationText(options.firstName);
  if (providedFirstName) firstNameCandidates.add(providedFirstName.split(' ')[0]);

  return {
    expectedNameLabel: fallbackFullName,
    fullNameCandidates: Array.from(fullNameCandidates),
    firstNameCandidates: Array.from(firstNameCandidates),
    profileSlug: normalizeProfileSlug(options.profileSlug || extractProfileSlug()),
  };
}

function extractNameFromAriaLabel(value) {
  const label = String(value || '').trim();
  if (!label) return '';

  const patterns = [
    /(?:conversation|messaging|message(?:s)?)\s+(?:with|to)\s+(.+)/i,
    /^(.+?)\s+(?:is\s+active|active now)$/i,
  ];

  for (const pattern of patterns) {
    const match = label.match(pattern);
    const extracted = match?.[1]?.trim();
    if (isUsefulConversationLabel(extracted)) {
      return extracted;
    }
  }

  return isUsefulConversationLabel(label) ? label : '';
}

function getConversationContainerFromForm(msgFormEl) {
  if (!msgFormEl) return null;

  for (const selector of SELECTORS.msgConversationContainer || []) {
    const container = msgFormEl.closest(selector);
    if (container) return container;
  }

  return msgFormEl.closest('.msg-overlay-conversation-bubble, .msg-overlay-list-bubble, .msg-thread, .msg-s-message-list-container') || msgFormEl;
}

function getConversationDisplayName(msgFormEl) {
  if (!msgFormEl) return '';

  const roots = uniqueElements([
    getConversationContainerFromForm(msgFormEl),
    msgFormEl,
    msgFormEl.parentElement,
    msgFormEl.parentElement?.parentElement,
  ]);

  const labels = [];

  for (const root of roots) {
    if (!root) continue;

    for (const element of queryAllWithin(root, SELECTORS.msgConversationTitle || [])) {
      const text = element?.textContent?.replace(/\s+/g, ' ').trim();
      if (isUsefulConversationLabel(text)) {
        labels.push(text);
      }
    }

    const ariaCandidates = [
      root.getAttribute?.('aria-label'),
      root.getAttribute?.('title'),
    ];
    for (const candidate of ariaCandidates) {
      const extracted = extractNameFromAriaLabel(candidate);
      if (extracted) labels.push(extracted);
    }
  }

  return labels.find(isUsefulConversationLabel) || '';
}

function findMessageForms() {
  const forms = [];
  const selectors = SELECTORS.msgFormContainer || ['.msg-form'];

  for (const selector of selectors) {
    forms.push(...deepQueryAll(selector));
  }

  return uniqueElements(forms).filter(isElementVisible);
}

function findComposerWithinForm(msgFormEl) {
  if (!msgFormEl) return null;

  for (const selector of SELECTORS.messageComposer) {
    const elements = msgFormEl.querySelectorAll(selector);
    for (const element of elements) {
      if (isElementVisible(element)) {
        return element;
      }
    }
  }

  return null;
}

function findComposerContainerWithinForm(msgFormEl, composerEl = null) {
  if (!msgFormEl) return null;

  const composerContainer = queryFirstWithin(msgFormEl, SELECTORS.msgFormComposerArea || []);
  if (composerContainer) {
    if (composerContainer.getAttribute('contenteditable') === 'true') {
      return composerContainer.parentElement || composerContainer;
    }
    return composerContainer;
  }

  return composerEl?.parentElement || msgFormEl;
}

function findFileInputWithinForm(msgFormEl) {
  if (!msgFormEl) return null;

  for (const selector of SELECTORS.fileInput) {
    const inputs = msgFormEl.querySelectorAll(selector);
    for (const input of inputs) {
      if (input?.type === 'file') {
        return input;
      }
    }
  }

  return null;
}

function findAttachmentPreviewWithinForm(msgFormEl) {
  if (!msgFormEl) return null;

  const searchRoots = uniqueElements([
    msgFormEl,
    getConversationContainerFromForm(msgFormEl),
  ]);

  for (const root of searchRoots) {
    if (!root) continue;

    for (const selector of SELECTORS.attachmentPreview) {
      const preview = root.querySelector(selector);
      if (preview) return preview;
    }

    const uploadedList = root.querySelector('[data-test-msg-cross-pillar-uploaded-attachment-list-presenter]');
    if (uploadedList && uploadedList.children.length > 0) {
      return uploadedList;
    }

    const blobImages = root.querySelectorAll('img[src^="blob:"]');
    if (blobImages.length > 0) {
      return blobImages[0];
    }

    const mediaPreview = root.querySelector('[class*="media-preview"], [class*="uploaded-attachment"]');
    if (mediaPreview) {
      return mediaPreview;
    }
  }

  return null;
}

function conversationContainsProfileSlug(targetConversation, profileSlug) {
  const normalizedSlug = normalizeProfileSlug(profileSlug);
  if (!normalizedSlug) return false;

  const searchRoots = uniqueElements([
    targetConversation?.conversationContainerEl,
    targetConversation?.msgFormEl,
  ]);

  for (const root of searchRoots) {
    if (!root || typeof root.querySelectorAll !== 'function') continue;
    const links = root.querySelectorAll('a[href*="/in/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (normalizeProfileSlug(href).startsWith(normalizedSlug)) {
        return true;
      }
    }
  }

  return false;
}

function scoreConversationMatch(targetConversation, identity) {
  if (!targetConversation || !identity) return 0;

  let score = 0;
  const matchedName = normalizeConversationText(targetConversation.matchedName);

  if (conversationContainsProfileSlug(targetConversation, identity.profileSlug)) {
    score += 10;
  }

  if (matchedName) {
    for (const candidate of identity.fullNameCandidates) {
      if (!candidate) continue;
      if (matchedName === candidate || matchedName.includes(candidate) || candidate.includes(matchedName)) {
        score = Math.max(score, 8);
      }

      const candidateTokens = tokenizeConversationText(candidate);
      if (candidateTokens.length > 1 && candidateTokens.every(token => matchedName.includes(token))) {
        score = Math.max(score, 7);
      }
    }

    for (const candidate of identity.firstNameCandidates) {
      if (!candidate) continue;
      if (
        matchedName === candidate ||
        matchedName.startsWith(`${candidate} `) ||
        matchedName.includes(` ${candidate} `)
      ) {
        score = Math.max(score, 4);
      }
    }
  }

  return score;
}

function buildTargetConversation(msgFormEl, identity = null, source = 'existing_match') {
  if (!msgFormEl) return null;

  const composerEl = findComposerWithinForm(msgFormEl);
  if (!composerEl) return null;

  return {
    msgFormEl,
    composerEl,
    composerContainerEl: findComposerContainerWithinForm(msgFormEl, composerEl),
    conversationContainerEl: getConversationContainerFromForm(msgFormEl),
    fileInputEl: findFileInputWithinForm(msgFormEl),
    matchedName: getConversationDisplayName(msgFormEl),
    expectedName: identity?.expectedNameLabel || '',
    source,
  };
}

function pickBestConversation(candidates, identity, { preferNewForms = null, allowLooseFallback = true } = {}) {
  if (!candidates.length) return null;

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreConversationMatch(candidate, identity),
      isNew: preferNewForms?.has(candidate.msgFormEl) ? 1 : 0,
      isVisible: isElementVisible(candidate.composerEl) ? 1 : 0,
    }))
    .sort((a, b) => (
      b.score - a.score ||
      b.isNew - a.isNew ||
      b.isVisible - a.isVisible
    ));

  if (ranked[0].score > 0) {
    return ranked[0].candidate;
  }

  if (preferNewForms) {
    const newCandidates = ranked.filter(entry => entry.isNew);
    if (newCandidates.length === 1) {
      return newCandidates[0].candidate;
    }
  }

  if (allowLooseFallback && ranked.length === 1) {
    return ranked[0].candidate;
  }

  return null;
}

function findTargetConversation(identity, options = {}) {
  const { preferNewForms = null, allowLooseFallback = true, source = 'existing_match' } = options;
  const candidates = findMessageForms()
    .map(msgFormEl => buildTargetConversation(msgFormEl, identity, source))
    .filter(Boolean);

  return pickBestConversation(candidates, identity, { preferNewForms, allowLooseFallback });
}

async function waitForTargetConversation(identity, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const intervalMs = options.intervalMs || 200;
  const preferNewForms = options.preferNewForms || null;
  const allowLooseFallback = Boolean(options.allowLooseFallback);
  const startTime = Date.now();

  while (Date.now() - startTime <= timeoutMs) {
    const targetConversation = findTargetConversation(identity, {
      preferNewForms,
      allowLooseFallback,
      source: 'opened_from_profile',
    });

    if (targetConversation) {
      return targetConversation;
    }

    await sleep(intervalMs);
  }

  throw new Error('Target conversation not found');
}

async function ensureTargetFileInputReady(targetConversation, identity) {
  if (!targetConversation) return targetConversation;
  if (targetConversation.fileInputEl) return targetConversation;

  try {
    const refreshedConversation = await waitForElement(() => {
      const nextTarget = findTargetConversation(identity, {
        allowLooseFallback: true,
        source: targetConversation.source,
      });
      return nextTarget?.fileInputEl ? nextTarget : null;
    }, 5000, 200);
    debugLog('ensureComposer', 'File input ready for target conversation');
    return refreshedConversation;
  } catch (error) {
    debugWarn('ensureComposer', 'File input not found after composer opened');
    return findTargetConversation(identity, {
      allowLooseFallback: true,
      source: targetConversation.source,
    }) || targetConversation;
  }
}

function normalizeAttachmentTarget(targetConversationOrComposer) {
  if (!targetConversationOrComposer) return null;

  if (targetConversationOrComposer.msgFormEl && targetConversationOrComposer.composerEl) {
    return targetConversationOrComposer;
  }

  if (isDomElement(targetConversationOrComposer)) {
    const composerEl = targetConversationOrComposer;
    const msgFormEl = composerEl.closest('.msg-form');
    if (!msgFormEl) return null;
    return {
      msgFormEl,
      composerEl,
      composerContainerEl: findComposerContainerWithinForm(msgFormEl, composerEl),
      conversationContainerEl: getConversationContainerFromForm(msgFormEl),
      fileInputEl: findFileInputWithinForm(msgFormEl),
      matchedName: getConversationDisplayName(msgFormEl),
      expectedName: '',
      source: 'legacy_element',
    };
  }

  return null;
}

function findMessageButton() {
  // Search regular DOM only — the profile Message button is NOT in shadow DOM.
  // Shadow DOM contains messaging UI that can falsely match aria-label selectors.
  for (const selector of SELECTORS.messageButton) {
    const buttons = document.querySelectorAll(selector);
    for (const btn of buttons) {
      debugLog('findMsgBtn', `"${selector}": found, visible=${btn.offsetParent !== null}`);
      if (btn.offsetParent !== null) return btn;
    }
  }

  // Fallback: find buttons/links by visible text content (regular DOM only)
  const allButtons = document.querySelectorAll('button, a[role="button"], a[aria-label], a[href*="messaging"]');
  for (const btn of allButtons) {
    const text = btn.textContent?.trim();
    if (text === 'Message' && btn.offsetParent !== null) {
      const rect = btn.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.7 && rect.width > 0) {
        debugLog('findMsgBtn', 'Found by text content fallback');
        return btn;
      }
    }
  }

  debugWarn('findMsgBtn', 'No visible message button found');
  trackContentErrorOnce('dom.message_button_selector_failed', 'dom.selector_failed', new Error('Message button not found'), {
    selectorGroup: 'messageButton',
    pathname: window.location.pathname,
    selectorCount: SELECTORS.messageButton.length,
  });
  return null;
}

function findMessageComposer() {
  const targetConversation = findTargetConversation(buildExpectedConversationIdentity(), {
    allowLooseFallback: true,
  });
  return targetConversation?.composerEl || null;
}

async function ensureComposerOpen(options = {}) {
  const identity = buildExpectedConversationIdentity(options);
  let targetConversation = findTargetConversation(identity, {
    allowLooseFallback: false,
  });

  if (targetConversation) {
    targetConversation = await ensureTargetFileInputReady(targetConversation, identity);
    targetConversation.composerEl.focus();
    return {
      success: true,
      composer: targetConversation.composerEl,
      targetConversation,
    };
  }

  const msgBtn = findMessageButton();
  if (!msgBtn) {
    return { success: false, error: 'No message button on this profile' };
  }

  const previousForms = new Set(findMessageForms());
  msgBtn.click();

  try {
    targetConversation = await waitForTargetConversation(identity, {
      timeoutMs: 5000,
      intervalMs: 200,
      preferNewForms: previousForms,
      allowLooseFallback: true,
    });
    await sleep(500);
    targetConversation = await ensureTargetFileInputReady(targetConversation, identity);
    targetConversation.composerEl.focus();
    return {
      success: true,
      composer: targetConversation.composerEl,
      targetConversation,
    };
  } catch (error) {
    return { success: false, error: 'Composer did not open for the target profile' };
  }
}

function findComposerFileInput(targetConversationOrComposer = null) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  if (!targetConversation?.msgFormEl) {
    return null;
  }

  return findFileInputWithinForm(targetConversation.msgFormEl);
}

async function openAttachUiIfNeeded(targetConversationOrComposer = null) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  if (!targetConversation?.msgFormEl) return null;

  for (const selector of SELECTORS.attachButton) {
    const buttons = targetConversation.msgFormEl.querySelectorAll(selector);
    for (const btn of buttons) {
      if (btn.offsetParent !== null) {
        debugLog('attachUI', `Clicking attach button: "${selector}"`);
        btn.click();
        await sleep(300);
        const fileInput = findComposerFileInput(targetConversation);
        if (fileInput) return fileInput;
      }
    }
  }

  return findComposerFileInput(targetConversation);
}

function checkAttachmentPreview(targetConversationOrComposer = null) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  if (!targetConversation?.msgFormEl) {
    debugLog('checkPreview', 'No target conversation provided');
    return false;
  }

  const preview = findAttachmentPreviewWithinForm(targetConversation.msgFormEl);
  if (preview) {
    debugLog('checkPreview', 'Found attachment preview inside target conversation');
    return true;
  }

  debugLog('checkPreview', 'No preview detected inside target conversation');
  return false;
}


// --- Attachment methods ---

async function tryReactFiberFileInput(file, targetConversationOrComposer) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  debugLog('attach:reactFiber', 'Attempting React fiber approach...');
  try {
    const fileInput = findComposerFileInput(targetConversation);
    if (!fileInput) {
      debugLog('attach:reactFiber', 'No file input found');
      return false;
    }

    const fiberKey = Object.keys(fileInput).find(
      key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );

    if (!fiberKey) {
      debugLog('attach:reactFiber', 'No React fiber found on file input');
      return false;
    }

    debugLog('attach:reactFiber', 'Found fiber key:', fiberKey);

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    // Walk fiber tree to find onChange handler
    let fiber = fileInput[fiberKey];
    let onChange = null;

    for (let i = 0; i < 15 && fiber; i++) {
      if (fiber.memoizedProps?.onChange) {
        onChange = fiber.memoizedProps.onChange;
        debugLog('attach:reactFiber', `Found onChange at fiber level ${i}`);
        break;
      }
      if (fiber.pendingProps?.onChange) {
        onChange = fiber.pendingProps.onChange;
        debugLog('attach:reactFiber', `Found onChange (pendingProps) at fiber level ${i}`);
        break;
      }
      fiber = fiber.return;
    }

    if (onChange) {
      try {
        onChange({ target: fileInput, currentTarget: fileInput });
        debugLog('attach:reactFiber', 'Called React onChange directly');
        await sleep(800);
        if (checkAttachmentPreview(targetConversation)) return true;
      } catch (e) {
        debugWarn('attach:reactFiber', 'React onChange call threw:', e.message);
      }
    }

    // Fallback: dispatch events after setting files
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(800);
    if (checkAttachmentPreview(targetConversation)) return true;
  } catch (e) {
    debugWarn('attach:reactFiber', 'React fiber method failed:', e.message);
  }
  return false;
}

async function trySyntheticPaste(file, targetConversationOrComposer) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  const composer = targetConversation?.composerEl;
  debugLog('attach:paste', 'Attempting synthetic paste with defineProperty fix...');
  try {
    if (!composer) return false;

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true
    });

    // Fix: Chrome ignores clipboardData in constructor, so set it via defineProperty
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: dataTransfer,
      writable: false
    });

    composer.focus();
    await sleep(100);
    composer.dispatchEvent(pasteEvent);

    debugLog('attach:paste', 'Paste dispatched, clipboardData items:', pasteEvent.clipboardData?.items?.length);
    await sleep(800);
    if (checkAttachmentPreview(targetConversation)) return true;
    debugLog('attach:paste', 'No preview after paste');
  } catch (e) {
    debugWarn('attach:paste', 'Synthetic paste failed:', e.message);
  }
  return false;
}

async function trySyntheticDrop(file, targetConversationOrComposer) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  const composer = targetConversation?.composerEl;
  debugLog('attach:drop', 'Attempting synthetic drop with full drag sequence...');
  try {
    if (!composer) return false;

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);

    // Fire full drag sequence (some frameworks need dragenter + dragover first)
    composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
    composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
    await sleep(100);

    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true
    });

    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: dataTransfer,
      writable: false
    });

    composer.dispatchEvent(dropEvent);
    debugLog('attach:drop', 'Drop event dispatched');
    await sleep(800);
    if (checkAttachmentPreview(targetConversation)) return true;
    debugLog('attach:drop', 'No preview after drop');
  } catch (e) {
    debugWarn('attach:drop', 'Drop method failed:', e.message);
  }
  return false;
}

async function tryFileInputImproved(file, targetConversationOrComposer) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  debugLog('attach:fileInput', 'Attempting file input method (Ember-compatible)...');
  try {
    let fileInput = findComposerFileInput(targetConversation);

    // If not found immediately, the messaging UI may still be loading
    // (e.g., composer was just opened). Retry a few times.
    if (!fileInput) {
      debugLog('attach:fileInput', 'No file input found, retrying...');
      await openAttachUiIfNeeded(targetConversation);
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(500);
        fileInput = findComposerFileInput(targetConversation);
        if (fileInput) {
          debugLog('attach:fileInput', `Found file input after ${(attempt + 1) * 500}ms`);
          break;
        }
      }
    }

    if (!fileInput) {
      debugLog('attach:fileInput', 'No file input found after retries');
      return false;
    }

    debugLog('attach:fileInput', `Found input: accept="${fileInput.accept}", id="${fileInput.id}"`);

    const dt = new DataTransfer();
    dt.items.add(file);

    // Use Object.getOwnPropertyDescriptor to set files properly
    // This is needed because some frameworks override the setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'files'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(fileInput, dt.files);
      debugLog('attach:fileInput', 'Set files via native setter');
    } else {
      fileInput.files = dt.files;
      debugLog('attach:fileInput', 'Set files directly');
    }

    // Dispatch multiple event types — Ember uses native event delegation
    // The change event is what Ember's action system listens for on <input>
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    debugLog('attach:fileInput', 'Events dispatched, waiting for preview...');
    await sleep(1500);
    if (checkAttachmentPreview(targetConversation)) return true;

    // Try again with a longer wait (upload might take time for large GIFs)
    debugLog('attach:fileInput', 'No preview yet, waiting longer...');
    await sleep(2000);
    if (checkAttachmentPreview(targetConversation)) return true;

    debugLog('attach:fileInput', 'No preview after file input');
  } catch (e) {
    debugWarn('attach:fileInput', 'File input method failed:', e.message);
  }
  return false;
}

async function tryUrlTextFallback(gifUrl, targetConversationOrComposer) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  const composer = targetConversation?.composerEl;
  debugLog('attach:urlText', 'Attempting URL text insertion as last resort...');
  try {
    if (!composer) return false;

    composer.focus();
    await sleep(200);

    const inserted = document.execCommand('insertText', false, gifUrl);
    debugLog('attach:urlText', 'execCommand insertText result:', inserted);

    if (!inserted) {
      // Fallback: directly set text and fire input event
      composer.textContent = gifUrl;
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: gifUrl
      }));
    }

    await sleep(500);
    const hasText = composer.textContent.includes(gifUrl.substring(0, 20));
    debugLog('attach:urlText', 'URL in composer:', hasText);
    return hasText;
  } catch (e) {
    debugWarn('attach:urlText', 'URL fallback failed:', e.message);
  }
  return false;
}

async function attachGifFileToComposer(file, targetConversationOrComposer, gifUrl) {
  const targetConversation = normalizeAttachmentTarget(targetConversationOrComposer);
  if (!targetConversation?.composerEl) {
    debugWarn('attach', 'No target conversation available for attachment');
    return { success: false, method: 'none' };
  }

  debugLog('attach', 'Starting attachment. File:', file.name, file.size, 'bytes');

  // Method 1: File input with native change event (best for Ember.js / LinkedIn)
  if (await tryFileInputImproved(file, targetConversation)) {
    addContentBreadcrumb('attach.success', { method: 'fileInput' });
    return { success: true, method: 'fileInput' };
  }

  // Method 2: Synthetic paste with defineProperty fix
  if (await trySyntheticPaste(file, targetConversation)) {
    addContentBreadcrumb('attach.success', { method: 'syntheticPaste' });
    return { success: true, method: 'syntheticPaste' };
  }

  // Method 3: Synthetic drop with full drag sequence
  if (await trySyntheticDrop(file, targetConversation)) {
    addContentBreadcrumb('attach.success', { method: 'syntheticDrop' });
    return { success: true, method: 'syntheticDrop' };
  }

  // Method 4: React Fiber (unlikely for LinkedIn/Ember, but included as fallback)
  if (await tryReactFiberFileInput(file, targetConversation)) {
    addContentBreadcrumb('attach.success', { method: 'reactFiber' });
    return { success: true, method: 'reactFiber' };
  }

  // Method 5: Insert GIF URL as text (graceful degradation)
  if (gifUrl && await tryUrlTextFallback(gifUrl, targetConversation)) {
    addContentBreadcrumb('attach.success', { method: 'urlText' });
    return { success: true, method: 'urlText' };
  }

  debugWarn('attach', 'All attachment methods failed');
  trackContentError('attach.all_methods_failed', new Error('All attachment methods failed'), {
    pathname: window.location.pathname,
    methodsTried: ['fileInput', 'syntheticPaste', 'syntheticDrop', 'reactFiber', 'urlText'],
    hadGifUrlFallback: Boolean(gifUrl),
    matchedConversationName: targetConversation.matchedName || null,
    expectedConversationName: targetConversation.expectedName || null,
  });
  return { success: false, method: 'none' };
}
