const { supabase } = require('../middleware/auth');

function safeString(value, maxLength = 2000) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

/**
 * Best-effort error event persistence for operational monitoring.
 */
async function trackError({
  source = 'backend',
  route = null,
  method = null,
  statusCode = null,
  userId = null,
  errorCode = null,
  message = 'Unknown error',
  stack = null,
  context = null,
}) {
  try {
    const payload = {
      source: safeString(source, 120),
      route: safeString(route, 200),
      method: safeString(method, 16),
      status_code: Number.isInteger(statusCode) ? statusCode : null,
      user_id: userId || null,
      error_code: safeString(errorCode, 120),
      message: safeString(message, 2000),
      stack: safeString(stack, 8000),
      context: context || null,
    };

    const { error } = await supabase.from('error_events').insert(payload);
    if (error) {
      console.error('[Tracking] Failed to persist error event:', error.message);
    }
  } catch (err) {
    console.error('[Tracking] Unexpected tracker error:', err.message);
  }
}

module.exports = {
  trackError,
};
