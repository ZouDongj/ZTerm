// Text-tier contrast contract: --text-1/--text-2 must stay >= 4.5:1 on every
// derived surface (win/float/card) for every terminal scheme; --text-3 must
// stay clearly below so "weak" stays weak. Guards accidental token drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hexToHsl, hslToHex } = require('../src/renderer/color-utils.js');

// Mirrors applyTerminalScheme's derivation (state.js) — if that changes, this
// test must change with it.
const derive = (bg, l) => { const { h, s } = hexToHsl(bg); return hslToHex(h, Math.max(s, 0.06), l); };
const SCHEMES = {
  oneHalfDark: '#282c34', snazzy: '#282a36', tokyonight: '#1a1b26', catppuccin: '#1e1e2e',
};
const TEXT = { text1: '#abb2bf', text2: '#a2aab7', text3: '#6a7280' };

const lum = (r, g, b) => {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const contrast = (a, b) => {
  const L1 = lum(...hexRgb(a)), L2 = lum(...hexRgb(b));
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
};

test('text-1 and text-2 pass 4.5:1 on every derived surface of every scheme', () => {
  for (const [name, bg] of Object.entries(SCHEMES)) {
    const surfaces = { win: derive(bg, 0.065), float: derive(bg, 0.185), card: derive(bg, 0.24) };
    for (const [sName, sHex] of Object.entries(surfaces)) {
      for (const t of ['text1', 'text2']) {
        const c = contrast(TEXT[t], sHex);
        assert.ok(c >= 4.5, `${name}/${sName}/${t}: ${c.toFixed(2)} < 4.5`);
      }
    }
  }
});

test('text-3 stays clearly weak (below 4.2:1, never near the 4.5 text line)', () => {
  // ~3.9 is intended: icons/decorations stay visible (WCAG graphics 3:1)
  // while text in this tier never reaches readable contrast.
  for (const [name, bg] of Object.entries(SCHEMES)) {
    const win = derive(bg, 0.065);
    assert.ok(contrast(TEXT.text3, win) < 4.2, `${name}: text3 on win drifted too bright`);
  }
});
