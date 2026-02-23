const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { requireAuth } = require('../middleware/auth');
const { trackError } = require('../services/errorTracker');

const router = express.Router();

// Create Supabase client with anon key for auth operations
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * POST /api/auth/signup
 * Create a new user account
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Create initial credits record (0 credits - no free tier)
    if (data.user) {
      console.log('[Auth] User created:', data.user.id);

      const serviceSupabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { error: creditsError } = await serviceSupabase.from('credits').insert({
        user_id: data.user.id,
        balance: 0
      });

      if (creditsError) {
        console.error('[Auth] Credits insert error:', creditsError);
        // User was created but credits failed - still return success
        // Credits can be added later
      } else {
        console.log('[Auth] Credits record created for user');
      }
    }

    // Return token for extension to use
    res.json({
      message: 'Account created successfully',
      user: data.user,
      token: data.session?.access_token,
      credits: 0
    });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    await trackError({
      source: 'auth',
      route: '/api/auth/signup',
      method: 'POST',
      statusCode: 500,
      errorCode: err.code || null,
      message: err.message || 'Failed to create account',
      stack: err.stack || null,
    });
    res.status(500).json({ error: err.message || 'Failed to create account' });
  }
});

/**
 * POST /api/auth/login
 * Login and get session token
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    // Get user's credit balance
    const serviceSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: credits } = await serviceSupabase
      .from('credits')
      .select('balance')
      .eq('user_id', data.user.id)
      .single();

    res.json({
      user: data.user,
      token: data.session?.access_token,
      credits: credits?.balance || 0
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    await trackError({
      source: 'auth',
      route: '/api/auth/login',
      method: 'POST',
      statusCode: 500,
      errorCode: err.code || null,
      message: err.message || 'Failed to login',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to login' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info and credit balance
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    // Get credit balance
    const { data: credits, error } = await req.supabase
      .from('credits')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
      throw error;
    }

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        created_at: req.user.created_at
      },
      credits: credits?.balance || 0
    });
  } catch (err) {
    console.error('[Auth] Get me error:', err.message);
    await trackError({
      source: 'auth',
      route: '/api/auth/me',
      method: 'GET',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to get user info',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

module.exports = router;
