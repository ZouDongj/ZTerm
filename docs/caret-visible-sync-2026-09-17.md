# 可见同步重绘中的软件光标接管

当前现场结论、构建标识与验证限制统一见 [STATUS.md](STATUS.md)。本文描述现行机制与可复用回归入口。

部分 TUI 在同一同步重绘单元内绘制 RGB 软件标记，并将协议光标移回该格后 SHOW。若只平滑绘制协议光标而保留软件标记，移动期间会出现两个位置不同的光标。

观察器仅接受证据完整的可见形式：先 HIDE，写入唯一窄 RGB 字符，存在默认样式普通写入，显式 CUP/HVP 回到该字符格，单次 SHOW 后正常结束同步单元。多彩色格、非默认普通文字、没有普通写入、错误停泊、反色变体、提前 SHOW 或确认后额外控制/写入均不能按此形式接管。

保留两次有效识别门槛。首次候选解析完成后，只有协议光标仍与候选格重合、候选仍有效时才维持原始显示，避免额外平滑绘制；位置移开或资格失效时恢复普通协议路径。第二次有效识别后允许软件光标接管，资格持续受解析水位、坐标、属性与会话生命周期约束。

原始 VT、底层字符和属性保持不变，字体、vendor 和 90ms 曲线保持现有行为。原子光栅、异步回放与实际会话验收是不同证据；覆盖范围以当前状态为准。

- [观察器](../src/renderer/ink-caret-observer.js)及[可见同步单元测试](../tests/ink-caret-visible-sync.test.mjs)：正例、歧义与非法尾部。
- [适配器测试](../tests/software-caret-adapter.test.mjs)：解析提交、预热及失效退出。
- [匿名单元](../tests/fixtures/visible-sync-caret.json)与[分块样本](../tests/fixtures/visible-sync-caret-chunks.json)：保留协议语义的回归输入。
- [光标绘制测试](../tests/xterm-smooth-cursor.test.mjs)：绘制行为回归。
- [Claude 直连派生分块](../tests/fixtures/claude-direct-native-chunks.json)（含序列中切断）与[观察器分块稳健性用例](../tests/ink-caret-frame-observer.test.mjs)：裸反转手势与分块切点无关。该形式的原生原子验收入口为 `scripts/caret-native-replay.mjs --atomic-claude-field`（离线诊断脚本，未入库）。
- 裸反转语法的样式追踪修复（`8e42f78`，2026-09-17 现场根因）：`ESC[m` 空参数按 ECMA-48 复位；默认样式态改为派生（fg/bg/rev + 属性位掩码），部分复位（22/23/24/25/28/29/39/49）与 256 色序列可正确归位。修复前 claude 提示符与启动 banner 使追踪永久脏污、检查点恢复全部失败、手势从未识别。
