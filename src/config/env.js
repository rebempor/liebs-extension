function readEnv(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

const env = {
  supabaseUrl: readEnv(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']),
  supabaseAnonKey: readEnv(['SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']),
  supabaseServiceKey: readEnv([
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]),
};

function assertSupabaseEnv() {
  const missing = [];

  if (!env.supabaseUrl) {
    missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
  }
  if (!env.supabaseAnonKey) {
    missing.push('SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  }
  if (!env.supabaseServiceKey) {
    missing.push('SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
  }

  if (missing.length === 0) {
    return;
  }

  const error = new Error(
    `[Config] Missing required environment variables: ${missing.join(', ')}`
  );
  error.code = 'CONFIG_MISSING_ENV';
  throw error;
}

module.exports = {
  env,
  assertSupabaseEnv,
};
