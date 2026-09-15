const ws = new WebSocket((await (await fetch('http://127.0.0.1:9485/json')).json()).find(t => t.url.includes('renderer.html')).webSocketDebuggerUrl);
let id = 0;
const ev = c => new Promise(r => {
  const i = ++id;
  ws.addEventListener('message', function h(e) { const m = JSON.parse(e.data); if (m.id === i) { ws.removeEventListener('message', h); r(m.result?.result?.value); } });
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: c, returnByValue: true, awaitPromise: true } })); });
ws.onopen = async () => {
  console.log(await ev(`(() => {
    const t = TabManager.tabs.find(x => x.tabId === 'ssh_2');
    if (!t || !t.term) return 'no-tab';
    const a = t._smoothCursor?._adapter;
    return JSON.stringify({
      docFocus: document.hasFocus(),
      coreFocused: t.term._core.coreBrowserService.isFocused,
      swActive: a?.instrumentation?.softwareCaret || null,
      swCursor: a?.instrumentation?.lastSoftwareCursor || null,
      cursorHidden: t.term._core.coreService.isCursorHidden,
    });
  })()`));
  // explicitly focus + re-render + re-read
  console.log('focus:', await ev(`TabManager.tabs.find(x => x.tabId === 'ssh_2')?.term?.focus?.(); document.activeElement?.className || document.activeElement?.tagName`));
  await new Promise(r => setTimeout(r, 300));
  console.log(await ev(`(() => {
    const t = TabManager.tabs.find(x => x.tabId === 'ssh_2');
    const a = t._smoothCursor?._adapter;
    return JSON.stringify({ coreFocused: t.term._core.coreBrowserService.isFocused, swCursor: a.instrumentation.lastSoftwareCursor, sw: a.instrumentation.softwareCaret });
  })()`));
  process.exit(0);
};
setTimeout(() => process.exit(1), 15000);
