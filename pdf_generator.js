/**
 * pdf_generator.js
 * 創音知能 AI Micro Store - 美麗 PDF 生成モジュール
 * Markdown テキストから日本語・英語対応のプロフェッショナル PDF バイナリ（Buffer）を生成
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// テーマ設定定義
const THEMES = {
  business_report: {
    id: "business_report",
    name: "Business Report",
    pageBg: "#FFFFFF",
    textMain: "#1E293B",      // slate-800
    textMuted: "#64748B",     // slate-500
    h1Color: "#0F172A",       // deep navy
    h2Color: "#1E3A8A",       // blue-900
    h3Color: "#2563EB",       // blue-600
    accent: "#2563EB",        // blue-600
    borderColor: "#E2E8F0",   // slate-200
    tableHeaderBg: "#F1F5F9", // slate-100
    tableHeaderText: "#0F172A",
    tableRowEvenBg: "#F8FAFC",
    codeBg: "#F1F5F9",
    codeBorder: "#CBD5E1",
    quoteBarColor: "#2563EB",
    quoteBg: "#F8FAFC",
    headerFooterColor: "#94A3B8"
  },
  modern_clean: {
    id: "modern_clean",
    name: "Modern Clean",
    pageBg: "#FCFCFD",
    textMain: "#334155",      // slate-700
    textMuted: "#64748B",
    h1Color: "#0F172A",
    h2Color: "#0D9488",       // teal-600
    h3Color: "#059669",       // emerald-600
    accent: "#0D9488",
    borderColor: "#E2E8F0",
    tableHeaderBg: "#F0FDFA", // teal-50
    tableHeaderText: "#134E4A",
    tableRowEvenBg: "#F8FAFC",
    codeBg: "#F8FAFC",
    codeBorder: "#E2E8F0",
    quoteBarColor: "#0D9488",
    quoteBg: "#F0FDFA",
    headerFooterColor: "#94A3B8"
  },
  dark_tech: {
    id: "dark_tech",
    name: "Dark Tech",
    pageBg: "#0B0F19",        // deep dark
    textMain: "#E2E8F0",      // slate-200
    textMuted: "#94A3B8",     // slate-400
    h1Color: "#38BDF8",       // sky-400 (neon cyan)
    h2Color: "#06B6D4",       // cyan-500
    h3Color: "#818CF8",       // indigo-400
    accent: "#38BDF8",
    borderColor: "#1E293B",   // slate-800
    tableHeaderBg: "#1E293B", // slate-800
    tableHeaderText: "#38BDF8",
    tableRowEvenBg: "#0F172A",
    codeBg: "#111827",        // gray-900
    codeBorder: "#374151",    // gray-700
    quoteBarColor: "#38BDF8",
    quoteBg: "#0F172A",
    headerFooterColor: "#64748B"
  }
};

/**
 * 日本語対応フォントパスの自動解決
 */
function resolveJapaneseFontPath() {
  const candidates = [
    path.join(__dirname, 'fonts', 'NotoSansJP[wght].ttf'),
    path.join(__dirname, '..', 'fonts', 'NotoSansJP[wght].ttf'),
    path.resolve(__dirname, '../../fonts/NotoSansJP[wght].ttf'),
    path.join(__dirname, 'fonts', 'ShipporiMincho-ExtraBold.ttf'),
    path.join(__dirname, '..', 'fonts', 'ShipporiMincho-ExtraBold.ttf'),
    path.join(__dirname, 'fonts', 'RocknRollOne-Regular.ttf'),
    path.join(__dirname, '..', 'fonts', 'RocknRollOne-Regular.ttf'),
    'C:\\Windows\\Fonts\\msgothic.ttc',
    'C:\\Windows\\Fonts\\meiryo.ttc'
  ];

  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }
  return null;
}

/**
 * インライン装飾記号のクリーンアップ（**bold**, `code`, etc）
 */
function stripMarkdownInline(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/**
 * 美麗 PDF バッファ生成関数
 * @param {Object} options
 * @param {string} options.markdown - 入力Markdownテキスト
 * @param {string} [options.title] - ドキュメントタイトル
 * @param {string} [options.theme] - business_report | modern_clean | dark_tech
 * @param {string} [options.pageSize] - A4 | Letter
 * @param {string} [options.footerText] - フッター左側表記
 * @returns {Promise<{ buffer: Buffer, pageCount: number, sizeBytes: number, title: string, theme: string, pageSize: string }>}
 */
function generateBeautifulPdfBuffer({
  markdown = "",
  title = "Document",
  theme = "business_report",
  pageSize = "A4",
  footerText = "Souon AI Micro Store"
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const activeTheme = THEMES[theme] || THEMES.business_report;
      const validPageSize = (pageSize === 'Letter') ? 'Letter' : 'A4';
      const margin = 46;

      const doc = new PDFDocument({
        size: validPageSize,
        margin,
        bufferPages: true,
        autoFirstPage: true
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => {
        const fullBuffer = Buffer.concat(buffers);
        const range = doc.bufferedPageRange();
        resolve({
          buffer: fullBuffer,
          pageCount: range.count || 1,
          sizeBytes: fullBuffer.length,
          title,
          theme: activeTheme.id,
          pageSize: validPageSize
        });
      });
      doc.on('error', err => reject(err));

      // ページ背景色適用ハンドラ（複数ページ対応）
      const applyPageBackground = () => {
        if (activeTheme.pageBg && activeTheme.pageBg.toUpperCase() !== '#FFFFFF') {
          doc.save();
          doc.rect(0, 0, doc.page.width, doc.page.height).fill(activeTheme.pageBg);
          doc.restore();
        }
      };

      doc.on('pageAdded', applyPageBackground);
      // 1ページ目の背景適用
      applyPageBackground();

      // 日本語フォント設定
      const fontPath = resolveJapaneseFontPath();
      if (fontPath) {
        try {
          doc.font(fontPath);
        } catch (e) {
          console.warn('[PDF] Failed to load font, falling back to Helvetica:', e.message);
          try { doc.font('Helvetica'); } catch (err) {}
        }
      } else {
        try { doc.font('Helvetica'); } catch (err) {}
      }

      const contentWidth = doc.page.width - margin * 2;
      const bottomLimit = doc.page.height - margin - 35;

      // ページ溢れチェック＆改ページ
      const ensureSpace = (neededHeight = 24) => {
        if (doc.y + neededHeight > bottomLimit) {
          doc.addPage();
        }
      };

      // ドキュメントタイトル（指定時かつ見出しで始まらない場合、またはヘッダータイトルとして）
      let lines = markdown.split(/\r?\n/);

      let inCodeBlock = false;
      let codeLines = [];
      let inTable = false;
      let tableRows = [];

      const flushCodeBlock = () => {
        if (codeLines.length === 0) return;
        const fontSize = 9;
        const lineHeight = fontSize * 1.35;
        const padding = 8;

        let remainingLines = [...codeLines];
        while (remainingLines.length > 0) {
          const availableHeight = bottomLimit - doc.y;
          // 最低3行分が入らない場合は新規ページへ
          if (availableHeight < lineHeight * 3 + padding * 2) {
            doc.addPage();
          }

          const currentAvailable = bottomLimit - doc.y;
          const maxLinesInThisPage = Math.max(1, Math.floor((currentAvailable - padding * 2) / lineHeight));
          const linesToRender = remainingLines.slice(0, maxLinesInThisPage);
          remainingLines = remainingLines.slice(maxLinesInThisPage);

          const blockHeight = linesToRender.length * lineHeight + padding * 2;
          const startX = margin;
          const startY = doc.y;

          // コード背景ボックス描画
          doc.save();
          doc.rect(startX, startY, contentWidth, blockHeight)
            .fillAndStroke(activeTheme.codeBg, activeTheme.codeBorder);
          doc.restore();

          // コード本文描画
          doc.fillColor(activeTheme.textMain)
            .fontSize(fontSize)
            .text(linesToRender.join('\n'), startX + padding, startY + padding, {
              width: contentWidth - padding * 2,
              lineGap: 2
            });

          doc.y = startY + blockHeight + 10;
        }
        codeLines = [];
      };

      const flushTable = () => {
        if (tableRows.length === 0) return;
        const rowHeight = 22;
        const padding = 5;
        const colCount = Math.max(...tableRows.map(r => r.length));
        if (colCount === 0) { tableRows = []; return; }

        const colWidth = contentWidth / colCount;
        const totalHeight = tableRows.length * rowHeight;

        ensureSpace(Math.min(totalHeight, 150));

        tableRows.forEach((row, rowIndex) => {
          ensureSpace(rowHeight);
          const currentY = doc.y;
          const isHeader = (rowIndex === 0);

          // 行背景描画
          doc.save();
          if (isHeader) {
            doc.rect(margin, currentY, contentWidth, rowHeight).fill(activeTheme.tableHeaderBg);
          } else if (rowIndex % 2 === 0) {
            doc.rect(margin, currentY, contentWidth, rowHeight).fill(activeTheme.tableRowEvenBg);
          }

          // 行境界線
          doc.strokeColor(activeTheme.borderColor).lineWidth(0.5)
            .rect(margin, currentY, contentWidth, rowHeight).stroke();
          doc.restore();

          // 各列セルテキスト描画
          row.forEach((cellText, colIndex) => {
            const cellX = margin + colIndex * colWidth + padding;
            const cleanText = stripMarkdownInline(cellText);
            doc.fillColor(isHeader ? activeTheme.tableHeaderText : activeTheme.textMain)
              .fontSize(isHeader ? 10 : 9)
              .text(cleanText, cellX, currentY + padding, {
                width: colWidth - padding * 2,
                ellipsis: true,
                lineBreak: false
              });
          });

          doc.y = currentY + rowHeight;
        });

        doc.y += 10;
        tableRows = [];
      };

      // 行単位のパース＆レンダリング
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // コードブロックの開始/終了
        if (trimmed.startsWith('```')) {
          if (inCodeBlock) {
            inCodeBlock = false;
            flushCodeBlock();
          } else {
            if (inTable) { inTable = false; flushTable(); }
            inCodeBlock = true;
            codeLines = [];
          }
          continue;
        }

        if (inCodeBlock) {
          codeLines.push(line);
          continue;
        }

        // テーブル行の判定 (| col1 | col2 |)
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
          // テーブル区切り行 (|:---|---:| 等) はスキップ
          if (/^\|[\s\-:]+(\|[\s\-:]+)+\|$/.test(trimmed)) {
            continue;
          }
          inTable = true;
          const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
          tableRows.push(cells);
          continue;
        } else if (inTable) {
          inTable = false;
          flushTable();
        }

        // 空行
        if (!trimmed) {
          doc.y += 8;
          continue;
        }

        // 見出し H1 (# )
        if (trimmed.startsWith('# ')) {
          ensureSpace(40);
          const text = stripMarkdownInline(trimmed.substring(2));
          doc.y += 8;
          doc.fillColor(activeTheme.h1Color).fontSize(20).text(text, { width: contentWidth });
          // H1 下線
          doc.strokeColor(activeTheme.accent).lineWidth(1.5)
            .moveTo(margin, doc.y + 3)
            .lineTo(margin + contentWidth, doc.y + 3)
            .stroke();
          doc.y += 12;
          continue;
        }

        // 見出し H2 (## )
        if (trimmed.startsWith('## ')) {
          ensureSpace(32);
          const text = stripMarkdownInline(trimmed.substring(3));
          doc.y += 8;
          doc.fillColor(activeTheme.h2Color).fontSize(15).text(text, { width: contentWidth });
          doc.strokeColor(activeTheme.borderColor).lineWidth(0.8)
            .moveTo(margin, doc.y + 2)
            .lineTo(margin + contentWidth * 0.4, doc.y + 2)
            .stroke();
          doc.y += 8;
          continue;
        }

        // 見出し H3 (### )
        if (trimmed.startsWith('### ')) {
          ensureSpace(26);
          const text = stripMarkdownInline(trimmed.substring(4));
          doc.y += 6;
          doc.fillColor(activeTheme.h3Color).fontSize(12).text(text, { width: contentWidth });
          doc.y += 6;
          continue;
        }

        // 水平線 (--- or ***)
        if (/^(\-{3,}|\*{3,})$/.test(trimmed)) {
          ensureSpace(14);
          doc.y += 6;
          doc.strokeColor(activeTheme.borderColor).lineWidth(1)
            .moveTo(margin, doc.y)
            .lineTo(margin + contentWidth, doc.y)
            .stroke();
          doc.y += 10;
          continue;
        }

        // 引用 (> )
        if (trimmed.startsWith('>')) {
          ensureSpace(24);
          const quoteText = stripMarkdownInline(trimmed.replace(/^>\s*/, ''));
          const startX = margin;
          const startY = doc.y;

          doc.save();
          // 左側アクセント縦線
          doc.rect(startX, startY, 3, 20).fill(activeTheme.quoteBarColor);
          doc.restore();

          doc.fillColor(activeTheme.textMuted)
            .fontSize(10)
            .text(quoteText, startX + 12, startY + 2, { width: contentWidth - 16 });

          doc.y += 8;
          continue;
        }

        // 箇条書きリスト (- or *)
        const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
        if (bulletMatch) {
          ensureSpace(18);
          const bulletText = stripMarkdownInline(bulletMatch[1]);
          const startY = doc.y;

          // ブレット記号
          doc.fillColor(activeTheme.accent).fontSize(10).text('•', margin + 4, startY);
          // リスト本文
          doc.fillColor(activeTheme.textMain).fontSize(10).text(bulletText, margin + 16, startY, {
            width: contentWidth - 16,
            lineGap: 3
          });
          doc.y += 4;
          continue;
        }

        // 番号付きリスト (1. )
        const numMatch = trimmed.match(/^([0-9]+)\.\s+(.*)$/);
        if (numMatch) {
          ensureSpace(18);
          const numStr = numMatch[1] + '.';
          const numText = stripMarkdownInline(numMatch[2]);
          const startY = doc.y;

          doc.fillColor(activeTheme.accent).fontSize(10).text(numStr, margin + 2, startY);
          doc.fillColor(activeTheme.textMain).fontSize(10).text(numText, margin + 18, startY, {
            width: contentWidth - 18,
            lineGap: 3
          });
          doc.y += 4;
          continue;
        }

        // 通常段落
        ensureSpace(18);
        const cleanParagraph = stripMarkdownInline(trimmed);
        doc.fillColor(activeTheme.textMain).fontSize(10.5).text(cleanParagraph, margin, doc.y, {
          width: contentWidth,
          lineGap: 4
        });
        doc.y += 6;
      }

      // 未完ブロックのフラッシュ
      if (inCodeBlock) flushCodeBlock();
      if (inTable) flushTable();

      // 全ページ巡回によるヘッダー・フッター描画
      const pageRange = doc.bufferedPageRange();
      const totalPages = pageRange.count || 1;

      for (let p = pageRange.start; p < pageRange.start + totalPages; p++) {
        doc.switchToPage(p);

        // ヘッダー（2ページ目以降、または全ページ）
        if (totalPages > 1) {
          doc.fillColor(activeTheme.headerFooterColor)
            .fontSize(8)
            .text(title, margin, 20, {
              width: contentWidth,
              align: 'right'
            });
          doc.strokeColor(activeTheme.borderColor).lineWidth(0.5)
            .moveTo(margin, 30)
            .lineTo(margin + contentWidth, 30)
            .stroke();
        }

        // フッター
        const footerY = doc.page.height - 28;
        doc.strokeColor(activeTheme.borderColor).lineWidth(0.5)
          .moveTo(margin, footerY - 6)
          .lineTo(margin + contentWidth, footerY - 6)
          .stroke();

        // 左: フッターテキスト
        doc.fillColor(activeTheme.headerFooterColor)
          .fontSize(8)
          .text(footerText, margin, footerY, {
            width: contentWidth * 0.6,
            align: 'left'
          });

        // 右: ページ番号 Page X of Y
        doc.fillColor(activeTheme.headerFooterColor)
          .fontSize(8)
          .text(`Page ${p + 1} of ${totalPages}`, margin + contentWidth * 0.6, footerY, {
            width: contentWidth * 0.4,
            align: 'right'
          });
      }

      // ドキュメント終了
      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateBeautifulPdfBuffer,
  THEMES
};
