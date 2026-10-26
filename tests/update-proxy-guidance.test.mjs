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
