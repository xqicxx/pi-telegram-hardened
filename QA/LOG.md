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
