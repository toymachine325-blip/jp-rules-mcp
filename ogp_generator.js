/**
 * ogp_generator.js
 * 創音知能 AI Micro Store - OGP・サムネイル画像自動生成モジュール
 * @resvg/resvg-js による Rust ベース超高速 SVG -> PNG ベクター画像レンダリングエンジン
 */

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

// サイズプリセット定義
const SIZES = {
  ogp: { id: "ogp", width: 1200, height: 630, label: "OGP / Twitter Card (1200x630)" },
  youtube: { id: "youtube", width: 1280, height: 720, label: "YouTube Thumbnail (1280x720 / 16:9)" },
  square: { id: "square", width: 1080, height: 1080, label: "Instagram / Square (1080x1080 / 1:1)" }
};

// テーマ設定定義
const THEMES = {
  cyber_neon: {
    id: "cyber_neon",
    name: "Cyber Neon",
    bgGradientStart: "#050814",
    bgGradientEnd: "#0A1128",
    cardBg: "rgba(11, 19, 43, 0.7)",
    cardBorder: "rgba(56, 189, 248, 0.3)",
    badgeBg: "rgba(56, 189, 248, 0.15)",
    badgeBorder: "#38BDF8",
    badgeText: "#38BDF8",
    titleColor: "#FFFFFF",
    titleAccent: "#38BDF8",
    subtitleColor: "#94A3B8",
    footerColor: "#64748B",
    accentColor: "#38BDF8",
    glowColor: "rgba(56, 189, 248, 0.15)"
  },
  clean_minimal: {
    id: "clean_minimal",
    name: "Clean Minimal",
    bgGradientStart: "#F8FAFC",
    bgGradientEnd: "#EEF2F6",
    cardBg: "#FFFFFF",
    cardBorder: "#E2E8F0",
    badgeBg: "rgba(13, 148, 136, 0.12)",
    badgeBorder: "#0D9488",
    badgeText: "#0D9488",
    titleColor: "#0F172A",
    titleAccent: "#0D9488",
    subtitleColor: "#475569",
    footerColor: "#94A3B8",
    accentColor: "#0D9488",
    glowColor: "rgba(13, 148, 136, 0.08)"
  },
  bold_editorial: {
    id: "bold_editorial",
    name: "Bold Editorial",
    bgGradientStart: "#0A0A0A",
    bgGradientEnd: "#141414",
    cardBg: "rgba(20, 20, 20, 0.9)",
    cardBorder: "#27272A",
    badgeBg: "#F59E0B",
    badgeBorder: "#F59E0B",
    badgeText: "#000000",
    titleColor: "#FFFFFF",
    titleAccent: "#F59E0B",
    subtitleColor: "#D4D4D8",
    footerColor: "#71717A",
    accentColor: "#F59E0B",
    glowColor: "rgba(245, 158, 11, 0.12)"
  }
};

/**
 * 日本語対応フォントパスの自動解決
 */
function resolveFontPath() {
  const candidates = [
    path.join(__dirname, 'fonts', 'NotoSansJP[wght].ttf'),
    path.join(__dirname, '..', 'fonts', 'NotoSansJP[wght].ttf'),
    path.resolve(__dirname, '../../fonts/NotoSansJP[wght].ttf'),
    path.join(__dirname, 'fonts', 'RocknRollOne-Regular.ttf'),
    path.join(__dirname, '..', 'fonts', 'RocknRollOne-Regular.ttf'),
    'C:\\Windows\\Fonts\\msgothic.ttc',
    'C:\\Windows\\Fonts\\meiryo.ttc'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * XML 特殊文字のエスケープ
 */
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 日本語・英語・絵文字混在タイトルの行分割（自動折り返し・サロゲートペア対応）
 */
function wrapTitleText(text, maxCharsPerLine = 22, maxLines = 3) {
  if (!text) return [];
  const lines = [];
  let current = '';
  let currentWeight = 0;
  const maxWeight = maxCharsPerLine * 2;
  const chars = Array.from(text);

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const codePoint = char.codePointAt(0);
    const weight = codePoint > 255 ? 2 : 1;

    if (currentWeight + weight > maxWeight && lines.length < maxLines - 1) {
      lines.push(current);
      current = char;
      currentWeight = weight;
    } else {
      current += char;
      currentWeight += weight;
    }
  }
  if (current) {
    if (lines.length >= maxLines - 1 && currentWeight > maxWeight) {
      const currentChars = Array.from(current);
      current = currentChars.slice(0, Math.max(1, maxCharsPerLine - 2)).join('') + '...';
    }
    lines.push(current);
  }
  return lines;
}

/**
 * OGP / サムネイル画像（PNG）バッファ生成関数
 * @param {Object} options
 * @param {string} options.title - メインタイトル
 * @param {string} [options.subtitle] - サブタイトル/説明文
 * @param {string} [options.badge] - カテゴリ/ブランドバッジ（例: 'AI COMMERCE', 'NEW'）
 * @param {string} [options.author] - 作成者/ブランド名（例: '創音知能 / Souon Chinou'）
 * @param {string} [options.theme] - cyber_neon | clean_minimal | bold_editorial
 * @param {string} [options.size] - ogp | youtube | square
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, size_bytes: number, theme: string, size: string, title: string }>}
 */
async function generateOgpImageBuffer({
  title = "Souon AI Micro Store",
  subtitle = "Autonomous Material & API Micro-Commerce for AI Agents",
  badge = "AI COMMERCE",
  author = "創音知能 • Souon Chinou",
  theme = "cyber_neon",
  size = "ogp"
} = {}) {
  const activeTheme = THEMES[theme] || THEMES.cyber_neon;
  const activeSize = SIZES[size] || SIZES.ogp;
  const { width, height } = activeSize;

  const fontPath = resolveFontPath();
  const isSquare = (size === 'square');
  const maxChars = isSquare ? 16 : 22;
  const titleLines = wrapTitleText(title, maxChars, isSquare ? 4 : 3);

  const safeBadge = escapeXml(badge);
  const safeSubtitle = escapeXml(subtitle);
  const safeAuthor = escapeXml(author);

  // SVG 内座標計算
  const paddingX = Math.round(width * 0.07);
  const paddingY = Math.round(height * 0.1);

  // タイトル文字サイズ
  let titleFontSize = isSquare ? 56 : (titleLines.length >= 3 ? 48 : 56);
  let titleLineHeight = Math.round(titleFontSize * 1.3);

  let badgeY = paddingY + 36;
  let titleStartY = badgeY + 60;
  let subtitleY = titleStartY + (titleLines.length * titleLineHeight) + 16;
  let footerY = height - paddingY;

  // テーマ別特有の装飾エレメント
  let decorativeElements = '';
  if (activeTheme.id === 'cyber_neon') {
    decorativeElements = `
      <!-- Cyber Glow Circle -->
      <circle cx="${width - paddingX}" cy="${paddingY + 40}" r="260" fill="${activeTheme.accentColor}" opacity="0.12" filter="blur(80px)" />
      <circle cx="${paddingX}" cy="${height - paddingY}" r="220" fill="#818CF8" opacity="0.08" filter="blur(70px)" />
      <!-- Grid pattern -->
      <defs>
        <pattern id="cyberGrid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(56, 189, 248, 0.04)" stroke-width="1"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#cyberGrid)" />
      <!-- Outer Tech Border -->
      <rect x="20" y="20" width="${width - 40}" height="${height - 40}" fill="none" stroke="rgba(56, 189, 248, 0.2)" stroke-width="1.5" rx="12" />
      <path d="M 20 50 L 50 20 M ${width - 20} ${height - 50} L ${width - 50} ${height - 20}" stroke="${activeTheme.accentColor}" stroke-width="2" />
    `;
  } else if (activeTheme.id === 'clean_minimal') {
    decorativeElements = `
      <!-- Clean Minimal Card Container -->
      <rect x="${paddingX * 0.6}" y="${paddingY * 0.6}" width="${width - paddingX * 1.2}" height="${height - paddingY * 1.2}" fill="${activeTheme.cardBg}" stroke="${activeTheme.cardBorder}" stroke-width="1.5" rx="16" />
      <!-- Top Accent Bar -->
      <rect x="${paddingX * 0.6}" y="${paddingY * 0.6}" width="${width - paddingX * 1.2}" height="6" fill="${activeTheme.accentColor}" rx="3" />
      <!-- Subtle Glow Accent -->
      <circle cx="${width - paddingX}" cy="${height - paddingY}" r="180" fill="${activeTheme.accentColor}" opacity="0.05" filter="blur(60px)" />
    `;
  } else if (activeTheme.id === 'bold_editorial') {
    decorativeElements = `
      <!-- Bold Editorial Left Strip -->
      <rect x="0" y="0" width="18" height="${height}" fill="${activeTheme.accentColor}" />
      <rect x="28" y="0" width="3" height="${height}" fill="rgba(245, 158, 11, 0.4)" />
      <!-- Angular cut accent -->
      <polygon points="${width},0 ${width},100 ${width - 100},0" fill="${activeTheme.accentColor}" opacity="0.8" />
    `;
  }

  // タイトル tspan タグ構築
  const titleTspans = titleLines.map((line, idx) => {
    const safeLine = escapeXml(line);
    const dy = idx === 0 ? 0 : titleLineHeight;
    return `<tspan x="${paddingX}" dy="${dy}">${safeLine}</tspan>`;
  }).join('\n      ');

  // SVG 構築
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mainBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${activeTheme.bgGradientStart}" />
      <stop offset="100%" stop-color="${activeTheme.bgGradientEnd}" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="url(#mainBgGrad)" />

  <!-- Decorative Atmosphere Elements -->
  ${decorativeElements}

  <!-- Badge Tag -->
  <g transform="translate(${paddingX}, ${badgeY})">
    <rect x="0" y="-22" width="${safeBadge.length * 11 + 28}" height="32" rx="16" fill="${activeTheme.badgeBg}" stroke="${activeTheme.badgeBorder}" stroke-width="1.2" />
    <text x="${(safeBadge.length * 11 + 28) / 2}" y="-1" text-anchor="middle" fill="${activeTheme.badgeText}" font-family="Noto Sans JP, sans-serif" font-size="12" font-weight="bold" letter-spacing="1.5">
      ${safeBadge}
    </text>
  </g>

  <!-- Main Title -->
  <text x="${paddingX}" y="${titleStartY}" fill="${activeTheme.titleColor}" font-family="Noto Sans JP, sans-serif" font-size="${titleFontSize}" font-weight="900" letter-spacing="-0.5">
    ${titleTspans}
  </text>

  <!-- Subtitle -->
  ${safeSubtitle ? `
  <text x="${paddingX}" y="${subtitleY}" fill="${activeTheme.subtitleColor}" font-family="Noto Sans JP, sans-serif" font-size="22" font-weight="normal">
    ${safeSubtitle}
  </text>` : ''}

  <!-- Footer Info -->
  <g transform="translate(${paddingX}, ${footerY})">
    <line x1="0" y1="-24" x2="${width - paddingX * 2}" y2="-24" stroke="${activeTheme.cardBorder}" stroke-width="1" />
    <!-- Author / Brand -->
    <text x="0" y="0" fill="${activeTheme.footerColor}" font-family="Noto Sans JP, sans-serif" font-size="15" font-weight="bold">
      ${safeAuthor}
    </text>
    <!-- Logo / Brand Right -->
    <text x="${width - paddingX * 2}" y="0" text-anchor="end" fill="${activeTheme.accentColor}" font-family="Noto Sans JP, sans-serif" font-size="14" font-weight="bold" letter-spacing="1">
      AI MICRO STORE
    </text>
  </g>
</svg>
`;

  // Resvg による SVG -> PNG レンダリング
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: width
    },
    font: {
      fontFiles: fontPath ? [fontPath] : [],
      loadSystemFonts: true,
      defaultFontFamily: 'Noto Sans JP'
    }
  });

  const pngData = resvg.render();
  const buffer = pngData.asPng();

  return {
    buffer,
    width,
    height,
    size_bytes: buffer.length,
    theme: activeTheme.id,
    size: activeSize.id || size,
    title
  };
}

module.exports = {
  generateOgpImageBuffer,
  THEMES,
  SIZES
};
