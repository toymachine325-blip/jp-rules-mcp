/**
 * products/drums_midi.js
 * 即戦力8ビート・ドラムMIDIジェネレータ (SMF Type 0)
 * ゼロ外部依存・純粋Node.js Buffer実装
 */

class SeededRandom {
  constructor(seed = 424242) {
    this.seed = seed;
  }
  next() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }
  range(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function writeVLQ(value) {
  const bytes = [];
  let v = Math.max(0, Math.floor(value));
  bytes.push(v & 0x7f);
  v >>= 7;
  while (v > 0) {
    bytes.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return Buffer.from(bytes.reverse());
}

/**
 * 8ビート・裏拍グルーヴ ドラムMIDIバイナリ (SMF Type 0 Buffer) を生成
 * @param {Object} options
 * @param {number} [options.bpm=121.86]
 * @param {number} [options.bars=16]
 * @param {number} [options.seed=20261113]
 * @returns {Buffer} SMF Type 0 MIDI Buffer
 */
function generateDrumsMidiBuffer(options = {}) {
  const bpm = Number(options.bpm) > 0 ? Number(options.bpm) : 121.86;
  const bars = Math.max(1, Math.min(64, parseInt(options.bars, 10) || 16));
  const seed = Number(options.seed) || 20261113;
  const rng = new SeededRandom(seed);

  const PPQ = 480;
  const TICKS_PER_BAR = PPQ * 4; // 1920
  const TOTAL_TICKS = TICKS_PER_BAR * bars;
  const CHANNEL = 9; // MIDI Ch 10 (0-indexed 9)

  const events = [];

  function addNote(tick, note, velocity, durationTicks = 120, isExact = false) {
    let actualTick = tick;
    let actualVel = velocity;
    if (!isExact) {
      actualTick += rng.range(-2, 2);
      actualVel = clamp(velocity + rng.range(-4, 4), 1, 127);
    }
    actualTick = Math.max(0, actualTick);

    // Note On
    events.push({
      tick: actualTick,
      type: 'noteOn',
      note,
      velocity: actualVel,
      order: 1
    });
    // Note Off
    events.push({
      tick: actualTick + durationTicks,
      type: 'noteOff',
      note,
      velocity: 0,
      order: 0
    });
  }

  function generateBasePattern(barStart, startBeat, maxBeat, bar) {
    const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5];

    let kickBeats = [];
    const blockIndex = Math.floor(bar / 4) % 4;
    if (blockIndex === 0) {
      kickBeats = [0, 1.5, 2.5];
    } else if (blockIndex === 1) {
      kickBeats = [0, 1.5, 2.5, 3.5];
    } else if (blockIndex === 2) {
      kickBeats = (bar % 2 === 0) ? [0, 1.5, 2.5, 3.5] : [0, 1.5, 2.0, 3.5];
    } else {
      kickBeats = (bar % 2 === 0) ? [0, 1.5, 2.5, 3.5] : [0, 0.5, 1.5, 2.5, 3.5];
    }

    // キック
    kickBeats.forEach(b => {
      if (b >= startBeat && b <= maxBeat) {
        if (b === 0) {
          addNote(barStart, 36, 115, 200, true);
        } else {
          addNote(barStart + Math.round(b * PPQ), 36, 110, 180);
        }
      }
    });

    // スネア (バックビート 2拍目・4拍目)
    if (1.0 >= startBeat && 1.0 <= maxBeat) {
      addNote(barStart + Math.round(1.0 * PPQ), 38, 114, 180);
    }
    if (3.0 >= startBeat && 3.0 <= maxBeat) {
      addNote(barStart + Math.round(3.0 * PPQ), 38, 116, 180);
    }

    // スネア・ゴーストノート
    const ghostBeat = (bar % 2 === 0) ? 3.5 : 1.5;
    if (ghostBeat >= startBeat && ghostBeat <= maxBeat) {
      addNote(barStart + Math.round(ghostBeat * PPQ), 38, 47, 100);
    }

    // ハイハット (Closed 42 & Open 46)
    const isOpenHiHatBar = (bar % 2 === 1);

    beats.forEach(b => {
      if (b >= startBeat && b <= maxBeat) {
        const isOffbeat = (b % 1 !== 0);
        const is4And = (b === 3.5);

        if (is4And && isOpenHiHatBar) {
          addNote(barStart + Math.round(b * PPQ), 46, 112, 220);
        } else {
          if (isOffbeat) {
            addNote(barStart + Math.round(b * PPQ), 42, 110, 140);
          } else {
            addNote(barStart + Math.round(b * PPQ), 42, 67, 120);
          }
        }
      }
    });
  }

  // 小節ループ
  for (let bar = 0; bar < bars; bar++) {
    const barStart = bar * TICKS_PER_BAR;

    // クラッシュシンバル (4小節ごと頭)
    if (bar % 4 === 0) {
      addNote(barStart, 49, 118, PPQ, true);
    }

    // フィルイン判定 (4小節目ごと)
    const isLastBar = (bar === bars - 1);
    const isFillBar = (bar % 4 === 3);

    if (isLastBar && bars >= 4) {
      // 最終小節のクライマックスフィル
      addNote(barStart, 36, 115, 200, true);
      addNote(barStart, 49, 120, PPQ, true);
      addNote(barStart + Math.round(0.5 * PPQ), 36, 110, 180);

      const fillNotes = [
        { beat: 1.0, note: 38, vel: 104 },
        { beat: 1.25, note: 38, vel: 108 },
        { beat: 1.5, note: 38, vel: 112 },
        { beat: 1.75, note: 38, vel: 116 },
        { beat: 2.0, note: 48, vel: 110 },
        { beat: 2.25, note: 48, vel: 114 },
        { beat: 2.5, note: 48, vel: 116 },
        { beat: 2.75, note: 48, vel: 118 },
        { beat: 3.0, note: 45, vel: 114 },
        { beat: 3.25, note: 45, vel: 118 },
        { beat: 3.5, note: 41, vel: 120 },
        { beat: 3.75, note: 41, vel: 124 },
      ];
      fillNotes.forEach(fn => {
        addNote(barStart + Math.round(fn.beat * PPQ), fn.note, fn.vel, 100);
      });
      addNote(barStart + Math.round(3.5 * PPQ), 46, 116, 220);
    } else if (isFillBar) {
      // 通常のフィルイン
      generateBasePattern(barStart, 0, 2.0, bar);
      addNote(barStart + Math.round(2.5 * PPQ), 38, 96, 100);
      addNote(barStart + Math.round(2.75 * PPQ), 38, 104, 100);
      addNote(barStart + Math.round(3.0 * PPQ), 38, 114, 100);
      addNote(barStart + Math.round(3.25 * PPQ), 48, 105, 100);
      addNote(barStart + Math.round(3.5 * PPQ), 45, 108, 100);
      addNote(barStart + Math.round(3.5 * PPQ), 46, 114, 220);
      addNote(barStart + Math.round(3.75 * PPQ), 41, 114, 100);
    } else {
      generateBasePattern(barStart, 0, 3.5, bar);
    }
  }

  // イベントソート
  events.sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    return a.order - b.order;
  });

  const trackData = [];

  // 1. テンポメタイベント (BPM -> us/beat)
  const usPerBeat = Math.round(60000000 / bpm);
  trackData.push(Buffer.from([
    0x00, 0xFF, 0x51, 0x03,
    (usPerBeat >> 16) & 0xFF,
    (usPerBeat >> 8) & 0xFF,
    usPerBeat & 0xFF
  ]));

  // 2. 拍子メタ: 4/4
  trackData.push(Buffer.from([0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]));

  // 3. トラック名
  const trackName = Buffer.from(`Drums 8Beat [${bars}Bars / BPM ${bpm}]`);
  trackData.push(Buffer.concat([
    Buffer.from([0x00, 0xFF, 0x03, trackName.length]),
    trackName
  ]));

  let lastTick = 0;
  for (const evt of events) {
    const delta = evt.tick - lastTick;
    trackData.push(writeVLQ(delta));

    if (evt.type === 'noteOn') {
      trackData.push(Buffer.from([0x90 | CHANNEL, evt.note, evt.velocity]));
    } else {
      trackData.push(Buffer.from([0x80 | CHANNEL, evt.note, evt.velocity]));
    }
    lastTick = evt.tick;
  }

  // 終端 End of Track
  const finalDelta = Math.max(0, TOTAL_TICKS - lastTick);
  trackData.push(writeVLQ(finalDelta));
  trackData.push(Buffer.from([0xFF, 0x2F, 0x00]));

  const trackContent = Buffer.concat(trackData);

  // MTrk チャンク
  const mtrkHeader = Buffer.alloc(8);
  mtrkHeader.write('MTrk', 0, 4, 'ascii');
  mtrkHeader.writeUInt32BE(trackContent.length, 4);

  // MThd チャンク
  const mthdChunk = Buffer.alloc(14);
  mthdChunk.write('MThd', 0, 4, 'ascii');
  mthdChunk.writeUInt32BE(6, 4);
  mthdChunk.writeUInt16BE(0, 8); // Format 0
  mthdChunk.writeUInt16BE(1, 10); // 1 Track
  mthdChunk.writeUInt16BE(PPQ, 12); // PPQ = 480

  return Buffer.concat([mthdChunk, mtrkHeader, trackContent]);
}

module.exports = {
  generateDrumsMidiBuffer
};
