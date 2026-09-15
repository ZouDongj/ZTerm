// Set window.__go on the B2 visual probe (port 9485).
const ws = new WebSocket((await (await fetch('http://127.0.0.1:9485/json')).json()).find(t => t.url.includes('renderer.html')).webSocketDebuggerUrl);
ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__go = true; document.hasFocus()' , returnByValue: true } })); };
ws.onmessage = ev => { console.log('go-set:', ev.data.slice(0, 200)); process.exit(0); };
setTimeout(() => { console.log('timeout'); process.exit(1); }, 8000);
