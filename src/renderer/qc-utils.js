// ZTerm - quick command pure logic (no DOM dependency; browser global + CommonJS dual export, node:test-able)

// Filter quick commands by name/group/command content (case-insensitive)
function filterQuickCommands(commands, query) {
    const q = (query || '').toLowerCase();
    if (!q) return commands.slice();
    return commands.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.group || '').toLowerCase().includes(q) ||
        (c.command || '').toLowerCase().includes(q)
    );
}

// When the "execute trailing Enter automatically" toggle is off: strip one
// trailing newline before injection (only one — newlines inside a multi-line
// command are kept; a command without a trailing newline passes through unchanged)
function stripTrailingNewline(text) {
    return text.replace(/\n$/, '');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { filterQuickCommands, stripTrailingNewline };
}
