/**
 * temp_mail.js
 * 創音知能 AI Micro Store - 使い捨てメール受信＆OTP・確認リンク抽出モジュール
 * AIエージェントの自律サインアップ・認証コード自動抽出・アクセス制御完備
 */

const crypto = require('crypto');

/**
 * 本文（text / html）から OTP 認証コードおよび確認リンクを高精度抽出
 */
function extractOtpAndLinks(text = '', html = '') {
  const combined = `${text}\n${html}`;
  const otpSet = new Set();
  const linkSet = new Set();

  // 西暦年（2020〜2035）の判定ヘルパー
  const isCommonYear = (str) => {
    const n = parseInt(str, 10);
    return n >= 2020 && n <= 2035;
  };

  // 1. 文脈付き OTP 抽出（日英対応・最優先）
  // 例: "認証コード: 839201", "確認コード is 582103", "OTP: 9981", "verification code: 123456"
  const contextOtpRegex = /(?:認証コード|確認コード|確認用コード|ワンタイムパスワード|セキュリティコード|PIN|passcode|code|otp|verification\s*code|security\s*code|one-time\s*password)[\s:：isは]*([0-9]{4,8})\b/gi;
  let match;
  while ((match = contextOtpRegex.exec(combined)) !== null) {
    const code = match[1];
    otpSet.add(code);
  }

  // 2. 単独の 6桁 数字（最も典型的な認証コードパターン。ただし一般的な西暦年 2020〜2035 を除外）
  const standaloneOtpRegex = /\b([0-9]{6})\b/g;
  while ((match = standaloneOtpRegex.exec(combined)) !== null) {
    const code = match[1];
    if (!isCommonYear(code)) {
      otpSet.add(code);
    }
  }

  // 3. 4〜8桁の太字/強調コード（`<strong>123456</strong>` や `*482910*`）
  const highlightedOtpRegex = /(?:<strong>|<b>|\*|`)([0-9]{4,8})(?:<\/strong>|<\/b>|\*|`)/gi;
  while ((match = highlightedOtpRegex.exec(combined)) !== null) {
    const code = match[1];
    if (!isCommonYear(code)) {
      otpSet.add(code);
    }
  }

  // 4. URL / 確認リンクの抽出
  const urlRegex = /https?:\/\/[^\s<>"')]+/g;
  while ((match = urlRegex.exec(combined)) !== null) {
    let cleanUrl = match[0];
    // 末尾の記号クリーンアップ
    cleanUrl = cleanUrl.replace(/[.,;:]+$/, '');
    linkSet.add(cleanUrl);
  }

  // 認証・確認らしきリンクを優先順にソート（verify, confirm, token, auth を含むものを先頭へ）
  const verificationLinks = Array.from(linkSet).sort((a, b) => {
    const aPriority = /(verify|confirm|activate|token|auth|otp)/i.test(a) ? 1 : 0;
    const bPriority = /(verify|confirm|activate|token|auth|otp)/i.test(b) ? 1 : 0;
    return bPriority - aPriority;
  });

  return {
    otpCodes: Array.from(otpSet),
    verificationLinks
  };
}

/**
 * 使い捨てメールインボックス管理マネージャー
 */
class TempMailManager {
  constructor(options = {}) {
    this.domain = options.domain || process.env.TEMP_MAIL_DOMAIN || 'inbox.souon.local';
    this.ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : (30 * 60 * 1000); // 30分
    this.inboxes = new Map(); // inboxId -> inboxObject
    this.emailToInboxId = new Map(); // email(lowercase) -> inboxId
  }

  /**
   * 期限切れインボックスの自動パージ
   */
  purgeExpired(now = Date.now()) {
    for (const [id, inbox] of this.inboxes.entries()) {
      if (inbox.expiresAt <= now) {
        this.emailToInboxId.delete(inbox.email.toLowerCase());
        this.inboxes.delete(id);
      }
    }
  }

  /**
   * 新規使い捨てインボックスの発行 (要 API キー)
   */
  createInbox(ownerApiKey, now = Date.now()) {
    this.purgeExpired(now);
    if (!ownerApiKey || typeof ownerApiKey !== 'string') {
      const err = new Error("ownerApiKey is required to create temp inbox");
      err.statusCode = 400;
      throw err;
    }

    const hex = crypto.randomBytes(4).toString('hex');
    const inboxId = `inb_${crypto.randomBytes(8).toString('hex')}`;
    const email = `agent-${hex}@${this.domain}`.toLowerCase();
    const expiresAt = now + this.ttlMs;

    const inbox = {
      id: inboxId,
      email,
      ownerApiKey,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      expiresAtIso: new Date(expiresAt).toISOString(),
      emails: []
    };

    this.inboxes.set(inboxId, inbox);
    this.emailToInboxId.set(email, inboxId);

    return {
      inbox_id: inboxId,
      email,
      expires_at: inbox.expiresAtIso,
      ttl_minutes: Math.round(this.ttlMs / 60000)
    };
  }

  /**
   * 受信 Webhook からのメール格納
   */
  receiveInboundEmail(payload = {}, now = Date.now()) {
    this.purgeExpired(now);
    const { to, from, subject, text, html } = payload || {};
    if (!to || typeof to !== 'string') {
      return { accepted: false, reason: "Missing 'to' address" };
    }

    // 宛先アドレスの正規化
    const emailMatch = to.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const targetEmail = (emailMatch ? emailMatch[0] : to).trim().toLowerCase();

    const inboxId = this.emailToInboxId.get(targetEmail);
    if (!inboxId) {
      return { accepted: false, reason: `No active inbox found for ${targetEmail}` };
    }

    const inbox = this.inboxes.get(inboxId);
    if (!inbox || inbox.expiresAt <= now) {
      return { accepted: false, reason: "Inbox expired" };
    }

    // 1インボックスあたり最大20通上限（古いものからローテーション）
    if (inbox.emails.length >= 20) {
      inbox.emails.shift();
    }

    const emailId = `msg_${crypto.randomBytes(6).toString('hex')}`;
    const rawText = text || '';
    const rawHtml = html || '';
    const analysis = extractOtpAndLinks(rawText, rawHtml);

    const receivedMsg = {
      id: emailId,
      received_at: new Date(now).toISOString(),
      from: from || 'unknown',
      to: targetEmail,
      subject: subject || '(No Subject)',
      text: rawText,
      html: rawHtml,
      otp_codes: analysis.otpCodes,
      verification_links: analysis.verificationLinks
    };

    inbox.emails.push(receivedMsg);
    return {
      accepted: true,
      inbox_id: inboxId,
      email_id: emailId,
      otp_count: analysis.otpCodes.length,
      links_count: analysis.verificationLinks.length
    };
  }

  /**
   * インボックス照会（所有者APIキーの一致検証必須）
   */
  readInbox(inboxId, ownerApiKey, now = Date.now()) {
    this.purgeExpired(now);
    if (!inboxId || !this.inboxes.has(inboxId)) {
      const err = new Error(`Inbox not found or expired: '${inboxId}'`);
      err.code = "INBOX_NOT_FOUND";
      err.statusCode = 404;
      throw err;
    }

    const inbox = this.inboxes.get(inboxId);
    if (inbox.expiresAt <= now) {
      this.inboxes.delete(inboxId);
      this.emailToInboxId.delete(inbox.email.toLowerCase());
      const err = new Error(`Inbox '${inboxId}' has expired.`);
      err.code = "INBOX_EXPIRED";
      err.statusCode = 404;
      throw err;
    }

    // 所有者 API キー検証 (厳格なアクセス制御)
    if (inbox.ownerApiKey !== ownerApiKey) {
      const err = new Error("Access denied: You do not own this inbox.");
      err.code = "FORBIDDEN";
      err.statusCode = 403;
      throw err;
    }

    // 受信メール全体から OTP とリンクを集約
    const allOtps = [];
    const allLinks = [];
    for (const msg of inbox.emails) {
      for (const otp of msg.otp_codes) {
        if (!allOtps.includes(otp)) allOtps.push(otp);
      }
      for (const link of msg.verification_links) {
        if (!allLinks.includes(link)) allLinks.push(link);
      }
    }

    return {
      inbox_id: inbox.id,
      email: inbox.email,
      created_at: inbox.createdAt,
      expires_at: inbox.expiresAtIso,
      remaining_seconds: Math.max(0, Math.ceil((inbox.expiresAt - now) / 1000)),
      total_emails: inbox.emails.length,
      latest_otp: allOtps.length > 0 ? allOtps[allOtps.length - 1] : null,
      all_otps: allOtps,
      verification_links: allLinks,
      emails: inbox.emails.map(e => ({
        id: e.id,
        received_at: e.received_at,
        from: e.from,
        subject: e.subject,
        text: e.text,
        otp_codes: e.otp_codes,
        verification_links: e.verification_links
      }))
    };
  }
}

module.exports = {
  TempMailManager,
  extractOtpAndLinks
};
