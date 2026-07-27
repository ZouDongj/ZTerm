// ZTerm - SSH known_hosts 管理（TOFU: Trust On First Use）
// 持久化已知主机指纹，首次连接记录，后续连接比对，不匹配时拒绝并上报
const fs = require('fs');
const path = require('path');

let knownHostsPath = null;
let hosts = null; // { "host:port": { algorithm, fingerprint, base64 } }

function init(userDataDir) {
    knownHostsPath = path.join(userDataDir, 'known_hosts.json');
    load();
}

function load() {
    if (!knownHostsPath) { hosts = {}; return; }
    try {
        if (fs.existsSync(knownHostsPath)) {
            hosts = JSON.parse(fs.readFileSync(knownHostsPath, 'utf-8'));
        } else {
            hosts = {};
        }
    } catch (e) {
        console.error('Failed to load known_hosts:', e.message);
        hosts = {};
    }
}

function save() {
    if (!knownHostsPath) return;
    try {
        const tmp = knownHostsPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(hosts, null, 2), 'utf-8');
        fs.renameSync(tmp, knownHostsPath);
    } catch (e) {
        console.error('Failed to save known_hosts:', e.message);
    }
}

// 查询主机指纹：返回 known / mismatch / unknown
function check(host, port, key) {
    if (!hosts) load();
    const id = host + ':' + (port || 22);
    const entry = hosts[id];
    const fingerprint = key.fingerprint();
    if (!entry) return { status: 'unknown' };
    if (entry.fingerprint === fingerprint) return { status: 'known' };
    return {
        status: 'mismatch',
        oldFingerprint: entry.fingerprint,
        oldAlgorithm: entry.algorithm,
        newFingerprint: fingerprint,
        newAlgorithm: key.algorithm(),
    };
}

// 记录/更新主机指纹（TOFU 首次信任或用户确认后更新）
function trust(host, port, key) {
    if (!hosts) load();
    const id = host + ':' + (port || 22);
    hosts[id] = {
        algorithm: key.algorithm(),
        fingerprint: key.fingerprint(),
        base64: key.base64(),
    };
    save();
}

module.exports = { init, check, trust };
