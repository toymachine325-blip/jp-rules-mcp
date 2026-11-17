/**
 * usage_stats.js
 * 「だれかが本当にこのショップの道具を呼んでいるか」を数えるだけの小さな集計器。
 *
 * 残すもの : 日付ごとの「どの呼び方が何回」「エラー何回」「だいたい何ユーザー」
 * 残さないもの: IPアドレス・User-Agent・リクエストの中身・APIキー
 *   - ユニーク数は「プロセスごとの使い捨てソルト＋日付＋IP＋UA」のハッシュを
 *     メモリの中でだけ数え、保存するのは件数（概数）だけ。
 *
 * 保存先: ローカルJSON（data/usage_stats.json）＋ Supabase 有効時は同じテーブルの別の行
 *   （id = `${storeId}__usage`）。課金データ（store.js）とは完全に別扱い。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RETENTION_DAYS = 90;
const MAX_NAME_LENGTH = 64;

function jstDayKey(date) {
  // 'sv' ロケールは YYYY-MM-DD 形式
  return date.toLocaleDateString('sv', { timeZone: 'Asia/Tokyo' });
}

class UsageStats {
  /**
   * @param {object} options
   * @param {string} [options.filePath]        ローカル保存先
   * @param {object} [options.supabaseConfig]  { url, serviceRoleKey, table, storeId }
   * @param {Function} [options.fetchFn]       fetch 互換関数（テストで差し替え）
   * @param {Function} [options.now]           () => Date
   * @param {number} [options.flushIntervalMs] 定期保存の間隔
   */
  constructor(options = {}) {
    this.filePath = options.filePath || null;
    this.supabaseConfig = options.supabaseConfig || null;
    this.fetchFn = options.fetchFn || null;
    this.now = options.now || (() => new Date());
    this.flushIntervalMs = typeof options.flushIntervalMs === 'number' ? options.flushIntervalMs : 60000;

    this.days = {};             // { 'YYYY-MM-DD': { calls: {name: n}, errors: n, uniques: n } }
    this.seenToday = new Map(); // dayKey -> Set(hash)  ※メモリ内のみ・保存しない
    this.salt = crypto.randomBytes(16).toString('hex');
    this.dirty = false;
    this.timer = null;
    this.flushing = null;
  }

  isRemoteEnabled() {
    const c = this.supabaseConfig;
    return !!(c && c.url && c.serviceRoleKey && c.table && c.storeId && this.fetchFn);
  }

  _remoteId() {
    return `${this.supabaseConfig.storeId}__usage`;
  }

  /** 起動時に保存済みの集計を読み戻す（失敗しても動き続ける） */
  async init() {
    let loaded = null;

    if (this.isRemoteEnabled()) {
      try {
        const { url, serviceRoleKey, table } = this.supabaseConfig;
        const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(this._remoteId())}&select=state`;
        const res = await this.fetchFn(endpoint, {
          method: 'GET',
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
        });
        if (res && res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows[0] && rows[0].state && rows[0].state.days) {
            loaded = rows[0].state.days;
          }
        }
      } catch (err) {
        console.error(`[Usage Stats] remote load failed: ${err.message}`);
      }
    }

    if (!loaded && this.filePath) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && parsed.days) loaded = parsed.days;
      } catch (_) { /* 初回はファイルなし */ }
    }

    if (loaded && typeof loaded === 'object') {
      for (const [day, rec] of Object.entries(loaded)) {
        this._mergeDay(day, rec);
      }
    }
  }

  _mergeDay(day, rec) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rec || typeof rec !== 'object') return;
    const target = this._day(day);
    const calls = rec.calls && typeof rec.calls === 'object' ? rec.calls : {};
    for (const [name, n] of Object.entries(calls)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
        const key = String(name).slice(0, MAX_NAME_LENGTH);
        target.calls[key] = (target.calls[key] || 0) + n;
      }
    }
    if (typeof rec.errors === 'number' && Number.isFinite(rec.errors)) target.errors += rec.errors;
    if (typeof rec.uniques === 'number' && Number.isFinite(rec.uniques)) target.uniques += rec.uniques;
  }

  _day(dayKey) {
    if (!this.days[dayKey]) {
      this.days[dayKey] = { calls: {}, errors: 0, uniques: 0 };
    }
    return this.days[dayKey];
  }

  /**
   * 1回ぶんを数える。
   * @param {string} name  例: 'tools/call:generate_beautiful_pdf' / 'tools/list' / 'demo:ogp'
   * @param {object} [info]
   * @param {boolean} [info.error]  エラーで終わったか
   * @param {string}  [info.ip]     ユニーク数のためだけに使い、保存しない
   * @param {string}  [info.ua]     同上
   */
  record(name, info = {}) {
    if (typeof name !== 'string' || !name) return;
    const key = name.slice(0, MAX_NAME_LENGTH);
    const dayKey = jstDayKey(this.now());
    const day = this._day(dayKey);

    day.calls[key] = (day.calls[key] || 0) + 1;
    if (info.error) day.errors += 1;

    if (info.ip) {
      let seen = this.seenToday.get(dayKey);
      if (!seen) {
        seen = new Set();
        this.seenToday.set(dayKey, seen);
        // 古い日のメモリは捨てる
        for (const k of this.seenToday.keys()) {
          if (k !== dayKey) this.seenToday.delete(k);
        }
      }
      const h = crypto.createHash('sha256')
        .update(`${this.salt}|${dayKey}|${info.ip}|${info.ua || ''}`)
        .digest('hex')
        .slice(0, 16);
      if (!seen.has(h)) {
        seen.add(h);
        day.uniques += 1;
      }
    }

    this.dirty = true;
  }

  _prune() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > RETENTION_DAYS) {
      delete this.days[keys.shift()];
    }
  }

  /**
   * 直近 days 日ぶんのまとめ
   * uniques は「日ごとの概数の合計」なので、複数日にまたがる同じ人は重複して数える。
   */
  getSummary(days = 30) {
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), RETENTION_DAYS);
    const keys = Object.keys(this.days).sort().slice(-n);
    const perDay = {};
    const totals = { calls: {}, total_calls: 0, errors: 0, uniques_sum: 0 };

    for (const k of keys) {
      const d = this.days[k];
      const dayTotal = Object.values(d.calls).reduce((a, b) => a + b, 0);
      perDay[k] = { total_calls: dayTotal, errors: d.errors, uniques_approx: d.uniques, calls: { ...d.calls } };
      totals.total_calls += dayTotal;
      totals.errors += d.errors;
      totals.uniques_sum += d.uniques;
      for (const [name, c] of Object.entries(d.calls)) {
        totals.calls[name] = (totals.calls[name] || 0) + c;
      }
    }

    return {
      timezone: 'Asia/Tokyo',
      days_requested: n,
      days_with_data: keys.length,
      totals,
      per_day: perDay,
      note: 'uniques は日ごとの概数（再起動で数え直し）。IP・UA・リクエスト内容は保存していません。'
    };
  }

  /** ローカルとリモートへ保存（変更がなければ何もしない） */
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.dirty) return;

    this._prune();
    const snapshot = JSON.parse(JSON.stringify({ days: this.days, updated_at: this.now().toISOString() }));
    this.dirty = false;

    this.flushing = (async () => {
      try {
        if (this.filePath) {
          try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
            fs.renameSync(tmp, this.filePath);
          } catch (err) {
            console.error(`[Usage Stats] local save failed: ${err.message}`);
          }
        }
        if (this.isRemoteEnabled()) {
          const { url, serviceRoleKey, table } = this.supabaseConfig;
          const endpoint = `${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`;
          const res = await this.fetchFn(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
              Prefer: 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify({ id: this._remoteId(), state: snapshot, updated_at: snapshot.updated_at })
          });
          if (!res || !res.ok) {
            this.dirty = true; // 次回また送る
            console.error(`[Usage Stats] remote save failed: HTTP ${res && res.status}`);
          }
        }
      } catch (err) {
        this.dirty = true;
        console.error(`[Usage Stats] flush error: ${err.message}`);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush(); }, this.flushIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.flushing) await this.flushing;
  }
}

module.exports = { UsageStats, jstDayKey, RETENTION_DAYS };
