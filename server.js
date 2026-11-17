/**
 * server.js
 * 創音知能 AI Micro Store バックエンドサーバー
 * ゼロ外部依存・純粋Node.js httpモジュール実装
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { StoreManager } = require('./store');
const { createMcpHandler, getAvailableTools, isRockTypoAvailable, isTempMailPublic } = require('./mcp');
// 利用集計は付け足しの機能。ファイルが同梱されていないビルド（jp-rules 専用の Dockerfile など）でも
// サーバーが起動できるよう、読み込めないときは何もしない集計器に差し替える。
let UsageStats;
try {
  ({ UsageStats } = require('./usage_stats'));
} catch (_) {
  UsageStats = class NoopUsageStats {
    constructor() { this.disabled = true; }
    async init() {}
    start() {}
    async stop() {}
    async flush() {}
    record() {}
    getSummary() {
      return { disabled: true, note: 'usage_stats.js is not included in this build.' };
    }
  };
}
const {
  CHARGE_PLANS,
  getChargePlan,
  createStripeCheckoutSession,
  verifyStripeSignature
} = require('./stripe_billing');

let exporterModule = null;
if (process.env.JP_RULES_ONLY !== 'true') {
  try {
    exporterModule = require(path.resolve(__dirname, '../ロックタイポスタジオ/rocktypo_mp4_exporter.js'));
  } catch (e) {
    try {
      exporterModule = require('../../ロックタイポスタジオ/rocktypo_mp4_exporter.js');
    } catch (err) {}
  }
}

function getJobManager() {
  if (process.env.JP_RULES_ONLY === 'true') return null;
  return exporterModule ? exporterModule.jobManager : null;
}

// 美麗 PDF / OGP 生成モジュールの遅延取得
let pdfGeneratorModule = null;
function getPdfGenerator() {
  if (!pdfGeneratorModule && process.env.JP_RULES_ONLY !== 'true') {
    try {
      pdfGeneratorModule = require('./pdf_generator');
    } catch (e) {
      try {
        pdfGeneratorModule = require(path.resolve(__dirname, 'pdf_generator'));
      } catch (err) {
        pdfGeneratorModule = null;
      }
    }
  }
  return pdfGeneratorModule;
}

let ogpGeneratorModule = null;
function getOgpGenerator() {
  if (!ogpGeneratorModule && process.env.JP_RULES_ONLY !== 'true') {
    try {
      ogpGeneratorModule = require('./ogp_generator');
    } catch (e) {
      try {
        ogpGeneratorModule = require(path.resolve(__dirname, 'ogp_generator'));
      } catch (err) {
        ogpGeneratorModule = null;
      }
    }
  }
  return ogpGeneratorModule;
}

function parseRawBody(req) {
  if (req._rawBody) return Promise.resolve(req._rawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      length += buf.length;
      if (length > 5 * 1024 * 1024) { // 5MB limit
        if (typeof req.destroy === 'function') {
          req.destroy();
        }
        reject(new Error("Request body too large"));
      }
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      req._rawBody = buffer;
      resolve(buffer);
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await parseRawBody(req);
  const body = raw.toString('utf8');
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error("Invalid JSON: " + err.message);
  }
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const jsonStr = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    ...extraHeaders
  });
  res.end(jsonStr);
}

function getAuthApiKey(req) {
  // 1. x-api-key ヘッダー (Smithery / Direct HTTP 互換)
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }

  // 2. Authorization ヘッダー (Bearer またはプレーン sk_souon_...)
  const auth = req.headers['authorization'] || '';
  if (typeof auth === 'string' && auth.trim()) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
    if (auth.trim().startsWith('sk_souon_')) {
      return auth.trim();
    }
  }

  return null;
}

function getBearerToken(req) {
  return getAuthApiKey(req);
}

function getRequestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['host'] || 'localhost:3456';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

// ダウンロード名に日本語などが入っても Content-Disposition を壊さない（RFC 6266 / 5987）
// ASCII 以外を含む値をそのまま入れると Node が ERR_INVALID_CHAR を出して 500 になる。
function attachmentDisposition(filename) {
  const name = String(filename || 'download.bin');
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function createStoreServer(options = {}) {
  const storePath = options.storePath;
  const storeManager = options.storeManager || new StoreManager(storePath, options);
  const handleMcp = createMcpHandler(storeManager);

  // 利用状況の集計（IP・中身は残さない。課金データとは別保存）
  const usageStats = options.usageStats || new UsageStats({
    filePath: path.join(path.dirname(storeManager.storePath), 'usage_stats.json'),
    supabaseConfig: storeManager.supabaseConfig,
    fetchFn: storeManager.fetchFn
  });

  // 自分のテスト呼び出しを数えないための合図（ヘッダー x-usage-ignore: 1）
  function recordUsage(req, name, extra = {}) {
    try {
      if (req.headers['x-usage-ignore'] === '1') return;
      usageStats.record(name, {
        ...extra,
        ip: getClientIp(req),
        ua: String(req.headers['user-agent'] || '').slice(0, 200)
      });
    } catch (_) { /* 集計の失敗で本処理を止めない */ }
  }

  // MCP リクエストを集計用の名前に直す（知らない名前は1つにまとめて、集計が膨らむのを防ぐ）
  function mcpUsageName(body) {
    const method = body && typeof body.method === 'string' ? body.method : '';
    if (method === 'tools/call') {
      const toolName = body.params && typeof body.params.name === 'string' ? body.params.name : '';
      const known = getAvailableTools().some(t => t.name === toolName);
      return `tools/call:${known ? toolName : '(unknown)'}`;
    }
    if (method === 'initialize' || method === 'tools/list' || method === 'ping') return method;
    return 'other';
  }

  function mcpResponseIsError(resp) {
    return Boolean(resp && (resp.error || (resp.result && resp.result.isError)));
  }

  // 無料（APIキー未指定）リクエスト用 IPレート制限設定（スライディングウィンドウ方式）
  const rateLimitWindowMs = typeof options.rateLimitWindowMs === 'number' ? options.rateLimitWindowMs : 60000;
  const rateLimitMaxRequests = typeof options.rateLimitMaxRequests === 'number' ? options.rateLimitMaxRequests : 30;
  const rateLimitMap = new Map(); // IP -> Array<timestamp>

  function checkFreeRateLimit(ip, now = Date.now()) {
    let timestamps = rateLimitMap.get(ip);
    if (!timestamps) {
      timestamps = [];
      rateLimitMap.set(ip, timestamps);
    }

    const windowStart = now - rateLimitWindowMs;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= rateLimitMaxRequests) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + rateLimitWindowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }

    timestamps.push(now);

    // メモリリーク防止（マップサイズ肥大化時の期限切れエントリ一括パージ）
    if (rateLimitMap.size > 500) {
      for (const [key, list] of rateLimitMap.entries()) {
        if (list.length === 0 || list[list.length - 1] <= windowStart) {
          rateLimitMap.delete(key);
        }
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  // 無料ライブデモ専用 IP レート制限設定（デフォルト 1分10回）
  const demoRateLimitWindowMs = typeof options.demoRateLimitWindowMs === 'number' ? options.demoRateLimitWindowMs : 60000;
  const demoRateLimitMaxRequests = typeof options.demoRateLimitMaxRequests === 'number' ? options.demoRateLimitMaxRequests : 10;
  const demoRateLimitMap = new Map(); // IP -> Array<timestamp>

  function checkDemoRateLimit(ip, now = Date.now()) {
    let timestamps = demoRateLimitMap.get(ip);
    if (!timestamps) {
      timestamps = [];
      demoRateLimitMap.set(ip, timestamps);
    }

    const windowStart = now - demoRateLimitWindowMs;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= demoRateLimitMaxRequests) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + demoRateLimitWindowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }

    timestamps.push(now);

    if (demoRateLimitMap.size > 500) {
      for (const [key, list] of demoRateLimitMap.entries()) {
        if (list.length === 0 || list[list.length - 1] <= windowStart) {
          demoRateLimitMap.delete(key);
        }
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  }

  async function handleHttpRequest(req, res) {
    // CORS プリフライト
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    try {
      // 0. 静的Web UI配信 (GET / または GET /index.html または GET /jp_rules.html)
      if ((pathname === '/' || pathname === '/index.html' || pathname === '/jp_rules.html') && method === 'GET') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        let targetHtml = isJpRulesOnly ? 'jp_rules.html' : (pathname === '/jp_rules.html' ? 'jp_rules.html' : 'index.html');
        let htmlPath = path.join(__dirname, 'public', targetHtml);
        if (!fs.existsSync(htmlPath)) {
          if (isJpRulesOnly) {
            htmlPath = path.join(__dirname, 'public', 'jp_rules.html');
          } else {
            htmlPath = path.join(__dirname, 'public', 'index.html');
          }
        }
        if (fs.existsSync(htmlPath)) {
          const content = fs.readFileSync(htmlPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(content),
            'Access-Control-Allow-Origin': '*'
          });
          res.end(content);
          return;
        } else {
          sendJson(res, 404, {
            success: false,
            error: "NOT_FOUND",
            message: `public/${targetHtml} not found`
          });
          return;
        }
      }

      // ファビコン
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 0-2. 汎用フォント配信 (GET /fonts/*)
      if (pathname.startsWith('/fonts/') && method === 'GET') {
        const FONTS_DIR = path.resolve(__dirname, '..', 'fonts');
        let relativePath;
        try {
          relativePath = decodeURIComponent(pathname.replace(/^\/fonts\//, ''));
        } catch (_) {
          sendJson(res, 400, {
            success: false,
            error: "BAD_REQUEST",
            message: "Malformed URI path"
          });
          return;
        }

        const safePath = path.resolve(FONTS_DIR, relativePath);
        // パストラバーサル防止チェック: 対象パスが FONTS_DIR 内部に収まっていること
        if (!safePath.startsWith(FONTS_DIR + path.sep) && safePath !== FONTS_DIR) {
          sendJson(res, 403, {
            success: false,
            error: "FORBIDDEN",
            message: "Path traversal blocked"
          });
          return;
        }

        if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ext = path.extname(safePath).toLowerCase();
          const mimeTypes = {
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8'
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          const fileContent = fs.readFileSync(safePath);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(fileContent),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          });
          res.end(fileContent);
          return;
        } else {
          sendJson(res, 404, {
            success: false,
            error: "NOT_FOUND",
            message: `Font file not found: ${relativePath}`
          });
          return;
        }
      }

      // 1. ヘルスチェック
      if (pathname === '/health' || pathname === '/api/health') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        const mode = isJpRulesOnly ? 'jp_rules_only' : (isRockTypoAvailable() ? 'full' : 'standard');
        const tools = getAvailableTools();
        sendJson(res, 200, {
          status: 'ok',
          service: 'souon-ai-micro-store',
          version: '1.0.0',
          mode,
          toolsCount: tools.length,
          free_beta: process.env.JP_RULES_FREE_BETA === 'true',
          temp_mail: isTempMailPublic(),
          storage: storeManager.isRemoteEnabled() ? 'supabase' : 'local_json',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // 1-1. 利用状況 (GET /api/stats?days=30) — 環境変数 STATS_TOKEN と x-stats-token が一致したときだけ
      if (pathname === '/api/stats' && method === 'GET') {
        const expected = process.env.STATS_TOKEN;
        const given = String(req.headers['x-stats-token'] || '');
        const ok = Boolean(expected) &&
          given.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
        if (!expected || !ok) {
          // 設定がない／合言葉違いは「そんなページはない」と同じ見え方にする
          sendJson(res, 404, {
            success: false,
            error: "NOT_FOUND",
            message: `Endpoint ${method} ${pathname} not found`
          });
          return;
        }
        sendJson(res, 200, { success: true, ...usageStats.getSummary(parsedUrl.searchParams.get('days')) });
        return;
      }

      // 1-2. Stripe 決済プラン一覧 (GET /api/billing/plans)
      if (pathname === '/api/billing/plans' && method === 'GET') {
        sendJson(res, 200, {
          success: true,
          plans: Object.values(CHARGE_PLANS)
        });
        return;
      }

      // 1-2-2. Stripe セッション決済結果照会 (GET /api/billing/session?session_id=cs_...)
      if (pathname === '/api/billing/session' && method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session_id');
        if (!sessionId || !sessionId.trim()) {
          sendJson(res, 400, {
            success: false,
            error: "MISSING_SESSION_ID",
            message: "session_id query parameter is required"
          });
          return;
        }

        const sessionResult = storeManager.getStripeSessionResult(sessionId.trim());
        if (sessionResult) {
          sendJson(res, 200, {
            success: true,
            status: "completed",
            ...sessionResult
          });
        } else {
          sendJson(res, 200, {
            success: true,
            status: "pending",
            sessionId: sessionId.trim(),
            message: "Payment processing or webhook pending"
          });
        }
        return;
      }

      // 1-3. Stripe Checkout Session 作成 (POST /api/billing/checkout)
      if (pathname === '/api/billing/checkout' && method === 'POST') {
        const body = await parseJsonBody(req);
        const planId = body.plan_id;
        const targetApiKey = body.apiKey || body.api_key || getBearerToken(req);
        const successUrl = body.success_url;
        const cancelUrl = body.cancel_url;

        // クライアントからの任意金額指定は拒否し改ざん防止
        if (body.amount_yen !== undefined || body.price !== undefined || body.amount !== undefined) {
          sendJson(res, 400, {
            success: false,
            error: "ARBITRARY_AMOUNT_NOT_ALLOWED",
            message: "Direct amount specification is prohibited. Please specify a valid plan_id."
          });
          return;
        }

        const plan = getChargePlan(planId);
        if (!plan) {
          sendJson(res, 400, {
            success: false,
            error: "INVALID_PLAN",
            message: `Invalid plan_id: '${planId}'. Must be one of: ${Object.keys(CHARGE_PLANS).join(', ')}`
          });
          return;
        }

        const stripeSecretKey = options.stripeSecretKey || process.env.STRIPE_SECRET_KEY;
        if (!stripeSecretKey) {
          sendJson(res, 503, {
            success: false,
            error: "STRIPE_SECRET_KEY_MISSING",
            message: "STRIPE_SECRET_KEY is not configured on this server. Set STRIPE_SECRET_KEY in environment variables."
          });
          return;
        }

        const baseUrl = getRequestBaseUrl(req);
        const effectiveSuccessUrl = successUrl || `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}&status=success`;
        const effectiveCancelUrl = cancelUrl || `${baseUrl}/?status=cancelled`;

        try {
          const session = await createStripeCheckoutSession({
            planId,
            apiKey: targetApiKey,
            successUrl: effectiveSuccessUrl,
            cancelUrl: effectiveCancelUrl,
            secretKey: stripeSecretKey
          });
          sendJson(res, 200, {
            success: true,
            sessionId: session.sessionId,
            url: session.url,
            plan: session.plan
          });
        } catch (err) {
          sendJson(res, err.statusCode || 500, {
            success: false,
            error: err.code || "CHECKOUT_SESSION_FAILED",
            message: err.message
          });
        }
        return;
      }

      // 1-4. 無料ライブデモ API (POST /api/demo/ogp & POST /api/demo/pdf)
      if (pathname.startsWith('/api/demo/') && method === 'POST') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "FORBIDDEN",
            message: "Demo endpoints are disabled in JP_RULES_ONLY mode."
          });
          return;
        }

        // IP レート制限チェック（1分10回）
        const clientIp = getClientIp(req);
        const rateCheck = checkDemoRateLimit(clientIp);
        if (!rateCheck.allowed) {
          sendJson(res, 429, {
            success: false,
            error: "RATE_LIMIT_EXCEEDED",
            message: `Demo rate limit exceeded (${demoRateLimitMaxRequests} requests/min). Use MCP API for production workflows.`
          }, {
            'Retry-After': String(rateCheck.retryAfterSec)
          });
          return;
        }

        const body = await parseJsonBody(req);

        // 利用集計（知っているデモ名だけ数える）
        const demoName = pathname.slice('/api/demo/'.length);
        if (['ogp', 'pdf', 'temp-mail'].includes(demoName)) {
          recordUsage(req, `demo:${demoName}`);
        }

        // 1-4-1. OGP 画像デモ (POST /api/demo/ogp)
        if (pathname === '/api/demo/ogp') {
          const title = body.title;
          if (!title || typeof title !== 'string' || !title.trim()) {
            sendJson(res, 400, {
              success: false,
              error: "BAD_REQUEST",
              message: "title is required"
            });
            return;
          }
          if (title.length > 120) {
            sendJson(res, 400, {
              success: false,
              error: "BAD_REQUEST",
              message: "Title exceeds demo limit of 120 characters"
            });
            return;
          }

          const ogpGen = getOgpGenerator();
          if (!ogpGen) {
            sendJson(res, 503, {
              success: false,
              error: "GENERATOR_UNAVAILABLE",
              message: "OGP generator is unavailable in current environment"
            });
            return;
          }

          try {
            const ogpResult = await ogpGen.generateOgpImageBuffer({
              title,
              subtitle: body.subtitle || "",
              badge: body.badge || "DEMO PREVIEW",
              author: body.author || "Souon AI Micro Store",
              theme: body.theme || "cyber_neon",
              size: body.size || "ogp"
            });

            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Content-Disposition': 'inline; filename="demo_ogp.png"',
              'Content-Length': ogpResult.buffer.length,
              'Access-Control-Allow-Origin': '*'
            });
            res.end(ogpResult.buffer);
            return;
          } catch (err) {
            sendJson(res, 500, {
              success: false,
              error: "OGP_GENERATION_FAILED",
              message: err.message
            });
            return;
          }
        }

        // 1-4-2. 美麗 PDF デモ (POST /api/demo/pdf)
        if (pathname === '/api/demo/pdf') {
          const markdown = body.markdown;
          if (!markdown || typeof markdown !== 'string' || !markdown.trim()) {
            sendJson(res, 400, {
              success: false,
              error: "BAD_REQUEST",
              message: "markdown is required"
            });
            return;
          }
          if (markdown.length > 1500) {
            sendJson(res, 400, {
              success: false,
              error: "BAD_REQUEST",
              message: "Demo markdown limit is 1,500 characters. Use MCP API for unlimited documents."
            });
            return;
          }

          const pdfGen = getPdfGenerator();
          if (!pdfGen) {
            sendJson(res, 503, {
              success: false,
              error: "GENERATOR_UNAVAILABLE",
              message: "PDF generator is unavailable in current environment"
            });
            return;
          }

          try {
            const pdfResult = await pdfGen.generateBeautifulPdfBuffer({
              markdown,
              title: body.title || "Live Demo Preview",
              theme: body.theme || "business_report",
              pageSize: body.pageSize || "A4",
              footerText: "Live Demo - Souon AI Micro Store"
            });

            res.writeHead(200, {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'inline; filename="demo_preview.pdf"',
              'Content-Length': pdfResult.buffer.length,
              'Access-Control-Allow-Origin': '*'
            });
            res.end(pdfResult.buffer);
            return;
          } catch (err) {
            sendJson(res, 500, {
              success: false,
              error: "PDF_GENERATION_FAILED",
              message: err.message
            });
            return;
          }
        }

        // 1-4-3. 使い捨てメール＆OTP抽出デモ (POST /api/demo/temp-mail)
        if (pathname === '/api/demo/temp-mail') {
          // 受信ドメインが未設定の無料ベータでは公開しない
          if (!isTempMailPublic()) {
            sendJson(res, 404, {
              success: false,
              error: "NOT_AVAILABLE",
              message: "The disposable-mail demo is not available yet."
            });
            return;
          }
          const tempMailMgr = typeof storeManager.getTempMailManager === 'function' ? storeManager.getTempMailManager() : null;
          if (!tempMailMgr) {
            sendJson(res, 503, {
              success: false,
              error: "TEMP_MAIL_UNAVAILABLE",
              message: "Temp mail manager is unavailable in current environment"
            });
            return;
          }

          try {
            const demoApiKey = `sk_demo_${Date.now()}`;
            // 1. 仮インボックス作成
            const inbox = tempMailMgr.createInbox(demoApiKey);

            // 2. ダミーの認証コード付きメールを受信シミュレート
            const dummyCode = String(Math.floor(100000 + Math.random() * 900000));
            const dummyToken = crypto.randomBytes(8).toString('hex');
            const verifyLink = `https://inbox.souon.local/verify?token=${dummyToken}`;

            tempMailMgr.receiveInboundEmail({
              to: inbox.email,
              from: "verify@auth.souon.local",
              subject: "【創音知能】アカウント確認用コードのお知らせ",
              text: `創音知能 AI Micro Store をご利用いただきありがとうございます。\n\nお客様の認証コードは【 ${dummyCode} 】です。有効期限は10分間です。\n\nまた、以下の確認リンクをクリックしてもアカウントを有効化できます：\n${verifyLink}\n\n※このメールに心当たりがない場合は破棄してください。`,
              html: `<p>認証コード：<strong>${dummyCode}</strong></p><p><a href="${verifyLink}">アカウント有効化リンク</a></p>`
            });

            // 3. インボックス読み取り & 抽出結果返却
            const readData = tempMailMgr.readInbox(inbox.inbox_id, demoApiKey);
            sendJson(res, 200, {
              success: true,
              demo: true,
              inbox_id: inbox.inbox_id,
              email: inbox.email,
              latest_otp: readData.latest_otp,
              all_otps: readData.all_otps,
              verification_links: readData.verification_links,
              sample_subject: readData.emails[0]?.subject,
              message: "Demo temporary inbox created and verification email parsed successfully."
            });
            return;
          } catch (err) {
            sendJson(res, 500, {
              success: false,
              error: "DEMO_TEMP_MAIL_FAILED",
              message: err.message
            });
            return;
          }
        }
      }

      // 1-5. 使い捨てメール受信 Webhook (POST /api/temp-mail/inbound)
      if (pathname === '/api/temp-mail/inbound' && method === 'POST') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "FORBIDDEN",
            message: "Temp mail inbound webhook is disabled in JP_RULES_ONLY mode."
          });
          return;
        }

        // シークレット検証 (設定時のみ)
        const expectedSecret = options.tempMailWebhookSecret || process.env.TEMP_MAIL_WEBHOOK_SECRET;
        if (expectedSecret) {
          const incomingSecret = req.headers['x-webhook-secret'];
          if (!incomingSecret || incomingSecret !== expectedSecret) {
            sendJson(res, 401, {
              success: false,
              error: "UNAUTHORIZED",
              message: "Invalid or missing x-webhook-secret header"
            });
            return;
          }
        }

        const tempMailMgr = typeof storeManager.getTempMailManager === 'function' ? storeManager.getTempMailManager() : null;
        if (!tempMailMgr) {
          sendJson(res, 503, {
            success: false,
            error: "TEMP_MAIL_UNAVAILABLE",
            message: "Temp mail manager is unavailable in current environment"
          });
          return;
        }

        const body = await parseJsonBody(req);
        const result = tempMailMgr.receiveInboundEmail(body);
        if (!result.accepted) {
          sendJson(res, 400, {
            success: false,
            error: "EMAIL_REJECTED",
            reason: result.reason
          });
          return;
        }

        sendJson(res, 200, {
          success: true,
          ...result
        });
        return;
      }

      // 1-4. Stripe Webhook イベント受信 (POST /api/billing/webhook)
      if (pathname === '/api/billing/webhook' && method === 'POST') {
        const rawBody = await parseRawBody(req);
        const signatureHeader = req.headers['stripe-signature'] || '';
        const webhookSecret = options.stripeWebhookSecret || process.env.STRIPE_WEBHOOK_SECRET;

        // HMAC-SHA256 署名検証 (timingSafeEqual)
        const verifyResult = verifyStripeSignature(rawBody, signatureHeader, webhookSecret);
        if (!verifyResult.valid) {
          sendJson(res, 400, {
            success: false,
            error: "INVALID_SIGNATURE",
            message: verifyResult.error || "Stripe signature verification failed"
          });
          return;
        }

        let event = null;
        try {
          event = JSON.parse(rawBody.toString('utf8'));
        } catch (e) {
          sendJson(res, 400, {
            success: false,
            error: "INVALID_JSON_BODY",
            message: "Webhook request body is not valid JSON"
          });
          return;
        }

        // checkout.session.completed 受信時
        if (event.type === 'checkout.session.completed') {
          const session = event.data?.object || {};
          const sessionId = session.id;
          const planId = session.metadata?.plan_id;
          const targetApiKey = session.metadata?.apiKey;
          const customerEmail = session.customer_details?.email || session.customer_email;
          const amountYen = session.amount_total !== undefined
            ? Math.floor(session.amount_total)
            : (getChargePlan(planId)?.price_yen || 0);

          try {
            const chargeResult = storeManager.applyStripeCheckoutSuccess({
              sessionId,
              planId,
              amountYen,
              targetApiKey,
              customerEmail
            });

            await storeManager.flushRemote();

            sendJson(res, 200, {
              success: true,
              received: true,
              event_id: event.id,
              event_type: event.type,
              sessionId,
              duplicate: chargeResult.duplicate,
              key: chargeResult.key,
              isNewKey: chargeResult.isNewKey,
              monthly_limit_yen: chargeResult.monthly_limit_yen
            });
            return;
          } catch (err) {
            sendJson(res, 500, {
              success: false,
              error: "BILLING_PROCESSING_FAILED",
              message: err.message
            });
            return;
          }
        }

        // その他の Stripe イベントは正常受領 (200 OK)
        sendJson(res, 200, {
          success: true,
          received: true,
          event_id: event.id,
          event_type: event.type,
          unhandled: true
        });
        return;
      }

      // 2. 商品一覧 (GET /api/products)
      if (pathname === '/api/products' && method === 'GET') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "FORBIDDEN",
            message: "Products endpoint is disabled in JP_RULES_ONLY mode."
          });
          return;
        }

        const products = storeManager.getProducts();
        sendJson(res, 200, {
          success: true,
          count: products.length,
          products
        });
        return;
      }

      // 3. お小遣いキー発行 (POST /api/keys)
      if (pathname === '/api/keys' && method === 'POST') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "PUBLIC_KEY_MANAGEMENT_DISABLED",
            message: "Direct key creation and modification are disabled in JP_RULES_ONLY mode. Please purchase via Stripe Checkout."
          });
          return;
        }

        const body = await parseJsonBody(req);
        const name = body.name || "Default Agent";
        const limit = body.monthly_limit_yen !== undefined ? body.monthly_limit_yen : 1000;
        const newKey = storeManager.createKey({ name, monthly_limit_yen: limit });
        await storeManager.flushRemote();
        sendJson(res, 201, {
          success: true,
          message: "AI allowance key issued successfully",
          key: newKey
        });
        return;
      }

      // 4. お小遣いキー利用状況照会 (GET /api/keys/:key/usage)
      const usageMatch = pathname.match(/^\/api\/keys\/([^/]+)\/usage$/);
      if (usageMatch && method === 'GET') {
        const apiKey = decodeURIComponent(usageMatch[1]);
        const usage = storeManager.getKeyUsage(apiKey);
        if (!usage) {
          sendJson(res, 404, { success: false, error: "KEY_NOT_FOUND", message: "API key not found" });
          return;
        }
        sendJson(res, 200, {
          success: true,
          usage
        });
        return;
      }

      // 5. お小遣いキー設定変更 (PATCH /api/keys/:key)
      const patchMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
      if (patchMatch && method === 'PATCH') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "PUBLIC_KEY_MANAGEMENT_DISABLED",
            message: "Direct key creation and modification are disabled in JP_RULES_ONLY mode. Please purchase via Stripe Checkout."
          });
          return;
        }

        const apiKey = decodeURIComponent(patchMatch[1]);
        const body = await parseJsonBody(req);
        const updated = storeManager.updateKey(apiKey, body);
        if (!updated) {
          sendJson(res, 404, { success: false, error: "KEY_NOT_FOUND", message: "API key not found" });
          return;
        }
        await storeManager.flushRemote();
        sendJson(res, 200, {
          success: true,
          message: "API key updated successfully",
          key: updated
        });
        return;
      }

      // 6. 購入リクエスト (POST /api/purchase)
      if (pathname === '/api/purchase' && method === 'POST') {
        const isJpRulesOnly = process.env.JP_RULES_ONLY === 'true';
        if (isJpRulesOnly) {
          sendJson(res, 403, {
            success: false,
            error: "FORBIDDEN",
            message: "Purchase endpoint is disabled in JP_RULES_ONLY mode."
          });
          return;
        }

        const body = await parseJsonBody(req);
        const apiKey = getBearerToken(req) || body.api_key;
        const productId = body.product_id;
        const params = body.params || {};

        // 無料ベータ中は APIキー不要・課金なし
        const freeStore = process.env.JP_RULES_FREE_BETA === 'true';

        if (!apiKey && !freeStore) {
          sendJson(res, 401, {
            success: false,
            error: "UNAUTHORIZED",
            message: "Missing API key in Authorization Bearer header or api_key body"
          });
          return;
        }

        if (!productId) {
          sendJson(res, 400, {
            success: false,
            error: "BAD_REQUEST",
            message: "product_id is required"
          });
          return;
        }

        try {
          const result = (freeStore && typeof storeManager.purchaseFree === 'function')
            ? storeManager.purchaseFree(productId, params)
            : storeManager.purchase(apiKey, productId, params);
          await storeManager.flushRemote();
          sendJson(res, 200, result);
        } catch (err) {
          const statusCode = err.statusCode || 500;
          sendJson(res, statusCode, {
            success: false,
            error: err.code || "PURCHASE_ERROR",
            message: err.message,
            monthly_limit_yen: err.monthly_limit_yen,
            used_yen: err.used_yen,
            required_yen: err.price_yen,
            remaining_yen: err.remaining_yen
          });
        }
        return;
      }

      // 7. ファイルダウンロード (GET /api/download/:tx_id) - MIDI / PDF バイナリ配信
      const downloadMatch = pathname.match(/^\/api\/download\/([^/]+)$/);
      if (downloadMatch && method === 'GET') {
        const txId = downloadMatch[1];

        // 汎用ファイルキャッシュ (PDF等)
        if (typeof storeManager.getDownloadFile === 'function') {
          const fileObj = storeManager.getDownloadFile(txId);
          if (fileObj && fileObj.buffer) {
            res.writeHead(200, {
              'Content-Type': fileObj.contentType || 'application/octet-stream',
              'Content-Disposition': attachmentDisposition(fileObj.filename || (txId + '.bin')),
              'Content-Length': fileObj.buffer.length,
              'Access-Control-Allow-Origin': '*'
            });
            res.end(fileObj.buffer);
            return;
          }
        }

        // 既存 MIDI ファイルキャッシュ
        const midiBuffer = storeManager.getMidiBufferByTx(txId);
        if (!midiBuffer) {
          sendJson(res, 404, { success: false, error: "FILE_NOT_FOUND", message: "File binary not found or expired" });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/midi',
          'Content-Disposition': `attachment; filename="souon_drums_${txId}.mid"`,
          'Content-Length': midiBuffer.length,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(midiBuffer);
        return;
      }

      // 7-2. ロックタイポ・レンダリングジョブ進捗照会 (GET /api/render-jobs/:job_id)
      const renderJobMatch = pathname.match(/^\/api\/render-jobs\/([^/]+)$/);
      if (renderJobMatch && method === 'GET') {
        const jobId = decodeURIComponent(renderJobMatch[1]);
        const jm = getJobManager();
        if (!jm) {
          sendJson(res, 503, { success: false, error: "EXPORTER_UNAVAILABLE", message: "Render engine not available" });
          return;
        }
        const jobStatus = jm.getRenderJobStatus(jobId);
        if (!jobStatus) {
          sendJson(res, 404, { success: false, error: "JOB_NOT_FOUND", message: `Render job ${jobId} not found` });
          return;
        }
        sendJson(res, 200, { success: true, job: jobStatus });
        return;
      }

      // 7-3. ロックタイポ・完成MP4ダウンロード (GET /api/render-download/:job_id)
      const renderDownloadMatch = pathname.match(/^\/api\/render-download\/([^/]+)$/);
      if (renderDownloadMatch && method === 'GET') {
        const jobId = decodeURIComponent(renderDownloadMatch[1]);
        const jm = getJobManager();
        if (!jm) {
          sendJson(res, 503, { success: false, error: "EXPORTER_UNAVAILABLE", message: "Render engine not available" });
          return;
        }
        const jobStatus = jm.getRenderJobStatus(jobId);
        if (!jobStatus || !jobStatus.outputPath || !fs.existsSync(jobStatus.outputPath)) {
          sendJson(res, 404, { success: false, error: "FILE_NOT_FOUND", message: `Rendered MP4 file not found or not completed for job ${jobId}` });
          return;
        }
        const stat = fs.statSync(jobStatus.outputPath);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="rocktypo_${jobId}.mp4"`,
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*'
        });
        const readStream = fs.createReadStream(jobStatus.outputPath);
        readStream.pipe(res);
        return;
      }

      // 7-4. MCP メタデータ配信エンドポイント (GET /.well-known/mcp.json, GET /server.json)
      if ((pathname === '/.well-known/mcp.json' || pathname === '/server.json') && method === 'GET') {
        const serverJsonPath = path.join(__dirname, 'server.json');
        if (fs.existsSync(serverJsonPath)) {
          try {
            const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
            sendJson(res, 200, serverJson);
            return;
          } catch (e) {}
        }
        sendJson(res, 200, {
          $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: "io.github.toymachine325-blip/jp-rules-mcp",
          title: "Japan Inbound & Cross-Border Rules MCP",
          description: "Official, verified Japan inbound travel and cross-border regulatory rules for AI Agents (Tax-Free Reform Nov 2026, Shinkansen Luggage, Customs).",
          version: "1.0.0",
          homepage: "https://jp-rules-mcp.onrender.com",
          repository: {
            type: "git",
            url: "https://github.com/toymachine325-blip/jp-rules-mcp.git"
          },
          remotes: [
            {
              type: "streamable-http",
              url: "https://jp-rules-mcp.onrender.com/mcp"
            }
          ]
        });
        return;
      }

      // 7-5. MCP HTTP GET ガード (405 Method Not Allowed)
      if (pathname === '/mcp' && method === 'GET') {
        sendJson(res, 405, {
          error: "METHOD_NOT_ALLOWED",
          message: "Use POST /mcp for MCP JSON-RPC 2.0 requests.",
          endpoint: "/mcp",
          protocolVersion: "2024-11-05"
        }, {
          'Allow': 'POST, OPTIONS'
        });
        return;
      }

      // 8. MCP互換エンドポイント (POST /mcp)
      if (pathname === '/mcp' && method === 'POST') {
        const body = await parseJsonBody(req);
        const authKey = getAuthApiKey(req);

        // 無料リクエスト（有効なAPIキー未所持・未登録キー含む）に対する IP レート制限
        const keyRecord = authKey ? storeManager.getKey(authKey) : null;
        const hasValidActiveKey = Boolean(keyRecord && (keyRecord.is_active === true || keyRecord.status === 'active'));

        if (!hasValidActiveKey) {
          const clientIp = getClientIp(req);
          const rateCheck = checkFreeRateLimit(clientIp);
          if (!rateCheck.allowed) {
            recordUsage(req, 'rate_limited', { error: true });
            const reqId = (body && body.id !== undefined) ? body.id : null;
            sendJson(res, 429, {
              jsonrpc: "2.0",
              id: reqId,
              error: {
                code: -32029,
                message: "Free tier rate limit exceeded (30 requests/min). Get an API key at / for higher limits and compliance checks."
              }
            }, {
              'Retry-After': String(rateCheck.retryAfterSec)
            });
            return;
          }
        }

        const mcpResponse = await handleMcp(body, authKey);
        recordUsage(req, mcpUsageName(body), { error: mcpResponseIsError(mcpResponse) });
        await storeManager.flushRemote();
        if (mcpResponse) {
          sendJson(res, 200, mcpResponse);
        } else {
          res.writeHead(204);
          res.end();
        }
        return;
      }

      // 該当ルートなし
      sendJson(res, 404, {
        success: false,
        error: "NOT_FOUND",
        message: `Endpoint ${method} ${pathname} not found`
      });

    } catch (err) {
      console.error("Internal Server Error:", err);
      sendJson(res, 500, {
        success: false,
        error: "INTERNAL_ERROR",
        message: err.message
      });
    }
  }

  const server = http.createServer((req, res) => handleHttpRequest(req, res));

  return {
    server,
    storeManager,
    usageStats,
    handleHttpRequest
  };
}

// 直接実行時の起動処理
if (require.main === module) {
  (async () => {
    const PORT = parseInt(process.env.PORT, 10) || 3456;
    const { server, storeManager, usageStats } = createStoreServer();

    // 利用集計を復元して、1分ごとに保存を始める
    try {
      await usageStats.init();
      usageStats.start();
    } catch (err) {
      console.error("[AI Micro Store] Usage stats init error:", err);
    }

    // 起動時にリモート (Supabase) から残高・APIキーを復元
    if (storeManager && typeof storeManager.hydrateFromRemote === 'function') {
      try {
        await storeManager.hydrateFromRemote();
      } catch (err) {
        console.error("[AI Micro Store] Startup hydrate error:", err);
      }
    }

    // SIGINT / SIGTERM で進行中のリモート同期を完了させて安全終了
    const handleShutdown = async () => {
      console.log("\n[AI Micro Store] Shutting down gracefully...");
      try {
        if (storeManager && typeof storeManager.flushRemote === 'function') {
          await storeManager.flushRemote();
        }
      } catch (_) {}
      try {
        await usageStats.stop();
      } catch (_) {}
      process.exit(0);
    };
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[AI Micro Store] Server listening on http://localhost:${PORT}`);
      console.log(`[AI Micro Store] MCP endpoint ready at http://localhost:${PORT}/mcp`);
      if (storeManager.isRemoteEnabled()) {
        console.log(`[AI Micro Store] Storage mode: Supabase PostgreSQL REST API (table: ${storeManager.supabaseConfig.table}, id: ${storeManager.supabaseConfig.storeId})`);
      } else {
        console.log(`[AI Micro Store] Storage mode: Local JSON file (data/store.json)`);
      }
    });
  })();
}

module.exports = {
  createStoreServer,
  getRequestBaseUrl
};
