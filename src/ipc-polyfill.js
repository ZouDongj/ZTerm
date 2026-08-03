// ZTerm -> Tauri 2 ipcRenderer 兼容层
// 用 IIFE 包裹, 不污染全局作用域
// 使用 window.__TAURI__ (withGlobalTauri: true 自动注入, 同步可用)
// 不需要 async import, 避免 404 / 竞态问题

(function() {
  // 等待 window.__TAURI__ 就绪 (Tauri 注入可能比 polyfill 稍晚)
  function getTauri() {
    if (window.__TAURI__) return window.__TAURI__;
    // 兜底: __TAURI_INTERNALS__ 始终存在, 但只有 invoke (没 listen)
    return null;
  }

  // Tauri 2 使用 Rust 函数名（snake_case），polyfill 收到 Electron IPC 是 kebab-case
  // 转换: get-profiles → get_profiles, pty-create → pty_create 等
  function kebabToSnake(cmd) {
    return cmd.replace(/-/g, '_');
  }

  // invoke: 优先用 __TAURI__.core.invoke, 兜底 __TAURI_INTERNALS__.invoke
  function doInvoke(cmd, args) {
    var tauriCmd = kebabToSnake(cmd);
    var t = getTauri();
    if (t && t.core && t.core.invoke) return t.core.invoke(tauriCmd, args);
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(tauriCmd, args);
    }
    return Promise.reject(new Error('Tauri invoke not available'));
  }

  // listen: 用 __TAURI__.event.listen
  function doListen(channel, handler) {
    var t = getTauri();
    if (t && t.event && t.event.listen) return t.event.listen(channel, handler);
    return Promise.resolve(function() {});
  }

  // 事件队列: on() 可能在 __TAURI__ 注入前调用, 先入队
  var eventQueue = new Map();
  var flushed = false;

  function flushQueue() {
    if (flushed) return;
    if (!getTauri()) return;
    flushed = true;
    console.log('[ipc-polyfill] __TAURI__ ready, flushing', eventQueue.size, 'channels');
    for (var channel of eventQueue.keys()) {
      var list = eventQueue.get(channel);
      doListen(channel, function(event) {
        var current = eventQueue.get(channel) || [];
        var remaining = [];
        for (var i = 0; i < current.length; i++) {
          try { current[i].callback({}, event.payload); } catch (e) { console.error('[ipc-polyfill] cb', channel, e); }
          if (!current[i].once) remaining.push(current[i]);
        }
        eventQueue.set(channel, remaining);
      });
    }
  }

  var ipcRenderer = {
    on: function(channel, callback) {
      if (getTauri()) {
        return doListen(channel, function(event) {
          try { callback({}, event.payload); } catch (e) { console.error('[ipc-polyfill] on', channel, e); }
        });
      }
      if (!eventQueue.has(channel)) eventQueue.set(channel, []);
      eventQueue.get(channel).push({ callback: callback, once: false });
      return Promise.resolve(function() {});
    },

    once: function(channel, callback) {
      if (getTauri()) {
        var unlisten = null;
        doListen(channel, function(event) {
          try { callback({}, event.payload); } catch (e) { console.error(e); }
          if (unlisten) unlisten();
        }).then(function(u) { unlisten = u; });
        return Promise.resolve(function() { if (unlisten) unlisten(); });
      }
      if (!eventQueue.has(channel)) eventQueue.set(channel, []);
      eventQueue.get(channel).push({ callback: callback, once: true });
      return Promise.resolve(function() {});
    },

    send: function(channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      // 始终传 { args: [...] } — Tauri 2 忽略函数不需要的字段
      doInvoke(channel, { args: args }).catch(function(e) {
        console.error('[ipc-polyfill] send', channel, e);
      });
    },

    invoke: function(channel) {
      var extraArgs = Array.prototype.slice.call(arguments, 1);
      return doInvoke(channel, { args: extraArgs });
    },
  };

  window.electron = { ipcRenderer: ipcRenderer };
  console.log('[ipc-polyfill] installed, __TAURI__ ' + (getTauri() ? 'ready' : 'pending'));

  // 轮询等待 __TAURI__ 注入 (Tauri 的 withGlobalTauri 用 initialization script 注入, 可能稍晚)
  if (!getTauri()) {
    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      if (getTauri()) {
        clearInterval(timer);
        flushQueue();
      } else if (attempts > 100) {
        clearInterval(timer);
        console.error('[ipc-polyfill] __TAURI__ not available after 10s');
      }
    }, 100);
  } else {
    flushQueue();
  }
})();
