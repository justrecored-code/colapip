# ColaPip

**本地 AI 任务服务器**——后台常驻进程，跑插件、管队列、崩溃恢复。Web Dashboard 监控一切。

## 一句话

把 AI 工作流（微信机器人、生图、文章摘要、知识归档）变成一个个插件，放在后台安静跑。崩了自动续，卡了看得见。

## 快速开始

```bash
git clone <repo>
cd colapip
npm install
cp config/platform.example.json config/platform.json   # 编辑填你的 LLM 地址
npm start
```

浏览器打开 `http://127.0.0.1:15001`

要求：Node.js 18+，一个 OpenAI-compatible 的 LLM 端点（llama.cpp / Ollama / LM Studio）。

## 能干什么

| 场景 | 用什么插件 |
|------|-----------|
| 微信消息 → AI 理解意图 → 调用插件干活 → 结果回微信 | `wechat-bot` |
| 公众号文章自动下载、AI 摘要、结构化归档 | `wechat-sub` + `knowledge-base` |
| 图片 → VLM 反推美学标签 → ComfyUI 出图 → 审计迭代 | `recipe-engine` |
| X.com 自动爬图，LLM 筛选 | `x-scrape` |
| 本地 LLM 进程管理，崩溃自动拉起 | `llm-launcher` |

## 平台做什么

- **插件生命周期**：`init → start → execute → resume → stop`，热重载
- **任务队列**：提交 → 排队 → 执行 → 完成，每插件独立并发控制
- **断点恢复**：任务崩了从上次 checkpoint 继续，不重头跑
- **LLM 排队**：多插件共享一个本地模型，自动排队避免并发冲突
- **多通道 I/O**：WebSocket Dashboard、微信、API，统一 replyTo 路由
- **参数校验**：INPUT.md 标记 `(必需)`，缺参拒绝提交

## 插件怎么跑

```
微信消息 → wechat-bot 收到 → agent 理解意图 → submitTask("recipe-engine")
→ 任务队列 → recipe-engine 执行 → ComfyUI 出图 → 审计
→ 完成通知 → agent → replyTo 路由 → wechat-bot 发回微信图片
```

每一步都有 checkpoint，中间崩了重启继续。

## 自带插件

| 插件 | 做什么 |
|------|--------|
| `wechat-bot` | 微信消息通道，收消息 → Agent → 插件 → 回复 |
| `wechat-sub` | 公众号订阅、下载、轮询、历史文章全量拉取 |
| `recipe-engine` | 图片 → VLM 标签提取 → ComfyUI 生图 → 审计迭代 |
| `knowledge-base` | 双 Agent 提取+审计 → 结构化知识库（Obsidian 可打开） |
| `x-scrape` | X.com 图片爬取，LLM 自动筛选 |
| `llm-launcher` | 本地 LLM 进程管理，崩溃重启 |

## 写插件

见 `PLUGIN_GUIDE.md`。每个插件就是一个目录：

```
plugins/my-plugin/
  plugin.json     # 名字、版本、依赖
  INPUT.md        # 参数定义（Dashboard 自动生成表单）
  OUTPUT.md       # 输出说明
  index.ts        # init/start/execute/resume/stop
  ui.html         # 可选，Dashboard 自动加标签页
```

## 许可证

AGPL-3.0
