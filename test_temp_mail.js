/**
 * test_temp_mail.js
 * 創音知能 AI Micro Store - 使い捨てメール受信＆OTP・認証リンク抽出 (temp_mail) 包括的QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TempMailManager, extractOtpAndLinks } = require('./temp_mail');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');

console.log("=================================================================");
console.log("  使い捨てメール受信＆OTP抽出 (temp_mail) 包括的QAテスト");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

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

function dispatchTestRequest(handler, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const url = options.url || '/';
    const headers = options.headers || {};
    const body = options.body;

    const { EventEmitter } = require('events');
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { ...headers };

    let resStatusCode = 200;
    const resHeaders = {};
    const resChunks = [];

    const res = {
      writeHead(statusCode, hdrs = {}) {
        resStatusCode = statusCode;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
      },
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v;
      },
      write(chunk) {
        if (chunk) {
          resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      },
      end(chunk) {
        if (chunk) {
          resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const fullBuffer = Buffer.concat(resChunks);
        const text = fullBuffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = text; }
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_temp_mail_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');

  const testStore = new StoreManager(tempStorePath);
  const testServer = createStoreServer({
    storePath: tempStorePath,
    storeManager: testStore,
    tempMailWebhookSecret: "test_secret_12345"
  });
  const httpReq = (opts, body) => dispatchTestRequest(testServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

  // テスト用APIキー発行（月額上限 100 JPY）
  const keyResult = testStore.createKey({ name: "TempMail Agent", monthly_limit_yen: 100 });
  const testApiKey = keyResult.key;

  // -------------------------------------------------------------
  // Test 01: extractOtpAndLinks で日英メール本文から OTP コードと確認 URL が正確に抽出されること
  // -------------------------------------------------------------
  runTest("01. extractOtpAndLinks で日英メール本文から OTP コードと確認 URL が正確に抽出されること", () => {
    const textJa = "創音知能をご利用ありがとうございます。\n認証コード：839201 です。有効期限は10分間です。\n以下のリンクをクリックして本人確認を完了してください：\nhttps://auth.souon.local/verify?token=secure123\n以上。";
    const htmlEn = "<p>Your security code is <strong>482910</strong>.</p><p>Alternatively, click <a href=\"https://api.partner.com/confirm/user?id=9988\">Confirm Account</a> to continue.</p>";

    const res = extractOtpAndLinks(textJa, htmlEn);
    assert.ok(Array.isArray(res.otpCodes), "otpCodes must be array");
    assert.ok(res.otpCodes.includes("839201"), "Must extract Japanese 認証コード 839201");
    assert.ok(res.otpCodes.includes("482910"), "Must extract English security code 482910");

    assert.ok(Array.isArray(res.verificationLinks), "verificationLinks must be array");
    assert.ok(res.verificationLinks.some(l => l.includes("verify?token=secure123")), "Must extract Japanese verify link");
    assert.ok(res.verificationLinks.some(l => l.includes("confirm/user?id=9988")), "Must extract English confirm link");
  });

  // -------------------------------------------------------------
  // Test 02: POST /mcp (create_temp_inbox) で 10 JPY 課金され、残高不足時は 402 LIMIT_EXCEEDED で拒否されること
  // -------------------------------------------------------------
  let createdInboxId = null;
  let createdEmail = null;

  await runAsyncTest("02. POST /mcp (create_temp_inbox) で 10 JPY 課金され、残高不足時は 402 LIMIT_EXCEEDED で拒否されること", async () => {
    const prevUsed = testStore.getKeyUsage(testApiKey).used_yen;

    // 1. tools/list に create_temp_inbox & read_temp_inbox が存在すること
    const listRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' }
    }, {
      jsonrpc: "2.0",
      id: "req_tools_list_mail",
      method: "tools/list"
    });
    assert.strictEqual(listRes.statusCode, 200);
    const tools = listRes.body.result?.tools || [];
    assert.ok(tools.some(t => t.name === "create_temp_inbox"), "create_temp_inbox must be listed");
    assert.ok(tools.some(t => t.name === "read_temp_inbox"), "read_temp_inbox must be listed");

    // 2. create_temp_inbox 呼び出し (10 JPY 課金)
    const callRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': testApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_create_inbox",
      method: "tools/call",
      params: {
        name: "create_temp_inbox",
        arguments: {}
      }
    });

    assert.strictEqual(callRes.statusCode, 200);
    assert.ok(callRes.body.result && !callRes.body.result.isError);
    const data = JSON.parse(callRes.body.result.content[0].text);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.cost_yen, 10, "Cost must be 10 JPY");
    assert.strictEqual(data.used_yen, prevUsed + 10);
    assert.strictEqual(data.remaining_yen, 100 - (prevUsed + 10));
    assert.ok(data.inbox_id && data.inbox_id.startsWith('inb_'));
    assert.ok(data.email && data.email.startsWith('agent-'));
    assert.strictEqual(data.ttl_minutes, 30);

    createdInboxId = data.inbox_id;
    createdEmail = data.email;

    // 3. 残高不足時の 402 LIMIT_EXCEEDED ロック検証
    const tightKeyResult = testStore.createKey({ name: "Tight Budget Agent", monthly_limit_yen: 5 });
    const tightApiKey = tightKeyResult.key;

    const tightRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': tightApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_tight_inbox",
      method: "tools/call",
      params: {
        name: "create_temp_inbox",
        arguments: {}
      }
    });

    assert.strictEqual(tightRes.statusCode, 200);
    assert.ok(tightRes.body.result && tightRes.body.result.isError);
    const errData = JSON.parse(tightRes.body.result.content[0].text);
    assert.strictEqual(errData.error, "LIMIT_EXCEEDED");
    assert.strictEqual(errData.statusCode, 402);
    assert.strictEqual(errData.used_yen, 0, "Used yen must not increase after 402");
    assert.strictEqual(errData.remaining_yen, 5, "Remaining balance must be protected");
  });

  // -------------------------------------------------------------
  // Test 03: POST /api/temp-mail/inbound で受信後、read_temp_inbox (0 JPY) で OTP とリンクが取得でき残高が減らないこと
  // -------------------------------------------------------------
  await runAsyncTest("03. POST /api/temp-mail/inbound で受信後、read_temp_inbox (0 JPY) で OTP とリンクが取得でき残高が減らないこと", async () => {
    assert.ok(createdInboxId && createdEmail, "Must have valid created inbox from test 02");

    // 1. Webhook からメール受信
    const inboundRes = await httpReq({
      method: 'POST',
      url: '/api/temp-mail/inbound',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': 'test_secret_12345'
      }
    }, {
      to: `Agent <${createdEmail}>`,
      from: "auth@developer-platform.org",
      subject: "Your Activation PIN Code",
      text: "Hello! Your registration PIN code is 918234. Please activate your account here: https://developer-platform.org/activate?code=918234"
    });

    assert.strictEqual(inboundRes.statusCode, 200);
    assert.strictEqual(inboundRes.body.success, true);
    assert.strictEqual(inboundRes.body.accepted, true);
    assert.strictEqual(inboundRes.body.inbox_id, createdInboxId);

    // 2. read_temp_inbox を呼んでメールと OTP を取得 (0 JPY)
    const usageBefore = testStore.getKeyUsage(testApiKey);

    const readRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': testApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_read_inbox",
      method: "tools/call",
      params: {
        name: "read_temp_inbox",
        arguments: {
          inbox_id: createdInboxId
        }
      }
    });

    assert.strictEqual(readRes.statusCode, 200);
    assert.ok(readRes.body.result && !readRes.body.result.isError);
    const readData = JSON.parse(readRes.body.result.content[0].text);
    assert.strictEqual(readData.success, true);
    assert.strictEqual(readData.cost_yen, 0, "Reading inbox must be completely free (0 JPY)");
    assert.strictEqual(readData.inbox_id, createdInboxId);
    assert.strictEqual(readData.total_emails, 1);
    assert.strictEqual(readData.latest_otp, "918234", "Must extract latest OTP code 918234");
    assert.ok(readData.verification_links.some(l => l.includes("/activate?code=918234")), "Must extract verification link");

    // 残高が一切減っていないことの物理検証
    const usageAfter = testStore.getKeyUsage(testApiKey);
    assert.strictEqual(usageAfter.used_yen, usageBefore.used_yen);
    assert.strictEqual(usageAfter.remaining_yen, usageBefore.remaining_yen);
  });

  // -------------------------------------------------------------
  // Test 04: 他人の API キーからは inbox_id を読めないこと（アクセス制御）
  // -------------------------------------------------------------
  await runAsyncTest("04. 他人の API キーからは inbox_id を読めないこと（アクセス制御）", async () => {
    // 別のエージェントキーを発行
    const hackerKeyResult = testStore.createKey({ name: "Another Hacker Agent", monthly_limit_yen: 50 });
    const hackerApiKey = hackerKeyResult.key;

    const readRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': hackerApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_hacker_read",
      method: "tools/call",
      params: {
        name: "read_temp_inbox",
        arguments: {
          inbox_id: createdInboxId
        }
      }
    });

    assert.strictEqual(readRes.statusCode, 200);
    assert.ok(readRes.body.result && readRes.body.result.isError, "Must be rejected with isError: true");
    const errData = JSON.parse(readRes.body.result.content[0].text);
    assert.strictEqual(errData.statusCode, 403, "Access to another user's inbox must return 403 Forbidden");
    assert.strictEqual(errData.error, "FORBIDDEN");
    assert.ok(errData.message.includes("You do not own this inbox"));
  });

  // -------------------------------------------------------------
  // Test 05: TEMP_MAIL_WEBHOOK_SECRET 設定時に不正シークレットが 401 で拒否され、TTL 期限切れ inbox が自動消去されること
  // -------------------------------------------------------------
  await runAsyncTest("05. TEMP_MAIL_WEBHOOK_SECRET 設定時に不正シークレットが 401 で拒否され、TTL 期限切れ inbox が自動消去されること", async () => {
    // 1. 不正な x-webhook-secret ヘッダー -> 401
    const invalidSecretRes = await httpReq({
      method: 'POST',
      url: '/api/temp-mail/inbound',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': 'wrong_invalid_secret'
      }
    }, {
      to: createdEmail,
      from: "attacker@bad.org",
      subject: "Spam",
      text: "Malicious payload"
    });

    assert.strictEqual(invalidSecretRes.statusCode, 401, "Invalid webhook secret must be rejected with 401");
    assert.strictEqual(invalidSecretRes.body.error, "UNAUTHORIZED");

    // 2. TTL 短縮インボックスの自動期限切れ・消去検証
    const shortTtlServer = createStoreServer({
      storePath: tempStorePath,
      tempMailOptions: { ttlMs: 50 } // 50ms 超短命
    });
    const shortReq = (opts, body) => dispatchTestRequest(shortTtlServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

    // インボックス作成
    const createRes = await shortReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': testApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_short_inbox",
      method: "tools/call",
      params: { name: "create_temp_inbox", arguments: {} }
    });
    const shortInboxData = JSON.parse(createRes.body.result.content[0].text);
    const shortInboxId = shortInboxData.inbox_id;

    // 70ms 待機して TTL 超過させる
    await new Promise(r => setTimeout(r, 70));

    // 読み取り照会 -> 404 (期限切れパージ済み)
    const readExpiredRes = await shortReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-api-key': testApiKey }
    }, {
      jsonrpc: "2.0",
      id: "req_read_expired",
      method: "tools/call",
      params: { name: "read_temp_inbox", arguments: { inbox_id: shortInboxId } }
    });

    assert.strictEqual(readExpiredRes.statusCode, 200);
    assert.ok(readExpiredRes.body.result && readExpiredRes.body.result.isError);
    const expiredData = JSON.parse(readExpiredRes.body.result.content[0].text);
    assert.strictEqual(expiredData.statusCode, 404, "Expired inbox must return 404");
  });

  // -------------------------------------------------------------
  // Test 06: JP_RULES_ONLY=true 時は create_temp_inbox / read_temp_inbox が除外・拒否されること
  // -------------------------------------------------------------
  await runAsyncTest("06. JP_RULES_ONLY=true 時は create_temp_inbox / read_temp_inbox が除外・拒否されること", async () => {
    const prevEnv = process.env.JP_RULES_ONLY;
    try {
      process.env.JP_RULES_ONLY = 'true';
      const jpOnlyServer = createStoreServer({ storePath: tempStorePath });

      // 1. tools/list に含まれないこと
      const listRes = await dispatchTestRequest(jpOnlyServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' },
        body: { jsonrpc: "2.0", id: "req_jp_list_mail", method: "tools/list" }
      });
      assert.strictEqual(listRes.statusCode, 200);
      const tools = listRes.body.result?.tools || [];
      assert.strictEqual(tools.some(t => t.name === "create_temp_inbox"), false, "create_temp_inbox must not be in JP_RULES_ONLY");
      assert.strictEqual(tools.some(t => t.name === "read_temp_inbox"), false, "read_temp_inbox must not be in JP_RULES_ONLY");

      // 2. tools/call 実行が拒否されること
      const callRes = await dispatchTestRequest(jpOnlyServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json', 'x-api-key': testApiKey },
        body: {
          jsonrpc: "2.0",
          id: "req_jp_call_mail",
          method: "tools/call",
          params: { name: "create_temp_inbox", arguments: {} }
        }
      });
      assert.strictEqual(callRes.statusCode, 200);
      assert.ok(callRes.body.result && callRes.body.result.isError);
      assert.ok(callRes.body.result.content[0].text.includes("unavailable in JP_RULES_ONLY mode"));

      // 3. POST /api/temp-mail/inbound が 403 で拒否されること
      const inboundRes = await dispatchTestRequest(jpOnlyServer.handleHttpRequest, {
        method: 'POST',
        url: '/api/temp-mail/inbound',
        headers: { 'Content-Type': 'application/json' },
        body: { to: "test@example.com", text: "Test" }
      });
      assert.strictEqual(inboundRes.statusCode, 403, "Inbound webhook must be 403 in JP_RULES_ONLY");
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_ONLY = prevEnv;
      } else {
        delete process.env.JP_RULES_ONLY;
      }
    }
  });

  // -------------------------------------------------------------
  // Test 07: receiveInboundEmail(null) がクラッシュせず安全に処理されること
  // -------------------------------------------------------------
  runTest("07. receiveInboundEmail(null) および receiveInboundEmail(undefined) がクラッシュせず安全に処理されること", () => {
    const mgr = new TempMailManager();
    const resNull = mgr.receiveInboundEmail(null);
    assert.strictEqual(resNull.accepted, false);
    assert.strictEqual(resNull.reason, "Missing 'to' address");

    const resUndefined = mgr.receiveInboundEmail(undefined);
    assert.strictEqual(resUndefined.accepted, false);
    assert.strictEqual(resUndefined.reason, "Missing 'to' address");
  });

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  使い捨てメール (temp_mail) テスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
