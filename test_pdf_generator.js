/**
 * test_pdf_generator.js
 * 創音知能 AI Micro Store - 美麗 PDF 生成ツール (generate_beautiful_pdf) 包括的QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateBeautifulPdfBuffer, THEMES } = require('./pdf_generator');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');

console.log("=================================================================");
console.log("  美麗 PDF 生成ツール (generate_beautiful_pdf) 包括的QAテスト");
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_pdf_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');

  const testStore = new StoreManager(tempStorePath);
  const testServer = createStoreServer({ storePath: tempStorePath, storeManager: testStore });
  const httpReq = (opts, body) => dispatchTestRequest(testServer.handleHttpRequest, { ...opts, body });

  // テスト用APIキー発行（月額上限 100 JPY）
  const keyResult = testStore.createKey({ name: "PDF Test Agent", monthly_limit_yen: 100 });
  const testApiKey = keyResult.key;

  const complexMarkdown = [
    "# 創音知能 AI プロジェクト月次分析レポート",
    "> 本レポートは AI Micro Store の `generate_beautiful_pdf` エンジンにより完全自律生成されました。",
    "",
    "## 1. 概要 (Executive Summary)",
    "日本語と英語の混在テキスト、**強調太字**、`インラインコード` のレンダリング品質を検証します。",
    "- 項目A: 高速ベクトル描画と日本語フォント自動解決",
    "- 項目B: スライディングウィンドウ方式による安全保護",
    "* 項目C: マルチテーマ対応 (Business Report / Modern Clean / Dark Tech)",
    "",
    "## 2. 料金・性能比較テーブル",
    "| プラン名 | 価格 (JPY) | 判定回数目安 | 対象ユーザー |",
    "|:---|---:|:---:|:---|",
    "| Mini | 100 | 約3回 | お試し単発向け |",
    "| Starter | 500 | 約16回 | 個人開発者向け |",
    "| Standard | 1,500 | 50回 | 一番人気プラン |",
    "| Pro | 5,000 | 約166回 | 大規模エージェント用 |",
    "",
    "## 3. 実装コードスニペット",
    "```javascript",
    "// 美麗 PDF 生成呼び出し例",
    "const result = await generateBeautifulPdfBuffer({",
    "  markdown: '# Sample',",
    "  theme: 'business_report',",
    "  pageSize: 'A4'",
    "});",
    "```",
    "",
    "---",
    "### 4. 判定と結論",
    "1. ゼロ外部C/C++依存での安定PDF生成が確認されました。",
    "2. 日本語文字化け・四角化のないプロ仕様のレイアウトが実現できました。"
  ].join('\n');

  // -------------------------------------------------------------
  // Test 01: 日英混在 Markdown からの有効な PDF バイナリ生成検証
  // -------------------------------------------------------------
  await runAsyncTest("01. 日英混在の複雑な Markdown から %PDF- で始まる有効な PDF バイナリが生成されること", async () => {
    const res = await generateBeautifulPdfBuffer({
      markdown: complexMarkdown,
      title: "プロジェクト分析レポート",
      theme: "business_report",
      pageSize: "A4",
      footerText: "Confidential - Souon AI Micro Store"
    });

    assert.ok(Buffer.isBuffer(res.buffer), "Must return Buffer");
    assert.strictEqual(res.buffer.slice(0, 5).toString('ascii'), "%PDF-", "Buffer must begin with %PDF- header");
    assert.ok(res.sizeBytes > 1000, `PDF size must be substantial (got ${res.sizeBytes} bytes)`);
    assert.strictEqual(res.sizeBytes, res.buffer.length);
    assert.ok(res.pageCount >= 1, `Page count must be >= 1 (got ${res.pageCount})`);
    assert.strictEqual(res.theme, "business_report");
    assert.strictEqual(res.pageSize, "A4");
  });

  // -------------------------------------------------------------
  // Test 02: 3テーマ (business_report, modern_clean, dark_tech) & 用紙サイズ検証
  // -------------------------------------------------------------
  await runAsyncTest("02. 3テーマ (business_report, modern_clean, dark_tech) と A4/Letter で正常生成されること", async () => {
    const themesToTest = ['business_report', 'modern_clean', 'dark_tech'];
    const pageSizesToTest = ['A4', 'Letter'];

    for (const theme of themesToTest) {
      for (const pageSize of pageSizesToTest) {
        const res = await generateBeautifulPdfBuffer({
          markdown: `## Test Theme: ${theme}\nPageSize: ${pageSize}\n日本語テキスト描画テスト。`,
          title: `Test ${theme} ${pageSize}`,
          theme,
          pageSize
        });

        assert.strictEqual(res.buffer.slice(0, 5).toString('ascii'), "%PDF-", `Theme ${theme} ${pageSize} must output %PDF-`);
        assert.ok(res.sizeBytes > 500, `Theme ${theme} ${pageSize} must have valid size`);
        assert.strictEqual(res.theme, theme);
        assert.strictEqual(res.pageSize, pageSize);
      }
    }
  });

  // -------------------------------------------------------------
  // Test 03: POST /mcp 経由での generate_beautiful_pdf 呼び出し & /api/download/:tx_id バイナリ配信検証
  // -------------------------------------------------------------
  await runAsyncTest("03. POST /mcp で 20 JPY 課金され、/api/download/:tx_id から application/pdf がダウンロードできること", async () => {
    const prevUsed = testStore.getKeyUsage(testApiKey).used_yen;

    // 1. tools/list に generate_beautiful_pdf が存在すること
    const listRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' }
    }, {
      jsonrpc: "2.0",
      id: "req_list_tools",
      method: "tools/list"
    });
    assert.strictEqual(listRes.statusCode, 200);
    const tools = listRes.body.result?.tools || [];
    const pdfTool = tools.find(t => t.name === "generate_beautiful_pdf");
    assert.ok(pdfTool, "generate_beautiful_pdf must be listed in tools/list");
    assert.ok(pdfTool.description.includes("20 JPY"), "Description must state 20 JPY price");
    assert.deepStrictEqual(pdfTool.inputSchema.required, ["markdown"]);

    // 2. tools/call generate_beautiful_pdf 呼び出し
    const callRes = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': testApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "req_gen_pdf",
      method: "tools/call",
      params: {
        name: "generate_beautiful_pdf",
        arguments: {
          markdown: complexMarkdown,
          title: "月次事業分析書",
          theme: "modern_clean",
          pageSize: "A4"
        }
      }
    });

    assert.strictEqual(callRes.statusCode, 200);
    assert.ok(callRes.body.result && !callRes.body.result.isError, "PDF generation call must succeed");
    const data = JSON.parse(callRes.body.result.content[0].text);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.cost_yen, 20, "Cost must be exactly 20 JPY");
    assert.strictEqual(data.used_yen, prevUsed + 20, "Used yen must increase by 20");
    assert.strictEqual(data.remaining_yen, 80, "Remaining yen must be 80 JPY (100 - 20)");
    assert.ok(data.tx_id, "Transaction ID must be returned");
    assert.ok(data.download_url.startsWith('/api/download/'), "Must return download_url");
    assert.ok(data.filename.endsWith('.pdf'), "Filename must end with .pdf");
    assert.strictEqual(data.theme, "modern_clean");
    assert.ok(data.size_bytes > 1000);

    // 3. /api/download/:tx_id からバイナリ直接ダウンロード検証
    const dlRes = await httpReq({
      method: 'GET',
      url: data.download_url
    });

    assert.strictEqual(dlRes.statusCode, 200);
    assert.strictEqual(dlRes.headers['content-type'], 'application/pdf');
    assert.ok(dlRes.headers['content-disposition'].includes('.pdf'));
    assert.strictEqual(dlRes.rawBuffer.slice(0, 5).toString('ascii'), '%PDF-', "Downloaded binary must be a valid PDF");
    assert.strictEqual(dlRes.rawBuffer.length, data.size_bytes, "Downloaded bytes must match reported size_bytes");
  });

  // -------------------------------------------------------------
  // Test 04: 残高不足時の 402 LIMIT_EXCEEDED 拒否と残高保護
  // -------------------------------------------------------------
  await runAsyncTest("04. 残高不足時に 402 LIMIT_EXCEEDED で拒否され残高が減らないこと", async () => {
    // 上限 15 JPY のキー（20 JPY の PDF 生成に足りない）
    const tightKeyResult = testStore.createKey({ name: "Tight Budget Agent", monthly_limit_yen: 15 });
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
      id: "req_tight_pdf",
      method: "tools/call",
      params: {
        name: "generate_beautiful_pdf",
        arguments: {
          markdown: "# Should Fail Due To Limit"
        }
      }
    });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.result && res.body.result.isError, "Limit exceeded must return isError: true");
    const errData = JSON.parse(res.body.result.content[0].text);
    assert.strictEqual(errData.error, "LIMIT_EXCEEDED");
    assert.strictEqual(errData.statusCode, 402);
    assert.strictEqual(errData.monthly_limit_yen, 15);
    assert.strictEqual(errData.used_yen, 0, "Used yen must not increase");
    assert.strictEqual(errData.remaining_yen, 15, "Remaining balance must be unchanged");

    // ストア側の永続化状態も保護されていること
    const usage = testStore.getKeyUsage(tightApiKey);
    assert.strictEqual(usage.used_yen, 0);
    assert.strictEqual(usage.remaining_yen, 15);
  });

  // -------------------------------------------------------------
  // Test 05: JP_RULES_ONLY=true 時の隔離検証
  // -------------------------------------------------------------
  await runAsyncTest("05. JP_RULES_ONLY=true 時は generate_beautiful_pdf が tools/list に含まれず実行も拒否されること", async () => {
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
          id: "req_jp_list",
          method: "tools/list"
        }
      });
      assert.strictEqual(listRes.statusCode, 200);
      const tools = listRes.body.result?.tools || [];
      const hasPdfTool = tools.some(t => t.name === "generate_beautiful_pdf");
      assert.strictEqual(hasPdfTool, false, "generate_beautiful_pdf must NOT be listed in JP_RULES_ONLY mode");

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
          id: "req_jp_call_pdf",
          method: "tools/call",
          params: {
            name: "generate_beautiful_pdf",
            arguments: { markdown: "# Should Be Denied" }
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

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  美麗 PDF 生成テスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
