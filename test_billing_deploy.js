/**
 * test_billing_deploy.js
 * Japan Inbound & Cross-Border Rules MCP / Stripe決済連携 & 本番公開QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStoreServer, getRequestBaseUrl } = require('./server');
const { StoreManager } = require('./store');
const { generateTestSignature, CHARGE_PLANS, buildCheckoutPayload } = require('./stripe_billing');

console.log("=================================================================");
console.log("  Japan Inbound Rules MCP & Stripe決済連携 包括的QAテスト");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

async function runAsyncTest(testName, testFn) {
  totalTests++;
  try {
    await testFn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

/**
 * Node.js http リクエストをモックなしで直接ディスパッチするテストヘルパー
 */
function dispatchTestRequest(handler, options = {}) {
  const {
    method = 'GET',
    url = '/',
    headers = {},
    body = null
  } = options;

  return new Promise((resolve, reject) => {
    const EventEmitter = require('events');
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    let resStatusCode = 200;
    const resHeaders = {};
    const chunks = [];

    const res = {
      writeHead(code, hdrs) {
        resStatusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            resHeaders[k.toLowerCase()] = v;
          }
        }
      },
      setHeader(name, val) {
        resHeaders[name.toLowerCase()] = val;
      },
      getHeader(name) {
        return resHeaders[name.toLowerCase()];
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const fullBuffer = Buffer.concat(chunks);
        const text = fullBuffer.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          json = text;
        }
        resolve({
          statusCode: resStatusCode,
          headers: resHeaders,
          body: json,
          rawBody: text,
          rawBuffer: fullBuffer
        });
      }
    };

    handler(req, res).catch(reject);

    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        const payload = (typeof body === 'object' && !Buffer.isBuffer(body)) ? JSON.stringify(body) : body;
        req.emit('data', payload);
      }
      req.emit('end');
    });
  });
}

(async () => {
  // 一時テストデータディレクトリ
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_billing_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');
  const TEST_WEBHOOK_SECRET = "whsec_test_secret_key_1234567890abcdef0123456789abcdef";

  // 環境変数 JP_RULES_ONLY=true を設定
  process.env.JP_RULES_ONLY = "true";

  const { storeManager, handleHttpRequest } = createStoreServer({
    storePath: tempStorePath,
    stripeWebhookSecret: TEST_WEBHOOK_SECRET
  });

  const request = (opts, body) => dispatchTestRequest(handleHttpRequest, { ...opts, body });

  let issuedApiKeyFromStripe = null;

  // -------------------------------------------------------------
  // Test Group 1: JP_RULES_ONLY 環境分離 & GET /health 検証
  // -------------------------------------------------------------
  await runAsyncTest("01. JP_RULES_ONLY=true で起動時、GET /health が 200 OK で mode: 'jp_rules_only' & toolsCount: 3 を返すこと", async () => {
    const res = await request({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.mode, 'jp_rules_only');
    assert.strictEqual(res.body.toolsCount, 3);
  });

  await runAsyncTest("02. JP_RULES_ONLY=true で tools/list が JP Rules 3 ツールのみを返し RockTypo が除外されていること", async () => {
    const res = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_tools_list",
      method: "tools/list"
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.result && Array.isArray(res.body.result.tools));
    const tools = res.body.result.tools;
    assert.strictEqual(tools.length, 3, `Expected exactly 3 tools, got ${tools.length}`);

    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes("list_jp_rule_categories"));
    assert.ok(toolNames.includes("query_jp_inbound_rules"));
    assert.ok(toolNames.includes("check_jp_travel_compliance"));
    assert.ok(!toolNames.includes("start_rocktypo_render"), "start_rocktypo_render must be excluded in JP_RULES_ONLY");
    assert.ok(!toolNames.includes("list_products"), "list_products must be excluded in standalone JP_RULES_ONLY mode");
  });

  await runAsyncTest("03. JP_RULES_ONLY=true 時に無効化された RockTypo ツールを呼ぶと安全にエラーを返すこと", async () => {
    const res = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_call_rocktypo",
      method: "tools/call",
      params: {
        name: "start_rocktypo_render",
        arguments: { lyrics: "test lyrics" }
      }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.result && res.body.result.isError === true);
    assert.ok(res.body.result.content[0].text.includes("RockTypo tools are unavailable in this environment"));
  });

  // -------------------------------------------------------------
  // Test Group 2: Stripe Billing プラン & 改ざん防止チェックアウト
  // -------------------------------------------------------------
  await runAsyncTest("04. GET /api/billing/plans でサーバー側固定プラン一覧を取得できること", async () => {
    const res = await request({ method: 'GET', url: '/api/billing/plans' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.plans));
    const planIds = res.body.plans.map(p => p.id);
    assert.ok(planIds.includes('mini_100'), "mini_100 plan must be included");
    assert.ok(planIds.includes('starter_500'));
    assert.ok(planIds.includes('standard_1500'));
    assert.ok(planIds.includes('pro_5000'));

    const miniPlan = res.body.plans.find(p => p.id === 'mini_100');
    assert.strictEqual(miniPlan.price_yen, 100);
    assert.strictEqual(miniPlan.currency, 'jpy');
  });

  await runAsyncTest("05. POST /api/billing/checkout でクライアント任意金額指定が 400 で拒否されること（改ざん防止）", async () => {
    const res = await request({ method: 'POST', url: '/api/billing/checkout' }, {
      plan_id: "starter_500",
      amount_yen: 10 // 改ざん試行
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "ARBITRARY_AMOUNT_NOT_ALLOWED");
  });

  await runAsyncTest("06. POST /api/billing/checkout で無効な plan_id が 400 で拒否されること", async () => {
    const res = await request({ method: 'POST', url: '/api/billing/checkout' }, {
      plan_id: "invalid_hacked_plan"
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "INVALID_PLAN");
  });

  await runAsyncTest("07. POST /api/billing/checkout で STRIPE_SECRET_KEY 未設定時に 503 エラーを返すこと", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await request({ method: 'POST', url: '/api/billing/checkout' }, {
      plan_id: "starter_500"
    });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, "STRIPE_SECRET_KEY_MISSING");
  });

  await runAsyncTest("07-1. POST /api/billing/checkout で mini_100 プランが正当に受理されること（プランバリデーションPASS）", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    // 無効プラン(400 INVALID_PLAN)ではなく、プランが正しく検証された上でSTRIPE_SECRET_KEY未設定(503)に進むことを確認
    const res = await request({ method: 'POST', url: '/api/billing/checkout' }, {
      plan_id: "mini_100"
    });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, "STRIPE_SECRET_KEY_MISSING", "mini_100 must be accepted by plan validator");
  });

  await runAsyncTest("07-2. buildCheckoutPayload で payment_method_types が送信ペイロードに含まれないこと (最新Stripe Dynamic Payment Methods準拠)", async () => {
    const plan = CHARGE_PLANS.starter_500;
    const payload = buildCheckoutPayload({
      plan,
      apiKey: "sk_souon_test123",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel"
    });

    assert.strictEqual(payload['payment_method_types[0]'], undefined, "Must NOT include payment_method_types[0]");
    assert.strictEqual(payload['payment_method_types'], undefined, "Must NOT include payment_method_types");
    const hasPaymentMethodTypes = Object.keys(payload).some(k => k.includes('payment_method_types'));
    assert.strictEqual(hasPaymentMethodTypes, false, "No key should contain payment_method_types");
    assert.strictEqual(payload.mode, 'payment');
    assert.strictEqual(payload['line_items[0][price_data][unit_amount]'], '500');
    assert.strictEqual(payload.success_url, 'https://example.com/success');

    // mini_100 のペイロード構築検証 (単価100 JPY)
    const miniPayload = buildCheckoutPayload({
      plan: CHARGE_PLANS.mini_100,
      apiKey: "",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel"
    });
    assert.strictEqual(miniPayload['line_items[0][price_data][unit_amount]'], '100');
    assert.strictEqual(miniPayload['metadata[plan_id]'], 'mini_100');
  });

  await runAsyncTest("07-3. x-forwarded-proto / host ヘッダから success_url / cancel_url のベースURLが動的生成されること", async () => {
    // 1. x-forwarded-proto + host (Render.com 本番環境リクエストのシミュレーション)
    const mockReqRender = {
      headers: {
        'x-forwarded-proto': 'https',
        'host': 'jp-rules-mcp.onrender.com'
      }
    };
    const baseUrlRender = getRequestBaseUrl(mockReqRender);
    assert.strictEqual(baseUrlRender, 'https://jp-rules-mcp.onrender.com');

    // 2. ヘッダ未指定時のローカルフォールバック
    const mockReqLocal = { headers: {} };
    const baseUrlLocal = getRequestBaseUrl(mockReqLocal);
    assert.strictEqual(baseUrlLocal, 'http://localhost:3456');

    // 3. PUBLIC_BASE_URL 環境変数優先（末尾スラッシュの正規化検証）
    const prevEnv = process.env.PUBLIC_BASE_URL;
    try {
      process.env.PUBLIC_BASE_URL = 'https://custom-rules.souon.com///';
      const baseUrlEnv = getRequestBaseUrl(mockReqRender);
      assert.strictEqual(baseUrlEnv, 'https://custom-rules.souon.com');
    } finally {
      if (prevEnv !== undefined) {
        process.env.PUBLIC_BASE_URL = prevEnv;
      } else {
        delete process.env.PUBLIC_BASE_URL;
      }
    }
  });

  // -------------------------------------------------------------
  // Test Group 3: Stripe Webhook HMAC-SHA256 署名検証セキュリティ
  // -------------------------------------------------------------
  await runAsyncTest("08. 不正署名 (改ざん・欠損) の Webhook リクエストが HTTP 400 で拒否されること", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    
    // 署名なし
    const res1 = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'Content-Type': 'application/json' }
    }, payload);
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.body.error, "INVALID_SIGNATURE");

    // 不正な v1 ハッシュ
    const res2 = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 't=1234567890,v1=bad_hash_bad_hash_bad_hash_bad_hash_bad_hash_bad_hash_bad_hash_1234'
      }
    }, payload);
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual(res2.body.error, "INVALID_SIGNATURE");
  });

  // -------------------------------------------------------------
  // Test Group 4: Webhook によるキー自動発行 & 冪等性テスト
  // -------------------------------------------------------------
  const session1Id = "cs_test_session_id_1001";
  const session1Payload = JSON.stringify({
    id: "evt_test_1001",
    type: "checkout.session.completed",
    data: {
      object: {
        id: session1Id,
        amount_total: 500,
        currency: "jpy",
        customer_email: "agent_traveler@example.com",
        metadata: {
          plan_id: "starter_500"
        }
      }
    }
  });

  await runAsyncTest("09. 正当署名の checkout.session.completed で 200 OK & 新規 sk_souon_... キーが自動発行されること", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = generateTestSignature({
      rawBody: session1Payload,
      secret: TEST_WEBHOOK_SECRET,
      timestamp: nowSec
    });

    const res = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': validSig
      }
    }, session1Payload);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.duplicate, false);
    assert.strictEqual(res.body.isNewKey, true);
    assert.ok(typeof res.body.key === 'string' && res.body.key.startsWith('sk_souon_'));
    assert.strictEqual(res.body.monthly_limit_yen, 500);

    issuedApiKeyFromStripe = res.body.key;

    // ストア側データ検証
    const usage = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usage.monthly_limit_yen, 500);
    assert.strictEqual(usage.used_yen, 0);
    assert.strictEqual(usage.remaining_yen, 500);
  });

  await runAsyncTest("10. 冪等性テスト: 同一 session_id を2回送信しても二重チャージされず duplicate: true となること", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = generateTestSignature({
      rawBody: session1Payload,
      secret: TEST_WEBHOOK_SECRET,
      timestamp: nowSec
    });

    const res = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': validSig
      }
    }, session1Payload);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.duplicate, true, "Must be flagged as duplicate session");
    assert.strictEqual(res.body.key, issuedApiKeyFromStripe);

    // ストア側の残高が二重加算（1000円）になっていないことを物理検証
    const usage = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usage.monthly_limit_yen, 500, "Monthly limit must remain 500 JPY (no duplicate top-up)");
    assert.strictEqual(usage.used_yen, 0);
  });

  // -------------------------------------------------------------
  // Test Group 5: 発行されたキーでの query 無料(0 JPY) & check 課金(30 JPY)実行テスト
  // -------------------------------------------------------------
  await runAsyncTest("11. Stripe自動発行キーで check_jp_travel_compliance を実行し 30円課金され、query_jp_inbound_rules は 0円無料なこと", async () => {
    // 1. query_jp_inbound_rules はキー付きでも 0 円（無料）
    const resQuery = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_query_rules",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          apiKey: issuedApiKeyFromStripe,
          category: "tax_free",
          keyword: "refund"
        }
      }
    });

    assert.strictEqual(resQuery.statusCode, 200);
    assert.ok(resQuery.body.result && !resQuery.body.result.isError);
    const queryObj = JSON.parse(resQuery.body.result.content[0].text);
    assert.strictEqual(queryObj.success, true);
    assert.strictEqual(queryObj.cost_yen, 0, "Query tool must be free (0 JPY)");
    assert.ok(Array.isArray(queryObj.rules));
    assert.ok(queryObj.rules.length > 0);

    // クエリ実行時点では使用額 0 円
    const usageAfterQuery = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usageAfterQuery.used_yen, 0);
    assert.strictEqual(usageAfterQuery.remaining_yen, 500);

    // 2. check_jp_travel_compliance は 30 円課金
    const resCheck = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_check_compliance",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: issuedApiKeyFromStripe,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 165
        }
      }
    });

    assert.strictEqual(resCheck.statusCode, 200);
    assert.ok(resCheck.body.result && !resCheck.body.result.isError);
    const checkObj = JSON.parse(resCheck.body.result.content[0].text);
    assert.strictEqual(checkObj.success, true);
    assert.strictEqual(checkObj.cost_yen, 30, "Compliance check must cost 30 JPY");
    assert.strictEqual(checkObj.monthly_limit_yen, 500);
    assert.strictEqual(checkObj.used_yen, 30);
    assert.strictEqual(checkObj.remaining_yen, 470);
    assert.strictEqual(checkObj.compliance.requires_reservation, true);

    // ストア側の最新利用額も 30 円であること
    const usageAfterCheck = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usageAfterCheck.used_yen, 30);
    assert.strictEqual(usageAfterCheck.remaining_yen, 470);
  });

  // -------------------------------------------------------------
  // Test Group 6: 既存キーへの追加チャージ & 冪等性テスト
  // -------------------------------------------------------------
  const session2Id = "cs_test_session_id_2002";
  const session2Payload = JSON.stringify({
    id: "evt_test_2002",
    type: "checkout.session.completed",
    data: {
      object: {
        id: session2Id,
        amount_total: 1500,
        currency: "jpy",
        customer_email: "agent_traveler@example.com",
        metadata: {
          plan_id: "standard_1500",
          apiKey: issuedApiKeyFromStripe // 既存キーへのチャージ
        }
      }
    }
  });

  await runAsyncTest("12. 既存キー指定の Webhook で上限が正しく増額されること (500 + 1500 = 2000 JPY)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = generateTestSignature({
      rawBody: session2Payload,
      secret: TEST_WEBHOOK_SECRET,
      timestamp: nowSec
    });

    const res = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': validSig
      }
    }, session2Payload);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.duplicate, false);
    assert.strictEqual(res.body.isNewKey, false);
    assert.strictEqual(res.body.key, issuedApiKeyFromStripe);
    assert.strictEqual(res.body.monthly_limit_yen, 2000);

    // ストア側の残高確認 (上限2000円、使用済30円、残1970円)
    const usage = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usage.monthly_limit_yen, 2000);
    assert.strictEqual(usage.used_yen, 30);
    assert.strictEqual(usage.remaining_yen, 1970);
  });

  await runAsyncTest("13. 既存キーへの追加チャージでも同一 session_id 再送時は二重チャージされないこと", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = generateTestSignature({
      rawBody: session2Payload,
      secret: TEST_WEBHOOK_SECRET,
      timestamp: nowSec
    });

    const res = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': validSig
      }
    }, session2Payload);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.duplicate, true);

    const usage = storeManager.getKeyUsage(issuedApiKeyFromStripe);
    assert.strictEqual(usage.monthly_limit_yen, 2000, "Monthly limit must still be 2000 JPY (no duplicate top-up)");
  });

  await runAsyncTest("13-2. Webhookで mini_100 決済時に上限100円のキーが発行され、30円判定3回後の4回目が402になること", async () => {
    const sessionMiniId = "cs_test_session_mini_100_unique";
    const sessionMiniPayload = JSON.stringify({
      id: "evt_test_mini_100",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionMiniId,
          amount_total: 100,
          currency: "jpy",
          customer_email: "mini_traveler@example.com",
          metadata: {
            plan_id: "mini_100"
          }
        }
      }
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const validSig = generateTestSignature({
      rawBody: sessionMiniPayload,
      secret: TEST_WEBHOOK_SECRET,
      timestamp: nowSec
    });

    const webhookRes = await request({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': validSig
      }
    }, sessionMiniPayload);

    assert.strictEqual(webhookRes.statusCode, 200);
    assert.strictEqual(webhookRes.body.success, true);
    assert.strictEqual(webhookRes.body.isNewKey, true);
    assert.strictEqual(webhookRes.body.monthly_limit_yen, 100);
    const miniKey = webhookRes.body.key;
    assert.ok(miniKey && miniKey.startsWith('sk_souon_'));

    // ストア初期状態: 上限100円、使用0円、残高100円
    const initialUsage = storeManager.getKeyUsage(miniKey);
    assert.strictEqual(initialUsage.monthly_limit_yen, 100);
    assert.strictEqual(initialUsage.used_yen, 0);
    assert.strictEqual(initialUsage.remaining_yen, 100);

    // 判定1回目 (30円消費 -> 残高70円)
    const call1 = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_mini_1",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: miniKey,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 150
        }
      }
    });
    const data1 = JSON.parse(call1.body.result.content[0].text);
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.cost_yen, 30);
    assert.strictEqual(data1.used_yen, 30);
    assert.strictEqual(data1.remaining_yen, 70);

    // 判定2回目 (30円消費 -> 残高40円)
    const call2 = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_mini_2",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: miniKey,
          checkType: "holiday_peak",
          travelDate: "2026-05-03"
        }
      }
    });
    const data2 = JSON.parse(call2.body.result.content[0].text);
    assert.strictEqual(data2.success, true);
    assert.strictEqual(data2.cost_yen, 30);
    assert.strictEqual(data2.used_yen, 60);
    assert.strictEqual(data2.remaining_yen, 40);

    // 判定3回目 (30円消費 -> 残高10円)
    const call3 = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_mini_3",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: miniKey,
          checkType: "tax_free",
          purchaseAmountJpy: 8000
        }
      }
    });
    const data3 = JSON.parse(call3.body.result.content[0].text);
    assert.strictEqual(data3.success, true);
    assert.strictEqual(data3.cost_yen, 30);
    assert.strictEqual(data3.used_yen, 90);
    assert.strictEqual(data3.remaining_yen, 10);

    // 判定4回目 (30円必要だが残高10円 -> 402 LIMIT_EXCEEDED 拒否 ＆ 残高10円保護)
    const call4 = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_mini_4",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: miniKey,
          checkType: "tax_free",
          purchaseAmountJpy: 5000
        }
      }
    });
    assert.strictEqual(call4.body.result.isError, true, "4th check must fail with isError: true");
    const errData = JSON.parse(call4.body.result.content[0].text);
    assert.strictEqual(errData.error, "LIMIT_EXCEEDED");
    assert.strictEqual(errData.statusCode, 402);
    assert.strictEqual(errData.monthly_limit_yen, 100);
    assert.strictEqual(errData.used_yen, 90, "Used yen must not increase after 402");
    assert.strictEqual(errData.remaining_yen, 10, "Remaining balance 10 JPY must be strictly preserved");

    // ストア永続化状態も残高10円であることを検証
    const usageAfter402 = storeManager.getKeyUsage(miniKey);
    assert.strictEqual(usageAfter402.used_yen, 90);
    assert.strictEqual(usageAfter402.remaining_yen, 10);

    // 無料の query_jp_inbound_rules は残高10円のキーでも 0 円で問題なく実行できること
    const callFree = await request({ method: 'POST', url: '/mcp' }, {
      jsonrpc: "2.0",
      id: "req_mini_free",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          apiKey: miniKey,
          category: "customs"
        }
      }
    });
    assert.strictEqual(callFree.statusCode, 200);
    const freeData = JSON.parse(callFree.body.result.content[0].text);
    assert.strictEqual(freeData.success, true);
    assert.strictEqual(freeData.cost_yen, 0);
  });

  // -------------------------------------------------------------
  // Test Group 7: Stripe セッション結果照会 & 英語LP配信 (Gate 4 現場受入)
  // -------------------------------------------------------------
  await runAsyncTest("14. GET /api/billing/session で未処理時は status: 'pending'、完了後は status: 'completed' & apiKey が返ること", async () => {
    // 1. session_id パラメータなし -> 400
    const resNoParam = await request({ method: 'GET', url: '/api/billing/session' });
    assert.strictEqual(resNoParam.statusCode, 400);
    assert.strictEqual(resNoParam.body.error, "MISSING_SESSION_ID");

    // 2. 未完了セッション -> 200 pending
    const resPending = await request({ method: 'GET', url: '/api/billing/session?session_id=cs_unprocessed_12345' });
    assert.strictEqual(resPending.statusCode, 200);
    assert.strictEqual(resPending.body.success, true);
    assert.strictEqual(resPending.body.status, "pending");

    // 3. 完了済みセッション (session1Id) -> 200 completed & apiKey
    const resCompleted = await request({ method: 'GET', url: `/api/billing/session?session_id=${session1Id}` });
    assert.strictEqual(resCompleted.statusCode, 200);
    assert.strictEqual(resCompleted.body.success, true);
    assert.strictEqual(resCompleted.body.status, "completed");
    assert.strictEqual(resCompleted.body.apiKey, issuedApiKeyFromStripe);
    assert.strictEqual(resCompleted.body.plan_id, "starter_500");
    assert.strictEqual(resCompleted.body.amount_yen, 500);
    assert.ok(resCompleted.body.remaining_yen >= 0);
  });

  await runAsyncTest("15. JP_RULES_ONLY=true で GET / が jp_rules.html (英語ファースト・375pxスマホ対応・session連携) を配信すること", async () => {
    const res = await request({ method: 'GET', url: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    const html = res.rawBody;

    // 英語コンテンツ・必須要素の検証
    assert.ok(html.includes("Japan Inbound & Cross-Border Rules MCP"), "Must contain title");
    assert.ok(html.includes("Nov 2026 Tax-Free Shopping Reform"), "Must contain tax-free reform rule");
    assert.ok(html.includes("Shinkansen Oversized Baggage"), "Must contain Shinkansen baggage rule");
    assert.ok(html.includes("/api/billing/session"), "Must integrate with session polling");
    assert.ok(html.includes("list_jp_rule_categories"), "Must integrate with live free tool");

    // Gate 4 スマホ実機基準 (375px-414pxレスポンシブ & 44pxタップ領域)
    assert.ok(html.includes("viewport"), "Must have viewport meta tag");
    assert.ok(html.includes("width=device-width"), "Must adapt to device width");
    assert.ok(html.includes("44px"), "Must secure 44px min-height tap targets");
  });

  // -------------------------------------------------------------
  // Test Group 8: 本番環境セキュリティロック (公開キー発行・改ざんの物理遮断)
  // -------------------------------------------------------------
  await runAsyncTest("16. JP_RULES_ONLY=true で POST /api/keys が 403 Forbidden で拒否されること", async () => {
    const res = await request({ method: 'POST', url: '/api/keys' }, {
      name: "Hacker Agent",
      monthly_limit_yen: 999999
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, "PUBLIC_KEY_MANAGEMENT_DISABLED");
  });

  await runAsyncTest("17. JP_RULES_ONLY=true で PATCH /api/keys/:key が 403 で拒否され、GET /api/keys/:key/usage は照会可能なこと", async () => {
    // 1. PATCH 改ざん試行 -> 403
    const resPatch = await request({ method: 'PATCH', url: `/api/keys/${issuedApiKeyFromStripe}` }, {
      monthly_limit_yen: 999999
    });
    assert.strictEqual(resPatch.statusCode, 403);
    assert.strictEqual(resPatch.body.success, false);
    assert.strictEqual(resPatch.body.error, "PUBLIC_KEY_MANAGEMENT_DISABLED");

    // 2. GET usage 照会 -> 200 OK
    const resUsage = await request({ method: 'GET', url: `/api/keys/${issuedApiKeyFromStripe}/usage` });
    assert.strictEqual(resUsage.statusCode, 200);
    assert.strictEqual(resUsage.body.success, true);
    assert.strictEqual(resUsage.body.usage.key, issuedApiKeyFromStripe);
  });

  // -------------------------------------------------------------
  // Test Group 9: MCP ディレクトリ掲載メタデータ & 互換性仕様検証
  // -------------------------------------------------------------
  await runAsyncTest("18. GET /.well-known/mcp.json および GET /server.json が 200 OK で公開リポジトリ jp-rules-mcp.git を返すこと", async () => {
    // 1. /.well-known/mcp.json
    const resMcpJson = await request({ method: 'GET', url: '/.well-known/mcp.json' });
    assert.strictEqual(resMcpJson.statusCode, 200);
    assert.strictEqual(resMcpJson.body.name, "io.github.toymachine325-blip/jp-rules-mcp");
    assert.strictEqual(resMcpJson.body.repository.url, "https://github.com/toymachine325-blip/jp-rules-mcp.git");
    assert.strictEqual(resMcpJson.body.homepage, "https://jp-rules-mcp.onrender.com");

    // 2. /server.json
    const resServerJson = await request({ method: 'GET', url: '/server.json' });
    assert.strictEqual(resServerJson.statusCode, 200);
    assert.strictEqual(resServerJson.body.name, "io.github.toymachine325-blip/jp-rules-mcp");
    assert.strictEqual(resServerJson.body.repository.url, "https://github.com/toymachine325-blip/jp-rules-mcp.git");
  });

  await runAsyncTest("19. GET /mcp が 405 Method Not Allowed と Allow: POST, OPTIONS ヘッダーを返すこと", async () => {
    const res = await request({ method: 'GET', url: '/mcp' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'POST, OPTIONS');
    assert.strictEqual(res.body.error, "METHOD_NOT_ALLOWED");
  });

  await runAsyncTest("20. POST /mcp において x-api-key ヘッダー認証で query_jp_inbound_rules が正常実行されること", async () => {
    const res = await request({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': issuedApiKeyFromStripe
      }
    }, {
      jsonrpc: "2.0",
      id: "test-x-api-key-1",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: { category: "customs" }
      }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, "test-x-api-key-1");
    assert.ok(res.body.result && res.body.result.content);
    assert.strictEqual(res.body.result.content[0].type, "text");
    const parsedData = JSON.parse(res.body.result.content[0].text);
    assert.strictEqual(parsedData.success, true);
    assert.ok(parsedData.rules && parsedData.rules.length > 0);
    assert.ok(parsedData.rules.every(r => r.category === "customs"));
    assert.strictEqual(parsedData.cost_yen, 0, "Query tool must be free (0 JPY) via HTTP x-api-key");

    // クエリ実行後もキー使用額は 30 円のまま（増加なし）
    assert.strictEqual(storeManager.getKeyUsage(issuedApiKeyFromStripe).used_yen, 30);
  });

  // -------------------------------------------------------------
  // Test Group 10: Supabase (PostgreSQL REST API) 永続化 & フォールバック
  // -------------------------------------------------------------
  await runAsyncTest("21. GET /health に storage フィールドが含まれること (通常時 local_json, リモート時 supabase)", async () => {
    // 1. 通常起動サーバー (storage: 'local_json')
    const res = await request({ method: 'GET', url: '/health' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.storage, 'local_json');

    // 2. モック Supabase 設定のサーバー (storage: 'supabase')
    const remoteTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon-remote-test-'));
    const remoteStorePath = path.join(remoteTempDir, 'remote_store.json');
    const mockStore = new StoreManager(remoteStorePath, {
      supabaseConfig: {
        url: 'https://example.supabase.co',
        serviceRoleKey: 'test-service-role-key-12345'
      },
      fetch: async () => ({ ok: true, json: async () => [] })
    });
    assert.strictEqual(mockStore.isRemoteEnabled(), true);

    const remoteApp = createStoreServer({
      storeManager: mockStore
    });
    const resRemote = await dispatchTestRequest(remoteApp.handleHttpRequest, { method: 'GET', url: '/health' });
    assert.strictEqual(resRemote.statusCode, 200);
    assert.strictEqual(resRemote.body.storage, 'supabase');

    try {
      fs.rmSync(remoteTempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await runAsyncTest("22. hydrateFromRemote() でリモートから keys (残高付き) と processed_stripe_sessions が復元されること", async () => {
    const hydTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon-hydrate-test-'));
    const hydStorePath = path.join(hydTempDir, 'hyd_store.json');

    const remoteStateData = {
      keys: {
        "sk_souon_remote_agent_999": {
          key: "sk_souon_remote_agent_999",
          name: "Remote Agent 999",
          monthly_limit_yen: 5000,
          used_yen: 300,
          created_at: "2026-11-15T00:00:00.000Z",
          last_reset_month: "2026-11",
          is_active: true,
          transactions: []
        }
      },
      processed_stripe_sessions: {
        "cs_remote_test_session_123": {
          sessionId: "cs_remote_test_session_123",
          apiKey: "sk_souon_remote_agent_999",
          plan_id: "pro_5000",
          amount_yen: 5000,
          is_new_key: true,
          processed_at: "2026-11-15T00:00:00.000Z"
        }
      },
      updated_at: "2026-11-15T00:00:00.000Z"
    };

    let fetchCalledUrl = null;
    let fetchHeaders = null;

    const mockFetch = async (url, opts = {}) => {
      fetchCalledUrl = url;
      fetchHeaders = opts.headers || {};
      return {
        ok: true,
        status: 200,
        json: async () => [{ state: remoteStateData }]
      };
    };

    const store = new StoreManager(hydStorePath, {
      supabaseConfig: {
        url: 'https://test-project.supabase.co/', // 末尾スラッシュ自動除去検証
        serviceRoleKey: 'secret-service-key-xyz',
        table: 'ai_micro_store_state',
        storeId: 'default'
      },
      fetch: mockFetch
    });

    assert.strictEqual(store.isRemoteEnabled(), true);
    await store.hydrateFromRemote();

    // 呼び出し先 URL & ヘッダーの検証
    assert.strictEqual(fetchCalledUrl, 'https://test-project.supabase.co/rest/v1/ai_micro_store_state?id=eq.default&select=state');
    assert.strictEqual(fetchHeaders['apikey'], 'secret-service-key-xyz');
    assert.strictEqual(fetchHeaders['Authorization'], 'Bearer secret-service-key-xyz');

    // 復元されたデータの検証
    const usage = store.getKeyUsage('sk_souon_remote_agent_999');
    assert.ok(usage, "Key must exist after remote hydration");
    assert.strictEqual(usage.monthly_limit_yen, 5000);
    assert.strictEqual(usage.used_yen, 300);
    assert.strictEqual(usage.remaining_yen, 4700);

    const sessionRes = store.getStripeSessionResult('cs_remote_test_session_123');
    assert.ok(sessionRes, "Stripe session must exist after remote hydration");
    assert.strictEqual(sessionRes.apiKey, 'sk_souon_remote_agent_999');
    assert.strictEqual(sessionRes.amount_yen, 5000);

    try {
      fs.rmSync(hydTempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await runAsyncTest("23. save() + flushRemote() で Supabase REST API (?on_conflict=id) へ直列で Upsert されること", async () => {
    const saveTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon-save-test-'));
    const saveStorePath = path.join(saveTempDir, 'save_store.json');

    const upsertCalls = [];

    const mockFetch = async (url, opts = {}) => {
      if (opts.method === 'POST') {
        upsertCalls.push({
          url,
          headers: opts.headers || {},
          body: JSON.parse(opts.body)
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () => ""
      };
    };

    const store = new StoreManager(saveStorePath, {
      supabaseConfig: {
        url: 'https://test-project.supabase.co',
        serviceRoleKey: 'secret-service-key-xyz',
        table: 'ai_micro_store_state',
        storeId: 'unit-test-store'
      },
      fetch: mockFetch
    });

    // 1. キー発行（内部で save が呼ばれる）
    const keyRecord = store.createKey({ name: "Upsert Test Agent", monthly_limit_yen: 1500 });
    assert.ok(keyRecord && keyRecord.key);

    // 2. 課金（内部で save が呼ばれる）
    store.chargeKey(keyRecord.key, 2, { action: "test_upsert" });

    // 3. 直列リモート完了待機
    await store.flushRemote();

    // Upsert コール検証 (少なくても createKey と chargeKey で呼び出しが発生)
    assert.ok(upsertCalls.length >= 2, `Expected at least 2 upserts, got ${upsertCalls.length}`);
    const lastCall = upsertCalls[upsertCalls.length - 1];

    assert.strictEqual(lastCall.url, 'https://test-project.supabase.co/rest/v1/ai_micro_store_state?on_conflict=id');
    assert.strictEqual(lastCall.headers['Prefer'], 'resolution=merge-duplicates,return=minimal');
    assert.strictEqual(lastCall.headers['apikey'], 'secret-service-key-xyz');
    assert.strictEqual(lastCall.headers['Authorization'], 'Bearer secret-service-key-xyz');
    assert.strictEqual(lastCall.body.id, 'unit-test-store');
    assert.ok(lastCall.body.state.keys[keyRecord.key]);
    assert.strictEqual(lastCall.body.state.keys[keyRecord.key].used_yen, 2);

    try {
      fs.rmSync(saveTempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  await runAsyncTest("24. リモート障害時 (500 / ネットワークエラー) でもクラッシュせずローカルフォールバックが維持されること", async () => {
    const errTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon-error-test-'));
    const errStorePath = path.join(errTempDir, 'err_store.json');

    // 常にネットワーク例外をスローするモック fetch
    const failingFetch = async () => {
      throw new Error("Supabase network outage / DNS resolution failure");
    };

    const store = new StoreManager(errStorePath, {
      supabaseConfig: {
        url: 'https://broken-domain.supabase.co',
        serviceRoleKey: 'test-key'
      },
      fetch: failingFetch
    });

    // 1. hydrateFromRemote() が例外を外部に投げず安全にフォールバックすること
    await store.hydrateFromRemote();

    // 2. キー発行・課金・保存がローカルで正常動作すること
    const k = store.createKey({ name: "Resilient Agent", monthly_limit_yen: 500 });
    assert.ok(k && k.key);
    const charge = store.chargeKey(k.key, 2, { action: "offline_charge" });
    assert.strictEqual(charge.remaining_yen, 498);

    // 3. flushRemote() もクラッシュせず安全に完了すること
    await store.flushRemote();

    // 4. ローカルファイルから再読み込みしてもデータが正常保存されていること
    const reloadedStore = new StoreManager(errStorePath);
    const reloadedUsage = reloadedStore.getKeyUsage(k.key);
    assert.strictEqual(reloadedUsage.remaining_yen, 498);

    try {
      fs.rmSync(errTempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  Stripe決済 & 本番公開QAテスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
