// Shared configuration never grants execution permission by itself. The native
// gate binds each ticket to an immutable payload and a cancellable owner.
const ZTermExecutionTrust = (() => {
    const pending = new Map();
    const localClaims = new Map();
    let dialogQueue = Promise.resolve();
    const clone = value => JSON.parse(JSON.stringify(value));

    function localOwner(requestId) {
        if (typeof TabManager === 'undefined') return null;
        for (const tab of TabManager.tabs) {
            if (TabManager._closingTabs?.has(tab.id)) continue;
            if (tab.splitRoot) {
                const pane = getAllPanes(tab).find(p => !p._closing && p.type !== 'ssh' && p.requestId === requestId);
                if (pane) return pane;
            } else if (tab.type !== 'ssh' && tab.type !== 'settings' && (tab.id === requestId || tab._ptyRequestId === requestId)) return tab;
        }
        return null;
    }

    function cancel(owner, preserveFailureClaim = false) {
        const entry = pending.get(owner);
        if (entry) {
            entry.cancelled = true;
            entry.dismiss?.();
            pending.delete(owner);
        }
        if (!preserveFailureClaim) {
            for (const [requestId, claim] of localClaims) {
                if (claim === owner) localClaims.delete(requestId);
            }
        }
        const params = { owner };
        if (entry?.kind === 'local' && entry.prepared) params.requestId = entry.requestId;
        return ipcRenderer.invoke('cancel-execution', params).catch(() => {});
    }

    function cancelOwner(wrapper) {
        if (!wrapper) return;
        if (wrapper.splitRoot) getAllPanes(wrapper).forEach(cancelOwner);
        const ids = [wrapper.id, wrapper.requestId, wrapper._ptyRequestId].filter(Boolean);
        const owners = new Set();
        for (const [owner, entry] of pending) {
            if (entry.kind === 'local' && ids.includes(entry.requestId)) owners.add(owner);
        }
        // The RPC can settle before its native result event is delivered.
        for (const [requestId, owner] of localClaims) if (ids.includes(requestId)) owners.add(owner);
        owners.forEach(owner => cancel(owner));
        const attempt = typeof sshAttempts !== 'undefined' ? sshAttempts.ownerAttempt(wrapper) : null;
        if (attempt) cancel('ssh:' + attempt);
    }

    function confirm(entry, response) {
        const ask = () => new Promise(resolve => {
            let settled = false;
            let cleanup = null;
            let rememberInput = null;
            let rememberLabel = null;
            const finish = approved => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                entry.dismiss = null;
                const decision = approved ? { allow: true, remember: rememberInput?.checked === true } : null;
                rememberLabel?.remove();
                document.getElementById('confirm-msg')?.classList.remove('execution-review');
                if (cleanup && typeof _activeConfirmCleanup !== 'undefined' && _activeConfirmCleanup === cleanup) cleanup();
                resolve(decision);
            };
            const tick = () => {
                if (entry.cancelled || !entry.alive()) { finish(false); return; }
                if (cleanup) {
                    if (_activeConfirmCleanup !== cleanup) finish(false);
                    return;
                }
                // Reuse the existing safe-default confirmation dialog without
                // replacing an unrelated delete or host-key decision.
                if ((typeof _activeConfirmCleanup !== 'undefined' && _activeConfirmCleanup) ||
                    (typeof _activeHostkeyCleanup !== 'undefined' && _activeHostkeyCleanup)) return;
                cleanup = showConfirm(response.description, () => finish(true), '仅本次允许', 'primary');
                const message = document.getElementById('confirm-msg');
                message.classList.add('execution-review');
                if (response.canRemember) {
                    rememberLabel = document.createElement('label');
                    rememberLabel.className = 'execution-remember';
                    rememberInput = document.createElement('input');
                    rememberInput.type = 'checkbox';
                    rememberLabel.append(rememberInput, document.createTextNode('在此 Windows 账户记住这份启动配置'));
                    message.insertAdjacentElement('afterend', rememberLabel);
                    rememberInput.addEventListener('change', () => {
                        document.getElementById('confirm-ok').textContent = rememberInput.checked ? '允许并记住' : '仅本次允许';
                    });
                }
            };
            const timer = setInterval(tick, 100);
            entry.dismiss = () => finish(false);
            tick();
        });
        const asking = dialogQueue.then(ask, ask);
        dialogQueue = asking.then(() => {}, () => {});
        return asking;
    }

    async function authorize(kind, payload, owner, alive, requestId) {
        const entry = { kind, owner, payload: clone(payload), requestId, alive, cancelled: false };
        pending.set(owner, entry);
        try {
            const response = await ipcRenderer.invoke('prepare-execution', { kind, owner, payload: entry.payload });
            entry.prepared = true;
            if (entry.cancelled || !alive()) throw new Error('启动已取消');
            let decision = response;
            if (!response?.ticket) {
                const choice = response?.challengeId ? await confirm(entry, response) : null;
                if (!choice?.allow) throw new Error('启动已取消');
                if (entry.cancelled || !alive()) throw new Error('启动已取消');
                decision = await ipcRenderer.invoke('decide-execution', {
                    challengeId: response.challengeId, allow: true, remember: choice.remember === true,
                });
            }
            if (entry.cancelled || !alive()) throw new Error('启动已取消');
            if (!decision?.ticket) throw new Error('启动授权已过期，请重试');
            if (decision.warning) showToast(decision.warning, true);
            return { payload: entry.payload, executionOwner: owner, executionTicket: decision.ticket };
        } catch (error) {
            await cancel(owner, kind === 'local' && !entry.cancelled && alive());
            throw error;
        }
    }

    async function startLocal(payload, invoke) {
        const requestId = payload?.requestId;
        const wrapper = localOwner(requestId);
        if (!wrapper) return;
        for (const [previousOwner, previous] of pending) {
            if (previous.kind === 'local' && previous.requestId === requestId) cancel(previousOwner);
        }
        const owner = 'local:' + crypto.randomUUID();
        localClaims.set(requestId, owner);
        wrapper._ptyRequestId = requestId;
        const alive = () => localClaims.get(requestId) === owner && !!localOwner(requestId);
        try {
            const authorized = await authorize('local', payload, owner, alive, requestId);
            if (!alive()) { await cancel(owner); return; }
            return await invoke({ ...authorized.payload, executionOwner: owner, executionTicket: authorized.executionTicket });
        } catch (error) {
            if (localOwner(requestId) && localClaims.get(requestId) === owner) {
                await cancel(owner, true);
                showToast('终端启动未完成：' + String(error?.message || error), true);
            }
        } finally { pending.delete(owner); }
    }

    function authorizeSsh(profile, attemptId) {
        return authorize('ssh', profile, 'ssh:' + attemptId, () => sshAttempts.ownerWants(attemptId));
    }

    function finish(owner) { pending.delete(owner); }
    function acceptLocalResult(requestId, owner) {
        if (!owner || localClaims.get(requestId) !== owner || !localOwner(requestId)) return false;
        localClaims.delete(requestId);
        return true;
    }
    return { startLocal, authorizeSsh, cancelOwner, cancel, finish, acceptLocalResult };
})();

if (typeof window !== 'undefined') window.ZTermExecutionTrust = ZTermExecutionTrust;
if (typeof module !== 'undefined' && module.exports) module.exports = { ZTermExecutionTrust };
