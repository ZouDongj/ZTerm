// ZTerm - inline SVG icon registry (browser global + CommonJS dual export, node:test friendly)
//
// WHY THIS EXISTS
// ---------------
// Text/emoji glyphs (⊞ ⚡ ⚙ 📁 ...) rendered inconsistently across font stacks
// and showed up as tofu boxes on some systems. Every UI icon is therefore an
// inline SVG built from this registry: 24x24 Lucide-style path data, stroked
// with currentColor so icons inherit the surrounding text color tier.
(function installIcons(root) {
  'use strict';

  // name -> inner SVG markup (Lucide-style paths, 24x24 viewBox)
  const ICONS = {
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    'folder-plus': '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    'arrow-up': '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    'arrow-down': '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
    key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'rotate-cw': '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    // Neutral outline server (SSH connections) — replaces the old yellow block
    server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M7.5 6.5h.01M7.5 17.5h.01M12 6.5h5M12 17.5h5"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    // Row-trailing "open" indicator for the session selector
    'enter-arrow': '<path d="M19 5v9H5m4-4-4 4 4 4"/>',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    // Collected from the hand-written inline SVGs that used to duplicate
    // these shapes (menu popup, overlays, search fields, SFTP header, dock rows)
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-6 0v4.76z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    // Top-right menu button (three dots), collected from tabs.js
    'more-vertical': '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
    // Window controls (minus/square + the existing x; restore reuses copy's
    // overlapping rectangles). The minus dash is longer than stock Lucide
    // (M4..20 vs M5..19): window-control glyphs need the optical weight of
    // the native caption buttons, not icon-grid proportions.
    minus: '<path d="M4 12h16"/>',
    square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  };

  // Solid (filled) variants on the same 24x24 grid: Material-style paths for
  // glyphs that must stay legible at small row sizes (SFTP listing rows, dock
  // toggle). Rendered with fill="currentColor" and no stroke.
  const FILLED_ICONS = {
    'folder-filled': '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
    'file-filled': '<path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/>',
  };

  // Filled two-tone glyphs for objects (terminals, hosts, folders, files,
  // settings, search): the base shape carries the accent and the inner
  // details are drawn in the same currentColor at low alpha, so they read as
  // darker grooves on dark chrome without hardcoding a background colour.
  // Thin-line glyphs stay for micro controls (chevrons, close, + at 11px).
  const DUOTONE_ICONS = {
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3" opacity=".9"/>' +
      '<path d="M7.6 9 10.8 12l-3.2 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/>' +
      '<path d="M12.6 15h4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" opacity=".28"/>',
    settings: ICONS.settings,
    folder: ICONS.folder +
      '<path d="M3 9h18" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".22"/>',
    file: ICONS.file +
      '<path d="M14 2v4a2 2 0 0 0 2 2h4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".24"/>',
    search: '<circle cx="11" cy="11" r="8" opacity=".9"/>' +
      '<circle cx="11" cy="11" r="3.6" opacity=".28"/>' +
      '<path d="m21 21-4.35-4.35" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".9"/>',
    plus: '<rect x="10.5" y="4" width="3" height="16" rx="1.5" opacity=".9"/>' +
      '<rect x="4" y="10.5" width="16" height="3" rx="1.5" opacity=".55"/>',
    palette: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2Z" opacity=".9"/>' +
      '<circle cx="7.6" cy="9.6" r="1.2" opacity=".26"/><circle cx="10.6" cy="6.6" r="1.2" opacity=".26"/><circle cx="15.2" cy="6.9" r="1.2" opacity=".26"/><circle cx="18.1" cy="10.2" r="1.2" opacity=".26"/>',
    highlighter: '<path d="M15.6 3.4a2.1 2.1 0 0 1 3 3L8.1 16.9 4 18l1.1-4.1L15.6 3.4Z" opacity=".9"/>' +
      '<path d="M4 21h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".22"/>',
    keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5" opacity=".9"/>' +
      '<rect x="5.5" y="8" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="8.5" y="8" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="11.5" y="8" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="14.5" y="8" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="17.5" y="8" width="2" height="1.6" rx=".5" opacity=".26"/>' +
      '<rect x="5.5" y="11.2" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="8.5" y="11.2" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="11.5" y="11.2" width="2" height="1.6" rx=".5" opacity=".26"/><rect x="14.5" y="11.2" width="2" height="1.6" rx=".5" opacity=".26"/>' +
      '<rect x="7" y="14.4" width="10" height="1.6" rx=".8" opacity=".26"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" opacity=".9"/>',
    server: '<rect x="2.6" y="3.4" width="18.8" height="4.6" rx="1.6" opacity=".92"/>' +
      '<rect x="2.6" y="9.7" width="18.8" height="4.6" rx="1.6" opacity=".7"/>' +
      '<rect x="2.6" y="16" width="18.8" height="4.6" rx="1.6" opacity=".5"/>' +
      '<circle cx="5.8" cy="5.7" r=".9" opacity=".28"/>' +
      '<circle cx="5.8" cy="12" r=".9" opacity=".24"/>' +
      '<circle cx="5.8" cy="18.3" r=".9" opacity=".2"/>' +
      '<rect x="9" y="5.2" width="8" height="1" rx=".5" opacity=".28"/>' +
      '<rect x="9" y="11.5" width="8" height="1" rx=".5" opacity=".24"/>' +
      '<rect x="9" y="17.8" width="8" height="1" rx=".5" opacity=".2"/>',
  };

  // Build an inline SVG string for `name` at `size` px. Stroked entries match
  // the hand-written inline SVGs in renderer.html (24x24 viewBox, fill="none",
  // stroke="currentColor"); entries in FILLED_ICONS render solid with
  // fill="currentColor" and stroke="none". Object glyphs in DUOTONE_ICONS use
  // the filled treatment from 14px up; below that the line version stays
  // legible. Unknown names return '' so callers can embed the result directly
  // without breaking markup.
  // A few glyphs carry too much interior detail to survive a filled rendering
  // at the 14px tab-strip size; they switch to duotone one step later.
  const DUOTONE_MIN = { settings: 16 };

  function iconSvg(name, size = 14) {
    const duo = DUOTONE_ICONS[name];
    if (duo && size >= (DUOTONE_MIN[name] || 14)) {
      return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" stroke="none">' + duo + '</svg>';
    }
    const filled = FILLED_ICONS[name];
    if (filled) {
      return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" stroke="none">' + filled + '</svg>';
    }
    const body = ICONS[name];
    if (!body) return '';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

  const api = { iconSvg, ICONS, FILLED_ICONS, DUOTONE_ICONS };
  root.Icons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
