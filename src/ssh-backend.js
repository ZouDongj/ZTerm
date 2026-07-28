// ZTerm - SSH backend (russh wrapper)
const russh = require('russh');
const { LoginScriptProcessor } = require('./login-script');

// ── followCwd rc 包装方案（零键入注入）──
// 上传 rc 文件后以它为启动 rc 直接拉起 shell（bash --rcfile / zsh ZDOTDIR），
// 终端里不敲任何命令 → history 完全无污染。失败时回退到键入注入。

// 开一个临时 exec channel 执行命令并收集输出
async function _execAndRead(auth, cmd, timeoutMs = 4000) {
    const ch = await auth.activateChannel(await auth.openSessionChannel());
    let out = '';
    try {
        ch.data$.subscribe(d => { out += Buffer.from(d).toString(); });
        await ch.requestExec(cmd);
        await Promise.race([
            new Promise(res => { ch.eof$.subscribe(() => res()); ch.closed$.subscribe(() => res()); }),
            new Promise(res => setTimeout(res, timeoutMs)),
        ]);
        // closed$ 可能先于 data$ 触发，留 200ms 宽限让数据事件投递完，避免读到空串
        await new Promise(res => setTimeout(res, 200));
    } finally {
        try { ch.close(); } catch(e) {}
    }
    return out.trim();
}

// 探测默认 shell：直接读 /etc/passwd 里该用户的登录 shell（确定性，不走 exec channel）
async function _detectShell(auth, sftp, username, onDebug) {
    try {
        const f = await sftp.open('/etc/passwd', russh.OPEN_READ);
        let data = '';
        while (true) {
            const chunk = await f.read(65536);
            if (chunk.length === 0) break;
            data += Buffer.from(chunk).toString();
            if (data.length > 262144) break;
        }
        await f.shutdown();
        const line = data.split('\n').find(l => l.startsWith(username + ':'));
        const shell = line ? line.split(':').pop().trim() : '';
        if (/bash/.test(shell)) return 'bash';
        if (/zsh/.test(shell)) return 'zsh';
        return shell;
    } catch(e) {
        return '';
    }
}

async function _sftpWrite(sftp, path, content) {
    const f = await sftp.open(path, russh.OPEN_WRITE | russh.OPEN_CREATE);
    await f.writeAll(new Uint8Array(Buffer.from(content, 'utf-8')));
    await f.shutdown();
}

// 探测默认 shell，上传 rc 文件，返回包装启动命令；无法使用时返回 null（走键入注入回退）
async function _prepareCwdWrapper(auth, sftp, username, onDebug) {
    const shellKind = await _detectShell(auth, sftp, username, onDebug);
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const cwdFn = '_zt_cwd() { printf \'\\033]7;file://%s%s\\033\\\\\' "$HOSTNAME" "$PWD"; }\n';
    if (shellKind === 'bash') {
        const rcPath = '/tmp/.zterm-rc-' + stamp;
        // 登录 bash 不读 --rcfile（本地已验证），用非登录 -i + 手动 source 登录链。
        // 不手动 source /etc/profile：RHEL 系 /etc/profile 和 /etc/bashrc 都会跑 profile.d，
        // 手动 source 会导致横幅双刷；profile 链路自身已覆盖环境初始化
        await _sftpWrite(sftp, rcPath,
            '{ [ -f ~/.bash_profile ] && . ~/.bash_profile; } || { [ -f ~/.bash_login ] && . ~/.bash_login; } || { [ -f ~/.profile ] && . ~/.profile; }\n'
            + cwdFn
            + 'PROMPT_COMMAND="_zt_cwd;${PROMPT_COMMAND}"\n'
            + 'rm -f ' + rcPath + '\n');
        return 'exec bash --rcfile ' + rcPath + ' -i';
    }
    if (shellKind === 'zsh') {
        const dir = '/tmp/.zterm-zdot-' + stamp;
        try { await sftp.createDirectory(dir); } catch(e) {}
        await _sftpWrite(sftp, dir + '/.zshrc',
            '[ -f ~/.zshrc ] && . ~/.zshrc\n'
            + cwdFn
            + 'precmd_functions+=(_zt_cwd)\n'
            + 'rm -rf ' + dir + '\n');
        await _sftpWrite(sftp, dir + '/.zprofile', '[ -f ~/.zprofile ] && . ~/.zprofile\n');
        return 'exec env ZDOTDIR=' + dir + ' zsh -il';
    }
    return null;
}

/**
 * Create an SSH connection and shell session using russh.
 * @param {Object} config - { host, port, username, password?, privateKey?, passphrase?, followCwd?, cols?, rows? }
 * @param {Object} callbacks - { onReady(conn), onData(data), onExit(code?), onError(err), onDebug(msg), onHostKey(key)->boolean|Promise<boolean> }
 */
function createSSHConnection(config, callbacks) {
    const { onReady, onData, onExit, onError, onDebug, onHostKey } = callbacks;
    let settled = false;
    let errored = false; // 认证/连接失败标志：设为 true 后 disconnect$ 不再触发 onExit（避免双重通知）
    // 退出信号去重：eof$/closed$/disconnect$ 都可能触发 onExit，只上报一次
    let exited = false;
    // 保存连接各层引用，供 cancel() 逐层断开
    let _transport = null, _client = null, _auth = null;
    const fireExit = (code) => {
        if (exited) return;
        exited = true;
        try { onExit(code); } catch(e) {}
    };

    // 认证超时包装：authenticateWith* 可能因半开连接/防火墙静默丢包永久挂起
    function _authWithTimeout(authPromise) {
        return Promise.race([
            authPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Authentication timed out (15s)')), 15000)),
        ]);
    }

    (async () => {
        try {
            // 1. Transport layer
            const transport = await russh.SshTransport.newSocket(
                (config.host || 'localhost') + ':' + (config.port || 22)
            );
            _transport = transport;

            // 2. Connect with host key verification (TOFU via onHostKey callback)
            const serverKeyCallback = onHostKey
                ? (key) => {
                    try { return Promise.resolve(onHostKey(key)); }
                    catch(e) { return Promise.resolve(false); }
                }
                : (key) => Promise.resolve(true); // 无回调时放行（向后兼容）
            const client = await russh.SSHClient.connect(
                transport,
                serverKeyCallback,
                {
                    keepaliveIntervalSeconds: 10,
                    keepaliveCountMax: 5,
                    connectionTimeoutSeconds: 30,
                }
            );
            _client = client;

            if (settled) { try { await client.disconnect(); } catch(e) {} return; }

            // Forward banner/debug messages
            client.banner$.subscribe(msg => {
                if (onDebug) try { onDebug(msg); } catch(e) {}
            });
            client.disconnect$.subscribe(() => {
                if (errored) return; // 认证/连接失败已报 onError，不再触发 onExit（避免双重通知）
                if (!settled) {
                    settled = true;
                    fireExit(-1);
                } else {
                    // 已建立连接后的意外断线（休眠/拔线/VPN 掉线）也要上报
                    fireExit(-1);
                }
            });

            // 3. Authenticate（套 15s 超时，防止半开连接永久挂起）
            let auth;
            if (config.privateKey) {
                const key = await russh.KeyPair.parse(config.privateKey, config.passphrase || undefined);
                auth = await _authWithTimeout(client.authenticateWithKeyPair(config.username, key, null));
            } else if (config.password) {
                auth = await _authWithTimeout(client.authenticateWithPassword(config.username, config.password));
            } else {
                auth = await _authWithTimeout(client.authenticateNone(config.username));
            }

            if (!(auth instanceof russh.AuthenticatedSSHClient)) {
                if (!settled) {
                    settled = true;
                    errored = true;
                    try { onError(new Error('Authentication failed')); } catch(e) {}
                }
                try { await client.disconnect(); } catch(e) {}
                return;
            }

            if (settled) { try { await auth.disconnect(); } catch(e) {} return; }
            _auth = auth;

            auth.disconnect$.subscribe(() => {
                if (errored) return;
                if (!settled) {
                    settled = true;
                    fireExit(-1);
                } else {
                    fireExit(-1);
                }
            });

            // 4. SFTP subsystems — separate channels for panel ops and file transfers
            //    （提前打开：followCwd 的 rc 包装方案要用 SFTP 上传）
            let sftp = null, sftpTransfer = null;
            try {
                sftp = await auth.activateSFTP(await auth.openSessionChannel());
            } catch(e) {}
            try {
                sftpTransfer = await auth.activateSFTP(await auth.openSessionChannel());
            } catch(e) {}

            // 5. followCwd：优先 rc 包装方案（零键入注入），失败回退键入注入
            const followCwd = config.followCwd === true;
            let execCmd = null;
            if (followCwd && sftp) {
                // 清理前几版注入残留（异步触发，不阻塞连接主流程）
                _execAndRead(auth, "sed -i -E '/_zt_cwd|_zt_hio|ZTERM_INJECTED|hist_ignore_space|HIST_IGNORE_SPACE|set [+-]o history|fc -p|fc -P|\\.zterm-|zterm-cwd|zterm-rc|zterm-zdot/d' ~/.bash_history ~/.zsh_history 2>/dev/null; true", 6000)
                    .catch(() => {});
                try { execCmd = await _prepareCwdWrapper(auth, sftp, config.username, onDebug); } catch(e) { try { onDebug('cwd-wrapper error: ' + e.message); } catch(e2) {} }
            }

            // 6. Open shell channel
            const cols = config.cols || 80;
            const rows = config.rows || 24;
            const ch = await auth.activateChannel(await auth.openSessionChannel());
            await ch.requestPTY('xterm-256color', { columns: cols, rows, pixWidth: 0, pixHeight: 0 });
            if (execCmd) await ch.requestExec(execCmd);
            else await ch.requestShell();

            if (settled) { try { await ch.close(); } catch(e) {} return; }
            settled = true;

            // 7. Login script processor
            const processor = config.loginScripts && config.loginScripts.length > 0
                ? new LoginScriptProcessor(config.loginScripts) : null;

            // 8. OSC 7 injection + cwd tracking (only when followCwd is enabled)
            //    rc 包装方案无需抑制注入回显；回退的键入注入需要 stty -echo + ZTERM_INJECTED 标记过滤
            let _injectState = (followCwd && !execCmd) ? 'waiting' : 'normal';
            let _injectBuf = '';
            let cwd = null;
            let _sshConn = null;

            const origOnData = onData;
            const injectOnData = (data) => {
                if (_injectState === 'normal') {
                    // Parse OSC 7 from terminal output (supports both BEL and ESC\ terminators)
                    const str = data.toString();
                    const m = str.match(/\x1b\]7;file:\/\/[^/\x07\x1b\\]*(\/[^\x07\x1b\\]*?)(?:\x07|\x1b\\)/);
                    if (m) {
                        cwd = m[1];
                        if (_sshConn) _sshConn.cwd = cwd;
                    }
                    try { origOnData(data); } catch(e) {}
                    return;
                }
                // Inject state machine: suppress ALL output until injection is complete
                // (welcome messages are sacrificed for a perfectly clean first prompt)
                _injectBuf += data.toString();
                if (_injectState === 'waiting') {
                    // Only match ZTERM_INJECTED as a standalone line (not the 'echo ZTERM_INJECTED' echo)
                    if (/^ZTERM_INJECTED\r?$/m.test(_injectBuf)) {
                        _injectState = 'normal';
                        return;
                    }
                    return;
                }
                try { origOnData(data); } catch(e) {}
            };

            // 8. Data flow (with injection filtering + OSC 7 parsing + login script matching)
            ch.data$.subscribe(data => {
                if (processor) {
                    const dataStr = Buffer.from(data).toString('utf-8');
                    const lsResult = processor.feed(dataStr);
                    if (lsResult) {
                        const sendBuf = Buffer.from(lsResult.send + '\n', 'utf-8');
                        try { ch.write(new Uint8Array(sendBuf.buffer, sendBuf.byteOffset, sendBuf.byteLength)); } catch(e) {}
                    }
                }
                try { injectOnData(Buffer.from(data)); } catch(e) {}
            });
            ch.extendedData$.subscribe(([ext, data]) => {
                try { onData(Buffer.from(data)); } catch(e) {}
            });
            ch.eof$.subscribe(() => {
                fireExit(0);
            });
            ch.closed$.subscribe(() => {
                fireExit(0);
            });

            const sshConn = {
                channel: ch,
                sftp,
                sftpTransfer,
                username: config.username,
                cwd: null,
                auth,
                write(data) {
                    try {
                        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
                        const result = ch.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
                        if (result && result.catch) result.catch(() => {});
                    } catch(e) {}
                },
                resize(cols, rows) {
                    try {
                        const result = ch.resizePTY({ columns: cols, rows, pixWidth: 0, pixHeight: 0 });
                        if (result && result.catch) result.catch(() => {});
                    } catch(e) {}
                },
                close() {
                    // auth.disconnect() 返回的 Promise 在 transport 已死时会 reject（SendError），必须吞掉
                    try {
                        const r = auth.disconnect();
                        if (r && r.catch) r.catch(() => {});
                    } catch(e) {}
                },
            };
            _sshConn = sshConn;

            // 键入注入（rc 包装不可用时的回退）：
            // bash 首行 set +o history、zsh 首行 HIST_IGNORE_SPACE + 载荷行前导空格，
            // 最多泄漏一行无害的 if 行
            if (followCwd && !execCmd) {
                const scriptBody = '_zt_cwd() { printf \'\\033]7;file://%s%s\\033\\\\\' "$HOSTNAME" "$PWD"; }\n'
                    + 'if [ -n "$ZSH_VERSION" ]; then\n'
                    + '  precmd_functions+=(_zt_cwd)\n'
                    + 'else\n'
                    + '  PROMPT_COMMAND="_zt_cwd;${PROMPT_COMMAND}"\n'
                    + 'fi\n';
                const injectLine = 'if [ -n "$ZSH_VERSION" ]; then _zt_hio=${options[hist_ignore_space]:-off}; setopt HIST_IGNORE_SPACE 2>/dev/null; else set +o history 2>/dev/null; fi\n'
                    + ' stty -echo\n'
                    + ' ' + scriptBody.replace(/\n/g, '\n ').trimEnd() + '\n'
                    + ' stty echo\n'
                    + ' echo ZTERM_INJECTED\n'
                    + ' if [ -n "$ZSH_VERSION" ]; then [ "$_zt_hio" = off ] && unsetopt HIST_IGNORE_SPACE 2>/dev/null; unset _zt_hio; else set -o history 2>/dev/null; fi\n';
                try { ch.write(new Uint8Array(Buffer.from(injectLine, 'utf-8'))); } catch(e) {}
            }

            // Execute unconditional login scripts (empty expect) before onReady
            if (processor) {
                const unconditional = processor.executeUnconditional();
                unconditional.forEach(cmd => {
                    const sendBuf = Buffer.from(cmd + '\n', 'utf-8');
                    try { ch.write(new Uint8Array(sendBuf.buffer, sendBuf.byteOffset, sendBuf.byteLength)); } catch(e) {}
                });
            }

            // settled 置位后可能有 disconnect 触发 onExit，此时不应再 onReady
            if (exited) return;
            onReady(sshConn);
        } catch (err) {
            if (!settled) {
                settled = true;
                try { onError(err); } catch(e) {}
            }
        }
    })();

    // Return a control object with cancel() — allows main.js to abort in-flight connections
    return {
        end() {} /* deprecated, kept for compat */,
        cancel() {
            if (!settled) {
                settled = true;
                errored = true;
                // 按连接建立顺序的反向逐层断开
                if (_auth) { try { _auth.disconnect(); } catch(e) {}; _auth = null; }
                if (_client) { try { _client.disconnect(); } catch(e) {}; _client = null; }
            }
        },
    };
}

module.exports = { createSSHConnection };
