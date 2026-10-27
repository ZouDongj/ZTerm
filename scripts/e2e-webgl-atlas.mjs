export async function runWebglAtlasChecks(cdp, check, { defaultAtlasCap = false, deviceScaleFactor = 0 } = {}) {
  const dpr = Number(deviceScaleFactor);
  if (dpr > 0) {
    const viewport = await cdp.eval(`({ width: innerWidth, height: innerHeight })`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: dpr, mobile: false });
  }
  let report;
  try {
    report = await cdp.eval(`(async () => {
    const hostTab = TabManager.getActive();
    const hostTerminal = hostTab?.term || getAllPanes(hostTab).find(p => p.term)?.term;
    if (!hostTerminal) throw new Error('No local terminal is available for the WebGL fixture');
    const options = {
      cols: 60, rows: 2, allowProposedApi: true, disableStdin: true, cursorBlink: false,
      fontFamily: hostTerminal.options.fontFamily, fontSize: hostTerminal.options.fontSize,
      fontWeight: hostTerminal.options.fontWeight, fontWeightBold: hostTerminal.options.fontWeightBold,
      lineHeight: hostTerminal.options.lineHeight, letterSpacing: hostTerminal.options.letterSpacing,
      allowTransparency: hostTerminal.options.allowTransparency, customGlyphs: true,
      minimumContrastRatio: hostTerminal.options.minimumContrastRatio,
      drawBoldTextInBrightColors: hostTerminal.options.drawBoldTextInBrightColors,
      theme: hostTerminal.options.theme,
    };
    const reset = '\\x1b[0m\\x1b[?25l\\x1b[2J\\x1b[H';
    const header = 'ABC 中文状态 streaming 123';
    const defaultCap = ${defaultAtlasCap};
    const frameLimit = defaultCap ? 2048 : 256;
    const results = [];
    function difference(a, b) {
      if (a.length !== b.length) throw new Error('Readback dimensions changed');
      let count = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > 2) count++;
      }
      return count;
    }
    function differenceDetails(a, b, width) {
      let count = 0, minX = width, minY = Infinity, maxX = -1, maxY = -1;
      const samples = [];
      for (let i = 0; i < a.length; i += 4) {
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) <= 2) continue;
        const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
        count++;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (samples.length < 12) samples.push({ x, y,
          before: Array.from(a.slice(i, i + 4)), after: Array.from(b.slice(i, i + 4)) });
      }
      return { count, bounds: count ? { minX, minY, maxX, maxY } : null, samples };
    }
    function create(mode) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:540px;min-height:46px;pointer-events:none;z-index:0';
      document.getElementById('tab-viewport').appendChild(host);
      const term = new Terminal(options);
      __unicodeWidth.installOn(term);
      term.open(host);
      const addon = new WebglAddon();
      term.loadAddon(addon);
      const smooth = mode === 'off' ? null : _wireSmoothCursorWebgl(term, addon);
      if (smooth && mode === 'disabled') smooth._adapter?.setEnabled(false);
      if (smooth && mode !== 'disabled') smooth.setOptions({ cursorBlink: false, cursorStyle: 'block' });
      let observer = null;
      if (mode === 'software') {
        const port = smooth._adapter.softwareCaretPort;
        observer = createInkCaretObserver({ rows: term.rows, cols: term.cols,
          onCandidate: c => port.candidate(c), onUnit: u => port.unit(u) });
      }
      if (mode !== 'off') term.focus();
      const browserService = term._core._coreBrowserService;
      const focusedFixture = mode !== 'off';
      // The disabled background host cannot own OS focus. Simulate focus only
      // on this synthetic terminal; this is not a native focus or IME test.
      if (focusedFixture) {
        term._core.coreService.isCursorInitialized = true;
        Object.defineProperty(browserService, 'isFocused', { configurable: true, get: () => true });
      }
      return { host, term, addon, smooth, observer, browserService, focusedFixture };
    }
    function frame(f, data) {
      return new Promise((resolve, reject) => {
        const service = f.term._core._renderService, renderer = f.addon._renderer;
        if (!renderer?._gl || service._renderer.value !== renderer) {
          reject(new Error('The real WebGL renderer is not active')); return;
        }
        let parsed = false;
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('No rendered fixture frame')); }, 6000);
        const subscription = service.onRender(() => {
          if (!parsed) return;
          subscription.dispose(); clearTimeout(timeout);
          try {
            const gl = renderer._gl, height = Math.ceil(renderer.dimensions.device.cell.height);
            const expected = renderer.dimensions.device.canvas;
            if (renderer._canvas.width !== expected.width || renderer._canvas.height !== expected.height) {
              throw new Error('Canvas/grid mismatch: ' + renderer._canvas.width + 'x' + renderer._canvas.height +
                ' != ' + expected.width + 'x' + expected.height);
            }
            const pixels = new Uint8Array(renderer._canvas.width * height * 4);
            gl.readPixels(0, renderer._canvas.height - height, renderer._canvas.width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL readPixels failed');
            resolve({ pixels });
          } catch (error) { reject(error); }
        });
        const seq = f.observer?.push(data).chunkSeq;
        const port = f.smooth?._adapter?.softwareCaretPort;
        if (seq !== undefined && port) port.enqueued(seq);
        f.term.write(data, () => { if (seq !== undefined && port) port.parsed(seq); parsed = true; });
      });
    }
    function instrument(f) {
      const atlas = f.addon._renderer._charAtlas, glyph = f.addon._renderer._glyphRenderer.value;
      const state = { atlas, glyph, merges: 0, rebinds: [] };
      state.originalMerge = atlas._mergePages;
      state.originalBind = glyph._bindAtlasPageTexture;
      atlas._mergePages = function (...args) { state.merges++; return state.originalMerge.apply(this, args); };
      glyph._bindAtlasPageTexture = function (gl, source, index) {
        state.rebinds.push({ index, page: source.pages[index] });
        return state.originalBind.call(this, gl, source, index);
      };
      return state;
    }
    function cursorTrace(f) {
      const snapshot = f.smooth?._adapter?.snapshot(), renderer = f.addon._renderer;
      const rectangle = snapshot?.lastRectangle, glyph = snapshot?.lastGlyph, model = renderer._model.cursor;
      return {
        visual: snapshot?.visual ?? null, target: snapshot?.target ?? null,
        animationActive: snapshot?.animationActive ?? null,
        rectangle: rectangle ? { x: rectangle.x, y: rectangle.y } : null,
        glyph: glyph ? { x: glyph.x, y: glyph.y, scissor: glyph.scissor ? [...glyph.scissor] : null } : null,
        modelCursor: model ? { x: model.x, y: model.y, width: model.width, style: model.style } : null,
        cell: { width: renderer.dimensions.device.cell.width, height: renderer.dimensions.device.cell.height },
        canvas: {
          width: renderer._canvas.width, height: renderer._canvas.height,
          expectedWidth: renderer.dimensions.device.canvas.width,
          expectedHeight: renderer.dimensions.device.canvas.height,
          cssWidth: renderer.dimensions.css.canvas.width, cssHeight: renderer.dimensions.css.canvas.height,
        },
      };
    }
    function vertices(state) {
      const stale = [], line = arguments[1];
      for (let col = 0; col < state.glyph._terminal.cols; col++) {
        const cell = line.getCell(col);
        if (!cell.getCode() || !cell.getWidth()) continue;
        const entry = state.atlas.getRasterizedGlyph(cell.getCode(), cell.bg, cell.fg, 0, false);
        const vertex = Array.from(state.glyph._vertices.attributes.slice(col * 11 + 4, col * 11 + 9));
        const cached = [entry.texturePage, entry.texturePositionClipSpace.x, entry.texturePositionClipSpace.y,
          entry.sizeClipSpace.x, entry.sizeClipSpace.y];
        if (vertex.some((value, index) => Math.abs(value - cached[index]) > 1e-7)) stale.push({ col, vertex, cached });
      }
      return stale;
    }
    function flood(index) {
      const color = index % 16;
      let data = '\\x1b[2;1H\\x1b[38;5;' + (color < 8 ? 30 + color : 90 + color - 8) + 'm';
      for (let i = 0; i < 58; i++) data += String.fromCodePoint(0x4e00 + (index * 58 + i) % 4096);
      return data + '\\x1b[0m\\x1b[?25l';
    }
    async function sharedClear() {
      const a = create('off'), b = create('off'), state = instrument(a);
      try {
        if (state.atlas !== b.addon._renderer._charAtlas) throw new Error('Fixture terminals do not share an atlas');
        const clean = await frame(b, reset + '\\x1b[38;5;171m' + header);
        const trackedPages = state.atlas.pages.map(page => {
          const original = page.clear, result = { page, original, calls: 0 };
          page.clear = function (...args) { result.calls++; return original.apply(this, args); };
          return result;
        });
        const caches = [state.atlas._cacheMap, state.atlas._cacheMapCombined].map(cache => {
          const original = cache.clear, result = { cache, original, calls: 0 };
          cache.clear = function (...args) { result.calls++; return original.apply(this, args); };
          return result;
        });
        const beforeVersion = state.atlas.pageLayoutVersion ?? null;
        a.addon.clearTextureAtlas();
        const clearProof = {
          pagesCleared: trackedPages.filter(p => p.calls > 0).length, expectedPages: trackedPages.length,
          cacheClears: caches.reduce((sum, c) => sum + c.calls, 0),
          textureCleared: state.atlas.pages.every(page => {
            const pixels = page.ctx.getImageData(0, 0, page.canvas.width, page.canvas.height).data;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return false;
            return true;
          }),
          generationBefore: beforeVersion, generationAfter: state.atlas.pageLayoutVersion ?? null,
        };
        for (const p of trackedPages) p.page.clear = p.original;
        for (const c of caches) c.cache.clear = c.original;
        for (let i = 0; i < 128; i++) await frame(a, flood(i));
        const after = await frame(b, '\\x1b[2;1Hx\\x1b[?25l');
        return { kind: 'clear', pixelDifference: difference(clean.pixels, after.pixels),
          bufferEqual: b.term.buffer.active.getLine(0).translateToString(true) === header, clearProof };
      } finally {
        state.atlas._mergePages = state.originalMerge;
        state.glyph._bindAtlasPageTexture = state.originalBind;
        a.term.dispose(); b.term.dispose(); a.host.remove(); b.host.remove();
      }
    }
    async function transient(mode) {
      const f = create(mode), state = instrument(f), previousCap = state.atlas.constructor.maxAtlasPages;
      if (!defaultCap) state.atlas.constructor.maxAtlasPages = 4;
      const previousMerges = state.merges;
      try {
        const prefix = mode === 'software' ? '\\x1b[0m\\x1b]8;;\\x07\\x1b[H' : '';
        const blank = await frame(f, reset + ' '), letter = await frame(f, reset + 'B');
        const positivePixels = difference(blank.pixels, letter.pixels);
        const clean = await frame(f, prefix + reset + '\\x1b[38;5;171m' + header +
          (mode === 'protocol' ? '\\x1b[2;1H\\x1b[?25h' : '\\x1b[?25l'));
        const cleanCursor = cursorTrace(f);
        const transitions = [];
        for (let i = 0; i < frameLimit; i++) {
          const color = (i + (mode === 'software' ? 7 : 0)) % 16;
          let data = prefix + '\\x1b[2;1H\\x1b[38;5;' + (color < 8 ? 30 + color : 90 + color - 8) + 'm';
          for (let j = 0; j < 29; j++) data += String.fromCodePoint(0x4e00 + (i * 29 + j) % 4096);
          if (mode === 'software') data += '\\x1b[0m\\x1b[2;5H\\x1b[7mX\\x1b[27m\\x1b[2;20H';
          else data += '\\x1b[0m\\x1b[2;' + (i % 4 + 1) + 'H' + (mode === 'protocol' ? '\\x1b[?25h' : '\\x1b[?25l');
          const beforeMerge = state.merges, previousPages = state.atlas.pages.slice(), rebindStart = state.rebinds.length;
          const current = await frame(f, data);
          if (state.merges === beforeMerge) continue;
          const rebinds = state.rebinds.slice(rebindStart);
          const staleGlyphs = vertices(state, f.term.buffer.active.getLine(0));
          const staleTexturePages = state.atlas.pages.filter((page, index) => previousPages[index] !== page &&
            !rebinds.some(item => item.page === page)).map(page => ({ index: state.atlas.pages.indexOf(page),
              version: page.version, boundVersion: state.glyph._atlasTextures[state.atlas.pages.indexOf(page)]?.version ?? null }));
          const pixelDiff = differenceDetails(clean.pixels, current.pixels, f.addon._renderer._canvas.width);
          transitions.push({ frame: i, pixelDifference: pixelDiff.count,
            pixelBounds: pixelDiff.bounds, pixelSamples: pixelDiff.samples,
            cursorBefore: cleanCursor, cursorAfter: cursorTrace(f),
            bufferEqual: f.term.buffer.active.getLine(0).translateToString(true) === header,
            staleGlyphCount: staleGlyphs.length, staleGlyphs: staleGlyphs.slice(0, 2), staleTexturePages,
            atlasLayoutVersion: state.atlas.pageLayoutVersion ?? null,
            rendererLayoutVersion: state.glyph._lastAtlasLayoutVersion ?? null });
        }
        const instrumentation = f.smooth?._adapter?.instrumentation;
        const control = { installed: !!f.smooth, enabled: f.smooth?._adapter?.snapshot().enabled ?? null,
          softwareActive: instrumentation?.softwareCaret?.active === true,
          cursorDraws: instrumentation?.cursorDrawPasses ?? 0, glyphDraws: instrumentation?.glyphDrawPasses ?? 0,
          continuations: instrumentation?.continuationRequests ?? 0,
          focusSimulation: f.focusedFixture ? 'synthetic-service-focus' : 'native',
          serviceFocused: f.browserService.isFocused,
          rendererFocused: f.addon._renderer._coreBrowserService.isFocused,
          cursorHidden: f.term._core.coreService.isCursorHidden,
          cursorInitialized: f.term._core.coreService.isCursorInitialized,
          cursorInitializationFixture: f.focusedFixture,
          cursor: [f.term.buffer.active.cursorX, f.term.buffer.active.cursorY],
          blinkVisible: f.addon._renderer._cursorBlinkStateManager?.value?.isCursorVisible ?? null,
          actualHeader: f.term.buffer.active.getLine(0).translateToString(true),
          atlasPages: state.atlas.pages.length, atlasCap: state.atlas.constructor.maxAtlasPages };
        return { kind: 'transient', mode, forcedAtlasPageCap: defaultCap ? previousCap : 4,
          framesTested: frameLimit, merges: state.merges - previousMerges, positivePixels,
          pixelDifference: Math.max(0, ...transitions.map(t => t.pixelDifference)),
          staleGlyphCount: transitions.reduce((sum, t) => sum + t.staleGlyphCount, 0),
          staleTextureCount: transitions.reduce((sum, t) => sum + t.staleTexturePages.length, 0),
          bufferEqual: transitions.length > 0 && transitions.every(t => t.bufferEqual),
          transitions: transitions.filter(t => t.pixelDifference || t.staleGlyphCount || t.staleTexturePages.length).slice(0, 4),
          mergeTransitions: transitions.length, control };
      } finally {
        state.atlas.constructor.maxAtlasPages = previousCap;
        state.atlas._mergePages = state.originalMerge;
        state.glyph._bindAtlasPageTexture = state.originalBind;
        f.smooth?.dispose();
        if (f.focusedFixture) delete f.browserService.isFocused;
        f.term.dispose(); f.host.remove();
      }
    }
    try {
      results.push(await sharedClear());
      for (const mode of defaultCap ? ['off'] : ['protocol', 'software']) results.push(await transient(mode));
      const failures = [];
      for (const result of results) {
        if (result.pixelDifference || result.staleGlyphCount || result.staleTextureCount) failures.push(result);
        if (result.kind === 'clear' && (result.clearProof.pagesCleared !== result.clearProof.expectedPages ||
          result.clearProof.cacheClears !== 2 || !result.clearProof.textureCleared ||
          !(result.clearProof.generationAfter > result.clearProof.generationBefore))) failures.push(result);
        if (result.kind === 'transient' && (!(result.positivePixels > 0) || !(result.merges > 0) || !result.bufferEqual || !result.mergeTransitions)) failures.push(result);
        if (result.mode === 'protocol' && (!result.control.installed || !result.control.enabled ||
          !(result.control.cursorDraws > 0) || !(result.control.glyphDraws > 0) || !(result.control.continuations > 0))) failures.push(result);
        if (result.mode === 'software' && (!result.control.installed || !result.control.enabled || !result.control.softwareActive ||
          !(result.control.cursorDraws > 0) || !(result.control.glyphDraws > 0) || !(result.control.continuations > 0))) failures.push(result);
      }
      return { ok: failures.length === 0, defaultAtlasCap: defaultCap, dpr: devicePixelRatio,
        fontFamily: options.fontFamily, animations: _settingsConfig.animations,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        results, failures: failures.slice(0, 3) };
    } finally {
      hostTerminal.focus();
    }
  })()`);
  } finally {
    if (dpr > 0) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  check(`WebGL 图集：同帧顶点/纹理一致（${defaultAtlasCap ? '默认页数上限' : 'cap4 + 光标路径'}）`,
    report?.ok === true, JSON.stringify(report));
}
