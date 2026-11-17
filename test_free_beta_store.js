/**
 * test_free_beta_store.js
 * 「ショップ全体の無料ベータ」（JP_RULES_FREE_BETA=true かつ JP_RULES_ONLY でない）の検証
 *
 * 確認すること:
 *   - PDF・OGP・商品購入が APIキーなし・0円で成功し、ダウンロードも取れる
 *   - 無料中は残高・保存データ（store.json）に一切触れない（キーを渡しても課金されない）
 *   - 無料ベータでないとき・JP_RULES_ONLY のときは従来どおり（課金される／使えない）
 *   - 使い捨てメールは受信ドメイン (TEMP_MAIL_DOMAIN) が無い間は公開しない
 *   - 無料でも回数制限と利用集計は効いている
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');
const { UsageStats } = require('./usage_stats');

console.log("=================================================================");
console.log("  ショップ全体 無料ベータ QAテスト");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${name}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

function dispatch(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { ...headers };
    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, h = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(h)) resHeaders[k.toLowerCase()] = v;
      },
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      write(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
      end(c) {
        if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = text; }
        resolve({ statusCode, headers: resHeaders, body: json, rawBody: text, rawBuffer: buf });
      }
    };
    handler(req, res).catch(reject);
    process.nextTick(() => {
      if (body !== undefined && body !== null) {
        req.emit('data', typeof body === 'object' ? JSON.stringify(body) : body);
      }
      req.emit('end');
    });
  });
}

const ENV_KEYS = ['JP_RULES_ONLY', 'JP_RULES_FREE_BETA', 'TEMP_MAIL_DOMAIN'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolCall = (name, args, headers = {}) => ({
  method: 'POST',
  url: '/mcp',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.20', ...headers },
  body: rpc('tools/call', { name, arguments: args })
});
const parseToolText = (res) => JSON.parse(res.body.result.content[0].text);

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_freebeta_test_'));

  function makeServer(extra = {}) {
    const dir = fs.mkdtempSync(path.join(tempDir, 'srv_'));
    const storePath = path.join(dir, 'store.json');
    const store = new StoreManager(storePath);
    const usage = new UsageStats({ filePath: path.join(dir, 'usage_stats.json') });
    const server = createStoreServer({ storePath, storeManager: store, usageStats: usage, ...extra });
    return { store, usage, storePath, call: (opts) => dispatch(server.handleHttpRequest, opts) };
  }

  try {
    // -------------------------------------------------------
    await runTest("01. 無料ベータ中の tools/list: PDF・OGP・購入が『無料ベータ』表記になり、apiKey が必須でなくなること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const res = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.21' }, body: rpc('tools/list', {}) });
      const tools = res.body.result.tools;
      for (const name of ['generate_beautiful_pdf', 'generate_ogp_image', 'purchase_product']) {
        const tool = tools.find(x => x.name === name);
        assert.ok(tool, `${name} が一覧にない`);
        assert.ok(tool.description.includes('無料ベータ'), `${name} の説明に無料ベータ表記がない`);
        assert.ok(!(tool.inputSchema.required || []).includes('apiKey'), `${name} が apiKey を必須にしている`);
      }
    });

    await runTest("02. 無料ベータ中は、受信ドメイン未設定の使い捨てメール道具を公開しないこと（設定すれば出る）", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      let t = makeServer();
      let res = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.22' }, body: rpc('tools/list', {}) });
      let names = res.body.result.tools.map(x => x.name);
      assert.ok(!names.includes('create_temp_inbox'));
      assert.ok(!names.includes('read_temp_inbox'));

      setEnv({ JP_RULES_FREE_BETA: 'true', TEMP_MAIL_DOMAIN: 'mail.example.test' });
      t = makeServer();
      res = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.22' }, body: rpc('tools/list', {}) });
      names = res.body.result.tools.map(x => x.name);
      assert.ok(names.includes('create_temp_inbox'));
      assert.ok(names.includes('read_temp_inbox'));
    });

    await runTest("03. 無料ベータでないときの tools/list は従来どおり（無料表記なし・apiKey 必須・使い捨てメールあり）", async () => {
      setEnv({});
      const t = makeServer();
      const res = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.23' }, body: rpc('tools/list', {}) });
      const tools = res.body.result.tools;
      const pdf = tools.find(x => x.name === 'generate_beautiful_pdf');
      assert.ok(!pdf.description.includes('無料ベータ'));
      assert.ok(tools.some(x => x.name === 'create_temp_inbox'));
    });

    // -------------------------------------------------------
    await runTest("04. PDF: APIキーなしで成功し、0円・free_beta で、ダウンロードが本物の PDF であること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const res = await t.call(toolCall('generate_beautiful_pdf', { markdown: '# 無料ベータ\n\n本文です。\n\n- 項目1\n- 項目2', title: '無料テスト' }));
      assert.ok(!res.body.result.isError, res.rawBody);
      const out = parseToolText(res);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.cost_yen, 0);
      assert.strictEqual(out.free_beta, true);
      assert.ok(/^tx_[0-9a-f]{16}$/.test(out.tx_id));

      const dl = await t.call({ url: out.download_url });
      assert.strictEqual(dl.statusCode, 200);
      assert.strictEqual(dl.headers['content-type'], 'application/pdf');
      assert.strictEqual(dl.rawBuffer.slice(0, 5).toString('ascii'), '%PDF-');
    });

    await runTest("05. OGP: APIキーなしで成功し、0円・free_beta で、ダウンロードが本物の PNG であること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const res = await t.call(toolCall('generate_ogp_image', { title: '無料OGPテスト', theme: 'cyber_neon' }));
      assert.ok(!res.body.result.isError, res.rawBody);
      const out = parseToolText(res);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.cost_yen, 0);
      assert.strictEqual(out.free_beta, true);

      const dl = await t.call({ url: out.download_url });
      assert.strictEqual(dl.statusCode, 200);
      assert.strictEqual(dl.headers['content-type'], 'image/png');
      assert.deepStrictEqual([...dl.rawBuffer.slice(0, 4)], [0x89, 0x50, 0x4E, 0x47]);
    });

    await runTest("06. 商品購入(ドラムMIDI): APIキーなしで成功し、本物の MIDI（MThd）が取れること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const res = await t.call(toolCall('purchase_product', { productId: 'drums-8beat-midi', params: { bpm: 140, bars: 4 } }));
      assert.ok(!res.body.result.isError, res.rawBody);
      const out = parseToolText(res);
      assert.strictEqual(out.success, true);
      assert.strictEqual(out.free_beta, true);
      assert.strictEqual(out.payment.amount_yen, 0);
      const midi = Buffer.from(out.data.midi_base64, 'base64');
      assert.strictEqual(midi.slice(0, 4).toString('ascii'), 'MThd');

      const dl = await t.call({ url: out.data.download_url });
      assert.strictEqual(dl.statusCode, 200);
      assert.strictEqual(dl.headers['content-type'], 'audio/midi');
      assert.strictEqual(dl.rawBuffer.slice(0, 4).toString('ascii'), 'MThd');
    });

    await runTest("07. 商品購入: プロンプト集もキーなしで取れ、存在しない商品は 404 相当のエラーになること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const prompts = await t.call(toolCall('purchase_product', { productId: 'cyber-comic-prompts' }));
      assert.ok(!prompts.body.result.isError, prompts.rawBody);

      const missing = await t.call(toolCall('purchase_product', { productId: 'no-such-product' }));
      assert.strictEqual(missing.body.result.isError, true);
      assert.strictEqual(parseToolText(missing).error, 'PRODUCT_NOT_FOUND');
    });

    // -------------------------------------------------------
    await runTest("08. 無料中は保存データ（store.json）が一切変わらないこと（残高・取引履歴に触れない）", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      // 先にキーを1つ作っておく（無料中にこのキーが課金されないことも見る）
      const created = await t.call({
        method: 'POST', url: '/api/keys',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'free-beta-test', monthly_limit_yen: 1000 }
      });
      const apiKey = created.body.key && created.body.key.key;
      assert.ok(typeof apiKey === 'string' && apiKey.startsWith('sk_souon_'), `キー作成に失敗: ${created.rawBody}`);

      const before = fs.readFileSync(t.storePath, 'utf8');
      await t.call(toolCall('generate_beautiful_pdf', { markdown: '# x', apiKey }));
      await t.call(toolCall('generate_ogp_image', { title: 'x', apiKey }));
      await t.call(toolCall('purchase_product', { productId: 'drums-8beat-midi', apiKey }));
      const after = fs.readFileSync(t.storePath, 'utf8');
      assert.strictEqual(after, before, "無料中なのに store.json が書き換わった");

      const usage = await t.call({ url: `/api/keys/${apiKey}/usage` });
      assert.strictEqual(usage.body.usage.used_yen, 0, "キーを渡したのに課金された");
    });

    await runTest("09. 無料ベータでないとき: キーなしの PDF は拒否され、キーありなら従来どおり 20円 課金されること", async () => {
      setEnv({});
      const t = makeServer();
      const noKey = await t.call(toolCall('generate_beautiful_pdf', { markdown: '# x' }));
      assert.strictEqual(noKey.body.result.isError, true);
      assert.ok(noKey.rawBody.includes('API key is required'));

      const created = await t.call({
        method: 'POST', url: '/api/keys',
        headers: { 'Content-Type': 'application/json' },
        body: { name: 'paid-regression', monthly_limit_yen: 1000 }
      });
      const apiKey = created.body.key && created.body.key.key;
      const paid = await t.call(toolCall('generate_beautiful_pdf', { markdown: '# x', apiKey }));
      assert.ok(!paid.body.result.isError, paid.rawBody);
      const out = parseToolText(paid);
      assert.strictEqual(out.cost_yen, 20);
      assert.strictEqual(out.free_beta, false);
      assert.strictEqual(out.used_yen, 20);
    });

    await runTest("10. JP_RULES_ONLY=true のときは、無料ベータが有効でも PDF・購入は使えず、道具は jp-rules の3つだけであること", async () => {
      setEnv({ JP_RULES_ONLY: 'true', JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const list = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.24' }, body: rpc('tools/list', {}) });
      assert.strictEqual(list.body.result.tools.length, 3);

      const pdf = await t.call(toolCall('generate_beautiful_pdf', { markdown: '# x' }));
      assert.strictEqual(pdf.body.result.isError, true);
      assert.ok(pdf.rawBody.includes('unavailable in JP_RULES_ONLY'));

      const buy = await t.call(toolCall('purchase_product', { productId: 'drums-8beat-midi' }));
      assert.strictEqual(buy.body.result.isError, true);
    });

    // -------------------------------------------------------
    await runTest("11. HTTP /api/purchase: 無料ベータならキーなしで 200（free_beta）、そうでなければ 401 のままであること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      let t = makeServer();
      let res = await t.call({
        method: 'POST', url: '/api/purchase',
        headers: { 'Content-Type': 'application/json' },
        body: { product_id: 'drums-8beat-midi', params: { bars: 2 } }
      });
      assert.strictEqual(res.statusCode, 200, res.rawBody);
      assert.strictEqual(res.body.free_beta, true);

      setEnv({});
      t = makeServer();
      res = await t.call({
        method: 'POST', url: '/api/purchase',
        headers: { 'Content-Type': 'application/json' },
        body: { product_id: 'drums-8beat-midi' }
      });
      assert.strictEqual(res.statusCode, 401);
    });

    await runTest("12. 無料でも IP の回数制限（429）は効き、無料の呼び出しは利用集計に道具名つきで数えられること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer({ rateLimitMaxRequests: 2 });
      const a = await t.call(toolCall('generate_ogp_image', { title: 'a' }));
      const b = await t.call(toolCall('generate_ogp_image', { title: 'b' }));
      const c = await t.call(toolCall('generate_ogp_image', { title: 'c' }));
      assert.ok(!a.body.result.isError && !b.body.result.isError);
      assert.strictEqual(c.statusCode, 429);
      const calls = t.usage.getSummary().totals.calls;
      assert.strictEqual(calls['tools/call:generate_ogp_image'], 2);
      assert.strictEqual(calls['rate_limited'], 1);
    });

    await runTest("13. /health が free_beta: true と、無料ベータ中の道具数（使い捨てメール除く）を返すこと", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      let t = makeServer();
      const free = await t.call({ url: '/health' });
      assert.strictEqual(free.body.free_beta, true);
      const freeCount = free.body.toolsCount;

      setEnv({});
      t = makeServer();
      const normal = await t.call({ url: '/health' });
      assert.strictEqual(normal.body.toolsCount - freeCount, 2, "使い捨てメール2つぶんだけ少ないはず");
    });
    // -------------------------------------------------------
    // 使い捨てメールは「お金がかかるので一旦見送り」。受信ドメインが無い間は、道具・デモ・画面のどこにも出さない。
    await runTest("15. 使い捨てメール見送り: 無料ベータ（受信ドメインなし）では /health が temp_mail:false、デモは 404、トップ画面のバナーは初期非表示であること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const health = await t.call({ url: '/health' });
      assert.strictEqual(health.body.temp_mail, false);

      const demo = await t.call({
        method: 'POST', url: '/api/demo/temp-mail',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.30' },
        body: {}
      });
      assert.strictEqual(demo.statusCode, 404);
      assert.strictEqual(demo.body.error, 'NOT_AVAILABLE');

      const create = await t.call(toolCall('create_temp_inbox', {}));
      assert.strictEqual(create.statusCode, 200);
      // 道具一覧に無いので、呼んでも使えない（集計では (unknown) 扱い）
      assert.ok(t.usage.getSummary().totals.calls['tools/call:(unknown)'] >= 1 || create.body.result?.isError === true || create.body.error);

      const top = await t.call({ url: '/' });
      assert.ok(top.rawBody.includes('id="tempMailBanner"'));
      assert.ok(/id="tempMailBanner"[^>]*style="display: none;/.test(top.rawBody), "バナーが初期表示になっている");
    });

    await runTest("16. 受信ドメイン(TEMP_MAIL_DOMAIN)を設定するか無料ベータをやめると、使い捨てメールが /health・デモで再び有効になること", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true', TEMP_MAIL_DOMAIN: 'mail.example.test' });
      let t = makeServer();
      assert.strictEqual((await t.call({ url: '/health' })).body.temp_mail, true);

      setEnv({});
      t = makeServer();
      assert.strictEqual((await t.call({ url: '/health' })).body.temp_mail, true);
      const demo = await t.call({
        method: 'POST', url: '/api/demo/temp-mail',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.31' },
        body: {}
      });
      assert.notStrictEqual(demo.statusCode, 404);
    });

    // -------------------------------------------------------
    // ロックタイポ関連の商品（モーションJSON）は、ロックタイポ完成まで公開しない
    await runTest("17. ロックタイポ モーションJSON は無料ベータの公開では、商品一覧・購入（MCP/HTTP）・道具の説明・画面のどこにも出ないこと", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const t = makeServer();
      const ID = 'rocktypo-motion-json';

      const list = await t.call(toolCall('list_products', {}));
      assert.ok(!list.rawBody.includes(ID), "list_products に出ている");
      assert.ok(list.rawBody.includes('drums-8beat-midi'), "他の商品まで消えている");

      const api = await t.call({ url: '/api/products' });
      assert.ok(!api.body.products.some(p => p.id === ID), "/api/products に出ている");
      assert.ok(api.body.products.some(p => p.id === 'drums-8beat-midi'));

      const buy = await t.call(toolCall('purchase_product', { productId: ID }));
      assert.strictEqual(buy.body.result.isError, true);
      assert.strictEqual(parseToolText(buy).error, 'PRODUCT_NOT_FOUND');

      const http = await t.call({
        method: 'POST', url: '/api/purchase',
        headers: { 'Content-Type': 'application/json' },
        body: { product_id: ID }
      });
      assert.strictEqual(http.statusCode, 404);

      const tools = await t.call({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.40' }, body: rpc('tools/list', {}) });
      const buyTool = tools.body.result.tools.find(x => x.name === 'purchase_product');
      assert.ok(!JSON.stringify(buyTool).includes(ID), "道具の説明に名前が残っている");

      const top = await t.call({ url: '/' });
      assert.ok(/data-product-id="rocktypo-motion-json" data-held-back="true" style="display: none;"/.test(top.rawBody), "画面のカードが初期非表示でない");
    });

    await runTest("18. 通常モード（無料ベータでない）では、モーションJSON は従来どおり商品一覧に載り、購入できること", async () => {
      setEnv({});
      const t = makeServer();
      const api = await t.call({ url: '/api/products' });
      assert.ok(api.body.products.some(p => p.id === 'rocktypo-motion-json'));
    });

    // -------------------------------------------------------
    // 本物の HTTP（実際に待ち受けて fetch する）で確認する。
    // 上のテストは本物の通信を使わないので、HTTP ヘッダーの文字種エラーなどは見つけられない。
    await runTest("14. 日本語タイトルの PDF / OGP が、本物の HTTP でもダウンロードできること（Content-Disposition が壊れない）", async () => {
      setEnv({ JP_RULES_FREE_BETA: 'true' });
      const dir = fs.mkdtempSync(path.join(tempDir, 'http_'));
      const storePath = path.join(dir, 'store.json');
      const { server } = createStoreServer({
        storePath,
        storeManager: new StoreManager(storePath),
        usageStats: new UsageStats({ filePath: path.join(dir, 'usage_stats.json') })
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const callTool = async (name, args) => {
          const r = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rpc('tools/call', { name, arguments: args }))
          });
          assert.strictEqual(r.status, 200);
          const j = await r.json();
          assert.ok(!j.result.isError, JSON.stringify(j));
          return JSON.parse(j.result.content[0].text);
        };

        const pdf = await callTool('generate_beautiful_pdf', { markdown: '# 日本語\n\n本文', title: '公開テスト' });
        const pdfRes = await fetch(base + pdf.download_url);
        assert.strictEqual(pdfRes.status, 200, `PDF ダウンロードが ${pdfRes.status}`);
        assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
        const pdfDisp = pdfRes.headers.get('content-disposition');
        assert.ok(pdfDisp.includes("filename*=UTF-8''"), pdfDisp);
        assert.ok(decodeURIComponent(pdfDisp.split("filename*=UTF-8''")[1]).includes('公開テスト'), "日本語名が復元できない");
        assert.ok(/^[\x20-\x7E]*$/.test(pdfDisp), "ヘッダーに ASCII 以外が残っている");
        assert.strictEqual(Buffer.from(await pdfRes.arrayBuffer()).slice(0, 5).toString('ascii'), '%PDF-');

        const ogp = await callTool('generate_ogp_image', { title: '無料公開テスト' });
        const ogpRes = await fetch(base + ogp.download_url);
        assert.strictEqual(ogpRes.status, 200, `OGP ダウンロードが ${ogpRes.status}`);
        assert.strictEqual(ogpRes.headers.get('content-type'), 'image/png');
        assert.deepStrictEqual([...Buffer.from(await ogpRes.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4E, 0x47]);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
  } finally {
    restoreEnv();
  }

  console.log(`\n=================================================================`);
  console.log(`  結果: ${passedTests} / ${totalTests} PASS`);
  console.log(`=================================================================`);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  if (passedTests !== totalTests) process.exitCode = 1;
})();
