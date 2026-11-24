import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer/shortcuts.js', import.meta.url), 'utf8');
const match = source.match(/function _friendlyUpdateError\(raw\) \{[\s\S]*?\n\}/);
assert.ok(match, 'exercise the actual update error mapper');
const context = vm.createContext({});
vm.runInContext(match[0], context);

test('unsupported TLS proxy guidance distinguishes proxy transport from HTTPS targets', () => {
    const message = context._friendlyUpdateError("invalid update proxy 'https://proxy.fixture:443': TLS-to-proxy is not supported");
    assert.match(message, /暂不支持 HTTPS 代理/);
    assert.match(message, /HTTP 代理端点/);
    assert.match(message, /仍可访问 HTTPS 更新地址/);
});

test('explicit invalid proxy errors direct the user to the configured setting', () => {
    const message = context._friendlyUpdateError("invalid update proxy 'not a url': invalid host");
    assert.match(message, /仅支持 HTTP 代理/);
    assert.match(message, /设置 → 关于/);
    assert.match(message, /not a url/);
});

test('environment proxy errors name the variable instead of the blank setting', () => {
    const message = context._friendlyUpdateError("invalid update proxy environment HTTPS_PROXY 'not a url': invalid host");
    assert.match(message, /环境变量 HTTPS_PROXY/);
    assert.match(message, /修正或清除该环境变量/);
    assert.doesNotMatch(message, /设置 → 关于/);
    assert.match(message, /not a url/);
});

test('ordinary connection failures retain their existing network guidance', () => {
    const message = context._friendlyUpdateError('[connect] synthetic unreachable endpoint');
    assert.match(message, /无法连接更新服务器/);
    assert.match(message, /synthetic unreachable endpoint/);
});

test('rate-limit retry_in becomes an approximate minutes hint', () => {
    const message = context._friendlyUpdateError('update check failed rate-limit: retry_in=125');
    assert.match(message, /请求过于频繁/);
    assert.match(message, /约 3 分钟后重试/);
    assert.match(message, /rate-limit: retry_in=125/);
});

test('rate-limit reset_at becomes a local clock hint', () => {
    const reset = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
    const message = context._friendlyUpdateError(`update check failed rate-limit: reset_at=${reset}`);
    assert.match(message, /请求过于频繁/);
    assert.match(message, /约 \d+ 分钟后（\d{2}:\d{2}）重试/);
    assert.match(message, new RegExp(`reset_at=${reset}`));
});

test('rate-limit without a time hint still guides the user to retry', () => {
    const message = context._friendlyUpdateError('update check failed rate-limit: unspecified');
    assert.match(message, /请求过于频繁/);
    assert.match(message, /请稍后重试/);
    assert.doesNotMatch(message, /更新服务器返回错误/);
});

test('out-of-range rate-limit hints fall back to generic retry guidance', () => {
    const farFuture = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
    const byReset = context._friendlyUpdateError(`update check failed rate-limit: reset_at=${farFuture}`);
    assert.match(byReset, /请稍后重试/);
    assert.doesNotMatch(byReset, /约 \d+ 分钟/);

    const byRetry = context._friendlyUpdateError('update check failed rate-limit: retry_in=999999');
    assert.match(byRetry, /请稍后重试/);
    assert.doesNotMatch(byRetry, /约 \d+ 分钟/);
});

test('proxy validation errors take precedence over a rate-limit substring', () => {
    const message = context._friendlyUpdateError("invalid update proxy 'http://rate-limit: retry_in=60': invalid host");
    assert.match(message, /仅支持 HTTP 代理/);
    assert.doesNotMatch(message, /请求过于频繁/);
});

test('prerelease feed and API fallback connect errors keep connection guidance', () => {
    const bothConnect = context._friendlyUpdateError(
        'update check failed: releases feed [connect] WinHttpSendRequest: 0x80072EFD; API [connect]: WinHttpSendRequest: 0x80072EFD'
    );
    assert.match(bothConnect, /无法连接更新服务器/);
    assert.match(bothConnect, /\[connect\]/);

    const feedHttpThenApiConnect = context._friendlyUpdateError(
        'update check failed: releases feed HTTP status 502; API [connect]: connection refused'
    );
    assert.match(feedHttpThenApiConnect, /无法连接更新服务器/);
    assert.doesNotMatch(feedHttpThenApiConnect, /更新服务器返回错误/);
});

test('_syncUpdateCardFromState restores prerelease tag/URL and sanitizes invalid st.tag', async () => {
    const utilsSource = readFileSync(new URL('../src/renderer/update-utils.js', import.meta.url), 'utf8');
    const startMarker = '// ── In-app update download (about page state machine) ──';
    const endMarker = '// Update check (about page): check -> download -> ready -> restart & install.';
    const startIdx = source.indexOf(startMarker);
    const endIdx = source.indexOf(endMarker);
    assert.ok(startIdx >= 0 && endIdx > startIdx, 'extract real update card state machine from shortcuts.js');

    const makeEl = () => ({ textContent: '', style: { display: 'none', color: '' }, disabled: false, offsetParent: {}, querySelector: () => ({ textContent: '' }) });
    const elements = {
        'update-check-desc': makeEl(),
        'btn-update-download': makeEl(),
        'btn-update-apply': makeEl(),
        'btn-check-update': makeEl(),
        'update-release-notes': makeEl(),
    };
    const notesLink = { textContent: '' };
    elements['update-release-notes'].querySelector = () => notesLink;

    let currentState = null;
    const win = { __updateUrl: null, __updateTag: null };
    const cardCtx = vm.createContext({
        window: win,
        document: { getElementById: (id) => elements[id] || null },
        ipcRenderer: { invoke: async (cmd) => (cmd === 'update-download-state' ? currentState : null) },
        showToast: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
        URL,
    });
    vm.runInContext(utilsSource, cardCtx);
    vm.runInContext(source.slice(startIdx, endIdx), cardCtx);

    // Failed prerelease download: restores tag and exact release tag URL on reopen.
    currentState = { phase: 'failed', tag: 'v1.2.5-dev.4', error: '[connect] refused' };
    await cardCtx._syncUpdateCardFromState();
    assert.equal(win.__updateTag, 'v1.2.5-dev.4');
    assert.equal(win.__updateUrl, 'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4');
    assert.equal(elements['btn-update-download'].textContent, '重试下载');
    assert.equal(notesLink.textContent, '打开发行页');

    // Downloading prerelease: restores tag/URL and renders dev label.
    win.__updateTag = null;
    win.__updateUrl = null;
    currentState = { phase: 'downloading', tag: 'v1.2.5-dev.4', downloaded: 50, total: 100 };
    await cardCtx._syncUpdateCardFromState();
    assert.equal(win.__updateTag, 'v1.2.5-dev.4');
    assert.equal(win.__updateUrl, 'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4');
    assert.equal(elements['update-check-desc'].textContent, '正在下载 开发版 v1.2.5-dev.4 安装包…');

    // Ready prerelease: restores tag/URL and renders dev apply button/description.
    win.__updateTag = null;
    win.__updateUrl = null;
    currentState = { phase: 'ready', tag: 'v1.2.5-dev.4' };
    await cardCtx._syncUpdateCardFromState();
    assert.equal(win.__updateTag, 'v1.2.5-dev.4');
    assert.equal(win.__updateUrl, 'https://github.com/ZouDongj/ZTerm/releases/tag/v1.2.5-dev.4');
    assert.equal(elements['btn-update-apply'].textContent, '重启并安装 开发版 v1.2.5-dev.4');
    assert.equal(elements['update-check-desc'].textContent, '开发版 v1.2.5-dev.4 已下载完成，随时可安装');

    // Invalid st.tag is sanitized by updateReleasePageUrl to the safe latest fallback
    // and clears window.__updateTag so a retry does not send an invalid tag.
    win.__updateTag = 'v1.2.5-dev.4';
    win.__updateUrl = null;
    currentState = { phase: 'failed', tag: '../evil?x=1', error: '[connect] refused' };
    await cardCtx._syncUpdateCardFromState();
    assert.equal(win.__updateTag, null);
    assert.equal(win.__updateUrl, 'https://github.com/ZouDongj/ZTerm/releases/latest');

    // Idle state leaves tag/URL untouched.
    win.__updateTag = null;
    win.__updateUrl = null;
    currentState = { phase: 'idle', tag: 'v1.2.5-dev.4' };
    await cardCtx._syncUpdateCardFromState();
    assert.equal(win.__updateTag, null);
    assert.equal(win.__updateUrl, null);
});
