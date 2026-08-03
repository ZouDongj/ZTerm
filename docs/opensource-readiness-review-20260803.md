# ZTerm 开源前代码质量检视报告

- **检视日期**：2026-08-03
- **检视对象**：当前 `tauri-migration` 分支，`HEAD`：`453fb38`
- **检视范围**：`src/`、`src-tauri/`、构建配置、依赖、README、docs
- **工作区状态**：检视开始时干净
- **检视方式**：静态代码审查、最近三批修复对照、敏感信息扫描、Rust 编译与格式检查
- **是否修改源码**：否

## 总体结论

当前代码已经完成一轮针对高、中、低严重度问题的修复，核心功能具备继续打磨的基础，但**暂不建议直接作为正式开源版本发布**。

目前最重要的风险集中在：

1. SSH 连接和 SFTP 传输的异步任务生命周期仍不完整。
2. 配置和 `known_hosts` 的并发保存存在覆盖风险。
3. 正式 Tauri 构建仍注册 PoC 命令，其中包含读取本地 SSH 私钥的接口。
4. 文档中包含真实公网服务器、端口和用户名信息。
5. README、启动方式和实际 Electron/Tauri 架构不完全一致。
6. 缺少正式自动化测试和 CI，Rust 格式检查当前未通过。

建议完成“发布阻塞项”后，再进行一次以真实 SSH/SFTP 服务器和 WebView2 为主的运行时回归测试。

## 严重度说明

- **高**：可能造成远端会话/文件残留、敏感信息暴露、数据丢失，或阻塞安全发布。
- **中**：会造成可靠性问题、状态损坏或明显维护成本。
- **低**：边界行为、工程质量或发布规范问题。

## 高严重度问题

### H1. 取消中的 SSH 连接仍可能泄漏资源

**证据**：

- [zterm.rs:814](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:814) 的 `russh::client::connect(...).await` 无法被原子标志直接中断。
- [zterm.rs:856](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:856) 及后续认证、channel、shell 操作都只在 await 之间检查取消状态。
- shell 建立后，writer task 和 reader task 分别在 [zterm.rs:974](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:974) 与 [zterm.rs:1027](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1027) 启动。
- [zterm.rs:1117](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1117) 的最后一次取消检查与 [zterm.rs:1121](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1121) 写入 `SessionMap` 之间仍存在竞态。

**影响**：

如果连接在最后一次检查后被取消，函数可能直接返回而不登记 session，但已经启动的后台 task 仍持有 SSH channel/handle。后续 `pty_destroy` 无法找到并清理它，可能留下远端 shell、TCP 连接和 Tokio task。

**建议**：使用可取消的连接任务封装，确保所有提前返回路径都显式关闭 channel/handle；最好让 session 统一拥有 reader/writer/transfer task，并在 `Drop` 或显式 close 中完成回收。

### H2. 关闭 tab 不会取消正在进行的 SFTP 传输

**证据**：

- SFTP transfer 使用独立的 cancel map，见 [zterm.rs:2148](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2148) 和 [zterm.rs:2232](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2232)。
- 下载、上传 task 分别在 [zterm.rs:2174](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2174) 和 [zterm.rs:2263](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2263) 启动。
- 关闭 session 的 [pty_destroy:1323](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1323) 只移除 session 并断开 SSH handle，没有遍历并设置 transfer cancel flag。

**影响**：

关闭 tab 后，传输可能继续写入本地或远端临时文件，甚至在 tab 已关闭后完成 rename。此时 renderer 已无法通过 SessionMap 找到 transfer 并取消它。

**建议**：将 transfer task 纳入 SSH session 生命周期，关闭 session 时统一取消并等待；完成、失败、取消、session 销毁都必须清理 registry 和临时文件。

### H3. SFTP 临时文件名固定，多个传输会互相覆盖

**证据**：

- 下载临时文件固定为 `local_path + ".zterm-tmp"`，见 [zterm.rs:2164](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2164)。
- 上传临时文件固定为 `remote_path + ".zterm-tmp"`，见 [zterm.rs:2247](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2247)。

**影响**：

同一目标同时传输时，任务会共享临时文件。一个任务可能截断另一个任务的内容，失败清理也可能删除仍在使用的文件，最终产生损坏文件或错误覆盖。

**建议**：临时文件名加入随机 nonce 或唯一 transfer ID，并使用独占创建；同一目标的并发策略应明确为排队、拒绝或覆盖。

## 中严重度问题

### M1. SFTP 初始化失败会遗留 cancel registry

**证据**：

取消 flag 在远端文件打开、metadata、本地文件创建等初始化操作前就插入 map，见 [zterm.rs:2149-2165](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2149) 和 [zterm.rs:2233-2253](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2233)。这些操作失败时函数提前返回，不会执行 task 末尾的 `c.remove()`。

**影响**：长期运行、多次失败或重复使用同一 transfer ID 时，registry 会残留失效条目，取消命令可能操作已经不存在的传输。

**建议**：完成所有初始化后再登记，或引入统一清理 guard。

### M2. 合法但结构错误的配置不会触发损坏备份

**证据**：

- [zterm.rs:399-413](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:399) 只判断 JSON 语法是否正确。
- 根值为数组、字符串、数字、`null` 时不会被视为损坏并备份。
- 对象字段类型也没有 schema 校验。

**影响**：用户配置可能被静默忽略并回退默认值，却没有 `.corrupt-*` 备份或通知；后续保存可能进一步覆盖原有数据。

**建议**：使用 serde 配置结构体、版本迁移和字段类型校验；语法错误与结构错误统一走备份恢复流程。

### M3. 配置保存存在并发覆盖和固定临时文件竞争

**证据**：

- 多个保存命令分别执行 load-modify-save，例如 [zterm.rs:1349](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1349)、[zterm.rs:1360](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1360)、[zterm.rs:1481](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:1481)。
- 主配置临时文件固定为 [zterm.rs:442](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:442) 的 `config.json.tmp`。
- fallback 路径仍使用非原子的直接写入，见 [zterm.rs:447-454](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:447)。

**影响**：快速连续保存不同设置时，后完成的旧快照可能覆盖先完成的修改；并发写入可能互相覆盖临时文件。fallback 路径还可能在崩溃时留下截断 JSON。

**建议**：在进程内使用单一配置锁/串行保存队列，临时文件使用唯一名称；fallback 和数据目录切换也必须采用同样的原子写入策略，并检查错误。

### M4. `known_hosts` 并发读改写可能丢失信任记录

**证据**：

- [zterm.rs:278-282](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:278) 执行无锁的 load-modify-save。
- [zterm.rs:241-249](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:241) 使用固定的 `known_hosts.json.tmp`。

**影响**：多个首次连接或 hostkey trust 同时发生时，后写入的一方可能覆盖另一方的主机记录；并发 rename 还可能失败或留下临时文件。

**建议**：使用进程内锁串行更新，并为临时文件使用唯一名称。

### M5. 自动重试依赖不稳定的错误字符串

**证据**：

- [ipc.js:180-183](/D:/Code/MyTerm/ZTerm/src/renderer/ipc.js:180) 根据 russh 错误文本匹配 timeout、key exchange、network 等关键词。
- 错误文本并不是稳定的跨版本 API。

**影响**：可能漏重试确定的瞬时故障，也可能误重试不应重试的错误。重试逻辑仍需要与连接请求代次严格绑定。

**建议**：Rust 后端返回结构化错误类别，前端只对明确的瞬时网络错误执行一次重试。

## 低严重度及开源质量问题

### L1. Tauri command 参数缺少严格校验

多个命令对缺少字段使用默认值：

- SSH host/username/port： [zterm.rs:747-760](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:747)
- SFTP transfer ID： [zterm.rs:2140-2146](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2140)
- SFTP 路径： [zterm.rs:2123-2127](/D:/Code/MyTerm/ZTerm/src-tauri/src/zterm.rs:2123)

这会把非法请求转换为 `localhost:22`、空路径或共享 ID `0`。建议改用强类型参数并拒绝非法输入，而不是静默采用默认值。

### L2. Rust 代码未通过格式检查

执行：

```text
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

结果失败，`src-tauri/src/main.rs` 和 `src-tauri/src/zterm.rs` 存在大量格式差异。应在提交前执行 `cargo fmt`，并将 `cargo fmt --check` 纳入 CI。

### L3. 正式构建仍注册 PoC 命令

`src-tauri/src/main.rs:136-158` 注册了多个 PoC 命令，包括：

- `poc_ssh_read_local_key()`：读取默认 SSH 私钥并返回内容
- `poc_pty_start()`：启动传入的 shell
- `poc_ssh_connect()`：接收私钥内容并建立 SSH 连接

这些命令当前没有正式 UI 使用，但开源版本不应暴露测试接口。建议删除，或仅在独立的 debug/test feature 中编译注册。

### L4. Tauri 生产配置关闭 CSP

[tauri.conf.json:11](/D:/Code/MyTerm/ZTerm/src-tauri/tauri.conf.json:11) 设置了 `"csp": null`，同时启用 `withGlobalTauri`。当前页面主要加载本地资源，但开源后若引入外部内容或插件，脚本注入后的影响面会扩大。

建议为 Tauri 配置明确 CSP，并保持所有资源本地化；Electron 的安全配置也应与 Tauri 分别说明。

### L5. README 与当前架构/启动方式不一致

README 的技术栈仍主要描述 Electron、node-pty 和 russh NAPI bindings，见 [README.md:36-42](/D:/Code/MyTerm/ZTerm/README.md:36)。但当前仓库包含正式 Tauri Rust 后端，`npm start` 启动的是 Electron 路径。

开源前必须明确：

- Electron 还是 Tauri 是主线
- 开发和打包分别使用什么命令
- 两套后端是否都受支持
- russh 的实际依赖和来源

### L6. 文档含真实测试基础设施信息

[docs/verify-first-batch.md:5](/D:/Code/MyTerm/ZTerm/docs/verify-first-batch.md:5) 及后续多处包含真实公网 IP、端口和用户名。

这是开源发布阻塞项。应替换为 `example.com:22`、`test-user` 等占位符，并在推送前检查完整 Git 历史，因为已提交信息不会因修改当前文件而消失。

### L7. 缺少正式测试和 CI

仓库没有正式 `test` script，也没有发现 CI workflow。当前能验证的主要是编译：

- Rust 编译通过
- 但没有 SSH 连接关闭/重连测试
- 没有 SFTP 取消和并发传输测试
- 没有配置损坏恢复测试
- 没有 tab/split 竞态测试
- 没有 WebView2 GUI 回归测试

这些缺口对终端软件尤其重要，因为大部分高风险问题都发生在异步事件和生命周期交错场景中。

## 已执行验证

| 检查 | 结果 |
|---|---|
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过，有 5 个 warning |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 失败，大量格式差异 |
| `git diff HEAD~3..HEAD --check` | 通过 |
| `npm audit --omit=dev` | 未完成；当前 npm mirror 返回 `404 / NOT_IMPLEMENTED` |
| 自动化测试 | 未发现正式测试脚本或 CI workflow |

## 开源发布前阻塞清单

在公开 GitHub 仓库或发布安装包前，建议至少完成以下事项：

- [ ] 删除或隔离正式构建中的所有 PoC invoke 命令。
- [ ] 清理文档、源码注释和 Git 历史中的真实服务器、端口、用户名及测试凭据线索。
- [ ] 完善 SSH pending connection 的取消和统一回收，确保所有提前返回路径关闭 handle/channel/task。
- [ ] 关闭 SSH session 时统一取消并等待 SFTP transfer task。
- [ ] 使用唯一 SFTP 临时文件名，处理初始化失败和关闭 tab 清理。
- [ ] 为配置和 `known_hosts` 增加串行写入锁、结构校验、唯一临时文件和完整错误处理。
- [ ] 为 Tauri 设置明确 CSP，确认生产构建不启用不必要的开发权限。
- [ ] 严格校验 Tauri command 参数，拒绝空路径、无效端口和缺失 transfer ID。
- [ ] 统一 Electron/Tauri 的 README、启动、构建和支持范围说明。
- [ ] 执行 `cargo fmt`，加入 `cargo fmt --check`、`cargo check` 和依赖审计 CI。
- [ ] 增加 SSH、SFTP、配置恢复、tab/split 竞态的回归测试。
- [ ] 使用脱敏测试环境重新验证全部高严重度修复。

## 最终判断

当前版本可以作为**内部 beta 或继续开发分支**，但还不适合作为“开源即用”的正式版本。优先级最高的发布阻塞项是：

1. 移除 PoC 暴露面和真实基础设施信息。
2. 修复 SSH/SFTP 后端任务生命周期。
3. 修复配置与 known_hosts 的并发持久化。
4. 建立最小 CI 和异步生命周期回归测试。
5. 统一并修正文档中的 Electron/Tauri 架构说明。
