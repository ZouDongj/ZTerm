// ZTerm - font-stack governance (N1 Phase 1): Nerd Font NON-Mono variants
// rasterize their icon glyphs at 1.19-1.88x the cell width and the WebGL atlas
// paints that ink unclipped (right-neighbor overprint, or truncation at
// background boundaries). The pure resolver below rewrites a fontFamily chain
// so Nerd Font references land on the Mono variant (icons constrained to one
// cell) whenever that variant is installed; it never reorders the user's
// explicit non-NF families and never drops entries. The module also owns the
// shared system-font enumeration cache used by both terminal init and the
// settings font pickers.
// No DOM dependency at load time; browser global + CommonJS dual export,
// node:test-able (same pattern as color-utils.js).

// Nerd Fonts publish three width variants per family:
//   shorthand:  'X NF' (proportional icons) / 'X NFM' (Mono) / 'X NFP' (Propo)
//   long forms: 'X Nerd Font' / 'X Nerd Font Mono' / 'X Nerd Font Propo'
// Classify returns 'mono' | 'nonmono' | null (not a Nerd Font reference).
function _classifyNfFamily(name) {
    if (/ nerd font mono$/i.test(name)) return 'mono';
    if (/ nfm$/i.test(name)) return 'mono';
    if (/ nerd font propo$/i.test(name)) return 'nonmono';
    if (/ nerd font$/i.test(name)) return 'nonmono';
    if (/ nfp$/i.test(name)) return 'nonmono';
    if (/ nf$/i.test(name)) return 'nonmono';
    return null;
}

// 'JetBrainsMonoNL NF' / 'JetBrainsMonoNL Nerd Font' / 'X NFP' -> the shared
// stem ('JetBrainsMonoNL' / 'X') the Mono candidate names are derived from.
function _nfStem(name) {
    return name.replace(/ (?:nerd font(?: mono| propo)?|nf[mp]?)$/i, '');
}

function _unquoteFontName(token) {
    const t = (token || '').trim();
    if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
        return t.slice(1, -1);
    }
    return t;
}

// Re-emit a swapped family in the original token's quoting style; an unquoted
// source token gets double quotes (NF family names always contain spaces).
function _requoteLike(token, name) {
    const t = token.trim();
    if (t[0] === "'") return "'" + name + "'";
    return '"' + name + '"';
}

function _findInstalledFont(installed, name) {
    const n = name.toLowerCase();
    for (const f of installed) {
        if (f.trim().toLowerCase() === n) return f.trim();
    }
    return null;
}

function _nfMonoCandidates(name) {
    const stem = _nfStem(name);
    // Both naming forms are tried regardless of the source form: which of the
    // two a Nerd Fonts release ships under varies by family and version.
    return [stem + ' NFM', stem + ' Nerd Font Mono'];
}

// Given a CSS font-family chain string and the list of installed families,
// return the governed chain:
// - each non-Mono NF family whose Mono counterpart is installed (exact,
//   case-insensitive match against the installed list, both the 'NFM' and the
//   'Nerd Font Mono' form) is swapped for that counterpart; one without an
//   installed counterpart stays as-is;
// - when the chain references no Nerd Font family at all and at least one NF
//   Mono family is installed, the first installed NF Mono family is appended
//   just before the final 'monospace' generic fallback (at the end when the
//   chain has no such fallback);
// - otherwise the chain is returned verbatim (idempotent: resolving a
//   governed chain returns it unchanged).
function governTerminalFontChain(chain, installedFamilies) {
    if (typeof chain !== 'string' || !chain.trim()) return chain;
    const installed = Array.isArray(installedFamilies) ? installedFamilies.filter(f => typeof f === 'string') : [];
    const parts = chain.split(',').map(p => p.trim()).filter(Boolean);
    let changed = false;
    let hasNf = false;
    const out = parts.map(token => {
        const kind = _classifyNfFamily(_unquoteFontName(token));
        if (!kind) return token;
        hasNf = true;
        if (kind === 'mono') return token;
        for (const cand of _nfMonoCandidates(_unquoteFontName(token))) {
            const hit = _findInstalledFont(installed, cand);
            if (hit) {
                changed = true;
                return _requoteLike(token, hit);
            }
        }
        return token;
    });
    if (!hasNf) {
        const monoInstalled = installed.filter(f => _classifyNfFamily(_unquoteFontName(f)) === 'mono');
        if (monoInstalled.length) {
            // Insert before the FINAL generic fallback: an earlier slot would
            // hijack glyphs (e.g. CJK) from the user's explicit fallbacks.
            let idx = -1;
            for (let i = out.length - 1; i >= 0; i--) {
                if (_unquoteFontName(out[i]).toLowerCase() === 'monospace') { idx = i; break; }
            }
            const entry = '"' + monoInstalled[0].trim() + '"';
            if (idx >= 0) out.splice(idx, 0, entry);
            else out.push(entry);
            changed = true;
        }
    }
    return changed ? out.join(', ') : chain;
}

// Settings hint predicate: given the terminal-font field value (a select value
// like "'JetBrainsMonoNL NF',monospace" or a bare family name), return the
// installed Mono counterpart when the CHOSEN (first) family is a non-Mono NF
// variant; null otherwise (no hint).
function suggestNfMonoCounterpart(fontFieldValue, installedFamilies) {
    const installed = Array.isArray(installedFamilies) ? installedFamilies.filter(f => typeof f === 'string') : [];
    const first = _unquoteFontName(String(fontFieldValue || '').split(',')[0]);
    if (_classifyNfFamily(first) !== 'nonmono') return null;
    for (const cand of _nfMonoCandidates(first)) {
        const hit = _findInstalledFont(installed, cand);
        if (hit) return hit;
    }
    return null;
}

// ── Shared system-font enumeration (renderer-only) ──
// Font lists barely change while the app runs; cache them so terminal init and
// each settings visit share one enumeration instead of re-invoking the backend
// (fontmanager-redux) and rebuilding thousands of <option> nodes. The cache is
// null until the first enumeration resolves, so peekSystemFonts() doubles as
// the "is the list known yet" signal for the terminal-create hot path.
let _systemFontsCache = null;
// The terminal-init kick and the settings paths can race the first
// enumeration; share one in-flight invocation so they cannot double-fetch.
let _systemFontsPromise = null;

// The JetBrainsMonoNL Nerd Font Mono faces vendored under src/assets/fonts/
// are registered as document fonts at startup (main.js), so from the
// renderer's perspective this family is always available even when the OS
// has no Nerd Font Mono installed. Reporting it alongside the real
// enumeration lets the governance resolver pick the Mono swap on such
// machines; the name must match the @font-face registration exactly (it is
// also the first Mono candidate _nfMonoCandidates derives for the default
// 'JetBrainsMonoNL NF' chain, and the legacy family name inside the TTFs).
const BUNDLED_NF_MONO_FAMILY = 'JetBrainsMonoNL NFM';

function peekSystemFonts() {
    return _systemFontsCache;
}

// Returns a Promise of the family-name array ('monospace' fallback when the
// enumeration comes back empty), or null on failure. A failure resets the
// promise so the next caller retries instead of latching a rejection forever.
// The bundled NF Mono family is appended when the OS enumeration lacks it —
// it is renderable via the vendored document fonts, so hiding it from the
// resolver would leave clean machines on the ungoverned chain.
function getSystemFonts() {
    if (_systemFontsCache) return Promise.resolve(_systemFontsCache);
    if (!_systemFontsPromise) {
        _systemFontsPromise = ipcRenderer.invoke('get-system-fonts').then(fonts => {
            const list = fonts && fonts.length > 0 ? fonts.slice() : ['monospace'];
            if (!_findInstalledFont(list, BUNDLED_NF_MONO_FAMILY)) list.push(BUNDLED_NF_MONO_FAMILY);
            _systemFontsCache = list;
            return _systemFontsCache;
        }, () => {
            _systemFontsPromise = null;
            return null;
        });
    }
    return _systemFontsPromise;
}

// Convenience wrapper for the terminal font chain: resolve through the
// governance rules when the enumeration cache is warm, pass through unchanged
// when it is not (the first terminal created at startup; the governance kick
// in terminal.js re-applies the governed chain once the list arrives).
function governTerminalFontFamily(normalizedChain) {
    const installed = peekSystemFonts();
    return installed ? governTerminalFontChain(normalizedChain, installed) : normalizedChain;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { governTerminalFontChain, suggestNfMonoCounterpart, peekSystemFonts, getSystemFonts, governTerminalFontFamily, BUNDLED_NF_MONO_FAMILY };
}
