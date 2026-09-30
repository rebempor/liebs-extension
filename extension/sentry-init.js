(function initSentryHelpers(global) {
  'use strict';

  // Replace once after creating the extension project in Sentry.
  const DEFAULT_SENTRY_DSN = 'https://f17ea28298c9eb425da7ef57f12b5b40@o4510993166368768.ingest.de.sentry.io/4510993201496144';
  const DISABLED_DSN_VALUES = new Set(['']);

  let sentryReady = false;
  let sentrySource = 'unknown';

  function isValidDsn(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (DISABLED_DSN_VALUES.has(trimmed)) return false;
    return /^https:\/\//i.test(trimmed);
  }

  function normalizeError(error, fallbackMessage) {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error.trim()) return new Error(error);
    return new Error(fallbackMessage || 'Unknown extension error');
  }

  function getExtensionVersion() {
    try {
      return chrome?.runtime?.getManifest?.().version || 'unknown';
    } catch (_error) {
      return 'unknown';
    }
  }

  function configureSentryHub(source, dsn) {
    const Sentry = global.Sentry;
    if (!Sentry) return false;

    const extensionVersion = getExtensionVersion();
    const release = `liebs-extension@${extensionVersion}`;

    const baseOptions = {
      dsn,
      release,
      transport: Sentry.makeFetchTransport,
      stackParser: Sentry.defaultStackParser,
      defaultIntegrations: false,
      integrations: [],
      initialScope: {
        tags: {
          script: source,
          extension_version: extensionVersion,
        },
      },
    };

    // Prefer a manual client so we do not depend on shared global handlers.
    if (typeof Sentry.BrowserClient === 'function' && typeof Sentry.Hub === 'function' && typeof Sentry.makeMain === 'function') {
      const client = new Sentry.BrowserClient(baseOptions);
      const scope = new Sentry.Scope();
      scope.setClient(client);
      scope.setTag('script', source);
      scope.setTag('extension_version', extensionVersion);
      const hub = new Sentry.Hub(client, scope);
      Sentry.makeMain(hub);
      client.init();
      return true;
    }

    if (typeof Sentry.init === 'function') {
      Sentry.init(baseOptions);
      return true;
    }

    return false;
  }

  function wireUnhandledHandlers() {
    if (!global.addEventListener || global.__LIEBS_SENTRY_GLOBAL_HANDLERS__) {
      return;
    }

    global.__LIEBS_SENTRY_GLOBAL_HANDLERS__ = true;

    global.addEventListener('error', (event) => {
      const error = normalizeError(event?.error, event?.message || 'Unhandled runtime error');
      captureExtensionError('unhandled.error', error, {
        filename: event?.filename || null,
        lineno: event?.lineno || null,
        colno: event?.colno || null,
      });
    });

    global.addEventListener('unhandledrejection', (event) => {
      const reason = event?.reason;
      const error = normalizeError(reason, 'Unhandled promise rejection');
      captureExtensionError('unhandled.rejection', error, {
        reasonType: typeof reason,
      });
    });
  }

  function initExtensionSentry(options = {}) {
    const source = options.source || 'unknown';
    const dsn = (options.dsn || DEFAULT_SENTRY_DSN || '').trim();

    sentrySource = source;

    if (!isValidDsn(dsn)) {
      sentryReady = false;
      return false;
    }

    try {
      sentryReady = configureSentryHub(source, dsn);
      if (sentryReady) {
        wireUnhandledHandlers();
      }
    } catch (error) {
      sentryReady = false;
      console.warn('[Sentry] Failed to initialize:', error?.message || error);
    }

    return sentryReady;
  }

  function captureExtensionError(eventName, error, context = {}) {
    if (!sentryReady || !global.Sentry) return;

    const Sentry = global.Sentry;
    const normalizedError = normalizeError(error, eventName || 'Extension error');
    const cleanEventName = typeof eventName === 'string' && eventName ? eventName : 'extension.error';

    if (typeof Sentry.withScope === 'function') {
      Sentry.withScope((scope) => {
        scope.setTag('script', sentrySource);
        scope.setTag('error_type', cleanEventName);
        scope.setExtras(context || {});
        scope.setLevel('error');
        Sentry.captureException(normalizedError);
      });
      return;
    }

    Sentry.captureException(normalizedError);
  }

  function addExtensionBreadcrumb(message, data = {}, level = 'info') {
    if (!sentryReady || !global.Sentry || typeof global.Sentry.addBreadcrumb !== 'function') return;

    global.Sentry.addBreadcrumb({
      category: 'extension.flow',
      message,
      level,
      data: data || {},
    });
  }

  global.initExtensionSentry = initExtensionSentry;
  global.captureExtensionError = captureExtensionError;
  global.addExtensionBreadcrumb = addExtensionBreadcrumb;
})(typeof globalThis !== 'undefined' ? globalThis : self);
