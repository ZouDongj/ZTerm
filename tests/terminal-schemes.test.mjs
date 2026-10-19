// Terminal scheme palette contract. The renderer keeps every scheme as a
// browser-global object in state.js, so the test extracts the real literal and
// evaluates it in a VM (no DOM needed).
//
// Guards:
//   - every scheme carries a complete 16-color ANSI palette + bg/fg;
//   - the two v12 schemes keep the exact anchors the prototype defines;
//   - the new schemes stay readable on their near-black canvases;
//   - the UI text tiers stay in the intended alpha order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const stateSrc = read('src/renderer/state.js');
const schemesMatch = stateSrc.match(/const TERMINAL_SCHEMES = (\{[\s\S]*?\n\});/);
assert.ok(schemesMatch, 'TERMINAL_SCHEMES literal found in state.js');
const SCHEMES = vm.runInNewContext(`(${schemesMatch[1]})`);

const HEX = /^#[0-9a-f]{6}$/i;
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

test('every scheme defines a complete ANSI palette and a readable foreground', () => {
  for (const [key, scheme] of Object.entries(SCHEMES)) {
    assert.ok(scheme.name, `${key}: missing display name`);
    for (const field of ['background', 'foreground', ...ANSI]) {
      assert.match(scheme[field] || '', HEX, `${key}: ${field} is not #rrggbb`);
    }
    const ratio = contrast(scheme.foreground, scheme.background);
    const floor = (key === 'inkFamily' || key === 'obsidian') ? 4.5 : 3.0;
    assert.ok(ratio >= floor, `${key}: foreground contrast ${ratio.toFixed(2)} < ${floor}`);
  }
});

test('Ink Family keeps the v12 prototype anchors', () => {
  const s = SCHEMES.inkFamily;
  assert.ok(s, 'inkFamily scheme exists');
  assert.equal(s.name, 'Ink Family');
  assert.equal(s.background, '#0e1117');
  assert.equal(s.foreground, '#ccd3e0');
  assert.equal(s.red, '#ee8089');
  assert.equal(s.green, '#a9d97c');
  assert.equal(s.yellow, '#efce8c');
  assert.equal(s.blue, '#79bcf7');
  assert.equal(s.magenta, '#d18fe8');
  assert.equal(s.cyan, '#67c7d4');
  assert.equal(s.brightBlack, '#8a93a6');
});

test('Obsidian keeps the near-black prototype anchors', () => {
  const s = SCHEMES.obsidian;
  assert.ok(s, 'obsidian scheme exists');
  assert.equal(s.name, 'Obsidian');
  assert.equal(s.background, '#0a0b0f');
  assert.equal(s.foreground, '#e6ebf3');
  assert.equal(s.red, '#f7768e');
  assert.equal(s.green, '#9ece6a');
  assert.equal(s.yellow, '#e0af68');
  assert.equal(s.blue, '#7aa2f7');
  assert.equal(s.magenta, '#bb9af7');
  assert.equal(s.cyan, '#7dcfff');
  assert.equal(s.brightBlack, '#939cb0');
});

test('the v12 schemes keep every ANSI accent above 3:1 on their canvas', () => {
  for (const key of ['inkFamily', 'obsidian']) {
    const s = SCHEMES[key];
    for (const field of ANSI.filter((f) => f !== 'black' && f !== 'brightBlack')) {
      const ratio = contrast(s[field], s.background);
      assert.ok(ratio >= 3, `${key}/${field}: ${ratio.toFixed(2)} < 3.0`);
    }
  }
});

test('UI text tiers keep the intended alpha ladder', () => {
  const css = read('src/renderer/app.css');
  const alpha = (token) => {
    const m = css.match(new RegExp(`--${token}:\\s*rgba\\(255,\\s*255,\\s*255,\\s*([0-9.]+)\\)`));
    assert.ok(m, `--${token} found in app.css`);
    return parseFloat(m[1]);
  };
  const [t1, t2, t3] = ['t1', 't2', 't3'].map(alpha);
  assert.ok(t1 > t2 && t2 > t3, `tiers out of order: ${t1}, ${t2}, ${t3}`);
  assert.ok(t1 >= 0.85 && t3 <= 0.45, `tiers drifted: ${t1}, ${t3}`);
});
