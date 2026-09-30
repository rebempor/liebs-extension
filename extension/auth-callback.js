if (typeof initExtensionSentry === 'function') {
  initExtensionSentry({
    source: 'auth-callback',
  });
}

const PENDING_EXTENSION_AUTH_KEY = 'pendingExtensionAuth';
const statusText = document.getElementById('status-text');
const closeBtn = document.getElementById('close-btn');

function setStatus(message, tone = 'info') {
  statusText.textContent = message;
  statusText.style.color = tone === 'error' ? '#a33f1f' : '#6a5646';
}

function showCloseButton() {
  closeBtn.hidden = false;
}

closeBtn.addEventListener('click', () => {
  window.close();
});

async function finishExtensionSignIn() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const redirectUri = chrome.runtime.getURL('auth-callback.html');
  const pending = (await chrome.storage.local.get(PENDING_EXTENSION_AUTH_KEY))[PENDING_EXTENSION_AUTH_KEY];

  if (!code || !state) {
    throw new Error('The browser did not return a valid extension sign-in code.');
  }

  if (!pending?.state || pending.state !== state) {
    throw new Error('This sign-in link does not match the extension tab that started it.');
  }

  const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/extension/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      redirectUri,
      state,
    }),
  }, 10000);

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'The extension could not finish sign-in.');
  }

  const email = data.user?.email || null;

  await chrome.storage.sync.set({
    authToken: data.token,
    userEmail: email,
  });
  await chrome.storage.local.set({
    authCache: {
      isAuthenticated: true,
      email: email || 'Connected account',
      credits: data.credits || 0,
      subscription: data.subscription || null,
      cachedAt: Date.now(),
    }
  });
  await chrome.storage.local.remove(PENDING_EXTENSION_AUTH_KEY);

  try {
    await chrome.runtime.sendMessage({
      action: 'authStateChanged',
      authenticated: true,
      userId: data.user?.id || email || null,
    });
  } catch (error) {
    console.warn('Failed to notify auth state change:', error);
  }

  setStatus('The extension is connected. You can close this tab.');
  showCloseButton();

  setTimeout(() => {
    window.close();
  }, 1200);
}

finishExtensionSignIn().catch(async (error) => {
  console.error('Extension auth callback failed:', error);
  if (typeof captureExtensionError === 'function') {
    captureExtensionError('extension_auth_callback.failed', error, {
      source: 'auth-callback',
    });
  }
  await chrome.storage.local.remove(PENDING_EXTENSION_AUTH_KEY);
  setStatus(error.message || 'The extension could not finish sign-in.', 'error');
  showCloseButton();
});
