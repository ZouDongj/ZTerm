# SFTP 交互移植方案（Flutter → ZTerm Web）

> 来源：`D:\Code\MyTerm\zterm-flutter\lib\sftp\`（8 文件 ~2900 行，2026-09-13 侦察）
> 用户点名要抄：图标位置、呼出方式、交互动画、布局、传输列表显示逻辑、传输动画。

## Flutter 版交互架构（侦察结论）

### 全局传输浮层（global_transfer_flyout.dart）
- 图标位置：**顶栏 tab 条右侧**（⇅ swap_vert 图标，add-tab/menu 按钮那一组）
- 显隐：有传输记录才显示；有活动传输且浮层关闭时，图标右上角 **8px 圆点徽标**（primary 色 + canvas 描边）
- 浮层：按钮下方弹出（WinUI MenuFlyout 式 bottom-left 对齐），maxHeight 自适应
- 内容结构：标题「全部传输」（10.5px/w600/letterSpacing 0.8）+ 活跃计数徽章（激活时 primaryDim 底 primary 字）+「全部展开/折叠」（>1 组时）→ **按会话分组的折叠列表**（first-seen 顺序稳定不跳动；组头 = 会话名 + 连接状态 + 聚合速率 + 方向 glyph ↓/↑/⇅；组内 active 在前 history 在后）→ 空态「暂无传输记录」
- 滚动条：6px、text3 50%、圆角 3

### SFTP 浏览面板（sftp_panel.dart）
- **per-pane 右侧停靠**（非全屏 overlay），默认宽 312px、per-pane 记忆可拖宽
- 呼出：顶栏 folder/folder_open 图标 toggle（仅当前 tab 是 SSH 会话时显示）+ 快捷键
- 结构：Header（folder 图标 + 「文件」13px w600 + 右侧 host chip）→ 地址栏 → 工具行 → 文件列表 + **底部内嵌传输区**（初始高 190px，可拖高，per-会话记忆）
- 拖放悬浮：accent 78% 1.2px 边框
- 配色从终端方案派生（与我们的 surface 派生同思路）

### 传输动画（transfer_visuals.dart + 不变量）
- 进度条：**4px 高 / 2px 圆角**，track 底 + primary 填充，进度变化做 **ease 插值**（0.001 死区，animate=false 时瞬跳）
- 动画不变量（历史教训，必须保持）：always-listen（监听器常驻，empty→active 状态切换不重建）；单一滚动条；44px chrome；AnimatedSize 稳定（列表高度变化不跳动）；拖拽语义
- 速度显示节流 300ms（ZTerm 已有同款）

## ZTerm 现状对照

| 项 | Flutter | ZTerm 现状 | 动作 |
|---|---|---|---|
| 传输入口 | 顶栏 tab 条右侧 ⇅ + 徽标点 | 状态栏 transfer-btn（有传输才显示） | **挪位置**：titlebar 内 add-tab 按钮旁 |
| 传输列表 | 按会话分组折叠 + 聚合速率 | 平铺列表（_history 不带会话归属） | **重写**：分组结构，history 补 tabId |
| 进度条 | 4px + ease 插值 + 死区 | 现有样式 | 重做组件 |
| SFTP 浏览 | 右侧停靠面板 312px 可拖宽 + 底部内嵌传输区 | 全屏 overlay（菜单呼出） | **布局级改造**（Phase B） |
| 呼出 | 顶栏 folder 图标（仅 SSH tab） | 菜单/快捷键 | Phase B 随停靠化一起 |

## 实施分期

**Phase A（独立可验收，不动布局）**：全局传输浮层——入口挪到顶栏 + 分组折叠列表 + 徽标点 + 新进度条。保留 transfer-btn/panel 的 DOM id，e2e 不破坏。
**Phase B（布局级）**：SFTP 浏览面板停靠化——overlay → 右侧 dock（312px 可拖宽 per-tab 记忆）+ 顶栏 folder 呼出 + 底部内嵌传输区 + 拖放边框。需要动 main-area 布局与 e2e 的 overlay-sftp 断言，单独一轮做。

## 数据层缺口
- `_history` 需补 `tabId`（归组用）；会话显示名解析复用 ssh.js 的 profile 名逻辑（Flutter 的 GlobalSessionResolver 对应物）
- 活动传输的 bytesPerSecond：TransferManager._speed 已有 ✓
