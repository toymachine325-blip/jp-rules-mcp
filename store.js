/**
 * store.js
 * データストア管理・アトミック永続化・APIキーお小遣い上限ロック
 * ゼロ外部依存・純粋Node.js実装
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 非JP商品生成モジュールの遅延・安全ロード（スタンドアロンJP Rules環境でのファイル未配置クラッシュ防止）
let drumsMidiModule = null;
function getDrumsMidi() {
  if (!drumsMidiModule && process.env.JP_RULES_ONLY !== 'true') {
    try {
      drumsMidiModule = require('./products/drums_midi');
    } catch (e) {
      drumsMidiModule = null;
    }
  }
  return drumsMidiModule;
}

let rocktypoMotionModule = null;
function getRocktypoMotion() {
  if (!rocktypoMotionModule && process.env.JP_RULES_ONLY !== 'true') {
    try {
      rocktypoMotionModule = require('./products/rocktypo_motion');
    } catch (e) {
      rocktypoMotionModule = null;
    }
  }
  return rocktypoMotionModule;
}

let tempMailModule = null;
function getTempMailModule() {
  if (!tempMailModule && process.env.JP_RULES_ONLY !== 'true') {
    try {
      tempMailModule = require('./temp_mail');
    } catch (e) {
      try {
        tempMailModule = require(path.resolve(__dirname, 'temp_mail'));
      } catch (err) {
        tempMailModule = null;
      }
    }
  }
  return tempMailModule;
}

const STORE_PATH = path.resolve(__dirname, 'data', 'store.json');
const CYBER_COMIC_PROMPTS_PATH = path.resolve(__dirname, 'products', 'cyber_comic_prompts.json');

function getCurrentYearMonth(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 初期3商品カタログ定義
const INITIAL_PRODUCTS = [
  {
    id: "drums-8beat-midi",
    name: "即戦力8ビート・ドラムMIDI（16小節/裏拍グルーヴ/SMF Type 0）",
    description: "4/4拍子、PPQ 480。裏拍オフビート強調ハイハット、シンコペーションキック、2/4拍スネア＋タムフィルイン付きの本物SMF Type 0 MIDIバイナリ生成。",
    price_yen: 30,
    type: "api",
    parameters: {
      bpm: { type: "number", default: 121.86, description: "テンポ (BPM)" },
      bars: { type: "integer", default: 16, description: "小節数 (1〜64)" },
      seed: { type: "integer", default: 20261113, description: "乱数シード" }
    }
  },
  {
    id: "rocktypo-motion-json",
    name: "ロックタイポ・キレキレ文字アニメーション設定JSON",
    description: "歌詞フレーズ配列を受け取り、ロックタイポスタジオ互換の超高速カット・ズーム・シェイク演出JSONを自動生成。",
    price_yen: 50,
    type: "api",
    parameters: {
      lyrics: { type: "array", description: "フレーズ配列または複数行テキスト", required: true },
      bpm: { type: "number", default: 150, description: "テンポ (BPM)" },
      aspect_ratio: { type: "string", default: "9:16", description: "アスペクト比 (9:16 / 16:9)" }
    }
  },
  {
    id: "cyber-comic-prompts",
    name: "サイバー・コミック風MV制作プロンプトテンプレート集（10シーン）",
    description: "Midjourney/ComfyUI/Runway等で即活用できるサイバー・コミック・ハーフトーン調MV用プロンプト完全攻略テンプレート集。",
    price_yen: 300,
    type: "file",
    parameters: {}
  }
];

class StoreManager {
  constructor(storePath = STORE_PATH, options = {}) {
    this.storePath = storePath;
    this.options = options || {};

    const env = process.env || {};
    const cfg = this.options.supabaseConfig || {};
    const rawUrl = cfg.url !== undefined ? cfg.url : env.SUPABASE_URL;
    const url = rawUrl ? String(rawUrl).trim().replace(/\/+$/, '') : '';

    const serviceRoleKey = cfg.serviceRoleKey !== undefined
      ? cfg.serviceRoleKey
      : (env.SUPABASE_SERVICE_ROLE_KEY ? String(env.SUPABASE_SERVICE_ROLE_KEY).trim() : '');

    const table = cfg.table !== undefined
      ? cfg.table
      : (env.SUPABASE_STORE_TABLE ? String(env.SUPABASE_STORE_TABLE).trim() : 'ai_micro_store_state');

    const storeId = cfg.storeId !== undefined
      ? cfg.storeId
      : (env.SUPABASE_STORE_ID ? String(env.SUPABASE_STORE_ID).trim() : 'default');

    this.supabaseConfig = {
      url,
      serviceRoleKey,
      table: table || 'ai_micro_store_state',
      storeId: storeId || 'default'
    };

    this.fetchFn = this.options.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    this.pendingRemoteSync = Promise.resolve();
    this.generatedMidiCache = new Map(); // tx_id -> Buffer
    this.generatedFileCache = new Map(); // tx_id -> { buffer, contentType, filename }

    const tmMod = getTempMailModule();
    if (tmMod && tmMod.TempMailManager) {
      this.tempMailManager = this.options.tempMailManager || new tmMod.TempMailManager(this.options.tempMailOptions || {});
    } else {
      this.tempMailManager = null;
    }

    this.init();
  }

  /**
   * Supabase リモート永続化が有効かどうか判定
   */
  isRemoteEnabled() {
    return !!(this.supabaseConfig && this.supabaseConfig.url && this.supabaseConfig.serviceRoleKey && this.fetchFn);
  }

  init() {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.storePath)) {
      const initialData = {
        products: INITIAL_PRODUCTS,
        keys: {},
        processed_stripe_sessions: {},
        updated_at: new Date().toISOString()
      };
      this.saveLocalOnly(initialData);
    } else {
      // 既存データマイグレーション（旧商品名・IDの更新 & Stripe冪等性マップ初期化）
      try {
        const data = this.load();
        let changed = false;
        if (!data.processed_stripe_sessions || typeof data.processed_stripe_sessions !== 'object') {
          data.processed_stripe_sessions = {};
          changed = true;
        }
        if (Array.isArray(data.products)) {
          data.products = data.products.map(p => {
            if (p.id !== 'drums-8beat-midi' && p.id !== 'rocktypo-motion-json' && p.id !== 'cyber-comic-prompts') {
              changed = true;
              return INITIAL_PRODUCTS[2];
            }
            return p;
          });
        }
        if (changed) {
          this.saveLocalOnly(data);
        }
      } catch (e) {}
    }
  }

  load() {
    try {
      const data = fs.readFileSync(this.storePath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      this.init();
      const data = fs.readFileSync(this.storePath, 'utf8');
      return JSON.parse(data);
    }
  }

  /**
   * ローカルファイル専用アトミック書き込み（リモート同期をトリガーしない）
   */
  saveLocalOnly(data) {
    if (!data.updated_at) {
      data.updated_at = new Date().toISOString();
    }
    const jsonStr = JSON.stringify(data, null, 2);
    const tmpPath = `${this.storePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, jsonStr, 'utf8');
      fs.renameSync(tmpPath, this.storePath);
    } catch (err) {
      // Windowsでの EPERM / EBUSY / 権限エラー対策: 直書きフォールバック
      fs.writeFileSync(this.storePath, jsonStr, 'utf8');
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch (e) {}
    }
  }

  /**
   * 現在のストア状態をリモート (Supabase PostgreSQL REST API) へ Upsert
   */
  async pushStateToRemote(stateSnapshot = null) {
    if (!this.isRemoteEnabled()) return;
    const { url, serviceRoleKey, table, storeId } = this.supabaseConfig;
    const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`;

    let statePayload;
    if (stateSnapshot) {
      statePayload = {
        keys: stateSnapshot.keys || {},
        processed_stripe_sessions: stateSnapshot.processed_stripe_sessions || {},
        updated_at: stateSnapshot.updated_at || new Date().toISOString()
      };
    } else {
      const current = this.load();
      statePayload = {
        keys: current.keys || {},
        processed_stripe_sessions: current.processed_stripe_sessions || {},
        updated_at: current.updated_at || new Date().toISOString()
      };
    }

    const payload = {
      id: storeId,
      state: statePayload,
      updated_at: new Date().toISOString()
    };

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[Supabase Store] Failed to push state (HTTP ${res.status}): ${errText}`);
      }
    } catch (err) {
      console.error(`[Supabase Store] Error pushing state to remote: ${err.message}`);
    }
  }

  /**
   * 起動時にリモート (Supabase) から残高・APIキー・決済冪等性データを復元
   */
  async hydrateFromRemote() {
    if (!this.isRemoteEnabled()) return;
    const { url, serviceRoleKey, table, storeId } = this.supabaseConfig;
    const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(storeId)}&select=state`;

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'GET',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[Supabase Store] Hydrate query failed (HTTP ${res.status}): ${errText}`);
        return;
      }

      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].state && typeof rows[0].state === 'object') {
        const remoteState = rows[0].state;
        const localData = this.load();

        if (remoteState.keys && typeof remoteState.keys === 'object') {
          localData.keys = remoteState.keys;
        }
        if (remoteState.processed_stripe_sessions && typeof remoteState.processed_stripe_sessions === 'object') {
          localData.processed_stripe_sessions = remoteState.processed_stripe_sessions;
        }
        if (remoteState.updated_at) {
          localData.updated_at = remoteState.updated_at;
        }

        // リモートへ再送せずローカルファイルのみアトミック更新
        this.saveLocalOnly(localData);
        console.log(`[Supabase Store] Hydrated successfully from remote: ${Object.keys(localData.keys).length} keys, ${Object.keys(localData.processed_stripe_sessions).length} sessions restored.`);
      } else {
        // レコードがまだ存在しない（初回起動など）場合、現在のローカル状態をリモートへ保存
        console.log(`[Supabase Store] Remote state empty for storeId='${storeId}'. Pushing initial local state.`);
        await this.pushStateToRemote(this.load());
      }
    } catch (err) {
      console.error(`[Supabase Store] Error during hydrateFromRemote: ${err.message}`);
    }
  }

  /**
   * Windowsセーフなアトミック同期保存 + リモート非同期直列 Upsert
   */
  save(data) {
    if (!data.updated_at) {
      data.updated_at = new Date().toISOString();
    }
    // 1. 同期ローカルアトミック保存
    this.saveLocalOnly(data);

    // 2. リモート有効時は直列キューで非同期 Upsert
    if (this.isRemoteEnabled()) {
      const snapshot = {
        keys: JSON.parse(JSON.stringify(data.keys || {})),
        processed_stripe_sessions: JSON.parse(JSON.stringify(data.processed_stripe_sessions || {})),
        updated_at: data.updated_at
      };
      this.pendingRemoteSync = this.pendingRemoteSync
        .then(() => this.pushStateToRemote(snapshot))
        .catch(err => {
          console.error(`[Supabase Store] Unhandled sync queue error: ${err.message}`);
        });
    }
  }

  /**
   * 進行中のリモート同期完了を待機
   */
  async flushRemote() {
    if (!this.isRemoteEnabled()) return;
    await this.pendingRemoteSync;
  }

  /**
   * 月次自動リセット判定
   * 現在月と last_reset_month が異なる場合、used_yen を 0 にリセット
   */
  _ensureMonthlyReset(keyRecord, data, date = new Date()) {
    if (!keyRecord) return false;
    const currentMonth = getCurrentYearMonth(date);
    if (!keyRecord.last_reset_month || keyRecord.last_reset_month !== currentMonth) {
      keyRecord.used_yen = 0;
      keyRecord.last_reset_month = currentMonth;
      return true;
    }
    return false;
  }

  // --- 商品関連 ---
  getProducts() {
    const data = this.load();
    return data.products || [];
  }

  getProductById(id) {
    const products = this.getProducts();
    return products.find(p => p.id === id) || null;
  }

  // --- APIキー（AIお小遣いキー）関連 ---
  createKey({ name = "Default Agent", monthly_limit_yen = 1000 }) {
    const data = this.load();
    const key = `sk_souon_${crypto.randomBytes(16).toString('hex')}`;
    const limit = Math.max(0, parseInt(monthly_limit_yen, 10) || 0);
    const currentMonth = getCurrentYearMonth();

    const keyRecord = {
      key,
      name: String(name),
      monthly_limit_yen: limit,
      used_yen: 0,
      last_reset_month: currentMonth,
      is_active: true,
      created_at: new Date().toISOString(),
      transactions: []
    };

    data.keys[key] = keyRecord;
    this.save(data);
    return keyRecord;
  }

  getKey(apiKey) {
    if (!apiKey) return null;
    const data = this.load();
    const key = data.keys[apiKey];
    if (!key) return null;

    if (this._ensureMonthlyReset(key, data)) {
      this.save(data);
    }

    return key;
  }

  getKeyUsage(apiKey) {
    const key = this.getKey(apiKey);
    if (!key) return null;
    const txs = Array.isArray(key.transactions) ? key.transactions : [];
    return {
      key: key.key,
      name: key.name,
      monthly_limit_yen: key.monthly_limit_yen,
      used_yen: key.used_yen,
      remaining_yen: Math.max(0, key.monthly_limit_yen - key.used_yen),
      last_reset_month: key.last_reset_month,
      is_active: key.is_active,
      created_at: key.created_at,
      transaction_count: txs.length,
      transactions: txs
    };
  }

  updateKey(apiKey, updates = {}) {
    const data = this.load();
    const key = data.keys[apiKey];
    if (!key) return null;

    if (updates.monthly_limit_yen !== undefined) {
      key.monthly_limit_yen = Math.max(0, parseInt(updates.monthly_limit_yen, 10) || 0);
    }
    if (updates.is_active !== undefined) {
      key.is_active = Boolean(updates.is_active);
    }
    if (updates.name !== undefined) {
      key.name = String(updates.name);
    }

    this.save(data);
    return key;
  }

  // --- Stripe決済連携 & 冪等性チャージ ---
  isStripeSessionProcessed(sessionId) {
    if (!sessionId) return false;
    const data = this.load();
    const sessions = data.processed_stripe_sessions || {};
    return Boolean(sessions[sessionId]);
  }

  getStripeSessionResult(sessionId) {
    if (!sessionId) return null;
    const data = this.load();
    const sessions = data.processed_stripe_sessions || {};
    const record = sessions[sessionId];
    if (!record) return null;

    const keyRecord = data.keys ? data.keys[record.apiKey] : null;
    const monthlyLimit = keyRecord ? keyRecord.monthly_limit_yen : record.amount_yen;
    const usedYen = keyRecord ? keyRecord.used_yen : 0;
    const remainingYen = Math.max(0, monthlyLimit - usedYen);

    return {
      sessionId: record.sessionId,
      apiKey: record.apiKey,
      is_new_key: record.is_new_key,
      plan_id: record.plan_id,
      amount_yen: record.amount_yen,
      monthly_limit_yen: monthlyLimit,
      used_yen: usedYen,
      remaining_yen: remainingYen,
      customer_email: record.customer_email || null,
      processed_at: record.processed_at
    };
  }

  applyStripeCheckoutSuccess({ sessionId, planId, amountYen, targetApiKey, customerEmail }) {
    if (!sessionId) {
      throw new Error("sessionId is required");
    }
    const data = this.load();
    data.processed_stripe_sessions = data.processed_stripe_sessions || {};

    // 冪等性チェック: 同一 session_id は即座に二重処理を物理遮断
    if (data.processed_stripe_sessions[sessionId]) {
      const prevRecord = data.processed_stripe_sessions[sessionId];
      return {
        success: true,
        duplicate: true,
        message: "Stripe session already processed (idempotency preserved)",
        sessionId,
        key: prevRecord.apiKey,
        amount_yen: prevRecord.amount_yen,
        processed_at: prevRecord.processed_at
      };
    }

    const price = Math.max(0, parseInt(amountYen, 10) || 0);
    let targetKeyRecord = null;
    let isNewKey = false;

    if (targetApiKey && data.keys[targetApiKey]) {
      targetKeyRecord = data.keys[targetApiKey];
      this._ensureMonthlyReset(targetKeyRecord, data);
      targetKeyRecord.monthly_limit_yen += price;
    } else {
      // 新規キー発行
      const newKey = `sk_souon_${crypto.randomBytes(16).toString('hex')}`;
      const currentMonth = getCurrentYearMonth();
      targetKeyRecord = {
        key: newKey,
        name: customerEmail ? `Stripe Agent (${customerEmail})` : "Stripe Agent",
        monthly_limit_yen: price,
        used_yen: 0,
        last_reset_month: currentMonth,
        is_active: true,
        created_at: new Date().toISOString(),
        transactions: []
      };
      data.keys[newKey] = targetKeyRecord;
      isNewKey = true;
    }

    const tx_id = `tx_stripe_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const txRecord = {
      tx_id,
      timestamp,
      product_id: "stripe_topup",
      product_name: `Stripe Checkout Top-Up (${planId || 'custom'})`,
      amount_yen: -price, // チャージ・上限加算
      status: "success",
      params: {
        session_id: sessionId,
        plan_id: planId || null,
        customer_email: customerEmail || null
      }
    };
    targetKeyRecord.transactions.push(txRecord);

    // 冪等性マップに物理記録
    data.processed_stripe_sessions[sessionId] = {
      sessionId,
      plan_id: planId || null,
      amount_yen: price,
      apiKey: targetKeyRecord.key,
      is_new_key: isNewKey,
      customer_email: customerEmail || null,
      processed_at: timestamp
    };

    this.save(data);

    return {
      success: true,
      duplicate: false,
      isNewKey,
      key: targetKeyRecord.key,
      name: targetKeyRecord.name,
      monthly_limit_yen: targetKeyRecord.monthly_limit_yen,
      used_yen: targetKeyRecord.used_yen,
      remaining_yen: Math.max(0, targetKeyRecord.monthly_limit_yen - targetKeyRecord.used_yen),
      tx_id,
      sessionId
    };
  }

  // --- お小遣いチャージ・従量消費（レンダリング等） ---
  chargeKey(apiKey, amountYen, { action = "render", description = "RockTypo MP4 Render", params = {} } = {}) {
    const data = this.load();
    const keyRecord = data.keys[apiKey];

    // 1. 認証チェック
    if (!keyRecord) {
      const err = new Error("Invalid API key");
      err.statusCode = 401;
      err.code = "INVALID_API_KEY";
      throw err;
    }

    // 月次自動リセット確認
    if (this._ensureMonthlyReset(keyRecord, data)) {
      this.save(data);
    }

    if (!keyRecord.is_active) {
      const err = new Error("API key is disabled");
      err.statusCode = 403;
      err.code = "KEY_DISABLED";
      throw err;
    }

    const price = Math.max(0, parseInt(amountYen, 10) || 0);
    const currentUsed = keyRecord.used_yen;
    const limit = keyRecord.monthly_limit_yen;

    // 2. 厳格な上限ロック (used + price > limit)
    if (currentUsed + price > limit) {
      const err = new Error(`Monthly allowance limit exceeded: limit=${limit} JPY, used=${currentUsed} JPY, required=${price} JPY`);
      err.statusCode = 402; // Payment Required
      err.code = "LIMIT_EXCEEDED";
      err.monthly_limit_yen = limit;
      err.used_yen = currentUsed;
      err.price_yen = price;
      err.required_yen = price;
      err.remaining_yen = Math.max(0, limit - currentUsed);
      throw err;
    }

    // 3. 上限チェック通過 -> 決済確定
    const tx_id = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = new Date().toISOString();

    keyRecord.used_yen += price;
    const txRecord = {
      tx_id,
      timestamp,
      product_id: action,
      product_name: description,
      amount_yen: price,
      status: "success",
      params: params || {}
    };
    keyRecord.transactions.push(txRecord);

    this.save(data);

    return {
      success: true,
      tx_id,
      timestamp,
      amount_yen: price,
      monthly_limit_yen: limit,
      used_yen: keyRecord.used_yen,
      remaining_yen: Math.max(0, limit - keyRecord.used_yen)
    };
  }

  // --- 商品の中身を作る（有料購入と無料ベータで共通） ---
  _generateProductData(product, params, tx_id) {
    let productData = null;
    let generatedMidiBuf = null;

    if (product.id === "drums-8beat-midi") {
      const dm = getDrumsMidi();
      if (!dm || typeof dm.generateDrumsMidiBuffer !== 'function') {
        const err = new Error("Product generator for drums-8beat-midi is unavailable in this standalone environment.");
        err.statusCode = 500;
        throw err;
      }
      generatedMidiBuf = dm.generateDrumsMidiBuffer(params);
      productData = {
        type: "midi",
        format: "SMF Type 0",
        bpm: params.bpm || 121.86,
        bars: params.bars || 16,
        byte_length: generatedMidiBuf.length,
        file_size_bytes: generatedMidiBuf.length,
        midi_base64: generatedMidiBuf.toString('base64'),
        download_url: `/api/download/${tx_id}`
      };
    } else if (product.id === "rocktypo-motion-json") {
      const rm = getRocktypoMotion();
      if (!rm || typeof rm.generateRockTypoMotion !== 'function') {
        const err = new Error("Product generator for rocktypo-motion-json is unavailable in this standalone environment.");
        err.statusCode = 500;
        throw err;
      }
      const typoMotion = rm.generateRockTypoMotion(params);
      productData = typoMotion;
    } else if (product.id === "cyber-comic-prompts") {
      try {
        if (!fs.existsSync(CYBER_COMIC_PROMPTS_PATH)) {
          throw new Error("File not found");
        }
        const fileContent = fs.readFileSync(CYBER_COMIC_PROMPTS_PATH, 'utf8');
        productData = JSON.parse(fileContent);
      } catch (e) {
        productData = { error: "Failed to load prompts template", raw: e.message };
      }
    } else {
      productData = { message: "Item purchased successfully", item: product.id };
    }

    return { productData, generatedMidiBuf };
  }

  // --- 無料ベータ用: キー不要。残高・保存データには触れない ---
  purchaseFree(productId, params = {}) {
    const data = this.load();
    const product = (data.products || []).find(p => p.id === productId);
    if (!product) {
      const err = new Error(`Product not found: ${productId}`);
      err.statusCode = 404;
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }

    const tx_id = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const { productData, generatedMidiBuf } = this._generateProductData(product, params || {}, tx_id);

    if (generatedMidiBuf) {
      this._purgeCache(this.generatedMidiCache, 50, 3600000);
      this.generatedMidiCache.set(tx_id, { buffer: generatedMidiBuf, createdAt: Date.now() });
    }

    return {
      success: true,
      tx_id,
      timestamp,
      free_beta: true,
      product: {
        id: product.id,
        name: product.name,
        price_yen: product.price_yen,
        type: product.type
      },
      payment: {
        amount_yen: 0,
        free_beta: true
      },
      data: productData
    };
  }

  // --- 購入 ＆ お小遣い上限ロック ---
  purchase(apiKey, productId, params = {}) {
    const data = this.load();
    const keyRecord = data.keys[apiKey];

    // 1. 認証チェック
    if (!keyRecord) {
      const err = new Error("Invalid API key");
      err.statusCode = 401;
      err.code = "INVALID_API_KEY";
      throw err;
    }

    // 月次自動リセット確認
    if (this._ensureMonthlyReset(keyRecord, data)) {
      this.save(data);
    }

    if (!keyRecord.is_active) {
      const err = new Error("API key is disabled");
      err.statusCode = 403;
      err.code = "KEY_DISABLED";
      throw err;
    }

    // 2. 商品存在チェック
    const product = (data.products || []).find(p => p.id === productId);
    if (!product) {
      const err = new Error(`Product not found: ${productId}`);
      err.statusCode = 404;
      err.code = "PRODUCT_NOT_FOUND";
      throw err;
    }

    const price = product.price_yen;
    const currentUsed = keyRecord.used_yen;
    const limit = keyRecord.monthly_limit_yen;

    // 3. 厳格な上限ロック (used + price > limit)
    if (currentUsed + price > limit) {
      const err = new Error(`Monthly allowance limit exceeded: limit=${limit} JPY, used=${currentUsed} JPY, required=${price} JPY`);
      err.statusCode = 402; // Payment Required
      err.code = "LIMIT_EXCEEDED";
      err.monthly_limit_yen = limit;
      err.used_yen = currentUsed;
      err.price_yen = price;
      err.required_yen = price;
      err.remaining_yen = Math.max(0, limit - currentUsed);
      throw err;
    }

    // 4. 上限チェック通過 -> 商品実体データの生成・取得（生成成功後に課金確定）
    const tx_id = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const { productData, generatedMidiBuf } = this._generateProductData(product, params, tx_id);

    // 5. 商品生成成功を確認した上で残高減算・トランザクション確定
    if (generatedMidiBuf) {
      this._purgeCache(this.generatedMidiCache, 50, 3600000);
      this.generatedMidiCache.set(tx_id, { buffer: generatedMidiBuf, createdAt: Date.now() });
    }

    keyRecord.used_yen += price;
    const txRecord = {
      tx_id,
      timestamp,
      product_id: product.id,
      product_name: product.name,
      amount_yen: price,
      status: "success",
      params: params || {}
    };
    keyRecord.transactions.push(txRecord);

    // アトミック保存
    this.save(data);

    return {
      success: true,
      tx_id,
      timestamp,
      product: {
        id: product.id,
        name: product.name,
        price_yen: product.price_yen,
        type: product.type
      },
      payment: {
        amount_yen: price,
        monthly_limit_yen: limit,
        used_yen: keyRecord.used_yen,
        remaining_yen: Math.max(0, limit - keyRecord.used_yen)
      },
      data: productData
    };
  }

  _purgeCache(map, maxCount = 50, ttlMs = 3600000, now = Date.now()) {
    if (!map || typeof map.entries !== 'function') return;
    for (const [key, item] of map.entries()) {
      if (item && item.createdAt && (now - item.createdAt > ttlMs)) {
        map.delete(key);
      }
    }
    while (map.size > maxCount) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  getMidiBufferByTx(txId, now = Date.now()) {
    this._purgeCache(this.generatedMidiCache, 50, 3600000, now);
    const item = this.generatedMidiCache.get(txId);
    if (!item) return null;
    return Buffer.isBuffer(item) ? item : (item.buffer || null);
  }

  registerDownloadFile(txId, { buffer, contentType = 'application/pdf', filename = 'document.pdf' }, now = Date.now()) {
    this._purgeCache(this.generatedFileCache, 50, 3600000, now);
    this.generatedFileCache.set(txId, { buffer, contentType, filename, createdAt: now });
  }

  getDownloadFile(txId, now = Date.now()) {
    this._purgeCache(this.generatedFileCache, 50, 3600000, now);
    const fileObj = this.generatedFileCache.get(txId);
    if (fileObj && fileObj.buffer) {
      return fileObj;
    }
    const midi = this.getMidiBufferByTx(txId, now);
    if (midi) {
      return {
        buffer: midi,
        contentType: 'audio/midi',
        filename: `souon_drums_${txId}.mid`
      };
    }
    return null;
  }

  getTempMailManager() {
    return this.tempMailManager;
  }
}

module.exports = {
  StoreManager,
  INITIAL_PRODUCTS,
  getCurrentYearMonth
};
