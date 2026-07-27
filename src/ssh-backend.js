// ZTerm - SSH backend (russh wrapper)
const russh = require('russh');
const { LoginScriptProcessor } = require('./login-script');

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

            // 4. Open shell channel
            const cols = config.cols || 80;
            const rows = config.rows || 24;
            const ch = await auth.activateChannel(await auth.openSessionChannel());
            await ch.requestPTY('xterm-256color', { columns: cols, rows, pixWidth: 0, pixHeight: 0 });
            await ch.requestShell();

            if (settled) { try { await ch.close(); } catch(e) {} return; }
            settled = true;

            // 5. Login script processor
            const processor = config.loginScripts && config.loginScripts.length > 0
                ? new LoginScriptProcessor(config.loginScripts) : null;

            // 6. SFTP subsystems — separate channels for panel ops and file transfers
            let sftp = null, sftpTransfer = null;
            try {
                sftp = await auth.activateSFTP(await auth.openSessionChannel());
            } catch(e) {}
            try {
                sftpTransfer = await auth.activateSFTP(await auth.openSessionChannel());
            } catch(e) {}

            // 6. OSC 7 injection + cwd tracking (only when followCwd is enabled)
            //    Inject a PROMPT_COMMAND that outputs OSC 7 sequences on every prompt.
            //    Filter the injection echo so the user sees a clean first prompt.
            const followCwd = config.followCwd === true;
            let _injectState = followCwd ? 'waiting' : 'normal'; // skip injection if disabled
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

            // Inject OSC 7 script with stty -echo to suppress all echo
            const injectScript = 'stty -echo\n'
                + '_zt_cwd() { printf \'\\033]7;file://%s%s\\033\\\\\' "$HOSTNAME" "$PWD"; }\n'
                + 'if [ -n "$ZSH_VERSION" ]; then\n'
                + '  precmd_functions+=(_zt_cwd)\n'
                + 'else\n'
                + '  PROMPT_COMMAND="_zt_cwd;${PROMPT_COMMAND}"\n'
                + 'fi\n'
                + 'stty echo\n'
                + 'echo ZTERM_INJECTED\n';
            if (followCwd) {
                try { ch.write(new Uint8Array(Buffer.from(injectScript, 'utf-8'))); } catch(e) {}
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
