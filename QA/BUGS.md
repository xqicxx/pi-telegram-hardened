# Bug 清单与状态

| ID | 严重度 | 描述 | 状态 |
|----|--------|------|------|
| B1 | 高 | instance-spawner 的 `instances` Map 永不清理 exited 实例 → 达到 maxInstances(4) 后永久拒绝新 spawn | ✅ 已修复+测试 |
| B2 | 高 | `isSpawned()` 对 exited 实例仍返回 true → 线程 dedup 卡死，无法重新 spawn | ✅ 已修复+测试 |
| B3 | 中→低 | `balanceTelegramHtml` 对裸 `<` 后无 `>` 的碎片会丢数据；但实际管线先经 renderTelegramInlineMarkdownHtml 转义，场景不可达 | ✅ 已加单测锁定，非阻塞 |
| B4 | 严重 | TTL 自愈把 ambiguous(commit-unknown) provision 当过期丢弃 → 重新 createForumTopic → 重复主题风险；与 store 层不变量矛盾 | ✅ 已修复+回归测试 |
| B5 | 设计 | 新线程首条消息被 leader 消费但不入队（"唤醒信号"），spawn 失败无通知 | 📋 记录为已知取舍，非阻塞，建议后续加失败通知 |
| B6 | 中 | spawner 内部 setTimeout 未 unref() → 拖住进程退出 | ✅ 已修复 |
| B7 | 架构 | index.ts 箭头函数 `() => process.cwd()` 破坏 "composition root" 不变量 | ✅ 已修复 |
| B8 | 中 | onExit 无陈旧子进程守卫 → 竞态下可能误删新实例 | ✅ 已修复 |
| B9 | 低 | delivery `pinned` 标志按 options.pin 硬编码，不反映实际是否 pin 成功 | ✅ 已修复 |
| B10 | 高 | API 硬超时与 provisioning 超时的 `timer.unref()` 在进程空闲时不触发 → 超时形同虚设，重新打开卡死窗口 | ✅ 已修复+测试 |
| B11 | 中 | spawn 失败(ENOENT)只记日志不清理 → 僵尸 starting 实例永久卡线程+占并发 | ✅ 已修复+测试 |

## 详细记录

### B4 (严重) — ambiguous provision TTL 误丢弃
- **根因**: `threads.ts` provisioner 的 pendingStale 判断只查 expiresAtMs/leaderEpoch，不看 status。
  store 层 `isPendingProvisionLiveOrTargeted` 明确"ambiguous 恒为 live"，provisioner/reconciler 与其矛盾。
- **影响**: createForumTopic 响应丢失(commit-unknown)后，若 TTL 过期，后继会重新建主题 → 重复主题。
  与 ambiguous 标记的设计目的直接冲突。
- **修复**: 
  - `threads.ts`: `pendingStale = status !== "ambiguous" && (...)` 
  - `thread-reconciler.ts`: `isPendingProvisionAlive` 加 ambiguous→true；`remove-expired-pending-provision` 分支排除 ambiguous；接口补 status 字段
- **回归测试**: `threads.test.ts` "keeps ambiguous intent past TTL"; `thread-reconciler.test.ts` "never removes ambiguous pending provisions as expired"

### B1/B2 (高) — spawner 生命周期泄漏
- **根因**: `instances` Map 只增不减，exited 实例残留 → `instances.size >= 4` 永久触发；`isSpawned` 也基于该 Map。
- **影响**: 新线程功能在前 4 个实例(含已退出)之后完全失效。
- **修复**: 重写生命周期——exited 移入 `recentExits`(带时间戳)，concurrency 只统计 live；
  `isSpawned` = live OR 30s 退出冷却；spawnForThread 在冷却期内拒绝重试(防崩溃循环)；
  onExit 加陈旧子进程守卫；setTimeout 加 unref()；加 getNowMs 时钟注入。
- **回归测试**: `instance-spawner.test.ts` 6 个用例（env/args、dedup、容量释放、冷却期、stop、按线程冷却）

### B7 (架构) — index.ts 破坏 composition-root 不变量
- **根因**: `getCwd: () => process.cwd()` 箭头函数。
- **修复**: 改方法简写 `getCwd() { return process.cwd(); }`

### B10 (高) — 超时定时器 unref 导致空闲进程不触发
- **根因**: `telegramFetch` 的 AbortController 定时器和 `withTelegramBusFollowerProvisionTimeout` 都 `timer.unref()`。
  当事件循环排空（空闲进程），unref 定时器被跳过，而挂起的 promise 不保持循环存活 → 超时永不触发，
  await 永远挂起。恰好是 0.42.3-pre 想修的那类卡死问题的复现路径。
- **验证**: 用子进程测试复现（execFile 环境下 unref 定时器不触发）。
- **修复**: 两处都去掉 unref（await 调用方本身就该让进程保持存活）。
- **附带发现**: `TELEGRAM_API_CALL_TIMEOUT_MS` 有 15s 下限（Math.max(15_000,...)），测试需用 20s。
- **回归测试**: telegram-api.test.ts 两个子进程测试（硬超时 ETIMEDOUT / 自有 signal 豁免）

## 测试环境备注
- invariants.test.ts 需要 repo 独有的 `.github/workflows/release.yml`（npm 包不含）→ 从 repo 复制
- bus-api/delivery 测试的 mock runtime 需要补 pinChatMessage/unpinChatMessage
- threads.test.ts 的 pending provision 断言需含 expiresAtMs
- thread-reconciler.test.ts 预期需含 remove-expired-pending-provision 动作
