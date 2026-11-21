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
