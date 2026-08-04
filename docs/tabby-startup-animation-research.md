# Tabby Terminal 启动界面与启动动画调研

- 调研对象：官方仓库 [Eugeny/tabby](https://github.com/Eugeny/tabby)
- 固定源码版本：`ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e`（`dep pins`，2026-07-12）
- 本文只引用官方 GitHub 源码、官方仓库提交历史；行号以固定 commit 页面为准。
- 对照对象：`D:\Code\MyTerm\ZTerm` 当前 Tauri + 原生 HTML 架构。

## 结论摘要

Tabby 的“启动动画”不是 Angular 路由页面切换动画，而是两层机制叠加：

1. Electron `BrowserWindow` 创建时 `show: false`，renderer 文档 `did-finish-load` 后才 `show()`；因此窗口不会在 HTML/脚本尚未完成加载时闪出。
2. 页面自身在 preload 阶段已经有一个覆盖全屏的静态启动壳 `.preload-logo`，显示 logo、Tabby 标题和插件加载进度条。Angular 根组件挂载后，根组件再执行一次 `fadeIn`。

Angular 的 `StartPageComponent` 是“应用已启动后没有标签页时的常规起始页”，不是一个独立的 Electron splash screen。首个终端的 xterm 前端 ready 会触发 PTY/session 初始化，但 Tabby 当前代码没有把 `.preload-logo` 的移除绑定到 xterm 首帧；它主要把插件加载进度写入进度条，随后由 Angular 内容覆盖启动壳。

对 ZTerm 最值得保留的是“主进程先隐藏、恢复窗口状态后显示”和“渲染器用明确 ready 状态控制界面”。不宜直接照搬 Tabby 的 Angular/插件启动层，也不宜把启动页隐藏完全绑定到终端首帧而没有失败、无标签和超时状态。

## 1. 官方源码与版本基线

官方仓库：<https://github.com/Eugeny/tabby>

固定 commit：<https://github.com/Eugeny/tabby/commit/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e>

本文主要引用：

- `app/lib/index.ts`：Electron 主进程入口和创建首窗。
- `app/lib/window.ts`：`BrowserWindow` 选项、加载页面、显示时机、`app:ready` Promise。
- `app/index.pug`、`app/src/preload.scss`：Angular 启动前的 HTML/CSS 启动壳。
- `app/src/entry.ts`、`app/src/plugins.ts`、`app/src/app.module.ts`：renderer bootstrap、插件发现/加载、Angular 根模块。
- `tabby-core/src/components/appRoot.component.*`：根组件 ready 状态、常规 StartPage、根组件淡入和标签动画。
- `tabby-core/src/components/startPage.component.*`：无标签时显示的产品起始页。
- `tabby-core/src/services/config.service.ts`、`app.service.ts`：配置 ready 和 tab 恢复顺序。
- `tabby-local/src/components/terminalTab.component.ts`、`tabby-terminal/src/api/baseTerminalTab.component.ts`：终端前端 ready、session/PTY 初始化。

## 2. Electron 主进程窗口创建与 show 时机

### 2.1 进程入口

`app/lib/index.ts` 在模块加载阶段读取配置；读取失败直接显示原生错误框并以 1 退出（第 28-33 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/index.ts#L28-L33>

随后创建 `Application`（第 35-37 行），在 Electron `ready` 事件中调用 `application.init()`、`application.newWindow({ hidden: argv.hidden })`，等待 `window.ready`，再转发 CLI 参数（第 93-115 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/index.ts#L35-L37>

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/index.ts#L93-L115>

### 2.2 BrowserWindow 初始不可见

`app/lib/window.ts` 构造 `BrowserWindowConstructorOptions` 时明确设置：

- `show: false`（第 61-78 行，重点是第 75 行）。
- 初始尺寸 800x600、最小尺寸 400x300。
- `backgroundColor: '#00000000'`。
- `loadFile` 的目标是打包后的 `dist/index.html`。

源码：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/window.ts#L53-L78>

窗口构造完成后，在 `webContents.once('did-finish-load', ...)` 中设置 vibrancy/dark mode，然后除非是 hidden 窗口才 `maximize()` 或 `show()`，接着 `focus()`、`moveTop()`、`application.focus()`（第 114-135 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/window.ts#L114-L135>

这里的关键边界是：Tabby 的窗口显示等待的是 HTML 文档加载完成，不是 `ready-to-show`，也不是 Angular bootstrap 完成，更不是终端首帧。相关提交是官方 commit `e8fdb8b8f93a9d1cfa2dba77181b2d2376465441`：

- 提交页：<https://github.com/Eugeny/tabby/commit/e8fdb8b8f93a9d1cfa2dba77181b2d2376465441>
- 变更文件：`app/lib/window.ts`
- 该提交将 `this.window.once('ready-to-show', ...)` 改成 `this.window.webContents.once('did-finish-load', ...)`，并将 `loadURL(file://...)` 改成 `loadFile(...)`。
- 差异提交：<https://github.com/Eugeny/tabby/commit/e8fdb8b8f93a9d1cfa2dba77181b2d2376465441>

`Window.ready` 不是 `did-finish-load` 本身，而是等待 renderer 发来的 `app:ready` IPC。构造函数第 172-180 行注册 listener，只接受当前窗口 webContents 发来的事件：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/window.ts#L172-L180>

`Application.newWindow()` 创建 `Window` 后订阅窗口可见/关闭事件，等待 `await window.ready` 才返回（第 117-141 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/app.ts#L117-L141>

因此存在两个不同的时机：

- `did-finish-load`：主进程允许显示窗口。
- renderer `app:ready`：Angular 根组件配置已 ready，并且 renderer 告知主进程可以把 `newWindow()` 视为 ready。

`Window` 还在窗口 `show` 事件中发出 `host:window-shown`（`window.ts` 第 323-327 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/window.ts#L323-L327>

### 2.3 启动失败处理

主进程 `ready` 回调把窗口创建、renderer ready 和 CLI 转发放在 try/catch 中；失败时记录 `logMainError`，显示原生 `dialog.showErrorBox('Tabby failed to start', ...)`，最后退出（`index.ts` 第 105-115 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/index.ts#L105-L115>

这意味着“窗口没有显示”不是静默卡住：主进程初始化失败有原生错误出口。

## 3. Renderer 启动壳、Angular 根组件和路由/加载状态

### 3.1 没有 Angular Router 参与首屏

`app/index.pug` 的结构是静态页面：`root`、`app-root`，并在 `app-root` 内预先放入 `.preload-logo`。它没有 Angular route 配置，也没有通过路由切换 splash/start page：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/index.pug#L1-L23>

`entry.ts` 启动时直接执行 `location.hash = ''`，注释是“Always land on the start view”（第 19-20 行）。这不是路由导航实现，而是清空 hash，确保从 start view 开始：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts#L19-L20>

### 3.2 preload-logo 是实际的启动界面

`app/index.pug` 预置：

- `.preload-logo`
- `.tabby-logo`
- `h1.tabby-title Tabby α`
- `.progress .bar`，初始宽度 0%

源码：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/index.pug#L14-L23>

`app/src/preload.scss` 将 `.preload-logo` 固定覆盖整个 viewport，使用黑色背景和 radial-gradient，内容居中；`.progress .bar` 有 1 秒 ease-out 的 width 过渡（第 5-36 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/preload.scss#L5-L36>

同一文件定义 `fadeIn`：0 到 1 的 opacity 动画，时长 0.5 秒、ease-out（第 39-42 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/preload.scss#L39-L42>

logo 与标题样式位于第 46-67 行：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/preload.scss#L46-L67>

### 3.3 Angular 根组件 ready 状态

`AppRootComponent` 使用 `@Input() ready = false`（`appRoot.component.ts` 第 55-72 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.ts#L55-L72>

模板里，标题栏、profile tree、主内容区都受 `ready` 控制；内容区只有 ready 后才创建。没有 tab 时显示 `<start-page>`，有 tab 时创建 `tab-body`（`appRoot.component.pug` 第 1-22、109-118 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.pug#L1-L22>

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.pug#L109-L118>

`ngOnInit()` 等 `config.ready$` 完成后才设 `ready = true` 并调用 `app.emitReady()`（`appRoot.component.ts` 第 191-195 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.ts#L191-L195>

`appRoot.component.scss` 在 host 上定义 0.5 秒 ease-out `fadeIn`，同时设置 100vw/100vh 和 overflow hidden（第 1-16 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.scss#L1-L16>

这里的根组件动画只是 Angular 根 DOM 的淡入，不是“等终端完成后再淡出启动遮罩”。

### 3.4 StartPage 的语义

`StartPageComponent` selector 是 `start-page`，通过 `CommandService` 获取 `CommandLocation.StartPage` 命令（第 7-25 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/startPage.component.ts#L7-L25>

模板显示 Tabby logo/title、可执行命令列表、GitHub、报告问题和版本号（第 2-27 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/startPage.component.pug#L2-L27>

它的 SCSS 只是布局、宽度、footer 和图标尺寸，没有启动动画 keyframes（第 1-31 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/startPage.component.scss#L1-L31>

所以应严格区分：

- `.preload-logo`：启动期间的加载壳，显示插件进度。
- `start-page`：配置 ready 后、`app.tabs.length == 0` 时的正常空标签页。

## 4. Angular bootstrap、插件加载和失败/安全模式

### 4.1 renderer bootstrap 顺序

`entry.ts` 先导入全局样式和插件发现/加载函数；`bootstrap()` 先按 safe mode 过滤插件，再 `loadPlugins()`，然后 `getRootModule(pluginModules)`，最后 `platformBrowserDynamic(...).bootstrapModule(module)`（第 1-54 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts#L1-L54>

真正的启动数据由主进程 `start` IPC 提供。renderer 收到后依次：

1. `initModuleLookup(bootstrapData.userPluginsPath)`。
2. `findPlugins()`。
3. 写入 `bootstrapData.installedPlugins`。
4. 应用 `pluginBlacklist`，过滤 web 插件。
5. 调用正常 `bootstrap()`。
6. 失败后记录 `safeModeReason`，仅加载 builtin 插件重试。

源码：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts#L57-L82>

文件末尾先向主进程发送 `ready`（第 84 行）。注意：该 `ready` 是 renderer 已加载 entry 脚本、可以接收主进程 `start` 的信号，不等同于 Angular app ready：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts#L84-L84>

### 4.2 插件发现与加载

`initModuleLookup()` 将 builtin、app node_modules、user plugin node_modules 等目录加入 Node module lookup path，并缓存 Angular 等 builtin module（`plugins.ts` 第 20-94 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/plugins.ts#L20-L94>

`findPlugins()` 从全局 module paths 发现 `tabby-`/旧 `terminus-` 前缀插件，读取 package.json、检查关键词、处理重复插件并排序；package 信息读取失败会 `console.error` 并返回 null，不会直接抛出（第 99-226 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/plugins.ts#L99-L226>

`loadPlugins()` 对每个插件执行 `require`，调用 `packageModule.default.forRoot()`（若存在），保存 `bootstrap` 组件；单个 require 失败只记录 `Could not load ...`，然后继续推进进度并以 50ms timeout 结束该 Promise（第 229-262 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/plugins.ts#L229-L262>

进度写入 `.progress .bar` 的代码在 `entry.ts` 第 39-41 行：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts#L34-L48>

进度不是严格的真实时间百分比：`loadPlugins()` 先 `progress(0, 1)`，每个插件按完成数回调，最后 `progress(1, 1)`；而且插件 Promise 并行执行（第 229-261 行）。因此它是“加载阶段反馈”，不应被当作完整启动耗时预测。

### 4.3 空 bootstrap 和安全模式

`getRootModule()` 将插件模块放进 Angular imports，把带 `bootstrap` 的组件收集起来；若没有任何 bootstrap component，直接抛出 `Did not find any bootstrap components. Are there any plugins installed?`（`app.module.ts` 第 6-37 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/app.module.ts#L6-L37>

正常 Angular bootstrap 失败时，renderer 进入 builtin-only safe mode，并把原始异常放到 `window['safeModeReason']`。根组件检测到这个字段后打开 `SafeModeModalComponent`（`appRoot.component.ts` 第 147-153 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.ts#L147-L153>

这套设计提供了三层故障出口：单插件失败继续启动、整体 Angular bootstrap 失败切换 safe mode、主进程创建失败显示原生错误框退出。官方 safe-mode 处理的历史提交是 `80699ee13fca96cae0282bc1d604448c90848371`：

- 提交页：<https://github.com/Eugeny/tabby/commit/80699ee13fca96cae0282bc1d604448c90848371>
- 该提交在 `app/src/entry.ts` 增加 `bootstrap(..., safeMode)` 和失败重试，并在 `app/src/plugins.ts` 侧保留插件加载错误处理。

## 5. Terminal 初始化顺序与“首帧”边界

### 5.1 配置 ready 先于恢复 tab

`ConfigService` 构造时异步 `init()`；`load()` 读取配置、没有配置时创建 `{ version: LATEST_VERSION }`，解密/迁移后建立 `ConfigProxy`（第 143-180、217-228 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/services/config.service.ts#L143-L180>

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/services/config.service.ts#L217-L228>

`AppService` 订阅 `config.ready$`；主窗口且开启 `recoverTabs` 时，读取恢复 token 并逐个 `openNewTabRaw()`（第 74-111 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/services/app.service.ts#L74-L111>

`AppRootComponent.ngOnInit()` 同样等待 `config.ready$` 后才把根 UI 标记 ready。因此典型顺序是：Angular module bootstrap -> 配置加载 -> 根 UI ready/app:ready -> 主窗口 Promise resolve；窗口实际 show 则早于 `app:ready`，因为主进程在 `did-finish-load` 就 show。

### 5.2 Local terminal 的 session 创建点

`TerminalTabComponent.ngOnInit()` 先读取 profile/options，判断 ConPTY，再调用 `super.ngOnInit()`（第 27-49 行）。`onFrontendReady()` 中以当前 xterm columns/rows 调用 `initializeSession()`，然后设置恢复状态并调用父类逻辑（第 51-55 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-local/src/components/terminalTab.component.ts#L27-L55>

`initializeSession()` 创建 `Session`，必要时 patch UAC 选项，调用 `session.start(...)`，再 `setSession(session)`（第 57-75 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-local/src/components/terminalTab.component.ts#L57-L75>

### 5.3 BaseTerminalTab 的 frontend ready 顺序

Base terminal 组件在 `ngOnInit()` 中根据 WebGL workaround 和设置选择 `XTermFrontend` 或 `XTermWebGLFrontend`，创建 frontend（第 360-375 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-terminal/src/api/baseTerminalTab.component.ts#L360-L375>

然后：

- 监听 frontend 的第一次 resize，把 columns/rows 写入 `size`。
- 发出 `frontendReady`，触发 `onFrontendReady()`。
- 之后附加 decorators、延迟 resize session、释放 session 初始数据缓冲区。
- 用 `setImmediate()` attach 到 DOM content，配置 frontend。

源码：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-terminal/src/api/baseTerminalTab.component.ts#L377-L452>

默认父类 `onFrontendReady()` 会把 `frontendIsReady = true`，恢复 saved state，并订阅 input（第 454-469 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-terminal/src/api/baseTerminalTab.component.ts#L454-L469>

这里的“ready”是 frontend 已获得尺寸并可接 session 的内部状态；官方启动壳的隐藏并未在这些代码中与 xterm 的第一次绘制直接连接。

### 5.4 PTY 后端

Electron 主进程的 `PTYManager.init()` 注册 `pty:spawn`；收到 IPC 后同步返回 UUID 并创建 `new PTY(...)`（`app/lib/pty.ts` 第 140-148 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/pty.ts#L140-L148>

`PTY` 构造函数立即 `node-pty.spawn(...)`，建立 output queue、接收 onData、在退出时标记 `exited`（第 90-109 行）：

<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/pty.ts#L90-L109>

这说明 Tabby 没有等待 shell 首次输出才显示 Electron 窗口；窗口/Angular UI 和 PTY 输出是相互独立的生命周期，terminal tab 自己负责在 frontend ready 后启动 session。

## 6. CSS/SCSS 动画清单

### 真正与启动相关

1. `app/src/preload.scss`：`.preload-logo { animation: 0.5s ease-out fadeIn; }`，启动壳淡入；进度条 `.bar` 有 `transition: 1s ease-out width`。
   - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/preload.scss#L5-L42>
2. `tabby-core/src/components/appRoot.component.scss`：`:host { animation: 0.5s ease-out fadeIn; }`，Angular 根组件淡入。
   - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.scss#L1-L16>
3. `app/index.pug` 内联 `body { transition: 0.5s background; }`。
   - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/index.pug#L11-L13>

### 不是启动页动画，但容易混淆

- 根组件的 `animateTab`：新增/移除 tab 时 250ms 改变宽度/flex-basis，不是启动动画（`appRoot.component.ts` 第 21-52、60-62 行）。
  - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.ts#L21-L62>
- Base terminal 的 toolbar/panel slide：100ms enter/leave，是终端内工具栏/面板动画（`baseTerminalTab.component.ts` 第 30-67 行）。
  - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-terminal/src/api/baseTerminalTab.component.ts#L30-L67>
- `global.scss` 的 `terminalShakeFrames` 是响铃视觉反馈，不是启动动画（第 133-149 行）。
  - <https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/global.scss#L133-L149>

## 7. 与 ZTerm 当前架构对照

以下均为当前工作区源码观察，不代表 Tabby 官方代码。

### 7.1 Tauri 主进程窗口

ZTerm 在 `src-tauri/src/main.rs` 的 Tauri `setup` 中手动创建 `WebviewWindow`，URL 为 `renderer.html`，窗口 `.visible(false)`，恢复窗口位置/尺寸/最大化后再 `window.show()`，然后 emit `window-shown`（第 71-112 行）：

- [main.rs](../src-tauri/src/main.rs#L71-L112)

这与 Tabby 的“先创建不可见窗口，再在状态准备好后 show”原则一致；ZTerm 还把窗口状态恢复放在 show 之前，避免默认尺寸闪现。`window-shown` 事件是 ZTerm 自己的 renderer 动画触发点，不是 Tabby 的原样机制。

ZTerm 的 `.visible(false)` 和 `show()` 更接近 Tabby 的 `show: false`/`did-finish-load` 设计，但当前 ZTerm 在 `show()` 后立即 emit `window-shown`，并没有等待 renderer 的配置或终端 ready。

### 7.2 原生 HTML 启动壳

ZTerm 在 `src/renderer.html` 第 9-32 行预置 `.startup-splash`，包含 SVG、ZTerm 名称和“正在启动…”提示：

- [renderer.html](../src/renderer.html#L9-L32)

CSS 在 `src/renderer/app.css` 第 8-24 行定义窗口淡入、splash 固定覆盖和离场 opacity transition：

- [app.css](../src/renderer/app.css#L6-L24)

renderer 在 `src/renderer/main.js` 第 97-133 行监听 `window-shown`，添加 `.win-in`；随后轮询第一个 terminal，监听 xterm `onRender`，触发 splash `.leaving`，450ms 后 remove，同时有 3 秒兜底：

- [main.js](../src/renderer/main.js#L97-L133)

这比 Tabby 当前源码更明确地把启动 splash 与终端首个 render 绑定。但这也引入一个必须处理的边界：如果配置加载、profiles IPC、PTY 创建或 xterm 初始化失败，首个 terminal 可能永远不存在；ZTerm 当前 3 秒兜底只负责移除 splash，没有把错误状态呈现给用户。

### 7.3 ZTerm 当前 renderer 初始化顺序

`main.js` 的初始化 IIFE 依次：

1. `get-data-dir-info`。
2. `loadSettings()`。
3. `loadQuickCommands()` 和 `loadHighlightRules()`。
4. 应用颜色、终端 scheme、UI font。
5. 应用 animations 设置。
6. `TabManager.init()`。
7. `armSplashHide()`。

源码：[main.js](../src/renderer/main.js#L137-L155)

`TabManager.init()` 监听 `profiles` IPC；无可恢复 tab 时补默认 local profile，随后 `createTabSilent()`，local tab 通过 `pty-create` 启动 shell，render 后切换首 tab（[tabs.js](../src/renderer/tabs.js#L79-L171)）。`createTabSilent()` 在第 181-205 行创建 tab 并发送 `pty-create`：

- [tabs.js](../src/renderer/tabs.js#L181-L205)

xterm 的 `wireTerminal()` 创建 `Terminal`、加载 Fit/WebGL/Search 等 addon、`term.open(inner)`、保存 `tab.term`，50ms 后首次 fit，随后通过 ResizeObserver 监听布局（[terminal.js](../src/renderer/terminal.js#L127-L185)）：

- [terminal.js](../src/renderer/terminal.js#L127-L185)

因此 ZTerm 的实际启动链路是：窗口显示/事件 -> settings -> profiles -> tab/PTY -> DOM terminal -> xterm open/fit -> `onRender` -> splash fade out。窗口显示并不等待这条链路完成。

## 8. 可借鉴点

### 8.1 借鉴窗口可见性边界

保留 ZTerm 当前“隐藏创建、恢复尺寸/最大化、show”的顺序。若后续需要更稳定的 renderer 状态，可增加一个单向 `renderer-ready` 事件，但不要让主进程无期限等待终端首帧，否则 PTY、WebGL 或配置异常会让窗口不可见。

推荐把状态拆成：

- `window-visible`：主进程已经恢复窗口状态并 show。
- `renderer-ready`：HTML/基础脚本、配置加载完成，UI 可交互。
- `terminal-ready`：首个 xterm 完成 open/fit，允许淡出 splash。
- `startup-error`：配置、profiles、PTY、SSH 或终端 frontend 的明确失败。

### 8.2 借鉴“静态壳先于框架”

Tabby 的 `.preload-logo` 在 Angular 尚未 bootstrap 前就存在，避免白屏；ZTerm 已采用同类原生 HTML splash。这个模式适合 Tauri + 原生 HTML，因为不需要再引入路由或组件框架。

### 8.3 借鉴进度反馈，但只表示阶段

Tabby 的插件进度条是阶段性反馈，且插件并行加载、回调不代表精确 ETA。ZTerm 如展示启动进度，建议使用有限阶段：`加载设置`、`恢复标签`、`启动终端`、`完成`，不要伪造精确百分比。

### 8.4 借鉴 safe mode / 单项容错

Tabby 对单插件加载失败继续启动，对整体 bootstrap 失败切换 builtin-only safe mode；ZTerm 可以采用更轻量的等价策略：

- 设置损坏：加载默认设置并显示“设置已重置/读取失败”。
- profiles 失败：显示默认 shell 或空状态。
- PTY 创建失败：保留标签页，显示错误和“重试/关闭”操作。
- xterm addon 失败：终端仍使用基本 renderer，不因 WebGL/Search addon 失败阻塞启动。

ZTerm 终端代码已经对 Fit/WebGL/Search/clipboard/web-links addon 使用 try/catch 并继续（[terminal.js](../src/renderer/terminal.js#L134-L143)），这是值得保留的局部容错。

### 8.5 借鉴明确的空状态语义

Tabby 的 `StartPageComponent` 是没有 tab 时的可交互空状态，和启动 splash 分离。ZTerm 也应把“启动中”“启动失败”“没有可恢复 tab”“用户关闭全部 tab”区分开，不要用 splash 兼任永久空状态。

## 9. 不宜照搬的点

### 9.1 不宜照搬 Angular 动态模块插件启动层

Tabby 的动态 plugin module lookup、Node `require` patch、Angular `forRoot`、bootstrap component 约定，是大型可扩展 Electron 应用的架构成本。ZTerm 是 Tauri + 原生 HTML/JS，直接照搬会引入 Angular runtime、模块编译和插件 ABI，不能解决终端首帧本身的问题。

### 9.2 不宜把 `did-finish-load` 等同于“可交互完成”

Tabby 在 `did-finish-load` 后显示窗口，但 Angular 配置、插件加载、tab 恢复仍在继续。这种做法适用于“先让用户看到稳定启动壳”；若 ZTerm 的目标是启动 splash 覆盖真实 UI，应继续使用独立的 renderer ready/terminal ready 状态，不要单凭 WebView load 事件隐藏 splash。

### 9.3 不宜无条件等待首个终端首帧

ZTerm 当前 `armSplashHide()` 等待第一个 `term` 的 `onRender`，再用 3 秒兜底。这对正常启动有较好的视觉效果，但不应将它升级为主进程 show 的硬前置条件。慢 shell、坏 profile、PTY 失败、xterm renderer 错误、恢复数据为空都可能没有首帧。

建议 splash controller 至少支持：

- `loading`：等待 terminal attach/render。
- `empty`：确认没有要创建的 tab，显示可操作空状态。
- `error`：启动失败，显示错误和重试。
- `ready`：淡出并移除。
- 超时只从 `loading` 转 `error` 或 `degraded`，而不是无提示地 remove。

### 9.4 不宜照搬 Tabby 的 radial-gradient 启动背景

Tabby 的 `preload.scss` 使用 radial-gradient 和黑色背景，这是品牌/主题选择，不是必要的启动逻辑。ZTerm 已有 `#21252b` 窗口背景和自己的 logo；应保持与最终主题一致，避免启动页和 WebView 背景之间出现颜色闪变。

### 9.5 不宜把 `StartPage` 当 splash

Tabby 的 StartPage 包含命令列表、GitHub、报告问题和版本号，是正常空状态。ZTerm 的启动 splash 应保持轻量、不可误操作；启动完成后的“没有会话”才适合提供新建终端/打开会话等命令。

## 10. 对 ZTerm 的具体建议

1. 主进程继续 `.visible(false)`，恢复窗口状态后 `show()`；保持 `window-shown` 只表示窗口已可见。
2. 在 renderer 增加内部启动状态，而不是只使用 `_splashHidden` 布尔值；至少记录 `settingsReady`、`profilesReady`、`terminalCreated`、`terminalRendered`、`startupError`。
3. `TabManager.init()` 的 profiles IPC 增加错误/超时出口；profiles 为空时显式进入 empty 状态，默认 shell 创建失败时进入 error 状态。
4. `armSplashHide()` 保留 `onRender` 作为正常成功路径，但 3 秒兜底应显示“启动较慢/重试/继续”类降级状态，或至少记录启动诊断，而不是静默删除 splash。
5. 若用户关闭所有 tab，移除启动 splash 后显示正常空状态；不要重新使用启动动画遮挡主 UI。
6. 保持 addon 级 try/catch；WebGL 失败不应阻塞 xterm 基础渲染，和当前 `terminal.js` 的策略一致。
7. 若增加启动动画，使用 opacity/transform 等低成本属性；不要在启动阶段对 xterm canvas、split pane 或 terminal layout 做连续几何动画。ZTerm 当前已对 fit/resize 做较多抑制和结算，启动动画不应制造额外 resize 风暴。

## 11. 主要一手来源索引

- Tabby 官方仓库：<https://github.com/Eugeny/tabby>
- 固定源码 commit：<https://github.com/Eugeny/tabby/tree/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e>
- Electron 入口：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/index.ts>
- Electron Window：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/window.ts>
- Application：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/lib/app.ts>
- 静态启动 HTML：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/index.pug>
- 启动壳样式：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/preload.scss>
- Renderer entry：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/entry.ts>
- 插件加载：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/plugins.ts>
- Angular root module：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/app/src/app.module.ts>
- App root：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.ts>
- App root template/style：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.pug>、<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/appRoot.component.scss>
- StartPage：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/components/startPage.component.ts>
- 配置 ready：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/services/config.service.ts>
- Tab 恢复：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-core/src/services/app.service.ts>
- Local session：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-local/src/components/terminalTab.component.ts>
- Terminal frontend：<https://github.com/Eugeny/tabby/blob/ea05156059f49f1d6cce3cc1d5455c3a3c8fa54e/tabby-terminal/src/api/baseTerminalTab.component.ts>
- 官方启动窗口修复提交：<https://github.com/Eugeny/tabby/commit/e8fdb8b8f93a9d1cfa2dba77181b2d2376465441>
- 官方插件失败/safe mode 提交：<https://github.com/Eugeny/tabby/commit/80699ee13fca96cae0282bc1d604448c90848371>
