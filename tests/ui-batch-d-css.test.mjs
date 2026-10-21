// UI batch D regressions — U-03/U-08/U-12/U-13/U-18/U-19 from
// dev/docs/reviews/ui-batch-consolidated-2026-10-21.md.
// Pure-CSS items assert the stylesheet contract (token exists, dead selector
// gone, open-state rule derives from the dock reserve); U-08 also checks the
// light-scheme marker derivation, and U-19 exercises the real icon registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const require = createRequire(import.meta.url);

const css = read('src/renderer/app.css');
const stateSrc = read('src/renderer/state.js');
const { iconSvg, DUOTONE_ICONS } = require('../src/renderer/icons.js');
const { colorFgbgForBackground } = require('../src/renderer/color-utils.js');

// Body (declarations between the braces) of a single `selector{...}` rule.
const ruleBody = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, `rule not found: ${selector}`);
  return m[1];
};

// ── U-03: search bar must not overlap the SFTP dock ──

test('U-03: search bar open state recenters from the dock reserve, no dead right', () => {
  // The same reserve expression .term-wrap uses; if the dock geometry
  // changes, this test must be updated together with it.
  const reserve = 'min(var(--sftp-width,320px), calc(100% - 240px)) + 12px';
  assert.ok(ruleBody('.main.sftp-open .term-wrap').includes(reserve), 'term-wrap dock reserve anchor');
  const open = ruleBody('.main.sftp-open .search-bar');
  assert.ok(!/(^|;)\s*right\s*:/.test(open), 'right is dead next to the base left+width pinning');
  assert.ok(open.includes(`left:calc((100% - (${reserve})) / 2)`), 'left centers in the area left of the dock');
  assert.ok(open.includes(`width:min(520px,calc(100% - (${reserve}) - 24px))`), 'width shrinks with the remaining area');
  const anim = ruleBody('.main.sftp-animating .search-bar');
  assert.ok(anim.includes('transition:left'), 'reveal animates left');
  assert.ok(!anim.includes('right'), 'no right transition remains');
});

// ── U-08: dock-plain + light terminal scheme ──

test('U-08: light scheme keeps the dark dock material instead of the light canvas', () => {
  const plain = ruleBody('.window.dock-plain .sftp-window');
  assert.ok(plain.includes('background:var(--term-bg)'), 'plain dock still follows the scheme canvas');
  const light = ruleBody('.window.dock-plain.scheme-light .sftp-window');
  assert.ok(light.includes('background:var(--acrylic)'), 'light scheme falls back to the dark material');
  assert.ok(light.includes('backdrop-filter:blur('), 'light scheme restores the material blur');
});

test('U-08: scheme-light marker derives from the COLORFGBG luminance test', () => {
  assert.match(stateSrc, /classList\.toggle\('scheme-light', colorFgbgForBackground\(theme\.background\) === '0;15'\)/,
    'applyTerminalScheme must derive the marker with the shared luminance test');
  const schemesMatch = stateSrc.match(/const TERMINAL_SCHEMES = (\{[\s\S]*?\n\});/);
  assert.ok(schemesMatch, 'TERMINAL_SCHEMES literal found in state.js');
  const SCHEMES = vm.runInNewContext(`(${schemesMatch[1]})`);
  for (const key of ['oneHalfLight', 'solarizedLight', 'tangoLight', 'vscodeLightModern']) {
    assert.equal(colorFgbgForBackground(SCHEMES[key].background), '0;15', `${key} must be detected as light`);
  }
  for (const key of ['onedark', 'inkFamily', 'obsidian']) {
    assert.equal(colorFgbgForBackground(SCHEMES[key].background), '15;0', `${key} must stay dark`);
  }
});

// ── U-12: SFTP path editor keeps field chrome, no layout jump ──

test('U-12: pathbar is pinned and the editor keeps the 20px field box', () => {
  assert.ok(ruleBody('.sftp-pathbar').includes('min-height:36px'), 'address row keeps the crumb-mode height');
  const input = ruleBody('.sftp-path-input');
  for (const decl of ['height:20px', 'border-radius:10px', 'background:var(--field-bg)', 'font-size:12px']) {
    assert.ok(input.includes(decl), `path input missing ${decl}`);
  }
  assert.equal(ruleBody('.sftp-path-input:focus').trim(), 'box-shadow:var(--field-focus)',
    'inset field ring replaces the global outer ring');
});

