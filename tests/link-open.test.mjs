// tests for src/renderer/link-open.js (ADR-0003): pure gesture/scheme gate
// plus the browser glue seam (stubbed document/showConfirm/showToast/ipcRenderer).
import test from 'node:test';
import assert from 'node:assert/strict';

// The glue installs only when a document global exists — stub the browser
// surface BEFORE importing the module (the IIFE runs at import time).
globalThis.document = {};
const calls = { toast: [], confirm: [], open: [] };
let confirmOk = null;
globalThis.showToast = (msg, isError) => calls.toast.push({ msg, isError });
globalThis.showConfirm = (msg, onOk, okText) => { calls.confirm.push({ msg, okText }); confirmOk = onOk; };
globalThis.ipcRenderer = {
    invoke: (cmd, args) => { calls.open.push({ cmd, args }); return Promise.resolve({ ok: true }); },
};

await import('../src/renderer/link-open.js');
const LinkOpen = globalThis.LinkOpen;

const ctrlClick = { button: 0, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };

test('gesture: bare Ctrl + primary button only', () => {
    assert.equal(LinkOpen.isAllowedLinkGesture(ctrlClick), true);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, ctrlKey: false }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, button: 2 }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, button: 1 }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, altKey: true }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, metaKey: true }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture({ ...ctrlClick, shiftKey: true }), false);
    assert.equal(LinkOpen.isAllowedLinkGesture(null), false);
    assert.equal(LinkOpen.isAllowedLinkGesture(undefined), false);
});

test('classify: http/https pre-check, everything else rejected', () => {
    assert.equal(LinkOpen.classifyLinkTarget('https://example.com/x'), 'https');
    assert.equal(LinkOpen.classifyLinkTarget('http://192.0.2.1:8080'), 'http');
    assert.equal(LinkOpen.classifyLinkTarget('HTTPS://EXAMPLE.COM'), 'https');
    assert.equal(LinkOpen.classifyLinkTarget('ftp://example.com'), 'other');
    assert.equal(LinkOpen.classifyLinkTarget('mailto:a@b.c'), 'other');
    assert.equal(LinkOpen.classifyLinkTarget('file:///C:/x'), 'other');
    assert.equal(LinkOpen.classifyLinkTarget('javascript:alert(1)'), 'other');
    assert.equal(LinkOpen.classifyLinkTarget(''), 'other');
    assert.equal(LinkOpen.classifyLinkTarget(null), 'other');
    assert.equal(LinkOpen.classifyLinkTarget('https://'), 'https'); // backend rejects empty host
});

test('activate: wrong gesture never reaches IPC or UI', () => {
    const n = calls.open.length + calls.confirm.length + calls.toast.length;
    LinkOpen.handleLinkActivate({ ...ctrlClick, ctrlKey: false }, 'https://example.com');
    LinkOpen.handleLinkActivate({ ...ctrlClick, shiftKey: true }, 'https://example.com', { osc8: true });
    assert.equal(calls.open.length + calls.confirm.length + calls.toast.length, n);
});

test('activate: plain http(s) link opens directly via open-url IPC', async () => {
    const before = calls.open.length;
    LinkOpen.handleLinkActivate(ctrlClick, 'https://example.com/a?b=c');
    assert.equal(calls.open.length, before + 1);
    assert.deepEqual(calls.open[calls.open.length - 1], { cmd: 'open-url', args: { url: 'https://example.com/a?b=c' } });
    assert.equal(calls.confirm.length, 0);
    await Promise.resolve(); // success path: no error toast
    assert.equal(calls.toast.length, 0);
});

test('activate: OSC 8 link confirms with the real target, opens only on OK', () => {
    const openBefore = calls.open.length;
    LinkOpen.handleLinkActivate(ctrlClick, 'https://osc8.example/real-target', { osc8: true });
    assert.equal(calls.confirm.length, 1);
    assert.match(calls.confirm[0].msg, /osc8\.example\/real-target/);
    assert.equal(calls.confirm[0].okText, '打开');
    assert.equal(calls.open.length, openBefore); // cancel path: nothing opened
    confirmOk(); // user confirms
    assert.equal(calls.open.length, openBefore + 1);
    assert.equal(calls.open[calls.open.length - 1].args.url, 'https://osc8.example/real-target');
});

test('activate: consumption is gated on TUI mouse-reporting mode', () => {
    let prevented = 0, stopped = 0;
    const spy = () => ({ ...ctrlClick, preventDefault: () => prevented++, stopPropagation: () => stopped++ });
    const tuiTerm = { modes: { mouseTrackingMode: 'x10' } };
    const plainTerm = { modes: { mouseTrackingMode: 'none' } };
    // TUI mode: the click we open is consumed so the remote app does not
    // also receive the mouseup half.
    LinkOpen.handleLinkActivate(spy(), 'https://consume.example', { term: tuiTerm });
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    // Normal mode: no remote to protect, and the document-level mouseup runs
    // xterm's selection cleanup — the event must flow through.
    LinkOpen.handleLinkActivate(spy(), 'https://consume.example', { term: plainTerm });
    LinkOpen.handleLinkActivate(spy(), 'https://consume.example');
    assert.equal(prevented, 1, 'normal mode must not consume');
    assert.equal(stopped, 1, 'normal mode must not consume');
    // Wrong gesture never consumes, even in TUI mode.
    LinkOpen.handleLinkActivate({ ...spy(), ctrlKey: false }, 'https://consume.example', { term: tuiTerm });
    assert.equal(prevented, 1, 'wrong gesture must not consume');
    assert.equal(stopped, 1, 'wrong gesture must not consume');
});

test('activate: OSC 8 confirm shows host and normalized target', () => {
    LinkOpen.handleLinkActivate(ctrlClick, 'HTTPS://OSC8.EXAMPLE:443/x', { osc8: true });
    const msg = calls.confirm[calls.confirm.length - 1].msg;
    assert.match(msg, /主机：osc8\.example/);
    assert.match(msg, /完整地址：https:\/\/osc8\.example\/x/);
});

test('activate: non-http(s) target is blocked with one error toast', () => {
    const openBefore = calls.open.length, toastBefore = calls.toast.length;
    LinkOpen.handleLinkActivate(ctrlClick, 'file:///etc/passwd');
    assert.equal(calls.open.length, openBefore);
    assert.equal(calls.toast.length, toastBefore + 1);
    assert.equal(calls.toast[calls.toast.length - 1].isError, true);
});

test('invoke: backend {ok:false} and IPC rejection both surface one toast', async () => {
    const toastBefore = calls.toast.length;
    globalThis.ipcRenderer.invoke = () => Promise.resolve({ ok: false, error: 'blockedProtocol' });
    LinkOpen.invokeOpenUrl('https://x.example');
    await Promise.resolve(); await Promise.resolve();
    globalThis.ipcRenderer.invoke = () => Promise.reject(new Error('osOpenFailed'));
    LinkOpen.invokeOpenUrl('https://x.example');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls.toast.length, toastBefore + 2);
    assert.match(calls.toast[calls.toast.length - 2].msg, /blockedProtocol/);
    assert.match(calls.toast[calls.toast.length - 1].msg, /osOpenFailed/);
});
