// UI consistency audit: quantify design-token drift across CSS, inline HTML
// styles, and JS-injected styles. Objective numbers only — every claim in the
// report can be recomputed by rerunning this script.
//
//   node scripts/ui-consistency-audit.mjs
//
// Scans: src/renderer/app.css, src/renderer/xterm.css (ours), inline style=""
// in src/renderer.html, and .style.xxx assignments in src/renderer/*.js.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/renderer';
const appCss = readFileSync(join(ROOT, 'app.css'), 'utf8');
const xtermCss = readFileSync(join(ROOT, 'xterm.css'), 'utf8');
const html = readFileSync('src/renderer.html', 'utf8');
const jsFiles = readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'conpty-caret.js' && f !== 'xterm-smooth-cursor.js' && f !== 'smooth-cursor-overlay.js');
const jsAll = jsFiles.map(f => ({ f, s: readFileSync(join(ROOT, f), 'utf8') }));

const report = { generatedAt: new Date().toISOString(), sources: {} };
const addSource = (name, bytes) => { report.sources[name] = bytes; };

// ---------- helpers ----------
const countBy = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

// Extract declarations from CSS blocks (rule bodies) — good enough for stats.
const cssDecls = (css) => {
  const out = [];
  // strip comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    for (const d of m[1].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out.push(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
};

const propsOf = (css) => {
  const decls = cssDecls(css);
  const map = new Map();
  for (let i = 0; i < decls.length; i += 2) {
    const p = decls[i], v = decls[i + 1];
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(v);
  }
  return map;
};

// ---------- 1. colors ----------
const normColor = (v) => v.toLowerCase().replace(/\s+/g, ' ').trim();
const grayish = (hex) => {
  // #rrggbb where r≈g≈b (gray family)
  const m = hex.match(/^#([0-9a-f]{6})$/);
  if (!m) return false;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  return Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8;
};
const collectColors = (css, inlineStyles, jsStyleVals) => {
  const raw = [];
  for (const v of [...css, ...inlineStyles, ...jsStyleVals]) {
    for (const c of v.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || []) raw.push(normColor(c));
  }
  return raw;
};

// ---------- scan CSS ----------
addSource('app.css', appCss.length);
addSource('xterm.css(ours)', xtermCss.length);
const cssMap = propsOf(appCss + '\n' + xtermCss);

// inline styles in HTML: style="..." attributes
const inlineAttr = [...html.matchAll(/style="([^"]*)"/g)].map(m => m[1]);
addSource('renderer.html inline style attrs', inlineAttr.length);
// inline <style> blocks in html
const htmlStyleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
const htmlCssMap = propsOf(htmlStyleBlocks);
for (const [p, vs] of htmlCssMap) {
  if (!cssMap.has(p)) cssMap.set(p, []);
  cssMap.get(p).push(...vs);
}

// JS-injected styles: el.style.xxx = 'yyy'
const jsStyleAssigns = [];
for (const { f, s } of jsAll) {
  for (const m of s.matchAll(/\.style\.([A-Za-z]+)\s*=\s*['"`]([^'"`]*)['"`]/g)) {
    jsStyleAssigns.push({ file: f, prop: m[1], val: m[2] });
  }
}
addSource('JS style assignments', jsStyleAssigns.length);

// ---------- build stats ----------
const colors = collectColors(
  [...(cssMap.get('color') || []), ...(cssMap.get('background') || []), ...(cssMap.get('background-color') || []), ...(cssMap.get('border-color') || []), ...(cssMap.get('border-top-color') || []), ...(cssMap.get('border-bottom-color') || [])],
  inlineAttr,
  jsStyleAssigns.filter(a => /color/i.test(a.prop)).map(a => a.val)
);
const uniqueColors = countBy(colors);
const grays = uniqueColors.filter(([c]) => grayish(c));
const varUses = (css) => (css.match(/var\(--/g) || []).length;
const varDefs = [...appCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1].toLowerCase());

const radius = countBy([...(cssMap.get('border-radius') || []), ...inlineAttr.join(';').match(/border-radius:[^;"]*/g)?.map(s => s.replace(/border-radius:/, '')) || []].map(v => v.trim()));
const shadows = countBy([...(cssMap.get('box-shadow') || []), ...jsStyleAssigns.filter(a => a.prop === 'boxShadow').map(a => a.val)]);
const fontSizes = countBy([...(cssMap.get('font-size') || []), ...jsStyleAssigns.filter(a => a.prop === 'fontSize').map(a => a.val)]);
const gaps = countBy((cssMap.get('gap') || []).map(v => v.trim()));
const margins = countBy([...(cssMap.get('margin') || []), ...(cssMap.get('margin-top') || []), ...(cssMap.get('margin-bottom') || []), ...(cssMap.get('margin-left') || []), ...(cssMap.get('margin-right') || [])]);
const paddings = countBy([...(cssMap.get('padding') || []), ...(cssMap.get('padding-top') || []), ...(cssMap.get('padding-bottom') || []), ...(cssMap.get('padding-left') || []), ...(cssMap.get('padding-right') || [])]);
const spacings = countBy([
  ...margins.flatMap(([v]) => String(v).split(/\s+/)),
  ...paddings.flatMap(([v]) => String(v).split(/\s+/)),
].map(s => s.trim()).filter(s => /^-?\d/.test(s)));
const transitions = countBy((cssMap.get('transition') || []).map(v => v.trim()));
const zIndexes = countBy((cssMap.get('z-index') || []).map(v => v.trim()));
const durations = countBy([...(cssMap.get('transition') || []).join(',').match(/\d*\.?\d+m?s/g) || [], ...(cssMap.get('animation') || []).join(',').match(/\d*\.?\d+m?s/g) || []]);
const fontsFamily = countBy((cssMap.get('font-family') || []).map(v => v.trim()));
const weights = countBy([...(cssMap.get('font-weight') || []), ...jsStyleAssigns.filter(a => a.prop === 'fontWeight').map(a => a.val)]);

// hover/focus/active coverage per UI area (selector counts in app.css)
const selCount = (re) => (appCss.match(re) || []).length;
const interaction = {
  hover: selCount(/:hover/g), focus: selCount(/:focus/g), focusVisible: selCount(/:focus-visible/g),
  active: selCount(/:active/g), disabled: selCount(/:disabled/g),
};

report.stats = {
  colors: { total: colors.length, unique: uniqueColors.length, uniqueGrays: grays.length, topGrays: grays.slice(0, 12), accentLike: uniqueColors.filter(([c]) => !grayish(c) && /#|rgb/.test(c)).slice(0, 15) },
  tokens: { varUses: varUses(appCss), varDefs: [...new Set(varDefs)] },
  radius: { unique: radius.length, values: radius.slice(0, 12) },
  shadows: { unique: shadows.length, values: shadows.slice(0, 10) },
  fontSizes: { unique: fontSizes.length, values: fontSizes.slice(0, 12) },
  fontFamily: { unique: fontsFamily.length, values: fontsFamily.slice(0, 8) },
  weights: { unique: weights.length, values: weights.slice(0, 8) },
  spacing: { unique: spacings.length, offGrid: spacings.filter(([v]) => { const n = parseFloat(v); return !Number.isNaN(n) && n > 0 && (n % 4 !== 0); }).slice(0, 12), topValues: spacings.slice(0, 12) },
  transitions: { unique: transitions.length, values: transitions.slice(0, 10), durations: durations.slice(0, 10) },
  zIndex: { values: zIndexes },
  interaction,
  jsStyleByFile: countBy(jsStyleAssigns.map(a => a.file)),
};

writeFileSync('design/ui-audit-20260913.json', JSON.stringify(report, null, 1));
console.log('wrote design/ui-audit-20260913.json');
console.log(JSON.stringify(report.stats, null, 1).slice(0, 3500));
