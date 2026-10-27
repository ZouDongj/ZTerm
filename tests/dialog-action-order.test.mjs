import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/renderer.html', import.meta.url), 'utf8');

function elementBlock(id) {
    const idAt = html.indexOf(`id="${id}"`);
    assert.notEqual(idAt, -1, `#${id} exists`);
    const start = html.lastIndexOf('<div', idAt);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    let match;
    while ((match = tags.exec(html))) {
        depth += match[0] === '</div>' ? -1 : 1;
        if (depth === 0) return html.slice(start, tags.lastIndex);
    }
    assert.fail(`#${id} has no closing tag`);
}

function actionPosition(block, marker) {
    const buttons = block.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
    const matches = buttons.filter(button => button.includes(marker));
    assert.equal(matches.length, 1, `exactly one button contains ${marker}`);
    return block.indexOf(matches[0]);
}

const dialogs = [
    ['SSH editor', 'overlay-ssh-edit', 'id="ssh-edit-save-btn"', 'class="btn-outline" onclick="closeSSHEdit()"'],
    ['quick command editor', 'overlay-qc-edit', 'onclick="saveQCEdit()"', 'class="btn-outline" onclick="closeQCEdit()"'],
    ['highlight editor', 'overlay-highlight-edit', 'onclick="saveHighlightEdit()"', 'class="btn-outline" onclick="closeHighlightEdit()"'],
    ['shared confirmation', 'overlay-confirm', 'id="confirm-ok"', 'id="confirm-cancel"'],
    ['color picker', 'color-picker-overlay', 'class="color-picker-ok"', 'class="color-picker-cancel"'],
];

for (const [name, id, primary, cancel] of dialogs) {
    test(`${name}: primary action precedes cancellation in DOM order`, () => {
        const block = elementBlock(id);
        assert.ok(actionPosition(block, primary) < actionPosition(block, cancel));
    });
}
