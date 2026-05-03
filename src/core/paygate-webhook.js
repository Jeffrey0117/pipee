/**
 * PayGate Webhook Handler
 *
 * Receives subscription events from PayGate and updates user plans.
 * Registered as a webhook endpoint in PayGate for pipee product events.
 */

const db = require('./db');

const PLAN_QUOTAS = {
  free: { max_sites: 3 },
  pro: { max_sites: 20 },
  creator: { max_sites: 50, ai_edits: 100 },
};

/**
 * Handle POST /api/paygate/webhook
 * PayGate sends: { event, data: { email, product, tier, subscription_id, ... } }
 */
async function handleWebhook(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { event, data } = payload;

      if (!event || !data || !data.email) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid payload' }));
      }

      // Only handle pipee product events
      if (data.product && data.product !== 'pipee') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ignored: true, reason: 'Not pipee product' }));
      }

      const tier = data.tier || 'free';

      if (event === 'subscription.activated' || event === 'subscription.renewed') {
        applyPlan(data.email, tier);
      } else if (event === 'subscription.cancelled' || event === 'subscription.expired') {
        applyPlan(data.email, 'free');
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error('[paygate-webhook] Error:', err.message);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function applyPlan(email, tier) {
  const users = db.getUsersByEmail(email);
  if (users.length === 0) {
    console.log(`[paygate-webhook] No user found for email: ${email}`);
    return;
  }

  const quota = PLAN_QUOTAS[tier] || PLAN_QUOTAS.free;

  for (const user of users) {
    db.updateUser(user.id, {
      plan: tier,
      max_sites: quota.max_sites,
    });
    console.log(`[paygate-webhook] Updated user ${user.id.slice(0, 8)}... to plan: ${tier}`);
  }
}

module.exports = { handleWebhook, PLAN_QUOTAS };
