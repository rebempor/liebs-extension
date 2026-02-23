const express = require('express');
const Stripe = require('stripe');
const { requireAuth, supabase } = require('../middleware/auth');
const { trackError } = require('../services/errorTracker');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Credit pack definitions
const CREDIT_PACKS = {
  'pack_5': { credits: 5, price: 500, name: '5 Credits' },      // $5
  'pack_12': { credits: 12, price: 1000, name: '12 Credits' },  // $10
  'pack_30': { credits: 30, price: 2000, name: '30 Credits' }   // $20
};

/**
 * GET /api/credits/balance
 * Get current credit balance
 */
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('credits')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    res.json({ balance: data?.balance || 0 });
  } catch (err) {
    console.error('[Credits] Balance error:', err.message);
    await trackError({
      source: 'credits',
      route: '/api/credits/balance',
      method: 'GET',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to get balance',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

/**
 * GET /api/credits/packs
 * Get available credit packs
 */
router.get('/packs', (req, res) => {
  const packs = Object.entries(CREDIT_PACKS).map(([id, pack]) => ({
    id,
    ...pack,
    priceFormatted: `$${(pack.price / 100).toFixed(2)}`
  }));
  res.json({ packs });
});

/**
 * POST /api/credits/purchase
 * Create Stripe checkout session for credit purchase
 */
router.post('/purchase', requireAuth, async (req, res) => {
  try {
    const { packId } = req.body;
    const pack = CREDIT_PACKS[packId];

    if (!pack) {
      return res.status(400).json({ error: 'Invalid pack ID' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `LinkedIn Pixar GIF - ${pack.name}`,
            description: `${pack.credits} GIF generation credits`
          },
          unit_amount: pack.price
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://your-app.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://your-app.com'}/cancel`,
      metadata: {
        user_id: req.user.id,
        pack_id: packId,
        credits: pack.credits.toString()
      }
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Credits] Purchase error:', err.message);
    await trackError({
      source: 'credits',
      route: '/api/credits/purchase',
      method: 'POST',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to create checkout session',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/credits/webhook
 * Stripe webhook to add credits after successful payment
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    await trackError({
      source: 'credits',
      route: '/api/credits/webhook',
      method: 'POST',
      statusCode: 400,
      errorCode: err.code || null,
      message: err.message || 'Webhook signature verification failed',
      stack: err.stack || null,
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, pack_id, credits } = session.metadata;
    const creditsToAdd = parseInt(credits, 10);

    console.log(`[Webhook] Payment completed for user ${user_id}: +${creditsToAdd} credits`);

    try {
      // Add credits to user
      const { data: existing } = await supabase
        .from('credits')
        .select('balance')
        .eq('user_id', user_id)
        .single();

      if (existing) {
        await supabase
          .from('credits')
          .update({ balance: existing.balance + creditsToAdd, updated_at: new Date() })
          .eq('user_id', user_id);
      } else {
        await supabase
          .from('credits')
          .insert({ user_id, balance: creditsToAdd });
      }

      // Log transaction
      await supabase.from('transactions').insert({
        user_id,
        type: 'purchase',
        amount: creditsToAdd,
        description: `Purchased ${pack_id}`,
        stripe_session_id: session.id
      });

      console.log(`[Webhook] Added ${creditsToAdd} credits to user ${user_id}`);
    } catch (err) {
      console.error('[Webhook] Failed to add credits:', err.message);
      await trackError({
        source: 'credits',
        route: '/api/credits/webhook',
        method: 'POST',
        statusCode: 500,
        userId: user_id || null,
        errorCode: err.code || null,
        message: err.message || 'Failed to add credits from webhook',
        stack: err.stack || null,
        context: {
          stripeSessionId: session.id,
          packId: pack_id,
          creditsToAdd,
        },
      });
    }
  }

  res.json({ received: true });
});

/**
 * GET /api/credits/history
 * Get transaction history
 */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ transactions: data || [] });
  } catch (err) {
    console.error('[Credits] History error:', err.message);
    await trackError({
      source: 'credits',
      route: '/api/credits/history',
      method: 'GET',
      statusCode: 500,
      userId: req.user?.id || null,
      errorCode: err.code || null,
      message: err.message || 'Failed to get transaction history',
      stack: err.stack || null,
    });
    res.status(500).json({ error: 'Failed to get history' });
  }
});

module.exports = router;
