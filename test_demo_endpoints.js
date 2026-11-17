/**
 * test_demo_endpoints.js
 * 創音知能 AI Micro Store - 無料ライブデモ API & UI 包括的QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');

console.log("=================================================================");
console.log("  無料ライブデモ API & ショップ UI 包括的QAテスト");
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

function isPng(buf) {
  return Buffer.isBuffer(buf) &&
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) &&
    buf.length >= 5 &&
    buf.slice(0, 5).toString('ascii') === '%PDF-';
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_demo_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');

  const testStore = new StoreManager(tempStorePath);
  const testServer = createStoreServer({ storePath: tempStorePath, storeManager: testStore });
  const httpReq = (opts, body) => dispatchTestRequest(testServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

  // -------------------------------------------------------------
  // Test 01: POST /api/demo/ogp 200 OK・image/png・PNGマジックバイト検証
  // -------------------------------------------------------------
  await runAsyncTest("01. POST /api/demo/ogp が 200 OK・image/png・PNGマジックバイトを返すこと", async () => {
    const res = await httpReq({
      method: 'POST',
      url: '/api/demo/ogp',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '192.0.2.1'
      }
    }, {
      title: "ライブデモ OGP テストタイトル",
      subtitle: "ブラウザから即座に生成できる無料プレビュー",
      theme: "cyber_neon",
      size: "ogp"
    });

    assert.strictEqual(res.statusCode, 200, "Must return 200 OK");
    assert.strictEqual(res.headers['content-type'], 'image/png');
    assert.ok(isPng(res.rawBuffer), "Must return valid PNG binary starting with 89 50 4E 47");
    assert.ok(res.rawBuffer.length > 5000, `Buffer size must be realistic (got ${res.rawBuffer.length} bytes)`);
  });

  // -------------------------------------------------------------
  // Test 02: POST /api/demo/pdf 200 OK・application/pdf・%PDF- 検証
  // -------------------------------------------------------------
  await runAsyncTest("02. POST /api/demo/pdf が 200 OK・application/pdf・%PDF- を返すこと", async () => {
    const res = await httpReq({
      method: 'POST',
      url: '/api/demo/pdf',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '192.0.2.2'
      }
    }, {
      markdown: "# ライブデモ PDF テスト\n> これは無料プレビューのテストです。\n- 項目1\n- 項目2",
      theme: "business_report",
      title: "デモプレビュー"
    });

    assert.strictEqual(res.statusCode, 200, "Must return 200 OK");
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.ok(isPdf(res.rawBuffer), "Must return valid PDF binary starting with %PDF-");
    assert.ok(res.rawBuffer.length > 1000);
  });

  // -------------------------------------------------------------
  // Test 03: PDF デモで 1,500文字超過時に 400 エラーが返ること
  // -------------------------------------------------------------
  await runAsyncTest("03. PDF デモで 1,500文字超過時に 400 エラーが返ること", async () => {
    const longMarkdown = "# Long Document\n" + "A".repeat(1501);

    const res = await httpReq({
      method: 'POST',
      url: '/api/demo/pdf',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '192.0.2.3'
      }
    }, {
      markdown: longMarkdown
    });

    assert.strictEqual(res.statusCode, 400, "Exceeding 1500 chars must return 400");
    assert.strictEqual(res.body.error, "BAD_REQUEST");
    assert.ok(res.body.message.includes("1,500 characters"), "Error message must mention 1,500 characters limit");
  });

  // -------------------------------------------------------------
  // Test 04: デモ IP レート制限超過時に 429 と Retry-After が返ること
  // -------------------------------------------------------------
  await runAsyncTest("04. デモ IP レート制限超過時に 429 と Retry-After が返ること", async () => {
    const rateLimitedServer = createStoreServer({
      storePath: tempStorePath,
      demoRateLimitMaxRequests: 2,
      demoRateLimitWindowMs: 60000
    });
    const throttledReq = (opts, body) => dispatchTestRequest(rateLimitedServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

    const clientIp = '198.51.100.77';

    // 1回目 (200 OK)
    const res1 = await throttledReq({
      method: 'POST',
      url: '/api/demo/ogp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp }
    }, { title: "Demo 1" });
    assert.strictEqual(res1.statusCode, 200);

    // 2回目 (200 OK)
    const res2 = await throttledReq({
      method: 'POST',
      url: '/api/demo/ogp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp }
    }, { title: "Demo 2" });
    assert.strictEqual(res2.statusCode, 200);

    // 3回目 (超過 -> 429)
    const res3 = await throttledReq({
      method: 'POST',
      url: '/api/demo/ogp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp }
    }, { title: "Demo 3" });

    assert.strictEqual(res3.statusCode, 429, "Exceeded request must return HTTP 429");
    assert.ok(res3.headers['retry-after'], "Must contain Retry-After header");
    const retryAfter = parseInt(res3.headers['retry-after'], 10);
    assert.ok(!isNaN(retryAfter) && retryAfter >= 1);
    assert.strictEqual(res3.body.error, "RATE_LIMIT_EXCEEDED");
    assert.ok(res3.body.message.includes("Demo rate limit exceeded"));
  });

  // -------------------------------------------------------------
  // Test 05: JP_RULES_ONLY=true 時はデモエンドポイントが 403 で拒否されること
  // -------------------------------------------------------------
  await runAsyncTest("05. JP_RULES_ONLY=true 時はデモエンドポイントが 403 で拒否されること", async () => {
    const prevEnv = process.env.JP_RULES_ONLY;
    try {
      process.env.JP_RULES_ONLY = 'true';
      const jpServer = createStoreServer({ storePath: tempStorePath });

      // OGP デモ
      const resOgp = await dispatchTestRequest(jpServer.handleHttpRequest, {
        method: 'POST',
        url: '/api/demo/ogp',
        headers: { 'Content-Type': 'application/json' },
        body: { title: "Should Fail" }
      });
      assert.strictEqual(resOgp.statusCode, 403, "JP_RULES_ONLY must block /api/demo/ogp with 403");
      assert.strictEqual(resOgp.body.error, "FORBIDDEN");

      // PDF デモ
      const resPdf = await dispatchTestRequest(jpServer.handleHttpRequest, {
        method: 'POST',
        url: '/api/demo/pdf',
        headers: { 'Content-Type': 'application/json' },
        body: { markdown: "# Should Fail" }
      });
      assert.strictEqual(resPdf.statusCode, 403, "JP_RULES_ONLY must block /api/demo/pdf with 403");
      assert.strictEqual(resPdf.body.error, "FORBIDDEN");
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_ONLY = prevEnv;
      } else {
        delete process.env.JP_RULES_ONLY;
      }
    }
  });

  // -------------------------------------------------------------
  // Test 06: GET / の index.html にライブデモ UI が含まれること
  // -------------------------------------------------------------
  await runAsyncTest("06. GET / の index.html にライブデモ UI が含まれること", async () => {
    const res = await httpReq({ method: 'GET', url: '/' });
    assert.strictEqual(res.statusCode, 200);
    const html = res.rawBody;

    // OGP デモ要素
    assert.ok(html.includes("demo-ogp-preview"), "Must contain #demo-ogp-preview image element");
    assert.ok(html.includes("btn-run-demo-ogp"), "Must contain #btn-run-demo-ogp button");
    assert.ok(html.includes("demo-ogp-theme"), "Must contain #demo-ogp-theme select");
    assert.ok(html.includes("demo-ogp-size"), "Must contain #demo-ogp-size select");

    // PDF デモ要素
    assert.ok(html.includes("demo-pdf-markdown"), "Must contain #demo-pdf-markdown textarea");
    assert.ok(html.includes("btn-run-demo-pdf"), "Must contain #btn-run-demo-pdf button");
    assert.ok(html.includes("demo-pdf-theme"), "Must contain #demo-pdf-theme select");

    // スマホ実機基準
    assert.ok(html.includes("min-height: 44px"), "Buttons must have 44px min-height");
    assert.ok(html.includes("max-width: 100%"), "Preview image must adapt to width");
  });

  // -------------------------------------------------------------
  // Test 07: POST /api/demo/temp-mail が 200 OK でクラッシュせずダミーメールの otp_codes を返すこと
  // -------------------------------------------------------------
  await runAsyncTest("07. POST /api/demo/temp-mail が 200 OK でクラッシュせずダミーメールの otp_codes を返すこと", async () => {
    const res = await httpReq({
      method: 'POST',
      url: '/api/demo/temp-mail',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '192.0.2.77'
      }
    }, {});

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.demo, true);
    assert.ok(res.body.inbox_id && res.body.inbox_id.startsWith('inb_'));
    assert.ok(res.body.email && res.body.email.startsWith('agent-'));
    assert.ok(res.body.latest_otp, "Must extract and return latest_otp");
    assert.ok(Array.isArray(res.body.all_otps) && res.body.all_otps.length > 0);
    assert.ok(Array.isArray(res.body.verification_links) && res.body.verification_links.length > 0);
  });

  // -------------------------------------------------------------
  // Test 08: ダミーの未登録 API キー付き POST /mcp リクエストでも IP レート制限（429）が発動すること
  // -------------------------------------------------------------
  await runAsyncTest("08. ダミーの未登録 API キー付き POST /mcp リクエストでも IP レート制限（429）が発動すること", async () => {
    const fakeKeyThrottledServer = createStoreServer({
      storePath: tempStorePath,
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 60000
    });
    const throttledMcpReq = (opts, body) => dispatchTestRequest(fakeKeyThrottledServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

    const attackerIp = '203.0.113.88';
    const fakeKey = 'sk_souon_fake_dummy_unregistered_key';

    // 1回目 (200 OK)
    const r1 = await throttledMcpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': attackerIp, 'x-api-key': fakeKey }
    }, { jsonrpc: "2.0", id: "fake_1", method: "tools/call", params: { name: "list_jp_rule_categories", arguments: {} } });
    assert.strictEqual(r1.statusCode, 200);

    // 2回目 (200 OK)
    const r2 = await throttledMcpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': attackerIp, 'x-api-key': fakeKey }
    }, { jsonrpc: "2.0", id: "fake_2", method: "tools/call", params: { name: "list_jp_rule_categories", arguments: {} } });
    assert.strictEqual(r2.statusCode, 200);

    // 3回目 (ダミーキーではレート制限バイパスできず 429 Throttled)
    const r3 = await throttledMcpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': attackerIp, 'x-api-key': fakeKey }
    }, { jsonrpc: "2.0", id: "fake_3", method: "tools/call", params: { name: "list_jp_rule_categories", arguments: {} } });

    assert.strictEqual(r3.statusCode, 429, "Fake key must not bypass free tier IP rate limit");
    assert.ok(r3.headers['retry-after']);
    assert.strictEqual(r3.body.error.code, -32029);
  });

  // -------------------------------------------------------------
  // Test 09: JP_RULES_ONLY=true 時に GET /api/products, POST /api/purchase, MCP list_products が遮断されること
  // -------------------------------------------------------------
  await runAsyncTest("09. JP_RULES_ONLY=true 時に GET /api/products, POST /api/purchase, MCP list_products が遮断されること", async () => {
    const prevEnv = process.env.JP_RULES_ONLY;
    try {
      process.env.JP_RULES_ONLY = 'true';
      const jpServer = createStoreServer({ storePath: tempStorePath });
      const jpReq = (opts, body) => dispatchTestRequest(jpServer.handleHttpRequest, body !== undefined ? { ...opts, body } : opts);

      // 1. GET /api/products -> 403
      const prodRes = await jpReq({ method: 'GET', url: '/api/products' });
      assert.strictEqual(prodRes.statusCode, 403);
      assert.strictEqual(prodRes.body.error, "FORBIDDEN");

      // 2. POST /api/purchase -> 403
      const purRes = await jpReq({ method: 'POST', url: '/api/purchase' }, { product_id: "drums-8beat-midi" });
      assert.strictEqual(purRes.statusCode, 403);
      assert.strictEqual(purRes.body.error, "FORBIDDEN");

      // 3. MCP tools/call list_products -> isError: true
      const mcpRes = await jpReq({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: "req_mcp_list_prod",
        method: "tools/call",
        params: { name: "list_products", arguments: {} }
      });
      assert.strictEqual(mcpRes.statusCode, 200);
      assert.ok(mcpRes.body.result && mcpRes.body.result.isError);
      assert.ok(mcpRes.body.result.content[0].text.includes("unavailable in JP_RULES_ONLY mode"));
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_ONLY = prevEnv;
      } else {
        delete process.env.JP_RULES_ONLY;
      }
    }
  });

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  無料ライブデモテスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
