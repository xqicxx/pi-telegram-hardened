# pi-telegram-working v2

自动把 pi 的「正在干什么」投影到 Telegram，**风格与终端 whimsical 状态栏同款**。

## 效果

agent 一开始干活，Telegram 里出现一条实时更新的消息，干完自动消失：

```
◜ Grepping the void for meaning...
[telegram] · Spark-X2.5-1.7B-GGUF
```

- **转圈动画**：◜◠◝◞◡◟ 每秒转一格（和终端 sleekOrbit 同款）
- **消息轮换**：每 10 秒换一条 whimsical 消息（和终端同节奏、同消息池：宝莱坞 1289 条 / 提示 / 梗 / 疯狂编译器 / Boss 战…）
- **真实状态覆盖**：
  - 思考中 → `🛠️` 变 `💭 思考中…`
  - 执行工具 → `🛠️ bash`
  - 等待你输入 → `⏳ 等待你输入：选一个…`
- 来源 + 模型显示在第二行小字：`[telegram] · 模型名`
- agent 结束自动删除该消息

## 安装

放到 `~/.pi/agent/extensions/pi-telegram-working/`（自动发现），`/reload` 或重启 pi 生效。

依赖：`npm:@llblab/pi-telegram`、`pi-agent-extensions`（whimsical 消息池，深路径导入）。

## 说明

- 通过 pi-telegram **Activity API** 注册，非阻塞，失败自动降级，不影响 Pi 生命周期。
- 不渲染工具参数/结果/思考原文，只显示工具名，避免泄露敏感内容。
- 消息更新约 1 次/秒（编辑同一消息，不刷屏）。
- 多个 pi 实例同时连接时各自投影；建议保留一个实例。
