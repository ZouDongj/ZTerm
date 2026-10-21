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

