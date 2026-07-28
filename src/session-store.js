// ZTerm - Session store (config.json read/write)
const fs = require('fs');
const path = require('path');

// 锚点目录（固定）：存放指向自定义数据目录的指针 config.json
const ANCHOR_DIR = path.join(process.env.APPDATA || process.env.HOME, 'ZTerm');
const ANCHOR_CONFIG = path.join(ANCHOR_DIR, 'config.json');
// 无指针时的默认数据目录：dev=锚点目录，打包版=安装目录/data（由 init 传入）
let defaultEffectiveDir = ANCHOR_DIR;
let dataDir = ANCHOR_DIR;
let configPath = path.join(dataDir, 'config.json');

// 内存配置缓存：所有读操作返回缓存，写操作只改缓存+防抖落盘，消除 read-modify-write 竞态
let _configCache = null;
let _flushTimer = null;
const FLUSH_DEBOUNCE_MS = 300;
// 配置损坏时的回调（由 main.js 注册，通过 IPC 通知 renderer 弹 toast）
let _onCorrupted = null;

const DEFAULT_CONFIG = {
    version: 1,
    profiles: [
        { id: 'powershell', name: 'PowerShell', type: 'local', command: 'powershell.exe', icon: 'local' },
        { id: 'cmd', name: 'Command Prompt', type: 'local', command: 'cmd.exe', icon: 'local' },
    ],
    sshProfiles: [],
    lastTabs: [],
    appearance: {
        fontFamily: '"JetBrains Mono","Cascadia Code",Consolas,monospace',
        fontSize: 14,
        fontWeight: '450',
        fontWeightBold: '700',
        theme: 'onedark',
    }
};

// 启动时调用一次：确定数据目录（迁移旧配置 + 解析指针）
function init(opts) {
    if (opts && opts.defaultDataDir) defaultEffectiveDir = opts.defaultDataDir;
    // 打包版首次运行：把 dev/旧版在 APPDATA 的配置迁移到新默认目录
    if (defaultEffectiveDir !== ANCHOR_DIR) {
        const targetConfig = path.join(defaultEffectiveDir, 'config.json');
        try {
            if (!fs.existsSync(targetConfig) && fs.existsSync(ANCHOR_CONFIG)) {
                const legacy = JSON.parse(fs.readFileSync(ANCHOR_CONFIG, 'utf-8'));
                if (!legacy.dataDir) {
                    fs.mkdirSync(defaultEffectiveDir, { recursive: true });
                    fs.copyFileSync(ANCHOR_CONFIG, targetConfig);
                }
            }
        } catch(e) { console.error('legacy config migration failed:', e.message); }
    }
    // 解析锚点指针（dataDir 字段 → 自定义数据目录）
    dataDir = defaultEffectiveDir;
    try {
        if (fs.existsSync(ANCHOR_CONFIG)) {
            const raw = JSON.parse(fs.readFileSync(ANCHOR_CONFIG, 'utf-8'));
            if (raw.dataDir && raw.dataDir !== defaultEffectiveDir) dataDir = raw.dataDir;
        }
    } catch(e) {}
    configPath = path.join(dataDir, 'config.json');
    ensureDir();
    // 覆盖安装后便携目录可能被清空，从锚点镜像恢复
    if (dataDir !== ANCHOR_DIR && !fs.existsSync(configPath) && fs.existsSync(ANCHOR_CONFIG)) {
        try {
            const mirror = JSON.parse(fs.readFileSync(ANCHOR_CONFIG, 'utf-8'));
            if (!mirror.dataDir) {
                fs.writeFileSync(configPath, JSON.stringify(mirror, null, 2), 'utf-8');
            }
        } catch(e) {}
    }
}

function getDataDirInfo() {
    return { current: dataDir, defaultDir: defaultEffectiveDir, isCustom: dataDir !== defaultEffectiveDir };
}

// 用户指定自定义数据目录：迁移当前配置 → 锚点写指针
function setCustomDataDir(newDir) {
    flushNow(); // 确保待写的防抖内容落盘到当前路径再迁移
    const current = loadConfig();
    delete current.dataDir;
    fs.mkdirSync(newDir, { recursive: true });
    const newPath = path.join(newDir, 'config.json');
    fs.writeFileSync(newPath, JSON.stringify(current, null, 2), 'utf-8');
    let anchor = {};
    try { if (fs.existsSync(ANCHOR_CONFIG)) anchor = JSON.parse(fs.readFileSync(ANCHOR_CONFIG, 'utf-8')); } catch(e) {}
    anchor.dataDir = newDir;
    fs.mkdirSync(ANCHOR_DIR, { recursive: true });
    fs.writeFileSync(ANCHOR_CONFIG, JSON.stringify(anchor, null, 2), 'utf-8');
    dataDir = newDir;
    configPath = newPath;
    _configCache = JSON.parse(JSON.stringify(current)); // 缓存跟随新路径
}

// 恢复默认数据目录：配置写回默认目录 → 移除锚点指针
function resetDataDir() {
    flushNow();
    const current = loadConfig();
    delete current.dataDir;
    fs.mkdirSync(defaultEffectiveDir, { recursive: true });
    fs.writeFileSync(path.join(defaultEffectiveDir, 'config.json'), JSON.stringify(current, null, 2), 'utf-8');
    try {
        if (fs.existsSync(ANCHOR_CONFIG)) {
            const anchor = JSON.parse(fs.readFileSync(ANCHOR_CONFIG, 'utf-8'));
            if (anchor.dataDir) {
                delete anchor.dataDir;
                fs.writeFileSync(ANCHOR_CONFIG, JSON.stringify(anchor, null, 2), 'utf-8');
            }
        }
    } catch(e) {}
    dataDir = defaultEffectiveDir;
    configPath = path.join(dataDir, 'config.json');
    _configCache = JSON.parse(JSON.stringify(current));
}

function setDataDir(dir) {
    dataDir = dir || ANCHOR_DIR;
    configPath = path.join(dataDir, 'config.json');
    ensureDir();
}

function getDataDir() { return dataDir; }

function ensureDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function deepMerge(base, extra) {
    if (Array.isArray(base) || Array.isArray(extra)) return extra !== undefined ? extra : base;
    if (typeof base !== 'object' || base === null || typeof extra !== 'object' || extra === null) {
        return extra !== undefined ? extra : base;
    }
    const out = { ...base };
    for (const key of Object.keys(extra)) {
        out[key] = deepMerge(base[key], extra[key]);
    }
    return out;
}

function loadConfig() {
    // 有缓存直接返回，避免重复磁盘 IO 和 read-modify-write 竞态
    if (_configCache) return _configCache;
    ensureDir();
    try {
        if (fs.existsSync(configPath)) {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            // Merge with defaults so missing keys (profiles, sshProfiles, ...) are restored
            _configCache = deepMerge(DEFAULT_CONFIG, raw);
            return _configCache;
        }
    } catch (e) {
        console.error('Failed to load config:', e.message);
        // 损坏的 config 先备份再重建，避免 SSH 配置/加密密码等数据永久丢失
        // .bak 加时间戳后缀，避免 Windows 上 renameSync 不能覆盖已有 .bak 导致永久卡死
        try {
            if (fs.existsSync(configPath)) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                fs.renameSync(configPath, configPath + '.bak.' + ts);
                if (_onCorrupted) try { _onCorrupted(); } catch(e2) {}
            }
        } catch(e2) { console.error('Failed to backup corrupt config:', e2.message); }
    }
    _configCache = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    saveConfig(_configCache);
    return _configCache;
}

// 防抖落盘：多次 saveXxx 在 300ms 内合并为一次原子写，消除并发覆盖竞态
function scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
        _flushTimer = null;
        if (_configCache) _writeConfigToDisk(_configCache);
    }, FLUSH_DEBOUNCE_MS);
}

// 立即同步落盘（用于退出前保存等不能等防抖的场景）
function flushNow() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    if (_configCache) _writeConfigToDisk(_configCache);
}

function _writeConfigToDisk(config) {
    ensureDir();
    // Atomic write: temp file + rename to avoid partial writes corrupting config
    const tmp = configPath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
        fs.renameSync(tmp, configPath);
    } catch(e) {
        // 杀软/索引器瞬时锁文件、磁盘满等--记录日志，下次保存时再试
        console.error('Failed to save config:', e.message);
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch(e2) {}
    }
    // 镜像写入锚点目录：覆盖安装/安装目录被清空后用于恢复
    if (dataDir !== ANCHOR_DIR) {
        try {
            const anchorTmp = ANCHOR_CONFIG + '.tmp';
            const mirror = { ...config }; delete mirror.dataDir;
            fs.mkdirSync(ANCHOR_DIR, { recursive: true });
            fs.writeFileSync(anchorTmp, JSON.stringify(mirror, null, 2), 'utf-8');
            fs.renameSync(anchorTmp, ANCHOR_CONFIG);
        } catch(e) {}
    }
}

function saveConfig(config) {
    _configCache = config;
    scheduleFlush();
}

// ── Last tabs ──

function saveLastTabs(tabs) {
    const config = loadConfig();
    config.lastTabs = tabs.map(t => {
        const entry = { name: t.name, type: t.type, command: t.command || 'powershell.exe' };
        if (t.args) entry.args = t.args;
        if (t.content) entry.content = t.content;
        if (t.splitRoot) entry.splitRoot = t.splitRoot;
        if (t.type === 'ssh') {
            entry.host = t.host;
            entry.port = t.port;
            entry.user = t.user;
            entry.sshProfileId = t.sshProfileId;
        }
        return entry;
    });
    saveConfig(config);
}

function loadLastTabs() {
    const config = loadConfig();
    return config.lastTabs && config.lastTabs.length > 0
        ? config.lastTabs
        : [{ name: 'PowerShell', type: 'local', command: 'powershell.exe' }];
}

// ── Profiles ──

function getProfiles() {
    return loadConfig().profiles;
}

// ── SSH Profiles ──

function getSSHProfiles() {
    return loadConfig().sshProfiles || [];
}

function saveSSHProfiles(sshProfiles) {
    const config = loadConfig();
    config.sshProfiles = sshProfiles;
    saveConfig(config);
}

function getAllProfiles() {
    const config = loadConfig();
    return {
        local: config.profiles || [],
        ssh: config.sshProfiles || [],
    };
}

// ── Appearance / Terminal settings ──

function saveAppearance(appearance) {
    const config = loadConfig();
    config.appearance = { ...(config.appearance || {}), ...appearance };
    saveConfig(config);
}

function saveTerminalSettings(terminal) {
    const config = loadConfig();
    config.terminal = { ...(config.terminal || {}), ...terminal };
    saveConfig(config);
}

// ── Transfer history ──

function saveTransferHistory(history) {
    const config = loadConfig();
    config.transferHistory = history;
    saveConfig(config);
}

function getTransferHistory() {
    return loadConfig().transferHistory || [];
}

// ── Quick Commands ──

function getQuickCommands() {
    return loadConfig().quickCommands || [];
}

function saveQuickCommands(commands) {
    const config = loadConfig();
    config.quickCommands = commands;
    saveConfig(config);
}

// ── Highlight rules ──

function getHighlightRules() {
    return loadConfig().highlightRules || [];
}

function saveHighlightRules(rules) {
    const config = loadConfig();
    config.highlightRules = rules;
    saveConfig(config);
}

function getHighlightSettings() {
    const config = loadConfig();
    return {
        highlightEnabled: config.highlightEnabled !== false,
        highlightAlternateDisable: config.highlightAlternateDisable !== false,
    };
}

function saveHighlightSettings(settings) {
    const config = loadConfig();
    config.highlightEnabled = settings.highlightEnabled;
    config.highlightAlternateDisable = settings.highlightAlternateDisable;
    saveConfig(config);
}

// ── Shortcuts ──

function getShortcuts() {
    return loadConfig().shortcuts || {};
}

function saveShortcuts(shortcuts) {
    const config = loadConfig();
    config.shortcuts = shortcuts;
    saveConfig(config);
}

module.exports = {
    loadConfig, saveConfig, flushNow,
    saveLastTabs, loadLastTabs,
    getProfiles, getAllProfiles,
    getSSHProfiles, saveSSHProfiles,
    saveAppearance, saveTerminalSettings,
    saveTransferHistory, getTransferHistory,
    getQuickCommands, saveQuickCommands,
    getHighlightRules, saveHighlightRules,
    getHighlightSettings, saveHighlightSettings,
    getShortcuts, saveShortcuts,
    init, getDataDirInfo, setCustomDataDir, resetDataDir,
    setDataDir, getDataDir,
    setCorruptedCallback: (cb) => { _onCorrupted = cb; },
    get configPath() { return configPath; }
};
