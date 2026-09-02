# pi-telegram 0.42.3-pre QA 迭代日志

> 任务：审查本地对 @llblab/pi-telegram 的修改（0.42.3-pre），与上游 0.42.2 对比，
> 测试/复现/找 bug，迭代修复直到可上线。
> 本文件记录全部过程：改动、测试、bug、设计思考、决策，供后续轮次参考。

## 工作区布局
- `upstream/` : 上游基线 0.42.2（从 npm 解压）
- `local/`    : 本地已修改版本副本（QA 工作副本，含 node_modules + tests）
- `repo/`     : GitHub 仓库克隆（含 tests/，main = 纯净 0.42.2）
- `patches/`  : 生成的补丁文件
- `BUGS.md`   : bug 清单
- 基线对比命令：`diff -rq upstream local`

## 会话 R1 (2026-09-03 00:20~)

### 阶段 1：现状调研
- 上游最新发布 = 0.42.2 (2026-09-01, npm + pi.dev 一致)
- 本地 = 0.42.2 + 未发布的 0.42.3-pre 改动（CHANGELOG 有记录，package.json 版本未 bump）
- GitHub main 分支 = 纯净 0.42.2（本地改动只存在于本地，未提交）
- 16 个差异文件：15 改 + 1 新增（lib/instance-spawner.ts 231 行）

### 阶段 2：建立测试环境
- repo: npm install 成功，基线测试 **1714 tests, 1711 pass, 0 fail, 3 skipped**
- local: 复制 node_modules + tests + tsconfig + .github（invariants 测试需要）
- 修复测试夹具：bus-api.test.ts / delivery.test.ts 的 mock 补 pinChatMessage/unpinChatMessage
- 修复 threads.test.ts 4 处 pending provision 断言补 expiresAtMs
- 修复 thread-reconciler.test.ts 预期新增 remove-expired-pending-provision 动作

### 阶段 3：发现的 bug 与修复
- **B4 (严重, 已修复)**: TTL 自愈把 ambiguous(commit-unknown) provision 当过期丢弃 → 后继重新 createForumTopic → 重复建主题窗口重新打开。store 层不变量(isPendingProvisionLiveOrTargeted)本就视 ambiguous 恒为 live，provisioner/reconciler 与它矛盾。
  - 修复: threads.ts provisioner stale 判断加 `status !== "ambiguous"` 门控；thread-reconciler.ts isPendingProvisionAlive + remove-expired-pending-provision 分支同样排除；reconciler 接口补 status 字段
  - 验证: 既有测试 "preserves ambiguous creation intent" 由失败转通过
- **B1 (待修复)**: instance-spawner.ts instances Map 永不清理 exited → 达到 maxInstances=4 后永久拒绝新 spawn
- **B2 (待修复)**: isSpawned() 对 exited 实例仍返回 true → 线程 dedup 卡死
- **B3 (待验证)**: balanceTelegramHtml 边界（含 `>` 属性、嵌套处理）需写测试验证
- **B5 (设计)**: 新线程首条消息被消费但不入队，spawn 失败无通知
- **架构不变量 (已修复)**: index.ts 用 `() => process.cwd()` 箭头函数破坏 "Entrypoint stays a composition root" 不变量 → 改方法简写

### 当前状态
- typecheck: 干净
- 测试: 1714 tests, 1711 pass, 0 fail, 3 skipped

### 下一步
- 写 B4 回归测试（provisioner + reconciler）
- 修 B1/B2（spawner Map 清理）
- 验证 B3（balanceTelegramHtml 单测）
- 验证 pin 功能、spawner 集成
- 同步修复到真实安装目录 + 提交 GitHub xqicxx

---
*每轮结束追加记录。*
