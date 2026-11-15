/**
 * stripe_billing.js
 * 創音知能 AI Micro Store - Stripe決済連携モジュール
 * ゼロ外部依存・純粋Node.js (https, crypto, querystring) 実装
 */

const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

// サーバー側固定チャージプラン（任意金額パラメータ改ざん防止）
const CHARGE_PLANS = {
  mini_100: {
    id: "mini_100",
    name: "AI Allowance Mini (100 JPY)",
    description: "Single-trip allowance pool for ~3 compliance checks / 判定3回分程度の旅行1回向け (100 JPY)",
    price_yen: 100,
    currency: "jpy"
  },
  starter_500: {
    id: "starter_500",
    name: "AI Allowance Starter (500 JPY)",
    description: "Initial allowance pool for AI Agent queries and renders",
    price_yen: 500,
    currency: "jpy"
  },
  standard_1500: {
    id: "standard_1500",
    name: "AI Allowance Standard (1,500 JPY)",
    description: "Standard allowance pool for AI Agent automation workflows",
    price_yen: 1500,
    currency: "jpy"
  },
  pro_5000: {
    id: "pro_5000",
    name: "AI Allowance Pro (5,000 JPY)",
    description: "Professional high-volume allowance pool for heavy agent workloads",
    price_yen: 5000,
    currency: "jpy"
  }
};

/**
 * プランIDの検証
 */
function getChargePlan(planId) {
  if (!planId || typeof planId !== 'string') return null;
  return CHARGE_PLANS[planId.trim()] || null;
}

/**
 * Stripe Checkout Session 用のフォームペイロードを構築
 * ※ 最新Stripe API (Dynamic Payment Methods) に準拠し payment_method_types は送信しない
 */
function buildCheckoutPayload({ plan, apiKey, successUrl, cancelUrl }) {
  return {
    'mode': 'payment',
    'line_items[0][price_data][currency]': plan.currency,
    'line_items[0][price_data][unit_amount]': String(plan.price_yen),
    'line_items[0][price_data][product_data][name]': plan.name,
    'line_items[0][price_data][product_data][description]': plan.description,
    'line_items[0][quantity]': '1',
    'metadata[plan_id]': plan.id,
    'metadata[amount_yen]': String(plan.price_yen),
    'metadata[apiKey]': apiKey || '',
    'success_url': successUrl || 'http://localhost:3456/?session_id={CHECKOUT_SESSION_ID}&status=success',
    'cancel_url': cancelUrl || 'http://localhost:3456/?status=cancelled'
  };
}

/**
 * Stripe Checkout Session 作成 (POST https://api.stripe.com/v1/checkout/sessions)
 */
function createStripeCheckoutSession({
  planId,
  apiKey,
  successUrl,
  cancelUrl,
  secretKey = process.env.STRIPE_SECRET_KEY
}) {
  return new Promise((resolve, reject) => {
    const plan = getChargePlan(planId);
    if (!plan) {
      const err = new Error(`Invalid plan_id: '${planId}'. Must be one of: ${Object.keys(CHARGE_PLANS).join(', ')}`);
      err.code = "INVALID_PLAN";
      err.statusCode = 400;
      return reject(err);
    }

    if (!secretKey || !secretKey.trim()) {
      const err = new Error("STRIPE_SECRET_KEY is not configured on this server");
      err.code = "STRIPE_SECRET_KEY_MISSING";
      err.statusCode = 500;
      return reject(err);
    }

    const payload = buildCheckoutPayload({
      plan,
      apiKey,
      successUrl,
      cancelUrl
    });

    const postData = querystring.stringify(payload);

    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: '/v1/checkout/sessions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey.trim()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          const err = new Error(`Failed to parse Stripe API response: ${data}`);
          err.statusCode = res.statusCode || 502;
          return reject(err);
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            success: true,
            sessionId: json.id,
            url: json.url,
            plan: plan
          });
        } else {
          const stripeError = json.error || {};
          const err = new Error(stripeError.message || `Stripe API error (${res.statusCode})`);
          err.code = stripeError.code || "STRIPE_API_ERROR";
          err.statusCode = res.statusCode || 500;
          err.stripeError = stripeError;
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Stripe-Signature ヘッダの HMAC-SHA256 署名検証
 * 署名フォーマット: t=timestamp,v1=signature[,v1=signature2...]
 * rawBody: 文字列またはBuffer
 */
function verifyStripeSignature(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!webhookSecret || typeof webhookSecret !== 'string') {
    return { valid: false, error: "Missing or invalid STRIPE_WEBHOOK_SECRET" };
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, error: "Missing Stripe-Signature header" };
  }
  if (rawBody === undefined || rawBody === null) {
    return { valid: false, error: "Missing raw request body" };
  }

  const rawStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);

  // パース: t=..., v1=...
  const parts = signatureHeader.split(',').map(p => p.trim());
  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 't') {
      timestamp = val;
    } else if (key === 'v1') {
      signatures.push(val);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return { valid: false, error: "Malformed Stripe-Signature header: timestamp (t) or signature (v1) missing" };
  }

  // タイムスタンプの許容時間チェック（Replay Attack 対策）
  if (toleranceSec > 0) {
    const tsSec = parseInt(timestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (isNaN(tsSec) || Math.abs(nowSec - tsSec) > toleranceSec) {
      return { valid: false, error: `Timestamp outside tolerance window (${toleranceSec}s)` };
    }
  }

  // 署名対象ペイロード: `${timestamp}.${rawStr}`
  const signedPayload = `${timestamp}.${rawStr}`;
  const expectedSignatureHex = crypto
    .createHmac('sha256', webhookSecret.trim())
    .update(signedPayload, 'utf8')
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignatureHex, 'utf8');

  // いずれかの v1 署名と timingSafeEqual で一致するか照合
  let matched = false;
  for (const sig of signatures) {
    const sigBuffer = Buffer.from(sig, 'utf8');
    if (sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    return { valid: false, error: "Signature mismatch" };
  }

  return {
    valid: true,
    timestamp: parseInt(timestamp, 10)
  };
}

/**
 * テスト用署名生成ヘルパー（単体テストやQA用）
 */
function generateTestSignature({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  const rawStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedPayload = `${timestamp}.${rawStr}`;
  const signatureHex = crypto
    .createHmac('sha256', secret.trim())
    .update(signedPayload, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signatureHex}`;
}

module.exports = {
  CHARGE_PLANS,
  getChargePlan,
  buildCheckoutPayload,
  createStripeCheckoutSession,
  verifyStripeSignature,
  generateTestSignature
};
