# pi-telegram 0.42.3-pre QA 迭代日志

> 任务：审查本地对 @llblab/pi-telegram 的修改（0.42.3-pre），与上游 0.42.2 对比，
> 测试/复现/找 bug，迭代修复直到可上线。本文件记录全部过程供后续轮次参考。
> 交付：https://github.com/xqicxx/pi-telegram-hardened

## 工作区布局
- `upstream/` : 上游基线 0.42.2（npm tarball，另存 /tmp/pitelegram-upstream/baseline-0.42.2）
- `local/`    : QA 工作副本（含 node_modules + tests + tsconfig + .github）
- `repo/`     : GitHub 仓库克隆（main = 纯净 0.42.2，仅用于取 tests/.github 基线）
- `release/`  : 最终发布目录（= 修复后源码 + tests + QA 文档，已推 GitHub）
- `patches/`  : from-0422-to-fixed.patch（上游→修复后，1314 行 16 文件）
- `BUGS.md`   : bug 清单与状态

## 会话 R1 (2026-09-03 00:20 ~ 01:00)

### 阶段 1：现状调研
- 上游最新发布 = 0.42.2 (2026-09-01, npm 与 pi.dev 一致)；GitHub main 也是纯净 0.42.2
- 本地安装包 = 0.42.2 + 未发布 0.42.3-pre 改动（仅存本地）
- 16 个差异文件（15 改 + 1 新增 lib/instance-spawner.ts 231 行）

### 阶段 2：测试环境
- 基线（纯净 0.42.2）：1714 tests / 1711 pass / 0 fail
- 本地修改版初测：6 个失败 → 分类为【测试需更新】vs【真 bug】

### 阶段 3：发现的 bug 与修复（详见 BUGS.md）
| ID | 严重度 | 摘要 | 修复 |
|----|--------|------|------|
| B4 | 严重 | TTL 自愈误丢弃 ambiguous provision → 重复建主题窗口重新打开（与 store 不变量矛盾） | ✅ provisioner/reconciler 排除 ambiguous |
| B1 | 高 | spawner instances Map 泄漏 exited → 4 个后永久拒新 spawn | ✅ 移入 recentExits + 冷却期 |
| B2 | 高 | isSpawned 对 exited 仍 true → dedup 卡死 | ✅ 同 B1 |
| B10 | 高 | 超时定时器 unref → 空闲进程不触发 → 超时形同虚设（复现了 0.42.3-pre 想修的卡死） | ✅ 去掉 unref（api + bus-leader） |
| B7 | 架构 | index.ts 箭头函数破坏 composition-root 不变量 | ✅ 改方法简写 |
| B8 | 中 | onExit 无陈旧子进程守卫 | ✅ children.get 校验 |
| B6 | 中 | spawner 内部 setTimeout 未 unref 拖进程 | ✅ connectTimer unref（注意与 B10 的区别：这个是后台探测，B10 是 await 的 deadline） |
| B9 | 低 | delivery pinned 标志不反映实际 pin 结果 | ✅ 跟踪实际成功 |
| B3 | 低 | balanceTelegramHtml 裸 `<` 丢数据（实际管线不可达，因先转义） | ✅ 加单测锁定，非阻塞 |
| B5 | 设计 | 新线程首条消息为"唤醒信号"不入队；spawn 失败无通知 | 📋 记录为已知取舍，建议后续加失败通知 |

### 阶段 4：新增/更新的测试（1714 → 1729）
- threads.test.ts：+1 ambiguous-TTL 回归；+expiresAtMs 断言 ×4
- thread-reconciler.test.ts：+1 ambiguous 不移除回归；预期 +remove-expired-pending-provision
- instance-spawner.test.ts：新建 6 个（env/args、dedup、容量释放 B1、冷却 B2、stop、按线程冷却）
- delivery.test.ts：+2 pin 路径（pin+unpin、无 deps 时 pinned=undefined）；mock 补 pin 方法
- rendering.test.ts：+1 balanceTelegramHtml（跨嵌套/未闭合/void/实体）
- bus-follower.test.ts：+1 env target 解析
- bus-leader.test.ts：+1 provisioning 超时拒绝
- telegram-api.test.ts：+2 子进程测试（20s 硬超时 ETIMEDOUT / 自有 signal 豁免；发现 15s 下限）
- bus-api.test.ts：mock 补 pin/unpin
- invariants.test.ts：环境修复（.github 需从 repo 复制）

### 阶段 5：交付
- 7 个修复文件同步回安装目录 ~/.pi/agent/npm/node_modules/@llblab/pi-telegram（重启生效）
- CHANGELOG 补 3 条（Ambiguous-Provision Safety / Spawner Lifecycle Hygiene / Hard-Deadline Delivery）
- 发布目录 release/ 验证：typecheck 干净 + 1729 tests / 0 fail
- 推送 GitHub：**xqicxx/pi-telegram-hardened**（public, main, 180 文件）
  https://github.com/xqicxx/pi-telegram-hardened

## 上线前待办（下一轮）
1. **重启 pi 加载新代码**（当前 leader pid 52366 仍是旧内存代码）——最重要
2. 观察新线程功能是否还会反复建主题（B4/B1/B2/B10 修复后应明显缓解）
3. 若仍频繁创建主题：查 follower 注册失败（Surge 代理 15s 超时）是否还发生
4. 可选：B5 加"实例启动失败通知线程"；B3 可顺手加固（把裸 `<` 转义而非丢弃）
5. 发布 npm 0.42.3 前跑 `npm run validate`（typecheck+test+audit+pack:check）
6. 决策：`xqicxx/pi-telegram`（现有 fork）是否也同步这份修复

## 关键经验（后续轮次必读）
- **测试需区分"测试要更新"和"真 bug"**：expiresAtMs/pin 方法/remove-expired 动作属于前者；ambiguous-TTL、unref、Map 泄漏属于后者
- **unref 陷阱**：await 中的 deadline 绝不能 unref；后台 bookkeeping 定时器必须 unref
- **TELEGRAM_API_CALL_TIMEOUT_MS 有 15s 下限**，测试无法用短值
- **cp -r 复制 node_modules 会坏 .bin 符号链接**，用 cp -a
- **invariants 测试需要 repo 独有文件**（.github/workflows/release.yml）
- 改 index.ts 必须满足 composition-root 不变量（无 =>、new Map、!. 等）
- `diff -rq` 与 `diff -ruN` 结合使用：-rq 快速确认文件集合，-ruN 生成补丁

---
*R1 完成：审查→测试→修复→回归→发布推送全链路。*

## 会话 R2 (2026-09-03 ~01:00)

### R2a: 集成路径验证
- pi-telegram-working 扩展 ↔ Activity API 契约：完全兼容（send/edit/delete、pin 透传、全部 event types）
- pin 功能端到端接线确认：activity send → sendTelegramView → runtime.sendView → pinMessage → api.pinChatMessage；index.ts 经 createTelegramBridgeDeliveryLifecycleHooks 正确传入
- bus-api withDefaultThreadTarget：topic 场景正确补 message_thread_id
- **RPC 模式确认**：pi docs rpc.md 明确"Extension commands (e.g. /mycommand) 立即执行"→ spawner 注入 `{"type":"prompt","message":"/telegram-connect"}` 可行
- telegram-connect 命令 → startPolling → (bus 启用时) startBusLeaderPolling；follower 通过 registerFollowerWithLeader + env target 绑定
- createForumTopic 429 路径：非 commit-unknown 立即 remove pending（不残留）；ambiguous 由 B4 保护
- **生产问题根因链确认**：Surge 代理卡 → createForumTopic 响应丢失(ambiguous) → B4 旧 bug 让 TTL 丢弃 ambiguous → 重试建新主题 → 连环建主题 → 429。B4 + probe 5s + B10(deadline 真触发) 三修复正好堵死此链

### R2b: B3 加固（已实现+推送）
- balanceTelegramHtml 加 `|` 备用分支：裸 `<` 转义为 &lt; 而非被 tokenizer 丢弃
- 新测试：rendering.test.ts "preserves stray less-than"（1730 tests 全绿）

### R2b: B5 决策
- 保持"已知限制"：spawn 失败通过 recordRuntimeEvent 进 diagnostics（/telegram-status 可见），
  不做跨模块线程内通知（无 live 测试环境下新增跨模块耦合风险 > 收益）
- 已记录实现方案供后续轮次

### R2c: 发布验证
- npm run typecheck / pack:check 通过（104 文件，842KB）
- release 目录全量：1730 tests / 1727 pass / 0 fail
- 推送 GitHub：B3 commit (319de0f)

## 会话 R3 (2026-09-03 ~01:10)

### B11 (新发现, 已修复)
- **根因**: instance-spawner 的 `child.on("error")` 只 recordRuntimeEvent，不清理 instances Map。
  spawn 失败(如 pi 不在 PATH, ENOENT)不触发 "exit" 事件 → 实例永远 "starting" → isSpawned 永久 true + 占并发额度。
- **修复**: error handler 复用 B1 的清理路径（移入 recentExits + 冷却），加 children.get 守卫。
- **回归测试**: instance-spawner.test.ts "releases a thread when spawn fails outright" (7/7)
- 全量: 1731 tests / 1728 pass / 0 fail

### 验证结论
- RPC 模式执行扩展命令确认（rpc.md: extension commands execute immediately）
- 生产 429 根因链完整：Surge 卡 → create 响应丢失(ambiguous) → B4 TTL 误丢弃 → 重试新建 → 连环建主题 → 429
  → B4 + probe 5s + B10 三个修复已堵死此链

## 会话 R4 (2026-09-03 ~01:20)

### B12 (新发现, 已修复)
- **根因**: lib/bus.ts 的 follower API 允许列表缺 pinChatMessage/unpinChatMessage。
  follower 场景 delivery pinMessage → bus-api callFollowerApi("call",["pinChatMessage",...]) → bus 拒绝。
  **意味着 Pinned Working Views 在 follower 传输下完全失效**（leader 直接传输下才可用）。
- **修复**: 允许列表补两个方法（generic 分支 + isTargetScoped 校验，跨 chat 仍拒绝）
- **双测试**: bus-api.test.ts "routes follower pin/unpin through the leader"（含默认线程目标注入）；
  bus.test.ts "allowlist permits scoped own-thread pin/unpin"（含跨 chat 拒绝）
- 全量: 1733 tests / 1730 pass / 0 fail

## 会话 R5 (2026-09-03 ~11:30)

### 任务
对比 pi.dev 发布版 vs 原项目(badlogic) vs 本地硬化版 → 明确目标 → 头脑风暴 → 测试找 Bug → 迭代 → 桌面 Excel 记录。

### 现状
- 基线（workbench = release + 安装包最新）：1733 tests / 1730 pass / 0 fail / 3 skipped；typecheck 干净
- 发现安装包有 R4 之后未发布的改动：delivery.ts `deleteViewStale`（pin 清理）+ bus.ts `[bus-debug]` 调试残留 + 遗留 .bak 文件

### B13 (中) — bus.ts 调试残留
- 根因: createTelegramFollowerApiCallAuthorizer 加了 console.error `[bus-debug]`（今天 10:52 调试时加的），每个 follower API 调用都刷 stderr，args 内容可能泄入日志
- 修复: 还原为 release 干净版（无副作用日志）
- 验证: diff release/lib/bus.ts 完全一致

### B14 (低) — 打包残留 .bak
- 根因: lib/delivery.ts.bak-pinfix-20260903-105249 备份文件留在 lib/，package.json `files:["lib/"]` 会打进 npm 包（体积+困惑）
- 修复: 删除；并在 invariants.test.ts 加"lib 无 .bak/orig/tmp/swp/~/"守卫测试
- 验证: pack:check 104 文件 843KB 无 .bak

### G1 (高) — deleteViewStale 零测试覆盖
- 根因: R4 后新功能（transport reconnect 后 stale pinned 卡片 unpin+delete），生产已接线（createTelegramBridgeDeliveryRuntime → createTelegramDeliveryRuntime 含 deleteViewStale），但 tests mock runtime 不实现它 → 新路径从未被测试
- 修复: delivery.test.ts 加 3 个测试（membrane 回退调用 / 无回退仍 stale-handle / 具体实现 unpin+delete 跨代）
- 验证: 全量 1737 tests / 1734 pass / 0 fail

### 交付
- 同步: release/ + 安装包 ~/.pi/agent/npm/node_modules/@llblab/pi-telegram（bus.ts、delivery.ts、tests、CHANGELOG、BUGS）
- CHANGELOG 0.42.3-pre 补 3 条: Stale-Handle Pin Cleanup / Pack Hygiene（+Follower Pin Routing 已在 R4）
- 桌面 Excel: pi-telegram-迭代记录.xlsx（问题/原因/方案/验证 全轮次）

### R5b: 语音 provider 故障修复（用户语音回复失败）
- **现象**: "Failed to send voice reply: every voice synthesis provider failed"（4 次，11:16-11:46）
- **根因（真 bug）**: `~/.pi/agent/telegram.json` 的 outbound voice handler 模板格式错误。
  用户写成 `"template": ["tts.sh", "{mp3}", "{ogg}"]`（按 inbound 的"命令+参数"直觉），
  但 outbound voice 的数组 template 是**管道命令序列**（每元素一条完整命令行，docs/voice.md）。
  桥把它当 3 步管道：①单独跑 tts.sh（无参报错）②把 mp3 路径当命令执行（ENOENT）③把 ogg 路径当命令执行（ENOENT），全部静默失败。
- **修复**: ①配置改为单元素完整命令行 `["/Users/cx/.pi/scripts/voice/tts.sh {mp3} {ogg}"]`（telegram.json，进程内复现 6.5KB ogg 成功）
  ②B15：组合步骤失败细节不再吞掉，汇入 "Outbound voice pipeline produced no output: step N: ..." 错误（2 个新测试）
- **验证**: 全量 1739 tests / 1736 pass / 0 fail；typecheck 干净；真实路径 vtest 生成 ogg 成功
- **生效**: 配置+代码已写盘，运行中桥需下次重启加载（与 R5 同批）
