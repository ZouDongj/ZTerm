// win32-input-mode serialization tests (ADR-0002 item: local Ctrl+J).
// The wire format is pinned against Microsoft's own source:
//   encode:  terminal/src/terminal/input/terminalInput.cpp::_makeWin32Output
//   decode:  terminal/src/terminal/parser/InputStateMachineEngine.cpp::_GenerateWin32Key
//   request: terminal/src/host/VtIo.cpp (conhost sends CSI ? 9001 h on ConPTY
//            session bring-up)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const w32 = require('../src/renderer/win32-input.js');
const { createConPtyCaretFilter } = require('../src/renderer/conpty-caret.js');

const ESC = "\u001b";

test('encodeWin32Key matches the conhost wire format (CSI Vk;Sc;Uc;Kd;Cs;Rc _)', () => {
  assert.equal(w32.encodeWin32Key(0x4a, 0x24, 0x0a, 1, 0x08, 1), `${ESC}[74;36;10;1;8;1_`);
  assert.equal(w32.encodeWin32Key(0x0d, 0x1c, 0x0d, 0, 0x00, 1), `${ESC}[13;28;13;0;0;1_`);
  // Omitted repeat count defaults to 1.
  assert.equal(w32.encodeWin32Key(0x41, 0x1e, 0x61, 1, 0x00), `${ESC}[65;30;97;1;0;1_`);
});

test('ctrlJSequence is exactly what Windows Terminal sends for Ctrl+J (down+up)', () => {
  assert.equal(w32.ctrlJSequence(), `${ESC}[74;36;10;1;8;1_${ESC}[74;36;10;0;8;1_`);
});

test('isCtrlJ accepts only bare Ctrl+J', () => {
  assert.equal(w32.isCtrlJ({ ctrlKey: true, key: 'j' }), true);
  assert.equal(w32.isCtrlJ({ ctrlKey: true, keyCode: 74 }), true);
  assert.equal(w32.isCtrlJ({ ctrlKey: true, shiftKey: true, key: 'J' }), false, 'shift = distinct key');
  assert.equal(w32.isCtrlJ({ ctrlKey: true, altKey: true, key: 'j' }), false);
  assert.equal(w32.isCtrlJ({ ctrlKey: true, metaKey: true, key: 'j' }), false);
  assert.equal(w32.isCtrlJ({ key: 'j' }), false, 'no ctrl');
  assert.equal(w32.isCtrlJ({ ctrlKey: true, key: 'k' }), false);
  assert.equal(w32.isCtrlJ(null), false);
  assert.equal(w32.isCtrlJ(undefined), false);
});

test('the caret filter flags the session when conhost requests win32-input-mode', () => {
  let fired = 0;
  const f = createConPtyCaretFilter({ mode: 'fix', onWin32InputMode: () => { fired += 1; } });
  assert.equal(f.state().win32Input, false);
  const out = f.push(`${ESC}[c${ESC}[?1004h${ESC}[?9001h`);
  assert.equal(f.state().win32Input, true, 'request observed');
  assert.equal(fired, 1, 'callback fired exactly once');
  assert.ok(out.includes(`${ESC}[?9001h`), 'request passes through to xterm');
  // Idempotent: a repeat (e.g. after RIS) must not re-fire.
  f.push(`${ESC}[?9001h`);
  assert.equal(fired, 1);
  // Split across chunks still detects.
  const g = createConPtyCaretFilter({ mode: 'fix' });
  g.push(`${ESC}[?90`);
  assert.equal(g.state().win32Input, false, 'incomplete sequence held back');
  g.push('01h');
  assert.equal(g.state().win32Input, true, 'reassembled across chunks');
});

test('win32 detection does not interfere with the DA1 handshake or hides', () => {
  let da1 = 0;
  const f = createConPtyCaretFilter({ mode: 'fix', onDa1Query: () => { da1 += 1; } });
  const out = f.push(`${ESC}[c${ESC}[?9001h${ESC}[?25l`);
  assert.equal(da1, 1, 'first DA1 still swallowed + answered');
  assert.equal(f.state().win32Input, true);
  assert.equal(f.state().visible, false, 'hide still tracked');
  assert.ok(out.includes(`${ESC}[?25l`), 'hide forwarded');
});

test('session gate: markGated/isGated keyed by backend session id', () => {
  assert.equal(w32.isGated('gate-test_a'), false, 'unknown id is not gated');
  w32.markGated('gate-test_a');
  assert.equal(w32.isGated('gate-test_a'), true);
  assert.equal(w32.isGated('gate-test_b'), false, 'other ids unaffected');
  w32.markGated('gate-test_a');
  assert.equal(w32.isGated('gate-test_a'), true, 'idempotent re-mark');
  w32.markGated(null);
  w32.markGated(undefined);
  w32.markGated('');
  assert.equal(w32.isGated(null), false, 'falsy ids never enter the gate');
  assert.equal(w32.isGated(''), false);
});
