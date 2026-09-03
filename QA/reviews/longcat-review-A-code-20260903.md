作为资深 TypeScript/Node.js 评审，我对这次 `pi-telegram` v0.42.3 的硬化改动进行了深度审查。

关于你关心的核心问题：
1. **`deleteViewStale` 绕过 generation fence 是否安全/正确？** 从设计意图上说是正确的，因为 Telegram 的 message ID 在跨 generation 时依然有效。但在并发和幂等处理上存在隐患。
2. **授权是否充分？** 充分，`deleteViewStale` 复用了 `resolveTelegramDeliveryTarget`，确保了即使 generation 变化，新 runtime 的权限策略依然生效。
3. **并发/幂等/重复删除？** 存在边界条件，`messageIds` 为空时会抛出 TypeError 导致静默吞错；单条消息删除失败会导致后续消息中断。
4. **B15 的 stepFailures + existsSync 有无竞态或泄露？** 有严重的逻辑漏洞和 Node.js 反模式。`existsSync` 是同步阻塞 I/O，且存在 TOCTOU 竞态；更致命的是，如果某步失败但文件已存在，错误会被静默吞掉，导致返回损坏的语音文件。

以下是逐条审查结果：

---

### 1. `deleteViewStale` 对空 `messageIds` 缺乏防御
* **严重度**: 高
* **文件:位置**: `lib/delivery.ts` 第 745 行附近 (`handle.messageIds[0]!`)
* **问题**: 如果 `handle.pinned` 为 `true`，但 `handle.messageIds` 是一个空数组，`handle.messageIds[0]!` 的非空断言会抛出 `TypeError: Cannot read properties of undefined`。这个错误会被外层的 `catch` 捕获，最终转化为 `transportFailure("delete", error, ...)`。这掩盖了真实的数据完整性问题，将其伪装成网络/传输故障，导致排查困难。
* **修复建议**: 在访问前增加空数组守卫。
  ```typescript
  if (handle.pinned && deps.unpinMessage && handle.messageIds.length > 0) {
    try {
      await deps.unpinMessage(authorized.value, handle.messageIds[0]!);
    } catch { ... }
  }
  ```

### 2. `deleteViewStale` 单条消息删除失败导致中断
* **严重度**: 中
* **文件:位置**: `lib/delivery.ts` 第 753-756 行 (`for (const messageId of handle.messageIds)`)
* **问题**: 在遍历 `handle.messageIds` 删除时，如果中间某条消息删除失败（例如 Telegram API 返回 `message to delete not found`），会直接抛出异常跳出循环，导致后续的 messageIds 无法被清理。作为一个“Best-effort cleanup”函数，它应该尽力清理所有可清理的消息。
* **修复建议**: 将单次 `deleteMessage` 包裹在 try-catch 中，记录失败但继续循环，最后汇总结果。
  ```typescript
  for (const messageId of handle.messageIds) {
    if (!active) return inactive();
    try {
      await deps.deleteMessage(authorized.value, messageId);
    } catch (deleteError) {
      // 记录日志，但继续尝试删除剩余消息
    }
    if (!active) return inactive();
  }
  ```

### 3. `outbound.ts` 使用同步 `existsSync` 阻塞事件循环
* **严重度**: 中
* **文件:位置**: `lib/outbound.ts` 第 511 行 (`existsSync(outputPath)`)
* **问题**: 在异步函数 `generateTelegramVoiceReplyFileWithHandler` 中使用了同步的 `existsSync`。Node.js 是单线程事件循环，同步 I/O 会阻塞整个进程，在高并发下会导致吞吐量急剧下降。此外，`existsSync` 和后续的 `throw` 之间存在 TOCTOU（检查时与使用时间）竞态条件。
* **修复建议**: 使用 `fs/promises` 的 `access` 或 `stat` 进行异步检查，并结合 `try/catch` 处理。
  ```typescript
  import { stat } from 'node:fs/promises';
  // ...
  if (stepFailures.length > 0) {
    try {
      await stat(outputPath);
    } catch {
      throw new Error(`Outbound voice pipeline produced no output: ${stepFailures.join("; ")}`);
    }
  }
  ```

### 4. `outbound.ts` 静默吞错导致返回损坏文件
* **严重度**: 高
* **文件:位置**: `lib/outbound.ts` 第 510-514 行
* **问题**: 逻辑漏洞。当前逻辑是：`if (stepFailures.length > 0 && !existsSync(outputPath)) throw`。这意味着，如果 Pipeline 中的第 1 步成功生成了文件，但第 2 步（如后处理/转码）失败了，`stepFailures` 不为空，但因为文件已存在，代码会**静默忽略错误并返回该损坏/不完整的文件**。这比直接抛错更危险，因为上层会认为语音文件生成成功并发送给用户。
* **修复建议**: 只要 `stepFailures.length > 0`，就应该视为失败，除非业务上明确允许某几步失败且文件依然可用。建议改为：
  ```typescript
  if (stepFailures.length > 0) {
    // 尝试清理可能存在的半成品文件
    await rm(outputPath, { force: true }).catch(() => {});
    throw new Error(`Outbound voice pipeline failed: ${stepFailures.join("; ")}`);
  }
  ```

### 5. `stdout = ""` 导致后续步骤处理空数据
* **严重度**: 中
* **文件:位置**: `lib/outbound.ts` 第 503 行
* **问题**: 当某步失败时，`stdout` 被重置为空字符串。如果后续步骤没有失败，它们将基于空字符串运行，这极有可能产生无效的输出文件。结合第 4 点，这加剧了“损坏文件”产生的概率。
* **修复建议**: 如果某步允许失败（`failure !== "root"`），应保持上一步的 `stdout` 不变，而不是清空，或者在失败时直接终止流水线。

### 6. `deleteViewStale` 绕过 generation fence 的授权边界确认
* **严重度**: 低 (设计确认)
* **文件:位置**: `lib/delivery.ts` 第 730-736 行
* **问题**: 无代码 Bug，但需确认设计约束。当