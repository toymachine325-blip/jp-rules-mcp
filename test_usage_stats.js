/**
 * test_usage_stats.js
 * 利用状況の集計（usage_stats.js）と、server.js への組み込みの検証
 *
 * 確認すること:
 *   - 日付ごと・名前ごとに正しく数える／エラーも数える
 *   - 個人を特定できるもの（IP・UA）を保存しない
 *   - 再起動（ファイル／Supabase）で数字が戻る・送信失敗でも失われない
 *   - /api/stats は合言葉があるときだけ見える
 *   - 自分のテスト呼び出し（x-usage-ignore）は数えない
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { UsageStats, jstDayKey, RETENTION_DAYS } = require('./usage_stats');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');

console.log("=================================================================");
console.log("  利用状況の集計 QAテスト");
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
    const chunks = [];
    const res = {
      writeHead(code) { statusCode = code; },
      setHeader() {},
      write(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); },
      end(c) {
        if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = text; }
        resolve({ statusCode, body: json, rawBody: text });
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

function makeClock(iso) {
  let t = new Date(iso).getTime();
  const clock = () => new Date(t);
  clock.set = (nextIso) => { t = new Date(nextIso).getTime(); };
  return clock;
}

function makeFakeSupabase() {
  const rows = new Map();
  const calls = [];
  let failNext = 0;
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body });
    if (failNext > 0) {
      failNext--;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      rows.set(payload.id, payload);
      return { ok: true, status: 201, json: async () => ({}) };
    }
    const m = url.match(/id=eq\.([^&]+)/);
    const id = m ? decodeURIComponent(m[1]) : null;
    const row = id && rows.get(id);
    return { ok: true, status: 200, json: async () => (row ? [{ state: row.state }] : []) };
  };
  return { fetchFn, rows, calls, failNext: (n) => { failNext = n; } };
}

const SB = { url: 'https://example.supabase.test', serviceRoleKey: 'test-key', table: 'souon_store', storeId: 'main' };

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_usage_test_'));

  // ---------------------------------------------------------
  // A. 集計器そのもの
  // ---------------------------------------------------------
  await runTest("A01. 名前ごとに数え、まとめ（totals）と日別が合うこと", () => {
    const clock = makeClock('2026-11-17T03:00:00Z');
    const s = new UsageStats({ now: clock });
    s.record('tools/list');
    s.record('tools/call:generate_beautiful_pdf');
    s.record('tools/call:generate_beautiful_pdf');
    const sum = s.getSummary(30);
    assert.strictEqual(sum.totals.total_calls, 3);
    assert.strictEqual(sum.totals.calls['tools/call:generate_beautiful_pdf'], 2);
    assert.strictEqual(sum.totals.calls['tools/list'], 1);
    assert.strictEqual(sum.per_day['2026-11-17'].total_calls, 3);
  });

  await runTest("A02. エラーで終わった呼び出しは errors に数えられること", () => {
    const s = new UsageStats({ now: makeClock('2026-11-17T03:00:00Z') });
    s.record('tools/call:x', { error: true });
    s.record('tools/call:x');
    const sum = s.getSummary();
    assert.strictEqual(sum.totals.errors, 1);
    assert.strictEqual(sum.totals.total_calls, 2);
  });

  await runTest("A03. 同じ IP+UA は1人、別の IP は別の人と数え、IP・UA は保存内容に一切残らないこと", () => {
    const s = new UsageStats({ now: makeClock('2026-11-17T03:00:00Z') });
    s.record('tools/list', { ip: '203.0.113.7', ua: 'AgentBot/1.0' });
    s.record('tools/list', { ip: '203.0.113.7', ua: 'AgentBot/1.0' });
    s.record('tools/list', { ip: '198.51.100.9', ua: 'AgentBot/1.0' });
    const sum = s.getSummary();
    assert.strictEqual(sum.per_day['2026-11-17'].uniques_approx, 2);
    const dump = JSON.stringify(s.days) + JSON.stringify(sum);
    assert.ok(!dump.includes('203.0.113.7'), "IP が保存・出力に含まれている");
    assert.ok(!dump.includes('198.51.100.9'), "IP が保存・出力に含まれている");
    assert.ok(!dump.includes('AgentBot'), "UA が保存・出力に含まれている");
  });

  await runTest("A04. 長すぎる名前は切り詰められ、空や文字列以外は無視されること", () => {
    const s = new UsageStats({ now: makeClock('2026-11-17T03:00:00Z') });
    s.record('x'.repeat(500));
    s.record('');
    s.record(null);
    s.record(12345);
    const names = Object.keys(s.getSummary().totals.calls);
    assert.strictEqual(names.length, 1);
    assert.strictEqual(names[0].length, 64);
  });

  await runTest("A05. 日付は日本時間で切り替わること（UTC 14:59 は同日、UTC 15:01 は翌日）", () => {
    const clock = makeClock('2026-11-17T14:59:00Z');
    const s = new UsageStats({ now: clock });
    s.record('a');
    clock.set('2026-11-17T15:01:00Z');
    s.record('a');
    const sum = s.getSummary();
    assert.strictEqual(sum.per_day['2026-11-17'].total_calls, 1);
    assert.strictEqual(sum.per_day['2026-11-18'].total_calls, 1);
    assert.strictEqual(jstDayKey(new Date('2026-11-17T15:00:00Z')), '2026-11-18');
  });

  await runTest("A06. ファイルに保存して、新しいインスタンスで読み戻すと数字が引き継がれること", async () => {
    const file = path.join(tempDir, 'a06', 'usage_stats.json');
    const s1 = new UsageStats({ filePath: file, now: makeClock('2026-11-17T03:00:00Z') });
    s1.record('tools/list');
    s1.record('tools/list');
    await s1.flush();
    assert.ok(fs.existsSync(file), "保存ファイルがない");

    const s2 = new UsageStats({ filePath: file, now: makeClock('2026-11-17T04:00:00Z') });
    await s2.init();
    s2.record('tools/list');
    assert.strictEqual(s2.getSummary().totals.calls['tools/list'], 3);
  });

  await runTest("A07. 変更がなければ flush は何も書かないこと", async () => {
    const file = path.join(tempDir, 'a07', 'usage_stats.json');
    const s = new UsageStats({ filePath: file, now: makeClock('2026-11-17T03:00:00Z') });
    await s.flush();
    assert.ok(!fs.existsSync(file), "変更がないのにファイルが作られた");
  });

  await runTest("A08. Supabase 有効時は別の行（<storeId>__usage）に保存し、課金データの行には触れないこと", async () => {
    const fake = makeFakeSupabase();
    const s = new UsageStats({ supabaseConfig: SB, fetchFn: fake.fetchFn, now: makeClock('2026-11-17T03:00:00Z') });
    s.record('tools/list');
    await s.flush();
    const posts = fake.calls.filter(c => c.method === 'POST');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(JSON.parse(posts[0].body).id, 'main__usage');
    assert.ok(fake.rows.has('main__usage'));
    assert.ok(!fake.rows.has('main'), "課金データの行 (main) に書き込んでいる");
  });

  await runTest("A09. 再起動後に Supabase から数字が戻ること", async () => {
    const fake = makeFakeSupabase();
    const s1 = new UsageStats({ supabaseConfig: SB, fetchFn: fake.fetchFn, now: makeClock('2026-11-17T03:00:00Z') });
    s1.record('tools/list');
    s1.record('tools/list');
    await s1.flush();

    const s2 = new UsageStats({ supabaseConfig: SB, fetchFn: fake.fetchFn, now: makeClock('2026-11-17T05:00:00Z') });
    await s2.init();
    assert.strictEqual(s2.getSummary().totals.calls['tools/list'], 2);
  });

  await runTest("A10. Supabase への送信が失敗しても数字は失われず、次の flush で送り直されること", async () => {
    const fake = makeFakeSupabase();
    const s = new UsageStats({ supabaseConfig: SB, fetchFn: fake.fetchFn, now: makeClock('2026-11-17T03:00:00Z') });
    s.record('tools/list');
    fake.failNext(1);
    await s.flush();
    assert.ok(!fake.rows.has('main__usage'), "失敗したのに保存されたことになっている");
    assert.strictEqual(s.dirty, true, "失敗後は未保存の印が残るべき");
    await s.flush();
    assert.ok(fake.rows.has('main__usage'));
    assert.strictEqual(fake.rows.get('main__usage').state.days['2026-11-17'].calls['tools/list'], 1);
  });

  await runTest("A11. 通信が例外で落ちても本処理（record/flush）が止まらないこと", async () => {
    const s = new UsageStats({
      supabaseConfig: SB,
      fetchFn: async () => { throw new Error('network down'); },
      now: makeClock('2026-11-17T03:00:00Z')
    });
    await s.init();
    s.record('tools/list');
    await s.flush();
    assert.strictEqual(s.getSummary().totals.total_calls, 1);
  });

  await runTest(`A12. ${RETENTION_DAYS}日より古い日は保存時に捨てられること`, async () => {
    const clock = makeClock('2026-01-01T03:00:00Z');
    const s = new UsageStats({ now: clock });
    for (let i = 0; i < RETENTION_DAYS + 10; i++) {
      s.record('a');
      clock.set(new Date(new Date('2026-01-01T03:00:00Z').getTime() + (i + 1) * 86400000).toISOString());
    }
    assert.ok(Object.keys(s.days).length > RETENTION_DAYS);
    await s.flush();
    assert.strictEqual(Object.keys(s.days).length, RETENTION_DAYS);
  });

  await runTest("A13. getSummary の days は 1〜90 に収まり、不正な値は 30 になること", () => {
    const s = new UsageStats({ now: makeClock('2026-11-17T03:00:00Z') });
    s.record('a');
    assert.strictEqual(s.getSummary(0).days_requested, 30); // 0 は不正扱い → 30
    assert.strictEqual(s.getSummary('abc').days_requested, 30);
    assert.strictEqual(s.getSummary(9999).days_requested, RETENTION_DAYS);
    assert.strictEqual(s.getSummary(-5).days_requested, 1);
  });

  await runTest("A14. 壊れた保存データ（数値以外・不正な日付）は読み込みで無視されること", async () => {
    const file = path.join(tempDir, 'a14', 'usage_stats.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      days: {
        'not-a-date': { calls: { a: 5 } },
        '2026-11-10': { calls: { good: 2, bad: 'x', neg: -3 }, errors: 'many', uniques: 4 }
      }
    }));
    const s = new UsageStats({ filePath: file, now: makeClock('2026-11-17T03:00:00Z') });
    await s.init();
    const sum = s.getSummary();
    assert.strictEqual(sum.totals.total_calls, 2);
    assert.strictEqual(sum.totals.calls.good, 2);
    assert.strictEqual(sum.totals.errors, 0);
    assert.strictEqual(sum.per_day['2026-11-10'].uniques_approx, 4);
  });

  // ---------------------------------------------------------
  // B. server.js への組み込み
  // ---------------------------------------------------------
  const prevEnv = {
    JP_RULES_ONLY: process.env.JP_RULES_ONLY,
    JP_RULES_FREE_BETA: process.env.JP_RULES_FREE_BETA,
    STATS_TOKEN: process.env.STATS_TOKEN
  };
  function restoreEnv() {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  function makeServer(extra = {}) {
    const dir = fs.mkdtempSync(path.join(tempDir, 'srv_'));
    const storePath = path.join(dir, 'store.json');
    const store = new StoreManager(storePath);
    const usage = new UsageStats({ filePath: path.join(dir, 'usage_stats.json'), now: makeClock('2026-11-17T03:00:00Z') });
    const server = createStoreServer({ storePath, storeManager: store, usageStats: usage, ...extra });
    const call = (opts) => dispatch(server.handleHttpRequest, opts);
    return { server, usage, call, dir };
  }

  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const postMcp = (headers, body) => ({ method: 'POST', url: '/mcp', headers: { 'Content-Type': 'application/json', ...headers }, body });

  await runTest("B01. POST /mcp の tools/list・initialize が集計されること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.1' }, rpc('initialize', {})));
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.1' }, rpc('tools/list', {})));
      const c = t.usage.getSummary().totals.calls;
      assert.strictEqual(c['initialize'], 1);
      assert.strictEqual(c['tools/list'], 1);
    } finally { restoreEnv(); }
  });

  await runTest("B02. tools/call は道具の名前つきで集計され、知らない名前は (unknown) にまとめられること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.2' }, rpc('tools/call', { name: 'list_jp_rule_categories', arguments: {} })));
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.2' }, rpc('tools/call', { name: 'evil_tool_' + Math.random(), arguments: {} })));
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.2' }, rpc('tools/call', { name: 'evil_tool_' + Math.random(), arguments: {} })));
      const c = t.usage.getSummary().totals.calls;
      assert.strictEqual(c['tools/call:list_jp_rule_categories'], 1);
      assert.strictEqual(c['tools/call:(unknown)'], 2);
      assert.strictEqual(Object.keys(c).filter(k => k.includes('evil_tool')).length, 0, "知らない名前がそのまま記録された");
    } finally { restoreEnv(); }
  });

  await runTest("B03. 知らないメソッドは 'other' にまとめられること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.3' }, rpc('weird/method_' + Math.random(), {})));
      const c = t.usage.getSummary().totals.calls;
      assert.strictEqual(c['other'], 1);
    } finally { restoreEnv(); }
  });

  await runTest("B04. エラーで終わった tools/call は errors に数えられること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    delete process.env.JP_RULES_FREE_BETA;
    try {
      const t = makeServer();
      // 無料ベータでないとき、キーなしの check_jp_travel_compliance はエラーになる
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.4' }, rpc('tools/call', { name: 'check_jp_travel_compliance', arguments: { checkType: 'tax_free' } })));
      const sum = t.usage.getSummary();
      assert.strictEqual(sum.totals.errors, 1);
      assert.strictEqual(sum.totals.calls['tools/call:check_jp_travel_compliance'], 1);
    } finally { restoreEnv(); }
  });

  await runTest("B05. x-usage-ignore: 1 を付けた呼び出しは数えられないこと", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.5', 'x-usage-ignore': '1' }, rpc('tools/list', {})));
      assert.strictEqual(t.usage.getSummary().totals.total_calls, 0);
      // 付けていない呼び出しは数えられる（反対側の確認）
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.5' }, rpc('tools/list', {})));
      assert.strictEqual(t.usage.getSummary().totals.total_calls, 1);
    } finally { restoreEnv(); }
  });

  await runTest("B06. 回数制限（429）になった呼び出しは rate_limited として数えられること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer({ rateLimitMaxRequests: 2 });
      const headers = { 'x-forwarded-for': '203.0.113.6' };
      await t.call(postMcp(headers, rpc('tools/list', {})));
      await t.call(postMcp(headers, rpc('tools/list', {})));
      const third = await t.call(postMcp(headers, rpc('tools/list', {})));
      assert.strictEqual(third.statusCode, 429);
      const c = t.usage.getSummary().totals.calls;
      assert.strictEqual(c['rate_limited'], 1);
      assert.strictEqual(c['tools/list'], 2);
    } finally { restoreEnv(); }
  });

  await runTest("B07. STATS_TOKEN が未設定なら /api/stats は 404（存在しないのと同じ見え方）であること", async () => {
    delete process.env.STATS_TOKEN;
    try {
      const t = makeServer();
      const res = await t.call({ url: '/api/stats', headers: { 'x-stats-token': 'anything' } });
      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.body.error, 'NOT_FOUND');
    } finally { restoreEnv(); }
  });

  await runTest("B08. 合言葉が違う・無いときは 404、正しいときだけ 200 で集計が見えること", async () => {
    process.env.STATS_TOKEN = 'test-token-0123456789';
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.8' }, rpc('tools/list', {})));

      const none = await t.call({ url: '/api/stats' });
      const wrong = await t.call({ url: '/api/stats', headers: { 'x-stats-token': 'wrong-token' } });
      const wrongSameLen = await t.call({ url: '/api/stats', headers: { 'x-stats-token': 'test-token-9999999999' } });
      assert.strictEqual(none.statusCode, 404);
      assert.strictEqual(wrong.statusCode, 404);
      assert.strictEqual(wrongSameLen.statusCode, 404);

      const ok = await t.call({ url: '/api/stats?days=7', headers: { 'x-stats-token': 'test-token-0123456789' } });
      assert.strictEqual(ok.statusCode, 200);
      assert.strictEqual(ok.body.success, true);
      assert.strictEqual(ok.body.days_requested, 7);
      assert.strictEqual(ok.body.totals.calls['tools/list'], 1);
    } finally { restoreEnv(); }
  });

  await runTest("B09. /api/stats の出力にも保存ファイルにも、アクセス元の IP が現れないこと", async () => {
    process.env.STATS_TOKEN = 'test-token-0123456789';
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.99', 'user-agent': 'SecretAgent/9' }, rpc('tools/list', {})));
      const res = await t.call({ url: '/api/stats', headers: { 'x-stats-token': 'test-token-0123456789' } });
      assert.ok(!res.rawBody.includes('203.0.113.99'));
      assert.ok(!res.rawBody.includes('SecretAgent'));
      await t.usage.flush();
      const saved = fs.readFileSync(path.join(t.dir, 'usage_stats.json'), 'utf8');
      assert.ok(!saved.includes('203.0.113.99'));
      assert.ok(!saved.includes('SecretAgent'));
      assert.strictEqual(res.body.per_day['2026-11-17'].uniques_approx, 1);
    } finally { restoreEnv(); }
  });

  await runTest("B10. 集計を数えても、課金データ（store.json）の中身は変わらないこと", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const t = makeServer();
      const storePath = path.join(t.dir, 'store.json');
      const before = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null;
      await t.call(postMcp({ 'x-forwarded-for': '203.0.113.10' }, rpc('tools/list', {})));
      await t.usage.flush();
      const after = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null;
      assert.strictEqual(after, before, "store.json が書き換わった");
    } finally { restoreEnv(); }
  });

  await runTest("B11. ライブデモ（POST /api/demo/ogp）が demo:ogp として集計され、JP_RULES_ONLY では数えないこと", async () => {
    delete process.env.JP_RULES_ONLY;
    try {
      const t = makeServer();
      const ok = await t.call({
        method: 'POST', url: '/api/demo/ogp',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
        body: { title: '集計テスト', theme: 'cyber_neon', size: 'ogp' }
      });
      assert.strictEqual(ok.statusCode, 200);
      assert.strictEqual(t.usage.getSummary().totals.calls['demo:ogp'], 1);

      process.env.JP_RULES_ONLY = 'true';
      const blocked = await t.call({
        method: 'POST', url: '/api/demo/ogp',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.11' },
        body: { title: 'x' }
      });
      assert.strictEqual(blocked.statusCode, 403);
      assert.strictEqual(t.usage.getSummary().totals.calls['demo:ogp'], 1, "403 のデモが数えられた");
    } finally { restoreEnv(); }
  });

  await runTest("B12. 集計器が壊れていても /mcp の応答は正常に返ること", async () => {
    process.env.JP_RULES_ONLY = 'true';
    try {
      const broken = { record() { throw new Error('boom'); }, getSummary() { return {}; }, flush() {} };
      const t = makeServer({ usageStats: broken });
      const res = await t.call(postMcp({ 'x-forwarded-for': '203.0.113.12' }, rpc('tools/list', {})));
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.result && Array.isArray(res.body.result.tools));
    } finally { restoreEnv(); }
  });

  await runTest("C01. usage_stats.js が同梱されていないビルド（jp-rules 専用 Dockerfile と同じ構成）でも、サーバーが起動して応答できること", async () => {
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(tempDir, 'image_'));
    for (const f of ['package.json', 'server.js', 'mcp.js', 'store.js', 'stripe_billing.js']) {
      fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
    }
    fs.cpSync(path.join(__dirname, 'jp_rules'), path.join(dir, 'jp_rules'), { recursive: true });
    fs.cpSync(path.join(__dirname, 'public'), path.join(dir, 'public'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'));
    assert.ok(!fs.existsSync(path.join(dir, 'usage_stats.js')));

    const script = [
      "const { createStoreServer } = require('./server');",
      "const t = createStoreServer({ storePath: require('path').join(__dirname, 'data', 'store.json') });",
      "t.usageStats.record('x');",
      "console.log(JSON.stringify({ disabled: t.usageStats.disabled === true, summary: t.usageStats.getSummary() }));"
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: dir,
      env: { ...process.env, JP_RULES_ONLY: 'true' },
      encoding: 'utf8'
    });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(parsed.disabled, true);
    assert.strictEqual(parsed.summary.disabled, true);
  });

  console.log(`\n=================================================================`);
  console.log(`  結果: ${passedTests} / ${totalTests} PASS`);
  console.log(`=================================================================`);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  if (passedTests !== totalTests) process.exitCode = 1;
})();
