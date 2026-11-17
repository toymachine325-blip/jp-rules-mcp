/**
 * test_store.js
 * 創音知能 AI Micro Store 包括的単体・統合テストスイート
 * ゼロ外部依存・純粋Node.jsインメモリディスパッチ実装（サンドボックス・CI完全互換）
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createStoreServer } = require('./server');

const TEST_DB_PATH = path.join(os.tmpdir(), `test_store_${process.pid}_${Date.now()}.json`);

// インメモリHTTPディスパッチャ（TCP不要・サンドボックス完全動作）
function dispatchTestRequest(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
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
          rawBuffer: fullBuffer,
          rawBody: text
        });
      }
    };

    // リクエストハンドラ呼び出し
    handler(req, res).catch(reject);

    // リクエストボディ配信
    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        const payload = (typeof body === 'object' && !Buffer.isBuffer(body)) ? JSON.stringify(body) : body;
        req.emit('data', payload);
      }
      req.emit('end');
    });
  });
}

// テストランナー
let passCount = 0;
let failCount = 0;
const testResults = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

async function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name} ... `);
  try {
    await fn();
    console.log("PASS");
    passCount++;
    testResults.push({ name, status: "PASS" });
  } catch (err) {
    console.log(`FAIL\n  -> ${err.message}`);
    failCount++;
    testResults.push({ name, status: "FAIL", error: err.message });
  }
}

async function main() {
  console.log("================================================================");
  console.log("  創音知能 AI Micro Store - Step 1 包括的技術QA検証");
  console.log("================================================================\n");

  // クリーンアップ
  if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
  }

  const { storeManager, handleHttpRequest } = createStoreServer({ storePath: TEST_DB_PATH });
  const request = (opts, body) => dispatchTestRequest(handleHttpRequest, { ...opts, body });

  let testApiKey = null;
  let drumsTxId = null;

  try {
    // 1. ヘルスチェック
    await runTest("01. ヘルスチェックエンドポイント (GET /health)", async () => {
      const res = await request({ method: 'GET', url: '/health' });
      assert(res.statusCode === 200, `Expected 200 but got ${res.statusCode}`);
      assert(res.body.status === 'ok', `Expected status 'ok'`);
      assert(res.body.service === 'souon-ai-micro-store', `Expected service name`);
    });

    // 2. 初期商品カタログ一覧取得
    await runTest("02. 初期3商品カタログの完全性 (GET /api/products)", async () => {
      const res = await request({ method: 'GET', url: '/api/products' });
      assert(res.statusCode === 200, `Expected 200 but got ${res.statusCode}`);
      assert(res.body.success === true, `Expected success true`);
      assert(res.body.products.length === 3, `Expected 3 products, got ${res.body.products.length}`);

      const p1 = res.body.products.find(p => p.id === 'drums-8beat-midi');
      const p2 = res.body.products.find(p => p.id === 'rocktypo-motion-json');
      const p3 = res.body.products.find(p => p.id === 'cyber-comic-prompts');

      assert(p1 && p1.price_yen === 30 && p1.type === 'api', "drums-8beat-midi invalid");
      assert(p2 && p2.price_yen === 50 && p2.type === 'api', "rocktypo-motion-json invalid");
      assert(p3 && p3.price_yen === 300 && p3.type === 'file', "cyber-comic-prompts invalid");
    });

    // 3. AIお小遣いキー発行（月額上限 100円）
    await runTest("03. AIお小遣いキー発行・月額100円上限設定 (POST /api/keys)", async () => {
      const res = await request({
        method: 'POST',
        url: '/api/keys',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: "Test Subagent 04",
        monthly_limit_yen: 100
      });

      assert(res.statusCode === 201, `Expected 201 but got ${res.statusCode}`);
      assert(res.body.success === true, "Expected success true");
      assert(res.body.key && res.body.key.key.startsWith('sk_souon_'), "Key format invalid");
      assert(res.body.key.monthly_limit_yen === 100, "Limit should be 100 yen");
      assert(res.body.key.used_yen === 0, "Used should start at 0");
      assert(res.body.key.is_active === true, "Key should be active");

      testApiKey = res.body.key.key;
    });

    // 4. キー利用状況照会
    await runTest("04. キー利用状況初期ステータス照会 (GET /api/keys/:key/usage)", async () => {
      const res = await request({ method: 'GET', url: `/api/keys/${testApiKey}/usage` });
      assert(res.statusCode === 200, `Expected 200 but got ${res.statusCode}`);
      assert(res.body.usage.monthly_limit_yen === 100, "Limit 100");
      assert(res.body.usage.used_yen === 0, "Used 0");
      assert(res.body.usage.remaining_yen === 100, "Remaining 100");
      assert(res.body.usage.transaction_count === 0, "Tx count 0");
    });

    // 5. 30円ドラムMIDI購入 ＆ SMF Type 0 バイナリ検証
    await runTest("05. 30円ドラムMIDI購入 ＆ SMF Type 0バイナリ・MThdヘッダ検証 (POST /api/purchase)", async () => {
      const res = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testApiKey}`
        }
      }, {
        product_id: 'drums-8beat-midi',
        params: { bpm: 125, bars: 8 }
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.success === true, "Expected success");
      assert(res.body.product.price_yen === 30, "Price 30 yen");
      assert(res.body.payment.used_yen === 30, "Used yen should be 30");
      assert(res.body.payment.remaining_yen === 70, "Remaining yen should be 70");

      drumsTxId = res.body.tx_id;
      assert(drumsTxId && drumsTxId.startsWith('tx_'), "Valid tx_id required");

      const data = res.body.data;
      assert(data.format === "SMF Type 0", "Format must be SMF Type 0");
      assert(data.bpm === 125, "BPM should match requested 125");
      assert(data.bars === 8, "Bars should match requested 8");

      // Base64デコードしてMIDIバイナリを検査
      const midiBuffer = Buffer.from(data.midi_base64, 'base64');
      assert(midiBuffer.length > 50, `MIDI size too small: ${midiBuffer.length}`);

      // SMF Header 検証 (MThd, 6, format 0, tracks 1, ppq 480)
      const headerStr = midiBuffer.toString('ascii', 0, 4);
      assert(headerStr === 'MThd', `Expected 'MThd' header but got ${headerStr}`);
      const headerLen = midiBuffer.readUInt32BE(4);
      assert(headerLen === 6, `Expected header length 6, got ${headerLen}`);
      const format = midiBuffer.readUInt16BE(8);
      assert(format === 0, `Expected SMF Format 0, got ${format}`);
      const tracks = midiBuffer.readUInt16BE(10);
      assert(tracks === 1, `Expected 1 track, got ${tracks}`);
      const ppq = midiBuffer.readUInt16BE(12);
      assert(ppq === 480, `Expected PPQ 480, got ${ppq}`);

      // MTrk チャンクヘッダ検証
      const trackHeaderStr = midiBuffer.toString('ascii', 14, 18);
      assert(trackHeaderStr === 'MTrk', `Expected 'MTrk' header but got ${trackHeaderStr}`);
    });

    // 6. MIDIファイルダウンロードエンドポイント検証
    await runTest("06. MIDIファイル直接ダウンロード検証 (GET /api/download/:tx_id)", async () => {
      const res = await request({
        method: 'GET',
        url: `/api/download/${drumsTxId}`
      });
      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.headers['content-type'] === 'audio/midi', "Content-Type must be audio/midi");
      const headerStr = res.rawBuffer.toString('ascii', 0, 4);
      assert(headerStr === 'MThd', "Downloaded file must begin with MThd");
    });

    // 7. 50円ロックタイポモーションJSON購入
    await runTest("07. 50円ロックタイポモーションJSON購入・キレキレ設定検証 (POST /api/purchase)", async () => {
      const res = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testApiKey}`
        }
      }, {
        product_id: 'rocktypo-motion-json',
        params: {
          lyrics: ["創音知能", "AIマイクロストア", "爆速デプロイ"],
          bpm: 160
        }
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.payment.used_yen === 80, `Cumulative used yen must be 80, got ${res.body.payment.used_yen}`);
      assert(res.body.payment.remaining_yen === 20, `Remaining yen must be 20, got ${res.body.payment.remaining_yen}`);

      const motionData = res.body.data;
      assert(motionData.scenes && motionData.scenes.length === 3, "Expected 3 scenes for 3 lyrics");
      assert(motionData.config.bpm === 160, "Config BPM must match 160");
      assert(motionData.scenes[0].text === "創音知能", "First scene text must match");
      assert(motionData.scenes[0].animation.keyframes.length >= 3, "Keyframes must be generated");
      assert(motionData.scenes[0].animation.shake.enabled === true, "Shake must be enabled");
    });

    // 8. ★最重要★ 厳格な上限ロック検証 (HTTP 402 LIMIT_EXCEEDED & 改ざん防止)
    await runTest("08. 厳格な上限ロック検証 (上限100円/残高20円で30円ドラム購入→402拒否＆残高改ざん防止)", async () => {
      // 現在: 上限 100円, 利用 80円, 残高 20円
      // 30円の商品を購入しようとする -> 80 + 30 = 110 > 100 なので拒否されなければならない
      const res = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testApiKey}`
        }
      }, {
        product_id: 'drums-8beat-midi',
        params: { bpm: 120, bars: 4 }
      });

      assert(res.statusCode === 402, `Expected HTTP 402 Payment Required, got ${res.statusCode}`);
      assert(res.body.error === 'LIMIT_EXCEEDED', `Expected error code LIMIT_EXCEEDED, got ${res.body.error}`);
      assert(res.body.monthly_limit_yen === 100, "Reported limit should be 100");
      assert(res.body.used_yen === 80, "Reported used should remain 80");
      assert(res.body.required_yen === 30, "Reported required price should be 30");
      assert(res.body.remaining_yen === 20, "Reported remaining should be 20");

      // 状態がロールバックされ、改ざんや不正引き落としがないことをDB照会で確認
      const usageRes = await request({
        method: 'GET',
        url: `/api/keys/${testApiKey}/usage`
      });
      assert(usageRes.body.usage.used_yen === 80, `used_yen must strictly remain 80, got ${usageRes.body.usage.used_yen}`);
      assert(usageRes.body.usage.remaining_yen === 20, `remaining_yen must remain 20, got ${usageRes.body.usage.remaining_yen}`);
      assert(usageRes.body.usage.transactions.length === 2, `Transactions count must strictly remain 2, got ${usageRes.body.usage.transactions.length}`);
    });

    // 9. 不正キー・無効キーのセキュリティ検証
    await runTest("09. 不正キー(401) および 無効化キー(403) のセキュリティ検証", async () => {
      // 存在しないキー
      const badKeyRes = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer sk_souon_fakekey000000000000000000'
        }
      }, { product_id: 'drums-8beat-midi' });
      assert(badKeyRes.statusCode === 401, `Expected 401 for invalid key, got ${badKeyRes.statusCode}`);

      // キーの無効化
      const patchRes = await request({
        method: 'PATCH',
        url: `/api/keys/${testApiKey}`,
        headers: { 'Content-Type': 'application/json' }
      }, { is_active: false });
      assert(patchRes.statusCode === 200, "Expected 200 on key patch");
      assert(patchRes.body.key.is_active === false, "Key should be disabled");

      // 無効化キーでの購入試行
      const disabledRes = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testApiKey}`
        }
      }, { product_id: 'drums-8beat-midi' });
      assert(disabledRes.statusCode === 403, `Expected 403 for disabled key, got ${disabledRes.statusCode}`);

      // キーを再有効化 & 上限を増額（1000円）
      await request({
        method: 'PATCH',
        url: `/api/keys/${testApiKey}`,
        headers: { 'Content-Type': 'application/json' }
      }, { is_active: true, monthly_limit_yen: 1000 });
    });

    // 10. ファイル商品購入 (サイバー・コミック風 プロンプト集 300円)
    await runTest("10. 300円ファイル商品 (cyber-comic-prompts) 購入 ＆ テンプレートJSON検証", async () => {
      const res = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${testApiKey}`
        }
      }, { product_id: 'cyber-comic-prompts' });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.product.price_yen === 300, "Price must be 300");
      assert(res.body.payment.used_yen === 380, `Used yen must be 80 + 300 = 380, got ${res.body.payment.used_yen}`);

      const promptData = res.body.data;
      assert(promptData.scenes && promptData.scenes.length === 10, "Expected 10 scenes in prompt template");
      assert(promptData.visual_dna && promptData.visual_dna.style.includes("Cyber Comic"), "Cyber Comic DNA present");
    });

    // 11. MCP JSON-RPC 2.0 initialize 検証
    await runTest("11. MCP JSON-RPC 2.0 initialize 互換ハンドシェイク検証 (POST /mcp)", async () => {
      const res = await request({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-ai-agent", version: "1.0.0" }
        }
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(res.body.jsonrpc === "2.0", "Expected jsonrpc 2.0");
      assert(res.body.id === 1, "Expected matching id 1");
      assert(res.body.result.serverInfo.name === "souon-ai-micro-store", "Server info name match");
      assert(res.body.result.capabilities.tools, "Tools capability must be declared");
    });

    // 12. MCP JSON-RPC 2.0 tools/list 検証
    await runTest("12. MCP JSON-RPC 2.0 tools/list ツール提供一覧検証 (POST /mcp)", async () => {
      const res = await request({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      const tools = res.body.result.tools;
      assert(Array.isArray(tools) && tools.length >= 2, "Expected at least 2 MCP tools");

      const tList = tools.find(t => t.name === "list_products");
      const tBuy = tools.find(t => t.name === "purchase_product");
      assert(tList, "list_products tool must be exposed");
      assert(tBuy, "purchase_product tool must be exposed");
      assert(tBuy.inputSchema.required.includes("productId"), "productId must be required");
    });

    // 13. MCP JSON-RPC 2.0 tools/call list_products 実行検証
    await runTest("13. MCP経由での商品一覧取得 (tools/call list_products)", async () => {
      const res = await request({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_products",
          arguments: {}
        }
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(!res.body.result.isError, "Should not be error");
      const text = res.body.result.content[0].text;
      const parsed = JSON.parse(text);
      assert(Array.isArray(parsed) && parsed.length === 3, "Parsed product array length must be 3");
    });

    // 14. MCP JSON-RPC 2.0 tools/call purchase_product 実行検証
    await runTest("14. MCP経由でのAIエージェント素材購入 (tools/call purchase_product)", async () => {
      const res = await request({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "purchase_product",
          arguments: {
            productId: "drums-8beat-midi",
            apiKey: testApiKey,
            params: { bpm: 130, bars: 4 }
          }
        }
      });

      assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
      assert(!res.body.result.isError, "Should succeed without error");
      const text = res.body.result.content[0].text;
      const parsed = JSON.parse(text);
      assert(parsed.success === true, "Purchase should succeed");
      assert(parsed.product.id === "drums-8beat-midi", "Product id must match");
      assert(parsed.payment.amount_yen === 30, "Amount must be 30");
      assert(parsed.data.midi_base64, "Midi base64 must be returned in MCP payload");
    });

    // 15. MCP経由での上限ロックエラー通知検証
    await runTest("15. MCP経由での上限ロック安全エラーハンドリング (tools/call purchase_product 超過時)", async () => {
      // 別のキーを上限10円で作成
      const keyRes = await request({
        method: 'POST',
        url: '/api/keys',
        headers: { 'Content-Type': 'application/json' }
      }, {
        name: "Tiny Budget Agent",
        monthly_limit_yen: 10
      });
      const tinyKey = keyRes.body.key.key;

      // 30円の商品をMCP経由で購入試行
      const mcpRes = await request({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' }
      }, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "purchase_product",
          arguments: {
            productId: "drums-8beat-midi",
            apiKey: tinyKey
          }
        }
      });

      assert(mcpRes.statusCode === 200, "MCP response should return 200 JSON-RPC");
      assert(mcpRes.body.result.isError === true, "Result must indicate isError: true");
      const errPayload = JSON.parse(mcpRes.body.result.content[0].text);
      assert(errPayload.error === "LIMIT_EXCEEDED", "Error code should be LIMIT_EXCEEDED");
      assert(errPayload.statusCode === 402, "StatusCode should be 402");
      assert(errPayload.monthly_limit_yen === 10, "Limit should be 10");
    });

    // 16. Web UI 静的配信 (GET / および GET /index.html) と必須UI要素の完全性検証
    await runTest("16. Web UI 静的配信 (GET / および GET /index.html) と 必須UI要素の完全性検証", async () => {
      // GET /
      const rootRes = await request({ method: 'GET', url: '/' });
      assert(rootRes.statusCode === 200, `Expected 200 for GET /, got ${rootRes.statusCode}`);
      assert(rootRes.headers['content-type'].includes('text/html'), `Expected text/html, got ${rootRes.headers['content-type']}`);
      assert(rootRes.headers['content-type'].includes('charset=utf-8'), `Expected charset=utf-8`);
      
      const html = rootRes.rawBody;
      assert(html.includes("<!DOCTYPE html>"), "Must be valid HTML5 document");
      assert(html.includes("AI Micro Store"), "Must contain store title");

      // 初期3商品名が含まれていること
      assert(html.includes("8ビート王道ドラムMIDI素材"), "Must include 8beat drum product title");
      assert(html.includes("キレキレタイポモーション設定JSON"), "Must include typo motion product title");
      assert(html.includes("サイバー・コミック風MV構図プロンプト集"), "Must include prompt pack product title");

      // プリセット上限ボタンが含まれていること
      assert(html.includes("100円"), "Must include 100 yen preset");
      assert(html.includes("500円"), "Must include 500 yen preset");
      assert(html.includes("2,000円"), "Must include 2,000 yen preset");

      // お小遣いキー発行および購入処理ロジック
      assert(html.includes("/api/keys"), "Must reference /api/keys endpoint");
      assert(html.includes("/api/purchase"), "Must reference /api/purchase endpoint");
      assert(html.includes("LIMIT_EXCEEDED") || html.includes("402"), "Must handle 402 limit exceeded");
      assert(html.includes(".mid"), "Must include midi download reference");

      // GET /index.html も同様に200で取得できること
      const indexRes = await request({ method: 'GET', url: '/index.html' });
      assert(indexRes.statusCode === 200, `Expected 200 for GET /index.html, got ${indexRes.statusCode}`);
      assert(indexRes.rawBody === html, "GET / and GET /index.html should deliver identical content");
    });

    // 17. スマホ実機基準 (Gate 4 受入要件: 375px〜414pxレスポンシブ & タップ領域44px以上) 検証
    await runTest("17. スマホ実機基準 (Gate 4: 375px-414px横崩れ防止 & 44pxタップ領域) 検証", async () => {
      const rootRes = await request({ method: 'GET', url: '/' });
      const html = rootRes.rawBody;

      // 1. viewport 設定
      assert(html.includes('<meta name="viewport"'), "Must have viewport meta tag");
      assert(html.includes('width=device-width'), "Viewport must configure width=device-width");

      // 2. box-sizing と overflow-x による横スクロール・はみ出しゼロ設計
      assert(html.includes('box-sizing: border-box'), "Must use border-box reset");
      assert(html.includes('overflow-x: hidden'), "Must specify overflow-x: hidden for zero horizontal scroll");

      // 3. 主要タップ領域 44px 以上の担保 (ボタン・入力欄)
      assert(html.includes('min-height: 44px') || html.includes('height: 44px'), "Must guarantee 44px minimum touch target height");
      assert(html.includes('.btn-buy'), "Must have .btn-buy class definition");
      assert(html.includes('.btn-preset'), "Must have .btn-preset class definition");
      assert(html.includes('.btn-main'), "Must have .btn-main class definition");
      assert(html.includes('.btn-download'), "Must have .btn-download class definition");

      // 4. MCP/外部エージェント接続情報アコーディオン
      assert(html.includes('claude_desktop_config.json'), "Must include Claude Desktop config sample");
      assert(html.includes('http://localhost:3456/mcp'), "Must reference MCP endpoint on port 3456");
    });

    // 18. フロントエンドUI(index.html)の全購入IDとストア実在商品IDの100%一致検証
    await runTest("18. フロントエンドUI(index.html)の全購入IDとストア実在商品IDの100%一致検証", async () => {
      const indexPath = path.resolve(__dirname, 'public', 'index.html');
      const htmlContent = fs.readFileSync(indexPath, 'utf8');

      // 正規表現で handlePurchase('...') をすべて抽出
      const matches = [...htmlContent.matchAll(/handlePurchase\(['"]([^'"]+)['"]\)/g)];
      assert(matches.length > 0, "No handlePurchase calls found in index.html");

      const storeProducts = storeManager.getProducts();
      const validProductIds = storeProducts.map(p => p.id);

      assert(validProductIds.length === 3, `Expected 3 valid products, got ${validProductIds.length}`);

      for (const match of matches) {
        const productId = match[1];
        assert(
          validProductIds.includes(productId),
          `UI contains invalid purchase product ID: '${productId}'. Valid IDs: ${validProductIds.join(', ')}`
        );
      }
    });

    // 19. 月次自動リセット機構の検証（前月キー利用額の当月自動リセット＆購入動作）
    await runTest("19. 月次自動リセット機構の検証（前月キー利用額の当月自動リセット＆購入動作）", async () => {
      // 1. 先月作成され、上限1000円のうち950円利用済みのキーをシミュレート
      const data = storeManager.load();
      const legacyKey = `sk_souon_monthly_test_${Date.now()}`;
      data.keys[legacyKey] = {
        key: legacyKey,
        name: "Monthly Test Agent",
        monthly_limit_yen: 1000,
        used_yen: 950,
        last_reset_month: "2025-12", // 過去月
        is_active: true,
        created_at: "2025-12-01T00:00:00.000Z",
        transactions: []
      };
      storeManager.save(data);

      // 2. 照会時に自動リセットが働き、used_yen = 0, remaining_yen = 1000 になること
      const usageRes = await request({ method: 'GET', url: `/api/keys/${legacyKey}/usage` });
      assert(usageRes.statusCode === 200, `Expected 200, got ${usageRes.statusCode}`);
      assert(usageRes.body.usage.used_yen === 0, `Expected used_yen reset to 0, got ${usageRes.body.usage.used_yen}`);
      assert(usageRes.body.usage.remaining_yen === 1000, `Expected remaining_yen reset to 1000, got ${usageRes.body.usage.remaining_yen}`);

      // DB内でもリセット月が当月に更新されていること
      const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      const reloadedData = storeManager.load();
      assert(reloadedData.keys[legacyKey].last_reset_month === currentMonth, `Expected last_reset_month to be ${currentMonth}`);
      assert(reloadedData.keys[legacyKey].used_yen === 0, "DB used_yen must be 0");

      // 3. リセット後の予算で正常に商品購入（300円）できること
      const purchaseRes = await request({
        method: 'POST',
        url: '/api/purchase',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${legacyKey}`
        }
      }, { product_id: 'cyber-comic-prompts' });

      assert(purchaseRes.statusCode === 200, `Expected 200 on purchase after reset, got ${purchaseRes.statusCode}`);
      assert(purchaseRes.body.payment.used_yen === 300, `used_yen should be 300, got ${purchaseRes.body.payment.used_yen}`);
      assert(purchaseRes.body.payment.remaining_yen === 700, `remaining_yen should be 700, got ${purchaseRes.body.payment.remaining_yen}`);
    });

    // 20. 他社商標（spider-verse / スパイダーバース）完全排除の検証
    await runTest("20. 他社商標完全排除の検証（商品マスタ・UI・プロンプトJSON・store.js・mcp.js）", async () => {
      const bannedWords = ["spider-verse", "spiderverse", "スパイダーバース"];

      // 1. 商品マスタ
      const products = storeManager.getProducts();
      for (const p of products) {
        const pStr = JSON.stringify(p).toLowerCase();
        for (const w of bannedWords) {
          assert(!pStr.includes(w), `Product ${p.id} contains banned trademark: ${w}`);
        }
      }

      // 2. フロントエンド UI (public/index.html)
      const indexPath = path.resolve(__dirname, 'public', 'index.html');
      const htmlContent = fs.readFileSync(indexPath, 'utf8').toLowerCase();
      for (const w of bannedWords) {
        assert(!htmlContent.includes(w), `index.html contains banned trademark: ${w}`);
      }

      // 3. プロンプトJSON (products/cyber_comic_prompts.json)
      const promptPath = path.resolve(__dirname, 'products', 'cyber_comic_prompts.json');
      const promptContent = fs.readFileSync(promptPath, 'utf8').toLowerCase();
      for (const w of bannedWords) {
        assert(!promptContent.includes(w), `cyber_comic_prompts.json contains banned trademark: ${w}`);
      }

      // 4. store.js & mcp.js
      const storeCode = fs.readFileSync(path.resolve(__dirname, 'store.js'), 'utf8').toLowerCase();
      for (const w of bannedWords) {
        assert(!storeCode.includes(w), `store.js contains banned trademark: ${w}`);
      }

      const mcpCode = fs.readFileSync(path.resolve(__dirname, 'mcp.js'), 'utf8').toLowerCase();
      for (const w of bannedWords) {
        assert(!mcpCode.includes(w), `mcp.js contains banned trademark: ${w}`);
      }
    });

  } finally {
    // テストDB削除
    if (fs.existsSync(TEST_DB_PATH)) {
      try { fs.unlinkSync(TEST_DB_PATH); } catch (e) {}
    }
  }

  console.log("\n================================================================");
  console.log(`  検証結果サマリー: 全 ${passCount + failCount} 件中 ${passCount} 件 PASS, ${failCount} 件 FAIL`);
  console.log("================================================================");

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unhandled Fatal Error in Test Suite:", err);
  process.exit(1);
});
