# ZTerm Bug 文档复核报告

- **复核日期**：2026-08-03
- **原始清单**：`docs/bug-review-20260803.md`
- **复核范围**：`src/renderer/`、`src-tauri/src/`、`src/ipc-polyfill.js`、`src/renderer.html`
- **复核方式**：静态代码逐项核对；检查当前未提交的 `src/renderer/tabs.js` 修改；执行 `cargo check --manifest-path src-tauri/Cargo.toml`
- **代码修改**：本次复核未修改源代码
- **编译结果**：通过；仅有未使用字段、未使用导入等警告

> 本报告用于核对原始 bug 清单，不替代真实 SSH/SFTP 服务器和 WebView2 GUI 环境下的运行时测试。

## 一、结论总览

| 编号 | 结论 | 备注 |
|---|---|---|
| H1 | **有效** | Tauri 正式路径只支持密码认证，私钥路径未被消费 |
| H2 | **有效** | Escape 关闭确认框不会解绑监听器，后续确认会执行旧回调 |
| H3 | **有效，但复现描述需修正** | 连接中的 `tabId` 通常已分配，但会话尚未进入 SessionMap |
| H4 | **有效** | 连接中重连会产生两个独立 SSH 会话 |
| H5 | **有效，且与当前 tabs.js 修改有关** | 根因描述需要调整 |
| M1 | **部分有效** | 是 H3 在 pane 生命周期上的重复表现，`tabId 为 null` 前提通常不成立 |
| M2 | **有效，但部分描述夸大** | 目标树校验失败会导致源 pane 从 UI 树丢失；后端会话通常不会被销毁 |
| M3 | **有效** | SFTP 异步响应没有请求序号或 tab 归属校验 |
| M4 | **有效** | 损坏配置静默回退默认值，后续保存会覆盖原文件 |
| M5 | **有效** | 关闭 SSH tab 不会自动关闭 SFTP overlay |
| M6 | **有效，但“永不匹配”表述过强** | russh 标准错误通常不会命中现有重试正则 |
| L1 | **有效** | `_exitSplit()` 未同步 `tab.connected` |
| L2 | **部分有效** | 淡出期间会出现重复 pane DOM，但具体闪烁效果依赖时序 |
| L3 | **有效** | 取消传输后不清理本地或远端半截文件 |
| P1 | **未确认** | 存在事件清理缺口，但是否必然在 WebView2 复现需实测 |
| P2 | **部分有效/待实测** | Clipboard API 异步失败可能被吞掉，但项目已启用 clipboard 权限 |
| P3 | **有效** | 构造出单 pane split 且它是唯一 tab 时会留下空死 tab |

## 二、逐项核验

### H1. SSH 密钥认证完全不可用 — 有效

证据：

- `src-tauri/src/zterm.rs:551-565` 的 `resolve_ssh_password()` 只读取 `Credential.password`。
- `src-tauri/src/zterm.rs:774-784` 的正式 SSH 路径唯一认证调用是 `authenticate_password()`。
- `src-tauri/src/zterm.rs:1816-1829` 虽然把 `privateKeyPath` 存进 `Credential.private_key_path`，但没有任何消费方。
- `cargo check` 也报告 `private_key_path` 字段从未读取。
- russh 0.60.3 本身提供 `authenticate_publickey()`，因此不是依赖库能力缺失，而是正式路径没有接入。

**结论**：原文“密钥认证功能不可用”成立，严重度高。应补充私钥读取、可选 passphrase 处理，以及 `authenticate_publickey()` 调用。

### H2. Escape 关闭确认弹窗导致监听器泄漏 — 有效

证据：

- `src/renderer/utils.js:73-92` 的 `showConfirm()` 只在确认、取消或 backdrop 点击时执行 cleanup。
- `src/renderer/shortcuts.js:339-344` 的 Escape 路径只调用 `closeAllOverlays()`，它仅移除 `.open` class。
- 因此，A 弹窗被 Escape 关闭后，A 的 `onOkClick` 仍挂在确认按钮上；再次打开 B 并确认时，A、B 回调都会执行。
- `src/renderer/ipc.js:341-362` 的 hostkey 弹窗也有相同的监听器清理缺口。

**结论**：删除配置的复现步骤成立，属于高严重度静默数据操作错误。hostkey 场景的“旧回调可能接受后续决定”也存在安全风险，但具体表现需结合弹窗交错时序验证。

### H3. 连接握手完成前关闭 tab 导致孤儿 SSH 会话 — 有效，描述需修正

原文中“连接中 `tabId` 为 null”不准确：

- `src/renderer/ipc.js:105-125` 收到 `ssh-connecting` 后，会立即把后端 `tabId` 写入 tab 或 pane。
- 但 `src-tauri/src/zterm.rs:1003-1021` 只有在认证、channel、shell 等初始化完成后，才把会话写入 SessionMap。
- `src-tauri/src/zterm.rs:1154-1176` 的 `pty_destroy()` 只删除已存在的 SessionMap 条目，无法取消正在执行的 `ssh_connect()` Future。
- `src-tauri/src/zterm.rs:174-195` 的 hostkey 决策等待没有超时；关闭时如果只走 `pty_destroy`，挂起的连接也不会被解除。

因此，关闭连接中的 tab 后，连接可能继续完成，随后发出 `ssh-connected` 并进入 SessionMap，成为没有 UI 所有者的会话。

**建议修正文案**：连接中已分配 backend ID，但没有 in-flight session registry 和 cancellation 机制；`pty_destroy` 对尚未登记的连接无效。

### H4. 连接中点击重新连接导致双连接 — 有效

证据：

- `src/renderer/tabs.js:356-385` 的 `reconnectTab()` 对连接中 tab 发送 disconnect，固定等待 500ms 后再次 connect。
- `src-tauri/src/zterm.rs:1033-1055` 的 `ssh_disconnect()` 只处理 SessionMap 中已经登记的会话，无法取消连接中的任务。
- 第二次连接会生成新的 `ssh_N` ID，但两个连接携带相同的 `rendererId`。
- `src/renderer/ipc.js:154-162` 的 `ssh-connected` 可以按 `rendererId` 命中同一个 tab，因此旧连接和新连接都可能被前端接收。
- `tabs.js:237-241` 在切走再切回同一未连接 tab 时，也可能自动触发该路径。

**结论**：双 SSH session、双远端 shell 和旧连接孤儿化均有代码依据，严重度高。应使用连接请求代次/token，并让旧请求可取消。

### H5. 拖拽分屏 tab 后源分屏覆盖目标分屏 — 有效，当前改动相关

当前未提交的 `tabs.js` 改动将 `_renderSplit()` 从“全量重建”改为“节点复用”。相关路径：

- `src/renderer/tabs.js:1386-1392` 在跨 tab 拖拽时先移除源 split DOM，随后执行源 tab 的 `sc()` 和目标 tab 的 `_renderSplit()`。
- 当源 tab 仍有多个 pane 时，`sc()` 会再次调用 `_renderSplit(sourceTab)`。
- 新建的源 split-root 会被追加到 `main-area`，默认可见；目标 split-root 可能是已有节点并保持原显示状态。
- 结果可能出现目标 tab 标签已激活，但内容区实际由源 tab 剩余 pane 覆盖的状态。

**需要修正原文根因**：不宜简单写成“复用隐藏目标 root 未恢复 display”。更准确的是：跨 tab 拖拽后，源 root 被重新创建并默认可见，而 `_renderSplit()` 没有统一依据 `tab.id === activeId` 同步 split-root 的显示状态，造成多个 root 的可见性和 DOM 层叠顺序不一致。

**建议**：`_renderSplit()` 统一设置 root 的 `display`，并在所有跨 tab 移动路径中保证 source/target 的 active 状态与 DOM 可见性一致。

### M1. 关闭正在连接中的 SSH pane 导致后端残留 — 部分有效

这是 H3 的 pane 版本，根因相同：

- `src/renderer/tabs.js:1073-1090` 只在 `pane.tabId` 存在时发送 `pty-destroy`。
- 但即使 pane 已收到 `ssh-connecting` 并拥有 `tabId`，后端连接也可能尚未进入 SessionMap。
- `src-tauri/src/zterm.rs:1154-1176` 对该 ID 删除 map 是 no-op，不能取消 in-flight connect。

因此残留机制成立，但原文“握手中 `tabId 为 null`”通常不成立。建议与 H3 合并，或明确标注为 H3 的 pane 生命周期表现，避免重复计数。

### M2. 拖拽中改变目标分屏树导致源 pane 丢失 — 有效，但需修正文案

证据：

- `src/renderer/tabs.js:1268-1292` 先从源树摘除 focused pane，并 dispose 原输入监听。
- `src/renderer/tabs.js:1361-1362` 之后才检查目标 pane 是否仍存在。
- 如果拖拽期间目标树发生变化，`findPane()` 失败后执行 `sc()` 并返回。
- 源 pane 已不在原树中，也没有重新挂回目标树，因此 UI 引用和输入路由会丢失。

但“后端永久销毁”不准确：当前失败路径通常没有发送 `pty-destroy`，所以后端会话更可能残留而不是被销毁；“源 tab 被错误折叠”也只在特定剩余 pane 数量下发生。

### M3. SFTP 面板快速切换 tab 时列表错配 — 有效

证据：

- `src/renderer/sftp.js:28-61` 的 `open()` 把请求结果直接写入全局 `_tabId`、`_path`、`_files`，没有请求序号或当前 tab 归属校验。
- `src/renderer/sftp.js:82-104` 的 `navigate()` 也直接使用异步返回结果更新全局状态。
- A 的旧 `sftp-open` 或 `sftp-readdir` 响应可能在 B 已打开面板后覆盖 B 的列表。

**结论**：复现步骤和实际风险成立。应为每次打开/导航生成 request token，并在响应返回时校验 token 与当前 `_tabId`。

### M4. config.json 损坏后静默重置并覆盖 — 有效

证据：

- `src-tauri/src/zterm.rs:381-399` 对读取失败和 JSON 解析失败统一返回 `default_config()`。
- 没有备份损坏文件，也没有发出 `config-corrupted` 事件。
- `src-tauri/src/zterm.rs:401-417` 使用直接 `std::fs::write()`，不是临时文件加原子 rename。
- 后续保存命令会先 `load_config()`，再保存默认配置，可能覆盖原有 SSH profiles、加密密码和其他设置。
- `src/renderer/ipc.js:326-329` 虽然存在通知监听器，但 Tauri 路径没有对应 emit。

**结论**：有效，严重度高。至少应保留损坏文件备份、发出通知，并避免在未确认前覆盖损坏配置。

### M5. SSH tab 关闭后 SFTP 面板仍打开 — 有效

证据：

- `src/renderer/tabs.js:286-354` 的 `closeTab()` 没有调用 `SFTP.close()`。
- `src/renderer/sftp.js:63-76` 只有显式关闭面板时才移除 overlay 并清空 `_tabId`。
- 关闭 tab 后 overlay 仍可能可见，并继续持有已销毁 SSH session 的 backend ID。

**结论**：有效。关闭 tab 前应检查 `SFTP._tabId` 是否属于该 tab，并自动关闭或切换到有效会话。

### M6. 握手失败自动重试是死代码 — 有效，但表述需收窄

证据：

- `src/renderer/ipc.js:180-206` 只对 `/handshake|lost before/i` 进行重试。
- Cargo 锁定 russh 0.60.3，其标准错误文本主要是 `Key exchange init failed`、`Key exchange failed`、`Connection timeout`、`Disconnected` 等。
- 这些常规文本通常不会命中当前正则，因此握手/瞬时网络错误一般直接进入 SSH error 分支。

不能绝对断言“任何错误永远不会匹配”，因为底层 IO 错误可能携带任意自定义文本。更准确的结论是：**该重试逻辑没有基于 russh 稳定的错误类型或错误文本契约，针对常见 russh 错误基本失效**。若偶然触发重试，还会继承 H4 的双连接风险。

### L1. `_exitSplit()` 未同步 `tab.connected` — 有效

`src/renderer/tabs.js:1399-1457` 将剩余 pane 的类型、主机、用户、tabId 等字段同步回 tab，但没有同步 `tab.connected = fp.connected`。

如果 SSH pane 已断开，再关闭该 pane 只剩 local pane，退出分屏后 tab 可能仍保留旧 SSH 的连接状态，标签上的状态点、重连按钮和状态栏都会错误。

### L2. 关闭 pane 淡出期间重复 DOM — 部分有效

证据：

- `src/renderer/tabs.js:1117-1120` 保留 `.pane-exit` DOM 约 200ms。
- `src/renderer/tabs.js:707-712` 复用收集时排除 `.pane-exit`。
- 如果此窗口内再次触发分屏渲染，`buildPane()` 会为相同 pane 创建新节点，造成相同 `data-pane`/`pane-body_*` 标识短时间并存。

重复 DOM 的可能性成立，但“新元素未定位、必然出现明显闪烁”取决于准确时序和布局计算，建议标记为部分有效而非必现高确定性 bug。

### L3. 取消上传/下载后残留不完整文件 — 有效

下载：

- `src-tauri/src/zterm.rs:1995` 立即创建或截断本地文件。
- `src-tauri/src/zterm.rs:2007-2015` 在循环中检测取消并返回错误。
- `src-tauri/src/zterm.rs:2031-2035` 错误分支没有删除本地文件。

上传：

- `src-tauri/src/zterm.rs:2066-2069` 以 `CREATE | TRUNCATE | WRITE` 打开远端文件。
- `src-tauri/src/zterm.rs:2083-2091` 检测取消后返回错误。
- 没有删除远端临时文件、恢复旧文件或执行回滚。

**结论**：有效。推荐先传输到临时路径，成功后 rename；取消或失败时清理临时文件。

### P1. 拖出窗口释放后拖拽层残留 — 未确认

代码只在 document `mouseup` 中清理拖拽状态，未见 `pointercancel`、`window.blur` 或 pointer capture 兜底。因此存在清理缺口，但 WebView2/Windows 是否会在窗口外释放时继续投递 `mouseup`，静态代码无法证明。

**建议实测**：拖拽 tab 和 pane 出窗口外释放，再移回窗口检查 `tab-drag-overlay`、`pane-drop-layer` 和 `body` 的 dragging class 是否残留。

### P2. autoCopy 在 WebView2 中可能静默失败 — 部分有效/待实测

证据：

- `src/renderer.html:856-875` 的 Tauri clipboard shim 调用异步 `navigator.clipboard.writeText()`。
- `writeText()` 没有返回 Promise，也没有对返回 Promise 接 `.catch()`，异步拒绝可能成为未处理 rejection。
- 但 `src-tauri/src/main.rs:161-174` 已启用 `.enable_clipboard_access()`，且项目有 Rust `arboard` clipboard fallback。

因此“存在失败被吞掉的代码路径”成立，但“WebView2 下实际必然静默失效”不能仅凭静态代码确认。应在打包 WebView2 环境测试 selectionchange 触发时的 clipboard 行为。

### P3. 恢复异常单 pane split 后关闭唯一 pane 留下死 tab — 有效

- `_deserializeSplitTree()` 可以恢复构造出的单 pane split tree。
- `src/renderer/tabs.js:1096-1101` 在剩余 pane 数为 0 时调用 `closeTab()`。
- `closeTab()` 在 `src/renderer/tabs.js:286-288` 遇到唯一 tab 会直接 return。
- 因此唯一 tab 的 `splitRoot` 可能已被改为空，但 tab 本身没有被移除，也没有恢复普通 terminal，形成空分屏死 tab。

## 三、原文“已排查排除”项目复核

### 1. 正常路径关闭 tab 后远端会话泄漏 — 原排除结论不成立

这是原清单中最需要补充的新问题。

- `src-tauri/src/zterm.rs:1154-1176` 的 `pty_destroy()` 对 SSH 仅从 map 删除对象。
- `src-tauri/src/zterm.rs:1033-1055` 的 `ssh_disconnect()` 也没有调用 russh 显式 disconnect。
- `src-tauri/src/zterm.rs:853-863` 的 writer task 持有 SSH handle。
- `src-tauri/src/zterm.rs:902-998` 的 reader task 持有 SSH channel 并持续执行 `channel.wait()`。
- 仅删除 SessionMap 引用不能证明 socket、远端 shell 和后台 Tokio task 已终止。

这与 H3/H4 不同：H3/H4 是会话尚未进入 map；这里是已登记会话的正常关闭清理不完整。建议新增一个中高严重度条目，实测远端 shell 是否仍然存活。

### 2. “编辑密码后保存两次” — 暂可排除

未发现确定的密码清空或旧密文覆盖路径：

- 编辑未修改密码时会沿用原 `encryptedPassword`。
- 修改成功后先更新 profile，再由外层保存读取新密文。
- Tauri 保存 SSH profiles 时不会重新解密或清空密码。

仍建议增加 UI 回归测试，覆盖“打开编辑 → 修改密码 → 保存 → 再次保存/重启”。

### 3. 右键粘贴权限 — 源码层面可排除，运行时仍应验证

- `src-tauri/src/main.rs:161-174` 已调用 `.enable_clipboard_access()`。
- `src/renderer.html:856-862` 提供异步读取 shim。
- `src/renderer/terminal.js:225-235` 使用异步读取路径。
- Rust 端也注册了系统剪贴板命令。

目前没有源码证据表明缺少权限或调用了不存在的 API，但最终行为仍取决于 WebView2 运行环境。

### 4. 设置重启丢失 — 原排除结论不成立，至少存在时序竞态

- `src/renderer/main.js:68-97` 的 `saveConfig()` 通过 fire-and-forget IPC 发送保存。
- `src/renderer/main.js:101-105` 收到退出事件后先调用保存，随后立即发送 `quit-ready`。
- `src/ipc-polyfill.js:87-93` 的 `send()` 不等待 invoke 完成。
- `src-tauri/src/zterm.rs:2190-2193` 的 `quit_ready()` 直接执行 `std::process::exit(0)`。

因此保存请求可能尚未完成，进程就已退出。15 秒定时保存只能降低概率，不能消除窗口关闭前刚发生修改的丢失风险。建议改成可 await 的保存确认后再退出。

## 四、建议的修复优先级

### 第一优先级

1. H1：实现完整 SSH 公钥认证，包含私钥读取和 passphrase。
2. H2：统一 overlay 生命周期；Escape、按钮、backdrop、程序关闭都必须走同一个 cleanup。
3. H3/H4/M1：增加 in-flight SSH 连接登记、取消 token、请求代次，并确保关闭/重连只允许当前请求接管 renderer。
4. H5：统一 `_renderSplit()` 的 root 可见性和 active tab 状态，修复跨 tab 拖拽后的 DOM 层叠问题。
5. M4：损坏配置先备份、发出通知，禁止默认配置无提示覆盖原文件。
6. 新增：正常 SSH 会话关闭时显式关闭 channel/connection，并停止后台 task。

### 第二优先级

1. M2：目标失效时恢复源 pane，或在失败路径明确销毁并清理其 terminal/backend。
2. M3：SFTP 请求增加 request token 和 tab/session ownership 校验。
3. M5：关闭 tab 时联动关闭对应 SFTP overlay。
4. M6：基于结构化错误类别设计有限重试，避免字符串正则和双连接。
5. L3：使用临时文件和成功后 rename，取消时清理临时文件。

### 第三优先级

1. L1：`_exitSplit()` 同步 `tab.connected`。
2. L2：避免复用排除 `.pane-exit` 时创建同一 pane 的重复节点。
3. P1/P2：补充 WebView2 运行时测试和 pointer cancel/blur 兜底。
4. P3：恢复配置时 normalize split tree，避免单 pane/空树进入运行态。
