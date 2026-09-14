// Histogram the highlight preview text pixels: the modal (most frequent)
// color is the full-coverage glyph core. If the core equals the chosen hex,
// there is no darkening transform; only anti-aliasing fringe exists.
import { readFileSync } from 'node:fs';
import { pngDecode } from './png-codec.mjs';

const CHOSEN = [0, 229, 255];
const { width, rgba } = pngDecode(readFileSync('artifacts/font-parity-20260913/fix-verify-highlight.png'));
// The rule-name band rect from the probe log (device px): y 215..248 area of
// the FIRST highlight row; scan the whole card column for cyan-ish pixels.
const counts = new Map();
let maxB = 0;
for (let y = 100; y < 1400; y++) {
  for (let x = 300; x < 2300; x++) {
    const i = (y * width + x) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (b > 90 && b > r + 40 && g > 90) {
      const key = `${r},${g},${b}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (b > maxB) maxB = b;
    }
  }
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log('chosen: rgb(0,229,255)');
console.log('top pixel colors (color, count):');
for (const [c, n] of top) console.log(`  rgb(${c})  x${n}`);
console.log('brightest blue channel seen:', maxB);
const exact = counts.get('0,229,255') || 0;
console.log(`exact-match pixels rgb(0,229,255): ${exact}`);
