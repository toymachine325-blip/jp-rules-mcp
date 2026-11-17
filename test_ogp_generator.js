/**
 * test_ogp_generator.js
 * 創音知能 AI Micro Store - OGP・サムネイル画像生成ツール (generate_ogp_image) 包括的QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateOgpImageBuffer, THEMES, SIZES } = require('./ogp_generator');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');

console.log("=================================================================");
console.log("  OGP・サムネイル画像生成ツール (generate_ogp_image) 包括的QAテスト");
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

function isPngHeader(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A;
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_ogp_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');

  const testStore = new StoreManager(tempStorePath);
  const testServer = createStoreServer({ storePath: tempStorePath, storeManager: testStore });
  const httpReq = (opts, body) => dispatchTestRequest(testServer.handleHttpRequest, { ...opts, body });

  // テスト用APIキー発行（月額上限 100 JPY）
  const keyResult = testStore.createKey({ name: "OGP Test Agent", monthly_limit_yen: 100 });
  const testApiKey = keyResult.key;

  // -------------------------------------------------------------
  // Test 01: 日英混在タイトル & XML 特殊文字からの有効な PNG 生成検証
  // -------------------------------------------------------------
  await runAsyncTest("01. 日英混在タイトル(XML特殊文字 & < > \" ' 含む)から PNG マジックバイトで始まる有効な PNG が生成されること", async () => {
    const res = await generateOgpImageBuffer({
      title: "【新曲リリース】Rock & Roll <Cyber> \"AI\" '2026' 判定 & 爆誕！",
      subtitle: "創音知能 & AI Micro Store - 次世代の自律調達 & OGPエンジン",
      badge: "ROCK & TECH",
      author: "創音知能 • Souon Chinou & Ravy",
      theme: "cyber_neon",
      size: "ogp"
    });

    assert.ok(Buffer.isBuffer(res.buffer), "Must return Buffer");
    assert.ok(isPngHeader(res.buffer), "Buffer must begin with valid PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)");
    assert.strictEqual(res.width, 1200);
    assert.strictEqual(res.height, 630);
    assert.ok(res.size_bytes > 5000, `PNG size must be substantial (got ${res.size_bytes} bytes)`);
    assert.strictEqual(res.size_bytes, res.buffer.length);
  });

  // -------------------------------------------------------------
  // Test 02: 3テーマ (cyber_neon, clean_minimal, bold_editorial) & 3サイズ検証
  // -------------------------------------------------------------
  await runAsyncTest("02. 3テーマ (cyber_neon, clean_minimal, bold_editorial) と 3サイズ (ogp, youtube, square) で正常生成されること", async () => {
    const themesToTest = ['cyber_neon', 'clean_minimal', 'bold_editorial'];
    const sizesToTest = ['ogp', 'youtube', 'square'];

    for (const theme of themesToTest) {
      for (const size of sizesToTest) {
        const expectedDims = SIZES[size];
        const res = await generateOgpImageBuffer({
          title: `テーマ検証: ${theme} - ${size}`,
          subtitle: `Size: ${expectedDims.width}x${expectedDims.height}`,
          badge: "QA VERIFIED",
          theme,
          size
        });

        assert.ok(isPngHeader(res.buffer), `Theme ${theme} ${size} must output valid PNG header`);
        assert.strictEqual(res.width, expectedDims.width, `Width must match ${expectedDims.width}`);
        assert.strictEqual(res.height, expectedDims.height, `Height must match ${expectedDims.height}`);
        assert.strictEqual(res.theme, theme);
        assert.strictEqual(res.size, size);
        assert.ok(res.size_bytes > 3000);
      }
    }
  });

  // -------------------------------------------------------------
  // Test 03: POST /mcp 経由での 10 JPY 課金 & /api/download/:tx_id PNG ダウンロード検証
  // -------------------------------------------------------------
  await runAsyncTest("03. POST /mcp で 10 JPY 課金され、/api/download/:tx_id から image/png バイナリが取得できること", async () => {
    const prevUsed = testStore.getKeyUsage(testApiKey).used_yen;

    // 1. tools/list に generate_ogp_image が存在すること
    const listRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' }
    }, {
      jsonrpc: "2.0",
      id: "req_list_tools_ogp",
      method: "tools/list"
    });
    assert.strictEqual(listRes.statusCode, 200);
    const tools = listRes.body.result?.tools || [];
    const ogpTool = tools.find(t => t.name === "generate_ogp_image");
    assert.ok(ogpTool, "generate_ogp_image must be listed in tools/list");
    assert.ok(ogpTool.description.includes("10 JPY"), "Description must state 10 JPY price");
    assert.deepStrictEqual(ogpTool.inputSchema.required, ["title"]);

    // 2. tools/call generate_ogp_image 呼び出し
    const callRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': testApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "req_gen_ogp",
      method: "tools/call",
      params: {
        name: "generate_ogp_image",
        arguments: {
          title: "AI商取引の未来：自律エージェントのマイクロ決済",
          subtitle: "月額お小遣い上限ガードで安全にAPIやデジタル素材を調達",
          badge: "RELEASE",
          theme: "cyber_neon",
          size: "ogp"
        }
      }
    });

    assert.strictEqual(callRes.statusCode, 200);
    assert.ok(callRes.body.result && !callRes.body.result.isError, "OGP generation call must succeed");
    const data = JSON.parse(callRes.body.result.content[0].text);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.cost_yen, 10, "Cost must be exactly 10 JPY");
    assert.strictEqual(data.used_yen, prevUsed + 10, "Used yen must increase by 10");
    assert.strictEqual(data.remaining_yen, 100 - (prevUsed + 10));
    assert.ok(data.tx_id, "Transaction ID must be returned");
    assert.ok(data.download_url.startsWith('/api/download/'), "Must return download_url");
    assert.ok(data.filename.endsWith('.png'), "Filename must end with .png");
    assert.strictEqual(data.width, 1200);
    assert.strictEqual(data.height, 630);
    assert.strictEqual(data.theme, "cyber_neon");
    assert.ok(data.size_bytes > 5000);

    // 3. /api/download/:tx_id からバイナリ直接ダウンロード検証
    const dlRes = await httpReq({
      method: 'GET',
      url: data.download_url
    });

    assert.strictEqual(dlRes.statusCode, 200);
    assert.strictEqual(dlRes.headers['content-type'], 'image/png', "Content-Type must be image/png");
    assert.ok(dlRes.headers['content-disposition'].includes('.png'), "Content-Disposition must contain .png");
    assert.ok(isPngHeader(dlRes.rawBuffer), "Downloaded buffer must be a valid PNG binary");
    assert.strictEqual(dlRes.rawBuffer.length, data.size_bytes, "Downloaded bytes must match reported size_bytes");
  });

  // -------------------------------------------------------------
  // Test 04: 残高不足時の 402 LIMIT_EXCEEDED 拒否と残高保護
  // -------------------------------------------------------------
  await runAsyncTest("04. 残高不足時に 402 LIMIT_EXCEEDED で拒否され残高が減らないこと", async () => {
    // 上限 5 JPY のキー（10 JPY の OGP 生成に足りない）
    const tightKeyResult = testStore.createKey({ name: "Tight Budget Agent OGP", monthly_limit_yen: 5 });
    const tightApiKey = tightKeyResult.key;

    const res = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': tightApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "req_tight_ogp",
      method: "tools/call",
      params: {
        name: "generate_ogp_image",
        arguments: {
          title: "This Should Fail Due To Limit"
        }
      }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.result && res.body.result.isError, "Limit exceeded must return isError: true");
    const errData = JSON.parse(res.body.result.content[0].text);
    assert.strictEqual(errData.error, "LIMIT_EXCEEDED");
    assert.strictEqual(errData.statusCode, 402);
    assert.strictEqual(errData.monthly_limit_yen, 5);
    assert.strictEqual(errData.used_yen, 0, "Used yen must not increase");
    assert.strictEqual(errData.remaining_yen, 5, "Remaining balance must be unchanged");

    // ストア側の永続化状態も保護されていること
    const usage = testStore.getKeyUsage(tightApiKey);
    assert.strictEqual(usage.used_yen, 0);
    assert.strictEqual(usage.remaining_yen, 5);
  });

  // -------------------------------------------------------------
  // Test 05: JP_RULES_ONLY=true 時の隔離検証
  // -------------------------------------------------------------
  await runAsyncTest("05. JP_RULES_ONLY=true 時は generate_ogp_image が tools/list に含まれず実行も拒否されること", async () => {
    const prevEnv = process.env.JP_RULES_ONLY;
    try {
      process.env.JP_RULES_ONLY = 'true';
      const jpOnlyServer = createStoreServer({ storePath: tempStorePath });

      // 1. tools/list に含まれないこと
      const listRes = await dispatchTestRequest(jpOnlyServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' },
        body: {
          jsonrpc: "2.0",
          id: "req_jp_list_ogp",
          method: "tools/list"
        }
      });
      assert.strictEqual(listRes.statusCode, 200);
      const tools = listRes.body.result?.tools || [];
      const hasOgpTool = tools.some(t => t.name === "generate_ogp_image");
      assert.strictEqual(hasOgpTool, false, "generate_ogp_image must NOT be listed in JP_RULES_ONLY mode");

      // 2. tools/call 実行が拒否されること
      const callRes = await dispatchTestRequest(jpOnlyServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': testApiKey
        },
        body: {
          jsonrpc: "2.0",
          id: "req_jp_call_ogp",
          method: "tools/call",
          params: {
            name: "generate_ogp_image",
            arguments: { title: "Should Be Denied in JP_RULES_ONLY" }
          }
        }
      });
      assert.strictEqual(callRes.statusCode, 200);
      assert.ok(callRes.body.result && callRes.body.result.isError, "Must return isError in JP_RULES_ONLY mode");
      const errText = callRes.body.result.content[0].text;
      assert.ok(errText.includes("unavailable in JP_RULES_ONLY mode"));
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_ONLY = prevEnv;
      } else {
        delete process.env.JP_RULES_ONLY;
      }
    }
  });

  // -------------------------------------------------------------
  // Test 06: 絵文字（🚀🔥）入り長文タイトルで折り返し描画しても XML/Resvg エラーなく有効な PNG が生成されること
  // -------------------------------------------------------------
  await runAsyncTest("06. 絵文字（🚀🔥）入り長文タイトルで折り返し描画しても XML/Resvg エラーなく有効な PNG が生成されること", async () => {
    const emojiTitle = "🚀 爆速リリース！ AI Micro Store 🔥 自動生成エンジンがサロゲートペア対応完了 🎉 2026年最新版！";
    const res = await generateOgpImageBuffer({
      title: emojiTitle,
      subtitle: "絵文字とマルチバイト文字の安全なサロゲートペア境界切断防止テスト",
      badge: "EMOJI TEST 🚀",
      author: "創音知能 🎸",
      theme: "cyber_neon",
      size: "ogp"
    });

    assert.ok(isPngHeader(res.buffer), "Must return valid PNG header even with emoji");
    assert.strictEqual(res.width, 1200);
    assert.strictEqual(res.height, 630);
    assert.ok(res.size_bytes > 5000);
  });

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  OGP・サムネイル画像生成テスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
