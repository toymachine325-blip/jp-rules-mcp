/**
 * mcp.js
 * Model Context Protocol (MCP) JSON-RPC 2.0 ハンドラ
 * AIエージェントから直接商品検索・お小遣い購入・ロックタイポMP4自動生成を可能にするエンドポイント
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ロックタイポスタジオの MP4 エクスポーター（非同期ジョブマネージャー）参照
let exporterModule = null;
if (process.env.JP_RULES_ONLY !== 'true') {
  try {
    exporterModule = require(path.resolve(__dirname, '../ロックタイポスタジオ/rocktypo_mp4_exporter.js'));
  } catch (e) {
    try {
      exporterModule = require('../../ロックタイポスタジオ/rocktypo_mp4_exporter.js');
    } catch (err) {
      // ロックタイポ未配置環境では安全にnull
    }
  }
}

function isRockTypoAvailable() {
  if (process.env.JP_RULES_ONLY === 'true') return false;
  return Boolean(exporterModule && exporterModule.jobManager);
}

function getJobManager() {
  return isRockTypoAvailable() ? exporterModule.jobManager : null;
}

// Japan Inbound & Cross-Border Rules モジュール参照
let jpRulesModule = null;
try {
  jpRulesModule = require('./jp_rules');
} catch (e) {
  try {
    jpRulesModule = require(path.resolve(__dirname, 'jp_rules'));
  } catch (err) {
    console.warn('[MCP] jp_rules module not loaded:', err.message);
  }
}

function getRulesDb() {
  return jpRulesModule ? jpRulesModule.defaultRulesDb : null;
}

// 美麗 PDF 生成モジュール参照（遅延・安全ロード）
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

// OGP・サムネイル画像生成モジュール参照（遅延・安全ロード）
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

const TOOL_LIST_PRODUCTS = {
  name: "list_products",
  description: "創音知能 AI Micro Store で販売中のAI生成素材・MIDI・設定JSONの一覧と価格（日本円）を取得します。 / List products available in Souon AI Micro Store.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const TOOL_PURCHASE_PRODUCT = {
  name: "purchase_product",
  description: "AIお小遣いキー（月額上限ロック付き）を使って商品を購入し、即戦力ドラムMIDIやアニメーションJSONを取得します。上限（月額お小遣い）を超過した場合は安全に402エラーで拒否され、購入は発生しません。 / Purchase digital products with AI allowance key.",
  inputSchema: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        description: "購入する商品ID / Product ID (drums-8beat-midi, rocktypo-motion-json, cyber-comic-prompts)"
      },
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance API key (sk_souon_...). HTTP Authorization Bearer ヘッダでも指定可能"
      },
      params: {
        type: "object",
        description: "商品生成パラメータ (例: bpm, bars, lyrics配列等) / Product generation parameters"
      }
    },
    required: ["productId"]
  }
};

const TOOL_START_ROCKTYPO_RENDER = {
  name: "start_rocktypo_render",
  description: "【日英/Bilingual】歌詞と楽曲からロック調キネティックタイポグラフィ縦型MP4動画（1080×1920/H.264/AAC）の非同期レンダリングを開始します。AIお小遣いキー月額上限（402）チェック連動（1回50円）。 / Start asynchronous vertical kinetic typography MP4 render (1080x1920 H.264/AAC) from lyrics and audio, with AI monthly allowance limit check (50 JPY per render).",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance key (sk_souon_...). Authorization Bearer ヘッダでも指定可"
      },
      lyrics: {
        type: "string",
        description: "歌詞テキスト（改行区切りまたはフレーズ文字列） / Lyrics text separated by newlines"
      },
      lrc: {
        type: "string",
        description: "LRCまたはSRT形式のタイムコード付き歌詞テキスト（指定時は手動タイミングを優先適用） / Timed lyrics text in LRC or SRT format with timecodes."
      },
      autoSync: {
        type: "boolean",
        description: "音声ファイル（audioPath）と Whisper による歌詞自動同期・強制アライメントを有効化するか（デフォルト: false、追加課金なし） / Whether to enable Whisper auto-sync alignment between lyrics and audio (default: false, no extra charge)."
      },
      autoDetectSection: {
        type: "boolean",
        description: "フル音源からサビ（指定歌詞の最適区間）を自動検出し、自動切り出して動画化するか（デフォルト: false） / Whether to automatically detect and extract the chorus/target section from full audio using Whisper (default: false)."
      },
      sectionPadding: {
        type: "number",
        description: "サビ自動検出時の前後余白秒数（デフォルト: 0.6秒） / Padding seconds before and after detected section (default: 0.6s)."
      },
      vocalSeparation: {
        type: "boolean",
        description: "Demucs によるボーカル分離（伴奏・楽器除去）を行い、Whisper の音声認識・強制アライメント精度を極限まで高めるか（デフォルト: false） / Whether to use Demucs AI vocal separation before Whisper forced alignment to maximize precision (default: false)."
      },
      audioPath: {
        type: "string",
        description: "ローカル音声ファイルパス（WAV/MP3）。指定時は楽曲尺に自動同期 / Local audio file path (WAV/MP3)"
      },
      bpm: {
        type: "number",
        description: "楽曲テンポ (BPM)。自動音ハメ計算の基準 (デフォルト: 120) / Music tempo in BPM (default: 120)"
      },
      preset: {
        type: "string",
        description: "ロックタイポ・プリセット名 (thunderbolt_burst, alterna_mincho, cyber_comic, retro_vhs 等 14種) / Preset name (default: thunderbolt_burst)"
      },
      aspectRatio: {
        type: "string",
        description: "画面比率 ('9:16' または '16:9'、デフォルト: '9:16') / Aspect ratio (default: '9:16')"
      },
      durationSec: {
        type: "number",
        description: "動画の秒数。音声指定時は音声長を自動採用。安全上限: 180秒 / Duration in seconds (max safety limit: 180s)"
      },
      fadeInSec: {
        type: "number",
        description: "動画冒頭のフェードイン秒数（黒画面・無音からフェード。サビ自動検出時はデフォルト0.4秒、未指定時通常0秒） / Fade-in seconds at video start (default: 0.4s for auto-detected section, 0s otherwise)"
      },
      fadeOutSec: {
        type: "number",
        description: "動画末尾のフェードアウト秒数（黒画面・無音へフェード。サビ自動検出時はデフォルト0.8秒、未指定時通常0秒） / Fade-out seconds at video end (default: 0.8s for auto-detected section, 0s otherwise)"
      },
      bgImage: {
        type: "string",
        description: "背景画像パス（PNG/JPG） / Optional background image path"
      },
      quality: {
        type: "number",
        description: "レンダリング品質 (0.5〜1.0、デフォルト: 0.92) / Quality (default: 0.92)"
      },
      projectState: {
        type: "object",
        description: "直接プロジェクト状態オブジェクトを渡す場合の設定（上級者用） / Raw projectState object"
      }
    },
    required: ["lyrics"]
  }
};

const TOOL_CHECK_ROCKTYPO_RENDER = {
  name: "check_rocktypo_render",
  description: "【日英/Bilingual】start_rocktypo_render で発行された job_id のレンダリング進捗（%）・ステータス・出力MP4パス・ダウンロード情報を照会します。 / Check status, progress percentage, and output path for a RockTypo rendering job by job_id.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "進捗照会するジョブID / Job ID issued by start_rocktypo_render"
      }
    },
    required: ["job_id"]
  }
};

const TOOL_PREVIEW_ROCKTYPO_FRAMES = {
  name: "preview_rocktypo_frames",
  description: "【日英/Bilingual】動画レンダリング書き出し前に、キネティックタイポグラフィの止め絵（静止画PNG）を1〜5枚即座に高速プレビューします（完全無料・課金0円・APIキー不要）。 / Generate quick still-frame preview PNG images (1-5 frames) of kinetic typography before video rendering (Free, 0 JPY, no API key required).",
  inputSchema: {
    type: "object",
    properties: {
      lyrics: {
        type: "string",
        description: "歌詞テキスト（改行区切りまたはフレーズ文字列） / Lyrics text separated by newlines"
      },
      lrc: {
        type: "string",
        description: "LRCまたはSRT形式のタイムコード付き歌詞テキスト（指定時は手動タイミングを優先適用） / Timed lyrics text in LRC or SRT format with timecodes."
      },
      autoSync: {
        type: "boolean",
        description: "音声ファイル（audioPath）と Whisper による歌詞自動同期・強制アライメントを有効化するか（デフォルト: false、追加課金なし） / Whether to enable Whisper auto-sync alignment between lyrics and audio (default: false, no extra charge)."
      },
      autoDetectSection: {
        type: "boolean",
        description: "フル音源からサビ（指定歌詞の最適区間）を自動検出し、自動切り出して動画化するか（デフォルト: false） / Whether to automatically detect and extract the chorus/target section from full audio using Whisper (default: false)."
      },
      sectionPadding: {
        type: "number",
        description: "サビ自動検出時の前後余白秒数（デフォルト: 0.6秒） / Padding seconds before and after detected section (default: 0.6s)."
      },
      vocalSeparation: {
        type: "boolean",
        description: "Demucs によるボーカル分離（伴奏・楽器除去）を行い、Whisper の音声認識・強制アライメント精度を極限まで高めるか（デフォルト: false） / Whether to use Demucs AI vocal separation before Whisper forced alignment to maximize precision (default: false)."
      },
      audioPath: {
        type: "string",
        description: "ローカル音声ファイルパス（WAV/MP3）。autoSync有効時に使用 / Local audio file path (WAV/MP3) used when autoSync is enabled."
      },
      bpm: {
        type: "number",
        description: "楽曲テンポ (BPM)。音ハメプレビュー計算の基準 (デフォルト: 120) / Music tempo in BPM (default: 120)"
      },
      preset: {
        type: "string",
        description: "ロックタイポ・プリセット名 (thunderbolt_burst, alterna_mincho, cyber_comic 等) / Preset name (default: thunderbolt_burst)"
      },
      aspectRatio: {
        type: "string",
        description: "画面比率 ('9:16' または '16:9'、デフォルト: '9:16') / Aspect ratio (default: '9:16')"
      },
      timestamps: {
        type: "array",
        items: {
          type: "number"
        },
        description: "プレビュー取得時刻の秒数配列（最大5点） / Array of timestamp seconds to preview (up to 5 points)"
      },
      count: {
        type: "number",
        description: "自動選定時のプレビュー画像枚数 (1〜5枚、デフォルト: 3) / Number of preview frames to pick automatically (1-5, default: 3)"
      },
      fullResolution: {
        type: "boolean",
        description: "高解像度 (1080x1920/1920x1080) で出力するか（デフォルト: false で 540x960/960x540 の軽量プレビュー） / Whether to render full resolution (default: false)"
      },
      bgImage: {
        type: "string",
        description: "背景画像パス（PNG/JPG） / Optional background image path"
      },
      projectState: {
        type: "object",
        description: "直接プロジェクト状態オブジェクトを渡す場合の設定（上級者用） / Raw projectState object"
      }
    },
    required: ["lyrics"]
  }
};

const TOOL_GENERATE_BEAUTIFUL_PDF = {
  name: "generate_beautiful_pdf",
  description: "【有料 / 20 JPY】Markdownテキストから見出し・太字・リスト・表・コードブロック・引用・ページ番号付きの美しいプロフェッショナルPDFを自動生成します（日本語・英語完全対応）。AIお小遣い月額上限ロック連動（1回20円、sk_souon_...必須）。 / Generate beautiful, professional PDF documents from Markdown with headers, bold text, lists, tables, code blocks, blockquotes, and page numbers (Japanese & English supported). 20 JPY per generation, requires AI allowance API key.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance API key (sk_souon_...). Authorization Bearer header also supported."
      },
      markdown: {
        type: "string",
        description: "PDF化するMarkdownテキスト / Markdown text to render into PDF"
      },
      title: {
        type: "string",
        description: "ドキュメントタイトル（ヘッダーに表示） / Document title shown in header (default: 'Document')"
      },
      theme: {
        type: "string",
        description: "テーマ選択 ('business_report', 'modern_clean', 'dark_tech') / Theme style: 'business_report' (white/navy), 'modern_clean' (clean/teal), 'dark_tech' (dark/cyan)",
        enum: ["business_report", "modern_clean", "dark_tech"]
      },
      pageSize: {
        type: "string",
        description: "用紙サイズ ('A4', 'Letter') / Page size: 'A4' or 'Letter' (default: 'A4')",
        enum: ["A4", "Letter"]
      },
      footerText: {
        type: "string",
        description: "フッター左側の表記テキスト / Footer text on bottom left (default: 'Souon AI Micro Store')"
      }
    },
    required: ["markdown"]
  }
};

const TOOL_GENERATE_OGP_IMAGE = {
  name: "generate_ogp_image",
  description: "【有料 / 10 JPY】タイトル・サブタイトル・バッジ・テーマ・サイズを指定し、SNSシェア用OGP画像やYouTubeサムネイルPNG（1200x630 / 1280x720 / 1080x1080）を超高速自動生成します（日本語・英語完全対応）。AIお小遣い月額上限ロック連動（1回10円、sk_souon_...必須）。 / Generate high-quality OGP banner & thumbnail PNG images (1200x630, 1280x720, 1080x1080) for SNS sharing and YouTube from title and badge (Japanese & English supported). 10 JPY per generation, requires AI allowance API key.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance API key (sk_souon_...). Authorization Bearer header also supported."
      },
      title: {
        type: "string",
        description: "画像の中央に大きく配置するメインタイトル（長文は自動折り返し） / Main title text to display on image"
      },
      subtitle: {
        type: "string",
        description: "タイトルの下に配置するサブタイトル・解説文 / Optional subtitle or description text"
      },
      badge: {
        type: "string",
        description: "左上に配置するカテゴリ・ブランドバッジ / Category badge tag on top left (default: 'AI COMMERCE')"
      },
      author: {
        type: "string",
        description: "フッター左に配置する著者・ブランド名 / Author or brand name in footer (default: '創音知能 • Souon Chinou')"
      },
      theme: {
        type: "string",
        description: "デザインテーマ ('cyber_neon', 'clean_minimal', 'bold_editorial') / Visual theme: 'cyber_neon' (dark/cyan), 'clean_minimal' (white/teal), 'bold_editorial' (high contrast yellow/black)",
        enum: ["cyber_neon", "clean_minimal", "bold_editorial"]
      },
      size: {
        type: "string",
        description: "画像サイズ ('ogp': 1200x630, 'youtube': 1280x720, 'square': 1080x1080) / Image size: 'ogp' (1200x630), 'youtube' (1280x720), or 'square' (1080x1080)",
        enum: ["ogp", "youtube", "square"]
      }
    },
    required: ["title"]
  }
};

const TOOL_CREATE_TEMP_INBOX = {
  name: "create_temp_inbox",
  description: "【有料 / 10 JPY】AIエージェント自律サインアップ用の使い捨てメールアドレス（inbox_id / 有効期限30分）を発行します。AIお小遣い月額上限ロック連動（1回10円、sk_souon_...必須）。 / Create a temporary disposable email inbox (valid for 30 mins) for autonomous agent signups and OTP verification. 10 JPY per inbox, requires AI allowance API key.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance API key (sk_souon_...). Authorization Bearer header also supported."
      }
    }
  }
};

const TOOL_READ_TEMP_INBOX = {
  name: "read_temp_inbox",
  description: "【無料 / 0 JPY】create_temp_inbox で作成したインボックスに届いたメール一覧を照会し、認証コード（OTP）と確認用URLを自動抽出して取得します（APIキー必須・所有者照会無料）。 / Read incoming emails from temporary inbox, automatically extracting verification codes (OTP) and confirmation links. Free (0 JPY), requires owner API key.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "インボックス作成時の所有者APIキー / Owner API key used when creating the inbox"
      },
      inbox_id: {
        type: "string",
        description: "照会するインボックスID (inb_...) / Temporary inbox ID to read"
      }
    },
    required: ["inbox_id"]
  }
};

const TOOL_LIST_JP_RULE_CATEGORIES = {
  name: "list_jp_rule_categories",
  description: "【無料 / Free 0 JPY】日本のインバウンド旅行・越境規制（2026年11月施行の新免税制度、JR新幹線特大荷物、祝日・大型連休混雑、税関・検疫持込制限）のカテゴリ一覧、ルール件数、最終検証日時を取得します。APIキー不要・課金0円。 / List available categories, rule counts, and verification timestamps for Japan inbound travel and cross-border regulations (tax-free reform Nov 2026, bullet train luggage, holiday rush, customs restrictions). Free, no API key required.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const TOOL_QUERY_JP_INBOUND_RULES = {
  name: "query_jp_inbound_rules",
  description: "【無料 / Free 0 JPY】日本のインバウンド旅行・越境規制ルール（2026年11月改正新免税制度、JR新幹線特大荷物、祝日大型連休混雑、税関検疫）をカテゴリ・キーワードで英語検索します。APIキー不要・課金0円。 / Query official Japan inbound travel and cross-border regulatory rules in structured English JSON (tax-free reform Nov 2026, Shinkansen luggage limits, peak holiday crowding, customs/quarantine). Free, no API key required.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "オプションのAIお小遣いキー（本ツールは無料のため渡されても課金されません） / Optional AI allowance API key (query is free, no charge even if provided)."
      },
      category: {
        type: "string",
        description: "ルールカテゴリ ('tax_free', 'rail_luggage', 'holidays', 'customs') / Rule category filter ('tax_free', 'rail_luggage', 'holidays', or 'customs')"
      },
      keyword: {
        type: "string",
        description: "検索キーワード / Keyword to search across rules, facts, or summaries"
      },
      limit: {
        type: "number",
        description: "取得最大件数（デフォルト: 10） / Maximum number of rules to return (default: 10)"
      }
    }
  }
};

const TOOL_CHECK_JP_TRAVEL_COMPLIANCE = {
  name: "check_jp_travel_compliance",
  description: "【有料 / 30 JPY】旅行者の購入額・荷物寸法・旅行日を指定し、日本の法規制適合性（新免税対象可否・特大荷物事前予約義務・祝日混雑リスク）を即決自動判定します。AIお小遣い月額上限ロック連動（1回30円、sk_souon_...必須）。 / Instant automated compliance evaluation for Japan inbound travel regulations: tax-free shopping eligibility (Nov 2026 reform), Shinkansen oversized baggage rules, or peak holiday congestion risk. 30 JPY per check, requires AI allowance API key.",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "AIお小遣いキー / AI allowance API key (sk_souon_...). Authorization Bearer header also supported."
      },
      checkType: {
        type: "string",
        description: "判定種別 ('tax_free', 'shinkansen_baggage', 'holiday_peak') / Compliance check type: 'tax_free', 'shinkansen_baggage', or 'holiday_peak'",
        enum: ["tax_free", "shinkansen_baggage", "holiday_peak"]
      },
      purchaseAmountJpy: {
        type: "number",
        description: "購入金額（税抜日本円。checkType === 'tax_free' で使用） / Purchase amount in JPY excluding tax (for tax_free check)"
      },
      baggageTotalCm: {
        type: "number",
        description: "荷物3辺合計（cm。checkType === 'shinkansen_baggage' で使用） / Total baggage dimensions in cm (length + width + height) (for shinkansen_baggage check)"
      },
      travelDate: {
        type: "string",
        description: "旅行日 (YYYY-MM-DD。checkType === 'holiday_peak' で使用) / Travel date in YYYY-MM-DD format (for holiday_peak check)"
      }
    },
    required: ["checkType"]
  }
};

const TOOL_CHECK_JP_TRAVEL_COMPLIANCE_FREE_BETA = {
  name: "check_jp_travel_compliance",
  description: "【無料ベータ / Free Beta 0 JPY】旅行者の購入額・荷物寸法・旅行日を指定し、日本の法規制適合性（新免税対象可否・特大荷物事前予約義務・祝日混雑リスク）を即決自動判定します。パブリックベータ期間中完全無料・APIキー不要。 / Instant automated compliance evaluation for Japan inbound travel regulations: tax-free shopping eligibility (Nov 2026 reform), Shinkansen oversized baggage rules, or peak holiday congestion risk. Free during public beta, no API key required (30 req/min).",
  inputSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        description: "オプションのAIお小遣いキー（ベータ期間中は無料のため渡されても課金されません） / Optional API key (free during beta, no charge even if provided)."
      },
      checkType: {
        type: "string",
        description: "判定種別 ('tax_free', 'shinkansen_baggage', 'holiday_peak') / Compliance check type: 'tax_free', 'shinkansen_baggage', or 'holiday_peak'",
        enum: ["tax_free", "shinkansen_baggage", "holiday_peak"]
      },
      purchaseAmountJpy: {
        type: "number",
        description: "購入金額（税抜日本円。checkType === 'tax_free' で使用） / Purchase amount in JPY excluding tax (for tax_free check)"
      },
      baggageTotalCm: {
        type: "number",
        description: "荷物3辺合計（cm。checkType === 'shinkansen_baggage' で使用） / Total baggage dimensions in cm (length + width + height) (for shinkansen_baggage check)"
      },
      travelDate: {
        type: "string",
        description: "旅行日 (YYYY-MM-DD。checkType === 'holiday_peak' で使用) / Travel date in YYYY-MM-DD format (for holiday_peak check)"
      }
    },
    required: ["checkType"]
  }
};

function isFreeBetaMode() {
  return process.env.JP_RULES_FREE_BETA === 'true';
}

// 無料ベータで「ショップ全体」を開けているか（JP_RULES_ONLY のときは従来どおり jp-rules だけ）
function isFreeStoreMode() {
  return isFreeBetaMode() && process.env.JP_RULES_ONLY !== 'true';
}

// 無料ベータ中の「課金したことにする」ダミー（残高は動かさない・保存もしない）
function makeFreeCharge() {
  return {
    tx_id: `tx_${crypto.randomBytes(8).toString('hex')}`,
    monthly_limit_yen: null,
    used_yen: 0,
    remaining_yen: null,
    free_beta: true
  };
}

function chargeOrFree(storeManager, apiKey, amountYen, info) {
  if (isFreeStoreMode()) return makeFreeCharge();
  return storeManager.chargeKey(apiKey, amountYen, info);
}

// 無料ベータ用の説明に差し替えた道具定義（元の定義は書き換えない）
function freeBetaVariant(tool) {
  const props = { ...(tool.inputSchema.properties || {}) };
  if (props.apiKey) {
    props.apiKey = {
      type: "string",
      description: "オプション（ベータ期間中は無料のため不要・渡されても課金されません） / Optional. Not needed during the free beta; never charged even if provided."
    };
  }
  return {
    ...tool,
    description: "【無料ベータ / Free Beta 0 JPY・APIキー不要】" + tool.description +
      " ※パブリックベータ期間中は0円（上記の価格は通常価格）。 / Free during the public beta: no API key, no charge (prices above are the regular prices).",
    inputSchema: {
      ...tool.inputSchema,
      properties: props,
      required: (tool.inputSchema.required || []).filter(r => r !== 'apiKey')
    }
  };
}

function getCheckComplianceTool() {
  return isFreeBetaMode() ? TOOL_CHECK_JP_TRAVEL_COMPLIANCE_FREE_BETA : TOOL_CHECK_JP_TRAVEL_COMPLIANCE;
}

function getAvailableTools() {
  const checkTool = getCheckComplianceTool();

  if (process.env.JP_RULES_ONLY === 'true') {
    return [
      TOOL_LIST_JP_RULE_CATEGORIES,
      TOOL_QUERY_JP_INBOUND_RULES,
      checkTool
    ];
  }

  const freeStore = isFreeStoreMode();
  const tools = [
    TOOL_LIST_PRODUCTS,
    freeStore ? freeBetaVariant(TOOL_PURCHASE_PRODUCT) : TOOL_PURCHASE_PRODUCT
  ];

  if (isRockTypoAvailable()) {
    tools.push(
      TOOL_START_ROCKTYPO_RENDER,
      TOOL_CHECK_ROCKTYPO_RENDER,
      TOOL_PREVIEW_ROCKTYPO_FRAMES
    );
  }

  // 美麗 PDF 生成ツール (通常モード)
  tools.push(freeStore ? freeBetaVariant(TOOL_GENERATE_BEAUTIFUL_PDF) : TOOL_GENERATE_BEAUTIFUL_PDF);

  // OGP・サムネイル画像生成ツール (通常モード)
  tools.push(freeStore ? freeBetaVariant(TOOL_GENERATE_OGP_IMAGE) : TOOL_GENERATE_OGP_IMAGE);

  // 使い捨てメール受信＆OTP抽出ツール (通常モード)
  // 使い捨てメールは「実際にメールを受け取れるドメイン」(TEMP_MAIL_DOMAIN) が設定されるまで、
  // 無料ベータでは公開しない（受け取れないアドレスを配ってしまうため）
  if (!freeStore || process.env.TEMP_MAIL_DOMAIN) {
    tools.push(TOOL_CREATE_TEMP_INBOX);
    tools.push(TOOL_READ_TEMP_INBOX);
  }

  tools.push(
    TOOL_LIST_JP_RULE_CATEGORIES,
    TOOL_QUERY_JP_INBOUND_RULES,
    checkTool
  );

  return tools;
}

function createMcpHandler(storeManager) {
  return async function handleMcpRequest(body, authHeaderKey) {
    if (!body || typeof body !== 'object') {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      };
    }

    const { id, method, params } = body;

    // 1. initialize
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "souon-ai-micro-store",
            version: "1.0.0"
          },
          capabilities: {
            tools: {}
          }
        }
      };
    }

    // 2. notifications (initialized etc.)
    if (method === "notifications/initialized") {
      return null; // 通知なのでレスポンス不要
    }

    // 3. tools/list
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: getAvailableTools()
        }
      };
    }

    // 4. tools/call
    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "list_products") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: list_products is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const products = storeManager.getProducts();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(products, null, 2)
              }
            ]
          }
        };
      }

      if (toolName === "purchase_product") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: purchase_product is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const apiKey = args.apiKey || authHeaderKey;
        const productId = args.productId;
        const productParams = args.params || {};

        if (!apiKey && !isFreeStoreMode()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header."
                }
              ]
            }
          };
        }

        try {
          const purchaseResult = isFreeStoreMode() && typeof storeManager.purchaseFree === 'function'
            ? storeManager.purchaseFree(productId, productParams)
            : storeManager.purchase(apiKey, productId, productParams);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(purchaseResult, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "PURCHASE_FAILED",
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    monthly_limit_yen: err.monthly_limit_yen,
                    used_yen: err.used_yen,
                    price_yen: err.price_yen,
                    remaining_yen: err.remaining_yen
                  }, null, 2)
                }
              ]
            }
          };
        }
      }

      // RockTypo ツール実行時の環境可否チェック
      if (toolName === "start_rocktypo_render" || toolName === "check_rocktypo_render" || toolName === "preview_rocktypo_frames") {
        if (!isRockTypoAvailable()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: RockTypo tools are unavailable in this environment (JP_RULES_ONLY mode enabled or rocktypo_mp4_exporter.js not found)."
                }
              ]
            }
          };
        }
      }

      // 4-1. start_rocktypo_render
      if (toolName === "start_rocktypo_render") {
        const apiKey = args.apiKey || authHeaderKey;
        if (!apiKey) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header."
                }
              ]
            }
          };
        }

        // バリデーション: 歌詞
        const lyricsRaw = args.lrc || args.lyrics;
        let lyricsText = "";
        if (typeof lyricsRaw === "string") {
          lyricsText = lyricsRaw.trim();
        } else if (Array.isArray(lyricsRaw)) {
          lyricsText = lyricsRaw.map(l => (typeof l === 'string' ? l : (l.text || ''))).filter(Boolean).join('\n');
        }

        if (!lyricsText && !args.projectState) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: lyrics is required and cannot be empty (or provide a valid projectState)."
                }
              ]
            }
          };
        }

        // バリデーション: autoSync / autoDetectSection / vocalSeparation
        if ((args.autoSync || args.autoDetectSection || args.vocalSeparation) && !args.audioPath) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: audioPath is required when autoSync, autoDetectSection, or vocalSeparation is enabled / autoSync, autoDetectSection または vocalSeparation を有効化する場合は audioPath の指定が必須です。"
                }
              ]
            }
          };
        }

        // バリデーション: durationSec
        if (args.durationSec !== undefined && args.durationSec !== null) {
          const dur = Number(args.durationSec);
          if (isNaN(dur) || dur <= 0) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Error: durationSec must be a positive number." }]
              }
            };
          }
          if (dur > 180) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Error: durationSec exceeds safety limit of 180 seconds (3 minutes)." }]
              }
            };
          }
        }

        // バリデーション: audioPath
        if (args.audioPath) {
          if (!fs.existsSync(args.audioPath)) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Error: Audio file not found at: ${args.audioPath}` }]
              }
            };
          }
        }

        // バリデーション: bgImage
        if (args.bgImage) {
          if (!fs.existsSync(args.bgImage)) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Error: Background image not found at: ${args.bgImage}` }]
              }
            };
          }
        }

        // お小遣い課金・月額上限チェック (50円)
        const renderCostYen = 50;
        let chargeInfo = null;
        try {
          chargeInfo = storeManager.chargeKey(apiKey, renderCostYen, {
            action: "rocktypo-mp4-render",
            description: "RockTypo Vertical MP4 Auto Render (1080x1920/H.264/AAC) / ロックタイポ・縦型MP4動画自動レンダリング",
            params: {
              bpm: args.bpm || 120,
              preset: args.preset || "thunderbolt_burst",
              durationSec: args.durationSec
            }
          });
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "CHARGE_FAILED",
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    monthly_limit_yen: err.monthly_limit_yen,
                    used_yen: err.used_yen,
                    price_yen: err.price_yen,
                    remaining_yen: err.remaining_yen
                  }, null, 2)
                }
              ]
            }
          };
        }

        // ジョブマネージャー呼び出し
        const jm = getJobManager();
        if (!jm) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: RockTypo job manager is not available in current environment."
                }
              ]
            }
          };
        }

        const job = jm.createRenderJob({
          lyricsText,
          lrc: args.lrc || null,
          autoSync: !!args.autoSync || !!args.autoDetectSection || !!args.vocalSeparation,
          autoDetectSection: !!args.autoDetectSection,
          sectionPadding: typeof args.sectionPadding === 'number' ? args.sectionPadding : undefined,
          vocalSeparation: !!args.vocalSeparation,
          fadeInSec: typeof args.fadeInSec === 'number' ? args.fadeInSec : undefined,
          fadeOutSec: typeof args.fadeOutSec === 'number' ? args.fadeOutSec : undefined,
          bpm: args.bpm || 120,
          preset: args.preset || "thunderbolt_burst",
          aspectRatio: args.aspectRatio || "9:16",
          audioPath: args.audioPath || null,
          bgImage: args.bgImage || null,
          durationSec: args.durationSec || null,
          quality: args.quality || 0.92,
          projectState: args.projectState || null
        });

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  job_id: job.id,
                  status: job.status,
                  cost_yen: renderCostYen,
                  monthly_limit_yen: chargeInfo.monthly_limit_yen,
                  used_yen: chargeInfo.used_yen,
                  remaining_yen: chargeInfo.remaining_yen,
                  tx_id: chargeInfo.tx_id,
                  message: "RockTypo MP4 rendering job started successfully. Poll check_rocktypo_render with job_id to monitor progress.",
                  download_url: `/api/render-download/${job.id}`
                }, null, 2)
              }
            ]
          }
        };
      }

      // 4-2. check_rocktypo_render
      if (toolName === "check_rocktypo_render") {
        const jobId = args.job_id;
        if (!jobId) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: job_id is required." }]
            }
          };
        }

        const jm = getJobManager();
        if (!jm) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: RockTypo job manager is not available." }]
            }
          };
        }

        const status = jm.getRenderJobStatus(jobId);
        if (!status) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error: Render job not found: ${jobId}` }]
            }
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  job_id: status.id,
                  status: status.status,
                  progress: status.progress,
                  stage: status.stage,
                  currentFrame: status.currentFrame,
                  totalFrames: status.totalFrames,
                  durationSec: status.durationSec,
                  fps: status.fps,
                  outputPath: status.outputPath,
                  downloadUrl: `/api/render-download/${status.id}`,
                  error: status.error,
                  createdAt: status.createdAt,
                  updatedAt: status.updatedAt,
                  completedAt: status.completedAt
                }, null, 2)
              }
            ]
          }
        };
      }

      // 4-3. preview_rocktypo_frames
      if (toolName === "preview_rocktypo_frames") {
        // 課金0円・apiKey 認証不要

        // バリデーション: 歌詞
        const lyricsRaw = args.lrc || args.lyrics;
        let lyricsText = "";
        if (typeof lyricsRaw === "string") {
          lyricsText = lyricsRaw.trim();
        } else if (Array.isArray(lyricsRaw)) {
          lyricsText = lyricsRaw.map(l => (typeof l === 'string' ? l : (l.text || ''))).filter(Boolean).join('\n');
        }

        if (!lyricsText && !args.projectState) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: lyrics is required and cannot be empty (or provide a valid projectState)."
                }
              ]
            }
          };
        }

        // バリデーション: autoSync / autoDetectSection / vocalSeparation
        if ((args.autoSync || args.autoDetectSection || args.vocalSeparation) && !args.audioPath) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: audioPath is required when autoSync, autoDetectSection, or vocalSeparation is enabled / autoSync, autoDetectSection または vocalSeparation を有効化する場合は audioPath の指定が必須です。"
                }
              ]
            }
          };
        }

        // バリデーション: bgImage
        if (args.bgImage) {
          if (!fs.existsSync(args.bgImage)) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Error: Background image not found at: ${args.bgImage}` }]
              }
            };
          }
        }

        // バリデーション: timestamps
        if (args.timestamps !== undefined && args.timestamps !== null) {
          if (!Array.isArray(args.timestamps)) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Error: timestamps must be an array of positive numbers." }]
              }
            };
          }
          for (const ts of args.timestamps) {
            if (typeof ts !== 'number' || isNaN(ts) || ts < 0) {
              return {
                jsonrpc: "2.0",
                id,
                result: {
                  isError: true,
                  content: [{ type: "text", text: "Error: timestamps must contain only non-negative numbers." }]
                }
              };
            }
          }
        }

        // バリデーション: count
        if (args.count !== undefined && args.count !== null) {
          const cnt = Number(args.count);
          if (isNaN(cnt) || !Number.isInteger(cnt) || cnt < 1 || cnt > 5) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: "Error: count must be an integer between 1 and 5." }]
              }
            };
          }
        }

        // レンダリング関数取得（storeManager経由またはexporterModule経由）
        const previewFn = (storeManager && storeManager.renderPreviewFrames) || (exporterModule ? exporterModule.renderPreviewFrames : null);
        if (!previewFn) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: RockTypo preview engine is not available in current environment."
                }
              ]
            }
          };
        }

        try {
          const previewResult = await previewFn({
            lyricsText,
            lrc: args.lrc || null,
            autoSync: !!args.autoSync || !!args.autoDetectSection || !!args.vocalSeparation,
            autoDetectSection: !!args.autoDetectSection,
            sectionPadding: typeof args.sectionPadding === 'number' ? args.sectionPadding : undefined,
            vocalSeparation: !!args.vocalSeparation,
            audioPath: args.audioPath || null,
            bpm: args.bpm || 120,
            preset: args.preset || "thunderbolt_burst",
            aspectRatio: args.aspectRatio || "9:16",
            timestamps: args.timestamps,
            count: args.count,
            fullResolution: !!args.fullResolution,
            bgImage: args.bgImage || null,
            projectState: args.projectState || null
          });

          const content = [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "Preview frames generated successfully.",
                width: previewResult.width,
                height: previewResult.height,
                count: previewResult.count,
                frames: (previewResult.frames || []).map(f => ({
                  index: f.index,
                  timeSec: f.timeSec,
                  filePath: f.filePath,
                  mimeType: f.mimeType
                }))
              }, null, 2)
            }
          ];

          for (const f of (previewResult.frames || [])) {
            content.push({
              type: "image",
              data: f.base64,
              mimeType: f.mimeType || "image/png"
            });
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: Failed to generate preview frames: ${err.message}`
                }
              ]
            }
          };
        }
      }

      // 4-4. list_jp_rule_categories (無料 0 JPY・APIキー不要)
      if (toolName === "list_jp_rule_categories") {
        const rulesDb = getRulesDb();
        if (!rulesDb) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: Japan Inbound Rules database is not available." }]
            }
          };
        }

        const categories = rulesDb.listCategories();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  cost_yen: 0,
                  total_categories: categories.length,
                  categories
                }, null, 2)
              }
            ]
          }
        };
      }

      // 4-5. query_jp_inbound_rules (無料 0 JPY・APIキー不要・渡されても課金なし)
      if (toolName === "query_jp_inbound_rules") {
        const rulesDb = getRulesDb();
        if (!rulesDb) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: Japan Inbound Rules database is not available." }]
            }
          };
        }

        const queryResult = rulesDb.queryRules({
          category: args.category,
          keyword: args.keyword,
          limit: args.limit
        });

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  cost_yen: 0,
                  total_rules: queryResult.total,
                  count: queryResult.count,
                  rules: queryResult.rules
                }, null, 2)
              }
            ]
          }
        };
      }

      // 4-6. check_jp_travel_compliance (有料 30 JPY / JP_RULES_FREE_BETA=true 時は完全無料0 JPY・APIキー不要)
      if (toolName === "check_jp_travel_compliance") {
        const isFreeBeta = isFreeBetaMode();
        const apiKey = args.apiKey || authHeaderKey;

        // ベータ期間外の通常時は API キー必須
        if (!isFreeBeta && !apiKey) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header."
                }
              ]
            }
          };
        }

        const checkType = args.checkType;
        if (!checkType) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: checkType is required. Valid options: 'tax_free', 'shinkansen_baggage', 'holiday_peak'"
                }
              ]
            }
          };
        }

        let complianceCostYen = 0;
        let chargeInfo = null;

        if (!isFreeBeta) {
          complianceCostYen = 30;
          try {
            chargeInfo = storeManager.chargeKey(apiKey, complianceCostYen, {
              action: "check_jp_travel_compliance",
              description: "Check Japan Travel Compliance (30 JPY)",
              params: {
                checkType,
                purchaseAmountJpy: args.purchaseAmountJpy,
                baggageTotalCm: args.baggageTotalCm,
                travelDate: args.travelDate
              }
            });
          } catch (err) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: err.code || "CHARGE_FAILED",
                      message: err.message,
                      statusCode: err.statusCode || 500,
                      monthly_limit_yen: err.monthly_limit_yen,
                      used_yen: err.used_yen,
                      price_yen: err.price_yen,
                      remaining_yen: err.remaining_yen
                    }, null, 2)
                  }
                ]
              }
            };
          }
        }

        const rulesDb = getRulesDb();
        if (!rulesDb) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: Japan Inbound Rules database is not available." }]
            }
          };
        }

        try {
          const complianceResult = rulesDb.checkCompliance({
            checkType,
            purchaseAmountJpy: args.purchaseAmountJpy,
            baggageTotalCm: args.baggageTotalCm,
            travelDate: args.travelDate
          });

          const resObj = {
            success: true,
            cost_yen: complianceCostYen,
            compliance: complianceResult
          };

          if (isFreeBeta) {
            resObj.free_beta = true;
          }

          if (chargeInfo) {
            resObj.monthly_limit_yen = chargeInfo.monthly_limit_yen;
            resObj.used_yen = chargeInfo.used_yen;
            resObj.remaining_yen = chargeInfo.remaining_yen;
            resObj.tx_id = chargeInfo.tx_id;
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(resObj, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Error: ${err.message}`
                }
              ]
            }
          };
        }
      }

      // 4-7. generate_beautiful_pdf (有料 20 JPY・APIキー必須・JP_RULES_ONLY時は除外)
      if (toolName === "generate_beautiful_pdf") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: generate_beautiful_pdf is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const apiKey = args.apiKey || authHeaderKey;
        if (!apiKey && !isFreeStoreMode()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header." }]
            }
          };
        }

        const markdown = args.markdown;
        if (!markdown || typeof markdown !== 'string' || !markdown.trim()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: markdown is required and cannot be empty." }]
            }
          };
        }

        const pdfCostYen = 20;
        let chargeInfo = null;
        try {
          chargeInfo = chargeOrFree(storeManager, apiKey, pdfCostYen, {
            action: "generate_beautiful_pdf",
            description: "Generate Beautiful PDF from Markdown (20 JPY)",
            params: {
              title: args.title || "Document",
              theme: args.theme || "business_report",
              pageSize: args.pageSize || "A4"
            }
          });
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "CHARGE_FAILED",
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    monthly_limit_yen: err.monthly_limit_yen,
                    used_yen: err.used_yen,
                    price_yen: err.price_yen,
                    remaining_yen: err.remaining_yen
                  }, null, 2)
                }
              ]
            }
          };
        }

        const pdfGen = getPdfGenerator();
        if (!pdfGen) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: PDF generator engine is not available in current environment." }]
            }
          };
        }

        try {
          const docTitle = args.title || "Document";
          const pdfResult = await pdfGen.generateBeautifulPdfBuffer({
            markdown,
            title: docTitle,
            theme: args.theme || "business_report",
            pageSize: args.pageSize || "A4",
            footerText: args.footerText || "Souon AI Micro Store"
          });

          // ダウンロード用バイナリのキャッシュ登録
          const txId = chargeInfo.tx_id;
          const safeTitle = docTitle.replace(/[^a-zA-Z0-9_\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\-]/g, '_');
          const filename = `${safeTitle || 'document'}_${txId}.pdf`;

          if (typeof storeManager.registerDownloadFile === 'function') {
            storeManager.registerDownloadFile(txId, {
              buffer: pdfResult.buffer,
              contentType: 'application/pdf',
              filename
            });
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    cost_yen: chargeInfo.free_beta ? 0 : pdfCostYen,
                    free_beta: chargeInfo.free_beta === true,
                    monthly_limit_yen: chargeInfo.monthly_limit_yen,
                    used_yen: chargeInfo.used_yen,
                    remaining_yen: chargeInfo.remaining_yen,
                    tx_id: txId,
                    download_url: `/api/download/${txId}`,
                    filename,
                    title: pdfResult.title,
                    theme: pdfResult.theme,
                    pageSize: pdfResult.pageSize,
                    page_count: pdfResult.pageCount,
                    size_bytes: pdfResult.sizeBytes,
                    message: "Beautiful PDF generated successfully."
                  }, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error generating PDF: ${err.message}` }]
            }
          };
        }
      }

      // 4-8. generate_ogp_image (有料 10 JPY・APIキー必須・JP_RULES_ONLY時は除外)
      if (toolName === "generate_ogp_image") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: generate_ogp_image is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const apiKey = args.apiKey || authHeaderKey;
        if (!apiKey && !isFreeStoreMode()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header." }]
            }
          };
        }

        const title = args.title;
        if (!title || typeof title !== 'string' || !title.trim()) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: title is required and cannot be empty." }]
            }
          };
        }

        const ogpCostYen = 10;
        let chargeInfo = null;
        try {
          chargeInfo = chargeOrFree(storeManager, apiKey, ogpCostYen, {
            action: "generate_ogp_image",
            description: "Generate OGP & Thumbnail Image (10 JPY)",
            params: {
              title,
              theme: args.theme || "cyber_neon",
              size: args.size || "ogp"
            }
          });
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "CHARGE_FAILED",
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    monthly_limit_yen: err.monthly_limit_yen,
                    used_yen: err.used_yen,
                    price_yen: err.price_yen,
                    remaining_yen: err.remaining_yen
                  }, null, 2)
                }
              ]
            }
          };
        }

        const ogpGen = getOgpGenerator();
        if (!ogpGen) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: OGP generator engine is not available in current environment." }]
            }
          };
        }

        try {
          const ogpResult = await ogpGen.generateOgpImageBuffer({
            title,
            subtitle: args.subtitle || "",
            badge: args.badge || "AI COMMERCE",
            author: args.author || "創音知能 • Souon Chinou",
            theme: args.theme || "cyber_neon",
            size: args.size || "ogp"
          });

          // ダウンロード用バイナリのキャッシュ登録
          const txId = chargeInfo.tx_id;
          const safeTitle = title.replace(/[^a-zA-Z0-9_\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\-]/g, '_');
          const filename = `ogp_${safeTitle || 'image'}_${txId}.png`;

          if (typeof storeManager.registerDownloadFile === 'function') {
            storeManager.registerDownloadFile(txId, {
              buffer: ogpResult.buffer,
              contentType: 'image/png',
              filename
            });
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    cost_yen: chargeInfo.free_beta ? 0 : ogpCostYen,
                    free_beta: chargeInfo.free_beta === true,
                    monthly_limit_yen: chargeInfo.monthly_limit_yen,
                    used_yen: chargeInfo.used_yen,
                    remaining_yen: chargeInfo.remaining_yen,
                    tx_id: txId,
                    download_url: `/api/download/${txId}`,
                    filename,
                    width: ogpResult.width,
                    height: ogpResult.height,
                    size_bytes: ogpResult.size_bytes,
                    theme: ogpResult.theme,
                    size: ogpResult.size,
                    message: "OGP / Thumbnail image generated successfully."
                  }, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error generating OGP image: ${err.message}` }]
            }
          };
        }
      }

      // 4-9. create_temp_inbox (有料 10 JPY・APIキー必須・JP_RULES_ONLY時は除外)
      if (toolName === "create_temp_inbox") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: create_temp_inbox is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const apiKey = args.apiKey || authHeaderKey;
        if (!apiKey) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header." }]
            }
          };
        }

        const inboxCostYen = 10;
        let chargeInfo = null;
        try {
          chargeInfo = storeManager.chargeKey(apiKey, inboxCostYen, {
            action: "create_temp_inbox",
            description: "Create Disposable Email Inbox (10 JPY)",
            params: {}
          });
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "CHARGE_FAILED",
                    message: err.message,
                    statusCode: err.statusCode || 500,
                    monthly_limit_yen: err.monthly_limit_yen,
                    used_yen: err.used_yen,
                    price_yen: err.price_yen,
                    remaining_yen: err.remaining_yen
                  }, null, 2)
                }
              ]
            }
          };
        }

        const tempMailMgr = typeof storeManager.getTempMailManager === 'function' ? storeManager.getTempMailManager() : null;
        if (!tempMailMgr) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: Temp mail manager is not available in current environment." }]
            }
          };
        }

        try {
          const inboxResult = tempMailMgr.createInbox(apiKey);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    cost_yen: inboxCostYen,
                    monthly_limit_yen: chargeInfo.monthly_limit_yen,
                    used_yen: chargeInfo.used_yen,
                    remaining_yen: chargeInfo.remaining_yen,
                    tx_id: chargeInfo.tx_id,
                    inbox_id: inboxResult.inbox_id,
                    email: inboxResult.email,
                    expires_at: inboxResult.expires_at,
                    ttl_minutes: inboxResult.ttl_minutes,
                    message: "Temporary inbox created successfully. Check incoming messages with read_temp_inbox."
                  }, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Error creating inbox: ${err.message}` }]
            }
          };
        }
      }

      // 4-10. read_temp_inbox (無料 0 JPY・APIキー必須・所有者検証・JP_RULES_ONLY時は除外)
      if (toolName === "read_temp_inbox") {
        if (process.env.JP_RULES_ONLY === 'true') {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: read_temp_inbox is unavailable in JP_RULES_ONLY mode." }]
            }
          };
        }

        const apiKey = args.apiKey || authHeaderKey;
        if (!apiKey) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: API key is required. Provide it in arguments.apiKey or HTTP Authorization Bearer header." }]
            }
          };
        }

        const inboxId = args.inbox_id;
        if (!inboxId) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: inbox_id is required." }]
            }
          };
        }

        const tempMailMgr = typeof storeManager.getTempMailManager === 'function' ? storeManager.getTempMailManager() : null;
        if (!tempMailMgr) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Error: Temp mail manager is not available in current environment." }]
            }
          };
        }

        try {
          const readResult = tempMailMgr.readInbox(inboxId, apiKey);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: true,
                    cost_yen: 0,
                    ...readResult
                  }, null, 2)
                }
              ]
            }
          };
        } catch (err) {
          const statusCode = err.statusCode || 500;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code || "READ_INBOX_FAILED",
                    statusCode,
                    message: err.message
                  }, null, 2)
                }
              ]
            }
          };
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool not found: ${toolName}` }
      };
    }

    // 未知のメソッド
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  };
}

module.exports = {
  createMcpHandler,
  getAvailableTools,
  isRockTypoAvailable
};
