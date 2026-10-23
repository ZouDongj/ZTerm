// UI batch D regressions — U-03/U-08/U-09/U-12/U-13/U-18/U-19 from
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

test('U-08: the light-scheme plain dock carries a 1px left hairline against the gutter', () => {
  // The plain rule drops the ::before ring; on a light scheme the dark dock
  // sits next to the dark 12px gutter, so only that configuration adds the
  // separator back. Dark schemes keep the seamless merge with the canvas.
  const light = ruleBody('.window.dock-plain.scheme-light .sftp-window');
  assert.ok(light.includes('inset 1px 0 0 var(--stroke)'),
    'left-edge hairline from the shared stroke token');
  assert.ok(light.includes('var(--shadow-pane)'), 'depth shadow kept alongside the hairline');
  const plain = ruleBody('.window.dock-plain .sftp-window');
  assert.ok(!plain.includes('--stroke'), 'dark-scheme plain dock stays seamless');
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

// ── U-09: sticky footer's 1px seam cover ──

test('U-09: the sticky SSH edit footer carries a 1px same-color seam cover', () => {
  const footer = ruleBody('#overlay-ssh-edit .ssh-edit-footer');
  assert.ok(footer.includes('position:sticky'), 'footer stays sticky');
  assert.ok(footer.includes('background:rgb(22,25,31)'), 'footer keeps its opaque base');
  // Fractional scroll offsets / fractional DPR can rasterize the sticky edge
  // between device pixels, opening a <=1px sliver of scrolled content above
  // the footer. The 1px same-color shadow above the border box keeps the seam
  // covered without changing layout.
  assert.ok(footer.includes('box-shadow:0 -1px 0 rgb(22,25,31)'), '1px seam cover above the footer');
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

// ── U-13: transfer flyout anchors below the titlebar token ──

test('U-13: titlebar height and transfer flyout share --titlebar-h', () => {
  assert.match(css, /--titlebar-h\s*:\s*46px/, 'titlebar height token exists');
  assert.ok(ruleBody('.titlebar').includes('height:var(--titlebar-h)'), 'titlebar consumes the token');
  const flyout = ruleBody('.transfer-window');
  assert.ok(flyout.includes('top:var(--titlebar-h)'), 'flyout anchors to the token');
  assert.ok(!/top\s*:\s*42px/.test(flyout), 'stale 42px anchor removed');
});

// ── U-18: dead pressed-state selectors ──

test('U-18: pal-item/qc-item selectors are gone; v3 items keep press feedback', () => {
  assert.ok(!css.includes('.pal-item'), 'no .pal-item selector remains');
  assert.ok(!css.includes('.qc-item'), 'no .qc-item selector remains');
  assert.match(css, /\.v3-item:active/, 'v3 items keep the shared pressed brightness');
});

// ── U-19: settings gear never renders as a filled duotone ──

test('U-19: settings renders the stroke gear at every size', () => {
  assert.equal(DUOTONE_ICONS.settings, undefined, 'settings must not be in the duotone registry');
  for (const size of [14, 16, 20, 24]) {
    const svg = iconSvg('settings', size);
    assert.ok(svg.includes('fill="none"'), `settings ${size}px stays a stroke glyph`);
    assert.ok(svg.includes('stroke="currentColor"'), `settings ${size}px inherits text color`);
    assert.ok(!svg.includes('fill="currentColor"'), `settings ${size}px never fills the hub`);
  }
});

// ── SSH saved-password status box height contract ──
// The .btn-outline base carries height:30px; inside the 34px .ssh-pwd-status
// flex row that inflates the box to 49px and the dialog height jumps when
// switching auth methods. The scoped override must neutralize the height.

test('ssh-pwd-status override resets the base 30px button height (status box stays 34px)', () => {
  assert.ok(ruleBody('.btn-outline').includes('height:30px'),
    'the base .btn-outline still carries the 30px height this pin guards against');
  assert.match(ruleBody('.ssh-pwd-status .btn-outline'), /height\s*:\s*auto/,
    'override must reset height or the status box grows past the 34px input height');
});

// ── SFTP dock icon optical sizing ──
// The breadcrumb drive glyph spans only 12x9 of its 16-unit viewBox and the
// toolbar glyphs span 14–19 of their 24-unit grid, so equal px boxes render
// visibly unequal ink. These pins freeze the optical corrections: the root
// crumb svg at 14px (sftp.js attrs and the css rule must agree — the rule
// overrides the attributes), and per-icon toolbar sizes chosen so each
// glyph's vertical ink span lands within ~1px of its neighbours.

test('root crumb drive svg is 14px in both sftp.js and the css rule', () => {
  const sftpSrc = read('src/renderer/sftp.js');
  const icon = sftpSrc.match(/const SFTP_ROOT_ICON = '<svg width="(\d+)" height="(\d+)"/);
  assert.ok(icon, 'SFTP_ROOT_ICON svg tag found in sftp.js');
  assert.equal(icon[1], '14', 'sftp.js svg width');
  assert.equal(icon[2], '14', 'sftp.js svg height');
  const rule = ruleBody('.sftp-breadcrumb .seg-root svg');
  assert.ok(rule.includes('width:14px') && rule.includes('height:14px'),
    'css rule must agree with the svg attrs (it overrides them)');
});

test('sftp toolbar svgs keep their per-icon optical sizes', () => {
  // Vertical ink spans on the 24-unit grid: arrow-up 14, refresh 18, pin 19,
  // mkdir 17, upload 18 units — the arrow grows to 15px, the pin shrinks to
  // 12px and the rest stay 13px so the rendered heights land within ~1px.
  const html = read('src/renderer.html');
  const expected = { goUp: 15, refresh: 13, togglePin: 12, mkdir: 13, upload: 13 };
  for (const [call, px] of Object.entries(expected)) {
    const m = html.match(new RegExp(`<button[^>]*onclick="SFTP\\.${call}\\(\\)"[^>]*><svg width="(\\d+)" height="(\\d+)" viewBox="0 0 24 24"`));
    assert.ok(m, `toolbar button ${call} inline svg found`);
    assert.equal(m[1], String(px), `${call} svg width`);
    assert.equal(m[2], String(px), `${call} svg height`);
  }
});
