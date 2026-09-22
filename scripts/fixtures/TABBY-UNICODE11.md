# Installed Tabby Unicode11 reference

`tabby-unicode11.js` is an evidence fixture, not the production width provider.
It contains the actual `@xterm/addon-unicode11` UMD bundled in the installed
`tabby-terminal` package `1.0.231-nightly.0`.

- Source: `D:/Program Files/Tabby/resources/builtin-plugins/tabby-terminal/dist/index.js`
- Original UMD source lines: 19173–19382.
- Source bundle SHA-256: `3069124e72181d6305224e9216e6f58c0329c89032eff079a65ab3094fb2572c`.
- Extracted UMD SHA-256 after LF normalization, excluding the surrounding markers and wrapper:
  `7c63300470f07c9f9cb35c76725529114fc3fe150825dd11973c151c5b403cd2`.
- Extraction changes: LF normalization and a small CommonJS/browser export wrapper only.
  The provider's tables, width algorithm, packed character properties and addon remain unchanged.
- Browser export: `__tabbyUnicode11.Unicode11Addon`.
- Tabby loads this addon and then explicitly sets `terminal.unicode.activeVersion = '11'`
  at source lines 40763–40764. The addon alone only registers the provider.

Use the existing [bundled Terminal and WebGL renderer](../../src/vendor/PROVENANCE.json)
with this addon for the reference column. Do not load both production and reference
providers into separate renderer implementations when comparing width behavior.
No glyph scaling is included in this fixture.

## Reproducible checks

Run `node --test tests/tabby-unicode-parity.test.mjs` from `ZTerm/`.
The test loads this exact fixture through `node:vm`, drives the actual bundled
Terminal parser, and reports buffer/cursor differences. It needs no Tabby installation,
font installation, DOM, GPU, application configuration, PTY or network access.

An explicitly strict comparison is red-capable:

```powershell
node -e "process.env.ZTERM_ASSERT_EXACT_TABBY_PARITY='1'; import('./tests/tabby-unicode-parity.test.mjs')"
```

That strict check currently fails intentionally: the production provider is a scoped
hybrid, not a complete Unicode11 replacement. A scan of `U+0000` through `U+10FFFF`
after the 89-character BMP widening finds 9,219 width differences:

| Region | Current → Tabby width | Count |
| --- | --- | ---: |
| BMP | 1 → 0 | 438 |
| BMP | 0 → 1 | 1 |
| BMP | 2 → 1 | 162 |
| BMP | 0 → 2 | 2 |
| Astral | 1 → 0 | 537 |
| Astral | 1 → 2 | 7,674 |
| Astral | 2 → 1 | 405 |

For example, production keeps newer emoji `U+1FAE0` at width 2 while this reference
returns 1. Common combining accents match; newer combining marks such as `U+1AB0`
do not. These differences are recorded, not silently changed. The full scan includes
unassigned, private-use and surrogate code points; its count is not a count of user-visible bugs.

Matching parser buffers does not establish matching font ink or GPU pixels. Synthetic
PUA adjacency is a controlled case, not evidence of the user's exact output or live Tabby state.

## MIT license

The xterm.js/addon notice is reproduced from [the repository's third-party notice](../../src/vendor/NOTICE.md).

```text
Copyright (c) 2014-2023 The xterm.js authors
Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
