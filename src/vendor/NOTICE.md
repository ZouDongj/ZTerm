# Third-Party Notices

## xterm.js and addons

The files in `src/vendor/` are the UMD bundles of xterm.js and its official addons:

- `xterm.js` — @xterm/xterm
- `addon-fit.js` — @xterm/addon-fit
- `addon-search.js` — @xterm/addon-search
- `addon-web-links.js` — @xterm/addon-web-links
- `addon-webgl.js` — @xterm/addon-webgl
- `addon-clipboard.js` — @xterm/addon-clipboard
- `xterm.css` — @xterm/xterm stylesheet

These bundles are minified from the npm packages and distributed under the MIT License:

```
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

## Other Rust dependencies

All Rust crates used by `src-tauri/` are listed in `src-tauri/Cargo.toml` /
`Cargo.lock` and are distributed under their respective open-source licenses
(MIT, Apache-2.0, BSD-3-Clause, ISC).
