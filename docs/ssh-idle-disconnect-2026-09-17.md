# SSH 空闲断开：诊断边界、修复与验证

用户症状与处理状态统一见 [STATUS.md](STATUS.md)。本文记录修复前后的实现事实与可复用的验证入口。

## 修复前（诊断结论）

[zterm.rs](../src-tauri/src/zterm.rs) 曾直接构造 `russh::client::Config::default()`：russh 0.60.3 默认 `keepalive_interval: None`、`inactivity_timeout: None`，无任何周期流量。中间设备（NAT/防火墙/运营商）静默丢弃空闲连接状态后，连接呈半开形态：两端都以为活着，客户端直到下次交互才发现，且断开事件不携带任何原因（通道 EOF、Close、传输错误被抹平成同一提示）。

## 修复（52c027a）

1. **保活**：`ssh_client_config()` 设 `keepalive_interval: Some(30s)`，`keepalive_max` 保持默认 3。SSH 层 keepalive 是加密协议内消息，刷新中间设备状态；连接真死时，先由 keepalive 报文的 TCP 重传失败（Windows 约 50s）或 russh 逻辑超时（约 120s）暴露，取其先者。russh 收到任何数据即复位计数，活跃会话不会误触发。`inactivity_timeout` 保持 `None`——终端必须保住"活着但空闲"的会话。
2. **原因传播**：`SshHandler::disconnected()` 将会话级原因分类（server 协议断开 / keepalive 超时 / 传输错误）写入与读取任务共享的槽位；读取任务把它并入 `ssh-disconnected`，竞态迟到时由独立的 `ssh-disconnect-reason` 事件补齐。`ssh_disconnect` 与关 tab 路径预填槽位，用户主动关闭标为 kind=closed，不写入终端。前端把原因以暗色行追加到已断开的 tab。

## 验证

`scripts/_ssh-keepalive-rig.mjs --exe <zterm.exe> --expect dead|alive`：在 rig 上对探针连接的四元组做双向 iptables DROP（只匹配该连接的源 IP+临时端口，同机其他会话不受影响；规则由服务端 `sleep 300; iptables -D ...` 自回滚）。这就是 NAT 表项过期的可观察形态。

- 修复构建：约 50s 检出，原因经 IPC 事件命名（本次走 TCP 重传失败路径，kind=error）。
- 修复前构建（对照）：240s 窗口内全程静默——隔夜挂死形态复现。

局域网内无法直验"保活包刷新真实 NAT 映射"一环；该性质由 keepalive 产生流量直接推出。隔夜实挂降级为现场复认，不再是门禁。

## 已知边界

- 检测路径取决于哪层先放弃：Windows TCP 重传计时器（约 50s，报 os error 10054）或 russh keepalive 逻辑超时（约 120s，kind=keepalive）。两种都算修复生效。
- 若对端应用持续输出（时钟提示符、日志刷屏），半开检测延后到服务端发送窗口耗尽之后——此时连接仍部分可用，属可接受行为。
- russh 计数器语义见 `client/mod.rs` 的 keepalive 分支：`alive_timeouts` 每间隔自增，超过 `keepalive_max` 返回 `Error::KeepaliveTimeout`；收到任何包即清零。
