# ZTerm Bug 清单（最终确认版）

- **日期**：2026-08-03
- **来源**：`bug-review-20260803.md`（双 Agent 审查）+ `bug-review-20260803-verified.md`（独立复核）合并确认
- **状态图例**：✅ 已确认 / 🔶 部分确认（描述已修正）/ 🔬 待实测

---

## 🔴 高严重度（7 个）

### H1. SSH 密钥认证完全不可用 ✅

- **复现**：SSH 配置选"密钥"认证 → 填私钥路径 → 保存 → 连接 → 100% 认证失败
- **根因**：`zterm.rs:776` 唯一认证调用是 `authenticate_password()`；`resolve_ssh_password` 只读密码；`Credential.private_key_path`（zterm.rs:1816）存入但无消费方（cargo check 证实字段未读）。russh 0.60.3 提供 `authenticate_publickey()`，纯属未接入
- **修复**：Rust 侧补私钥读取（+passphrase）→ `authenticate_publickey()`；前端字段已就绪

### H2. 确认弹窗被 Escape 关闭后监听器泄漏 → 下次确认误执行上次操作 ✅

- **复现**：删除 A → 弹窗按 Escape → 删除 B → 点"删除" → **A、B 都被删**
- **根因**：`showConfirm`（utils.js:73）cleanup 只在按钮/backdrop 点击执行；Escape → `closeAllOverlays`（shortcuts.js:340）只移除 `.open` 类 → 旧回调残留叠加。hostkey 弹窗（ipc.js:341-362）同缺口
- **修复**：统一 overlay 生命周期——打开前解绑旧监听 / closeAllOverlays 触发 cleanup 回调

### H3. 连接握手完成前关闭 tab → 孤儿 SSH 会话 ✅（描述已修正）

- **复现**：连慢速主机 → "Connecting..." 时关 tab/pane/退分屏
- **修正后根因**：连接中 `tabId` **已分配**（ipc.js:105-125 收到 ssh-connecting 即写入），但会话**尚未进入 SessionMap**（zterm.rs:1003-1021 完成初始化才登记）；`pty_destroy`（zterm.rs:1154）只删已登记条目，**无法取消 in-flight 的 `ssh_connect()` Future**；hostkey 决策 await 无超时（zterm.rs:174-195）且 pty_destroy 不清理 decision_state → 连接随后完成 → `ssh-connected` 找不到 UI 所有者 → 远端 shell 永续
- **修复**：Rust 侧 in-flight 连接登记表 + 取消机制（见 H4）

### H4. 连接中点击重连（或切走切回）→ 双连接/双 shell ✅

- **复现**："Connecting..." 时点 ↻，或连接中切走再切回（switchTo 自动重连）
- **根因**：`reconnectTab`（tabs.js:356）对 in-flight 连接发 `ssh-disconnect` 是 no-op（未登记）→ 500ms 后发第二个连接；两个连接同 rendererId，`ssh-connected`（ipc.js:154）按 `tab.id === rendererId` 新旧都命中 → 旧会话孤儿
- **修复**：连接请求代次 token——`ssh_connect` 携带 requestId 代次，后端登记 in-flight 连接，旧代次连接被取消或结果被丢弃

### H5. 拖拽分屏 tab 到分屏 tab → 源分屏幽灵叠加 ✅（本次动画改造引入的回归，根因已修正）

- **复现**：Tab A 分 3 pane → Tab B 分屏且激活 → 拖 A 标签到 B 内容区释放 → 视图显示 A 剩余 pane 盖在 B 上
- **修正后根因**：跨 tab 拖拽（tabs.js:1386-1392）：`ss.remove()` 源 DOM → `sc()` 里 `_renderSplit(sourceTab)` **新建源 root 默认可见** → `_renderSplit(targetTab)` 复用已隐藏（display:none）的目标 root → 源 root 叠在目标上。`_renderSplit` 没有统一按 `tab.id === activeId` 同步 root 可见性
- **修复**：`_renderSplit` 统一设置 root display；跨 tab 移动路径保证 active 状态与 DOM 可见性一致

### H6. 正常路径关闭已连接 SSH tab → 会话清理不完整（复核新增）✅

- **复现**：SSH 连接成功 → 关闭 tab → 远端 shell 是否退出待实测
- **根因**：`pty_destroy`（zterm.rs:1154）只从 map 删除对象；`ssh_disconnect`（zterm.rs:1033）无显式 disconnect；reader task（zterm.rs:902-998）持续 `channel.wait()`，writer task（zterm.rs:853）持 handle——仅删 map 引用**不能证明** socket/task/远端 shell 已终止
- **修复**：关闭时显式关闭 channel/session + 等待 task 退出（或验证现有 Drop 链已足够）

### H7. config.json 损坏 → 静默重置并覆盖，配置/密码丢失 ✅（严重度提升）

- **复现**：config.json 改坏 → 启动 → 改设置/定时保存 → 原文件被默认配置覆盖
- **根因**：`load_config`（zterm.rs:381）解析失败静默返回默认值；无备份、无 `config-corrupted` emit（ipc.js:327 监听器是死代码）；`save_config`（zterm.rs:401）非原子直写
- **修复**：解析失败 → 备份坏文件 + emit 通知 + 禁止无提示覆盖；保存改原子写（tmp+rename）

---

## 🟡 中严重度（5 个）

### M1. 关闭连接中的 SSH pane → 后端残留 🔶（H3 的 pane 表现，建议合并处理）

- 与 H3 同根因：pane 有 tabId 但会话未入 map，`_closePane`（tabs.js:1073）发 pty-destroy 是 no-op
- **处理**：随 H3/H4 的 in-flight 机制一并修复

### M2. 拖拽中改变目标分屏树再 drop → 源 pane 丢失 🔶（文案已修正）

- **修正**：目标校验失败（tabs.js:1361 摘除源 pane 之后才 `findPane`）→ 源 pane 从 UI 树丢失、输入路由失效；**后端会话是残留而非销毁**（失败路径没发 pty-destroy）
- **修复**：失败路径回滚（源 pane 放回源树）或明确清理

### M3. SFTP 快速切 tab → 列表错配 ✅

- `sftp.js:28-61` open/navigate 异步响应无归属校验，旧 tab 响应覆盖新面板
- **修复**：请求 token + 响应时校验 `_tabId`

### M5. SSH tab 关闭后 SFTP 面板仍开 ✅

- `closeTab`（tabs.js:286）不联动 `SFTP.close()`
- **修复**：closeTab 检查 `SFTP._tabId` 归属并自动关闭

### M6. ssh-error 握手重试正则对 russh 基本失效 🔶

- `/handshake|lost before/i`（ipc.js:180）针对 Electron ssh2 错误；russh 常规错误（Key exchange failed / Connection timeout 等）不命中 → 瞬时失败不重试
- **修复**：基于错误类别（timeout/网络断开）做有限重试；与 H4 token 机制整合避免双连接

---

## 🟢 低严重度（4 个）

### L1. `_exitSplit` 漏同步 `tab.connected` ✅
- tabs.js:1399-1457 全字段同步唯独漏 connected → 标签状态点/重连按钮错误

### L2. 关闭 pane 淡出窗口内再分屏 → 双 DOM 🔶
- pane-exit 排除复用 + buildPane 无条件新建 → 同 `data-pane` 双元素短暂并存；是否明显闪烁依赖时序

### L3. 取消传输残留半截文件 ✅
- 上传 TRUNCATE 已写部分保留；下载本地部分文件保留；无清理无提示
- **修复**：临时文件 + 成功后 rename，取消时清理

### L4. 设置退出保存竞态（复核新增）✅
- `saveConfig` fire-and-forget（main.js:68）+ `quit_ready` 直接 `exit(0)`（zterm.rs:2190）→ 关闭前刚改的设置可能未落盘
- **修复**：退出前 await 保存确认（IPC 改为可等待，或延迟退出）

---

## 🔬 待实测（3 个）

| # | 描述 | 验证方法 |
|---|------|---------|
| P1 | 拖拽拖出窗口外释放 → overlay 残留 | WebView2 实测；修复：pointercancel/window.blur 兜底 |
| P2 | autoCopy（selectionchange 写剪贴板）在 WebView2 可能静默失败 | DevTools 手动 `navigator.clipboard.writeText('x')` 验证；修复：补 .catch + Rust arboard 回退 |
| P3 | 异常 1-pane split 树恢复后关唯一 pane → 空死 tab ✅已确认逻辑 | 修复：`_deserializeSplitTree` normalize，拒绝 1-pane/空树 |

---

## 已确认排除

- "编辑密码后保存两次"：无丢失路径 ✅
- 右键粘贴权限：`enable_clipboard_access`（main.rs:173）已授权 ✅
