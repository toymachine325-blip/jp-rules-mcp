/**
 * products/rocktypo_motion.js
 * ロックタイポスタジオ互換 キレキレ文字アニメーション設定JSONジェネレータ
 * ゼロ外部依存・純粋Node.js実装
 */

/**
 * 歌詞フレーズからロックタイポモーション設定JSONを自動生成
 * @param {Object} options
 * @param {string[]|string} options.lyrics - 歌詞フレーズ配列または複数行テキスト
 * @param {number} [options.bpm=150] - テンポ (BPM)
 * @param {string} [options.aspect_ratio="9:16"] - 縦型/横型 (9:16 or 16:9)
 * @param {string} [options.preset="hardrock_kinetic"] - モーションプリセット
 * @returns {Object} ロックタイポスタジオ互換モーション設定オブジェクト
 */
function generateRockTypoMotion(options = {}) {
  const bpm = Number(options.bpm) > 0 ? Number(options.bpm) : 150;
  const fps = 60;
  const aspectRatio = options.aspect_ratio || "9:16";
  const preset = options.preset || "hardrock_kinetic";

  // 歌詞パース
  let phrases = [];
  if (Array.isArray(options.lyrics)) {
    phrases = options.lyrics.map(s => String(s).trim()).filter(Boolean);
  } else if (typeof options.lyrics === 'string') {
    phrases = options.lyrics.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  // デフォルトフレーズ（未指定時）
  if (phrases.length === 0) {
    phrases = [
      "創音知能",
      "研ぎ澄ませ",
      "オフビートを撃て",
      "臨界点を突破せよ"
    ];
  }

  // 1拍の秒数 (BPMベース)
  const secondsPerBeat = 60 / bpm;
  // フレーズごとの割り当て拍数（文字数に応じたダイナミックビート配分）
  const motionStyles = [
    { type: "slam_zoom", scale_from: 3.2, scale_to: 1.0, shake_intensity: 18, rgb_split: 12, blur_in: 8 },
    { type: "horizontal_whip", offset_x: -400, shake_intensity: 14, rgb_split: 8, angle: -6 },
    { type: "punch_glitch", scale_from: 0.4, scale_to: 1.05, glitch_slices: 6, rgb_split: 16, flash: true },
    { type: "vertical_drop", offset_y: -300, bounce: 0.15, shake_intensity: 22, rgb_split: 10 }
  ];

  let currentSec = 0.0;
  const scenes = phrases.map((text, idx) => {
    // 文字数に応じて 2拍 または 4拍 などを動的計算
    const beatSpan = text.length <= 4 ? 2 : (text.length <= 8 ? 3 : 4);
    const duration = beatSpan * secondsPerBeat;
    const style = motionStyles[idx % motionStyles.length];

    const startSec = Math.round(currentSec * 1000) / 1000;
    const endSec = Math.round((currentSec + duration) * 1000) / 1000;
    currentSec += duration;

    // キーフレーム
    const keyframes = [
      {
        progress: 0.0,
        time_sec: startSec,
        scale: style.scale_from || 1.0,
        translate_x: style.offset_x || 0,
        translate_y: style.offset_y || 0,
        rotate_deg: style.angle || 0,
        opacity: 0,
        rgb_split_px: style.rgb_split,
        flash_intensity: style.flash ? 1.0 : 0.0,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)" // Expo Out
      },
      {
        progress: 0.15,
        time_sec: Math.round((startSec + duration * 0.15) * 1000) / 1000,
        scale: 1.0,
        translate_x: 0,
        translate_y: 0,
        rotate_deg: 0,
        opacity: 1,
        rgb_split_px: Math.round(style.rgb_split * 0.3),
        flash_intensity: 0.0,
        easing: "linear"
      },
      {
        progress: 1.0,
        time_sec: endSec,
        scale: style.scale_to || 1.03,
        translate_x: (idx % 2 === 0 ? 10 : -10),
        translate_y: 0,
        rotate_deg: (idx % 2 === 0 ? 0.5 : -0.5),
        opacity: 1,
        rgb_split_px: 0,
        flash_intensity: 0.0
      }
    ];

    return {
      scene_id: `scene_${idx + 1}`,
      text,
      time_range: {
        start: startSec,
        end: endSec,
        duration: Math.round(duration * 1000) / 1000
      },
      animation: {
        motion_type: style.type,
        shake: {
          enabled: true,
          intensity_px: style.shake_intensity,
          frequency_hz: 30,
          decay: 0.85
        },
        rgb_split: {
          enabled: style.rgb_split > 0,
          max_offset_px: style.rgb_split
        },
        keyframes
      },
      typography: {
        font_family: "Impact, Hiragino Kaku Gothic StdN, sans-serif",
        font_weight: 900,
        letter_spacing_em: 0.05,
        fill_color: "#FFFFFF",
        stroke_color: "#000000",
        stroke_width_px: 8,
        accent_color: (idx % 2 === 0 ? "#FF003C" : "#00F0FF")
      }
    };
  });

  return {
    version: "rocktypo-v1.0",
    generator: "ai-micro-store/rocktypo-engine",
    created_at: new Date().toISOString(),
    config: {
      bpm,
      fps,
      aspect_ratio: aspectRatio,
      total_duration_sec: Math.round(currentSec * 1000) / 1000,
      total_scenes: scenes.length,
      preset
    },
    scenes
  };
}

module.exports = {
  generateRockTypoMotion
};
