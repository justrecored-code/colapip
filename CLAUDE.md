# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ColaPip** — 本地 AI 任务服务器。类似 Docker 管理容器，平台管理本地 AI 任务的运行时。核心设计理念：本地模型不可靠，因此架构以**异步任务队列 + SQLite checkpoint + 被动错误检测**为基础。

### 职责边界

```
平台做什么:                 插件做什么:
- 任务队列 + 调度           - 业务逻辑
- SQLite 持久化              - 自己的数据 & 日志
- EventBus 事件路由          - ctx.output 输出消息
- WebSocket Dashboard        - 可选的 ui.html
- LLM Adapter 排队           - ctx.llm.chat() 调 LLM
- Agent 工具注册             - INPUT.md / OUTPUT.md 文档
```

## Commands

```bash
npm start             # tsx src/cli.ts start — 启动平台
npm run typecheck     # tsc --noEmit
npm test              # vitest run（需单线程避开 SQLite 锁：
npm run test:watch    # vitest (watch mode)
```

**推荐测试命令**（避免 SQLite 锁竞争）：
```bash
npx vitest run --pool=forks --poolOptions.forks.singleFork
```

**前置条件**：Node.js 18+。Dashboard: `http://127.0.0.1:15001`。

## Architecture

```
启动流程:
  loadConfig → setEventBus → initDB → ToolRegistry.loadFromDir → startDashboard
  → PluginManager.scanAndRegister → cleanupOrphanTasks → recoverTasks

LLM Adapter 模式:
  OpenAICompatibleAdapter — 请求排队（pending Promise 链），healthCheck，
  支持 reasoning_content。createAdapter(cfg) 工厂，getPlatformLLM() 单例。

任务提交:
  submitTask(plugin, params) → 并发控制（插件级 maxConcurrent，默认 1）
    params.notify 默认 false。Agent 需要任务通知时显式传 notify: true。
    若 submitTask 调用时 _replyToContext 存在（由 _agentHandler 设置），
    平台自动注入 _replyTo 到 params 并强设 notify: true，任务完成时通知带上路由信息。
  参数校验: 平台根据 INPUT.md 的 (必需) 标记 + ### action 分段校验，缺参拒绝提交。

Platform LLM（Chat Agent）:
  Dashboard Agent = 平台统一大脑，所有异步 Agent 调用共享此实例。
  systemPrompt 来自 config/agent-prompt.md（角色：指挥官，不生成内容，只调度插件），thinkingLevel: xhigh。
  插件通过 ctx.output.agent("dashboard", { prompt, replyTo }) 调用。
  使用模块级 agentQueue 队列——Agent 忙时不丢弃，排队等待处理。
  Dashboard 聊天 API（/api/tasks）也走同一条队列（返回 { type: "queued" }），WebSocket 异步投递回复。
  Agent 报错时自动 requeue（3s 延迟重试），不丢消息。

插件输出:
  ctx.output.platform(data) → WebSocket → Dashboard 展示
  ctx.output.agent(targetOrData, data?) → 统一 Agent 路由：
    - 单参数: ctx.output.agent({ prompt }) → 本插件独立 Agent
    - 双参数: ctx.output.agent("dashboard", { prompt, replyTo }) → 平台主 LLM
  replyTo 输出路由（由 deliverReply 分发，server.ts 内零插件特定代码）:
    { dashboard: true }                      → broadcast WebSocket
    { plugin: "xxx", pluginData: {...} }     → submitTask("xxx", { action: "deliver_reply", content, pluginData })
  调用方通过 replyTo 指定目标，Agent 只管生成内容。

Agent 使用模式:
  两种模式都是合理的，选哪个取决于场景：
  1. ctx.output.agent("dashboard", ...) — 短交互、无状态，共享 Dashboard Agent 工具集
  2. 自己 new Agent(modelConfig) — 多轮有状态工作流，需要每任务不同的自定义工具
     这种场景用 createAgentModel()（来自 src/core/llm.ts）构造模型描述符

事件体系:
  EventBus — 仅平台层单例，6 种事件:
    log, task.progress, task.error, task.completed, task.state_change,
    plugin.registered
  handler 错误不中断 bus（try/catch 包裹）。
  插件错误上报 — ctx.eventBus.emit("task.error", { taskId, errorCode, rawError, pluginName })
  插件输出 — ctx.output 通道，不在 EventBus 注册新事件

插件热重载:
  POST /api/plugins/:name/reload 或 Dashboard ↻ 按钮，无需重启平台。
  内部流程: stop() → import(url + "?t=" + Date.now()) → init() → start()
```

## Key Modules

| Path | Purpose |
|------|---------|
| `src/cli.ts` | Commander CLI 入口。`start` 命令串联所有启动步骤 |
| `src/core/config.ts` | 集中配置，读 `config/platform.json`。导出 ROOT/DATA_DIR/DB_PATH/PLUGINS_DIR/SKILLS_DIR 等路径常量。`loadConfig()` 缓存单例，`PluginConfig` 含 `platformLLM` 供插件自建 Agent |
| `src/core/llm.ts` | LLM Adapter。`OpenAICompatibleAdapter` 请求排队（Promise 链），healthCheck，支持 reasoning_content。`createAdapter()` 工厂 + `getPlatformLLM()` 单例 + `createAgentModel()` 供插件自建 Agent |
| `src/core/db.ts` | SQLite 封装（better-sqlite3 同步绑定，WAL 模式）。tasks/assets/chat_history 三表。全部参数化查询。导出 `createTask`/`updateTaskState`/`getAllTasks`/`deleteTask`/`createAsset`/`getAssets`/`deleteAsset`/`openPluginDB` 等 |
| `src/core/event-bus.ts` | 单例 pub/sub。6 种事件（log, task.progress, task.error, task.completed, task.state_change, plugin.registered）。handler 错误不中断 bus。`clear()` 用于 shutdown |
| `src/core/error-codes.ts` | 错误码唯一定义源。导出 `ERR_SERVICE_DOWN`/`ERR_TIMEOUT`/`ERR_AUTH`/`ERR_CONTEXT_LIMIT`/`ERR_UNKNOWN` 常量和 `errMsg()` 辅助函数 |
| `src/core/plugin.ts` | Plugin 接口 + PluginContext（llm/eventBus/logger/createAsset/aborted/output）。含 ToolDef/Task/TaskResult 类型。`output.agent` 文档化两种 Agent 模式 |
| `src/core/plugin-manager.ts` | 扫描/注册/校验/派发/并发控制/恢复/取消/热重载。含 ToolRegistry + `createPluginContext` 共享工厂（dispatch + recovery 共用）+ `_replyToContext` 上下文存储。`submitTask` 中根据 `_replyToContext` 自动注入 `_replyTo` 到 params |
| `src/core/logger.ts` | 平台日志（文件 `logs/platform/platform.log` + EventBus `log` 事件，本地时间）。`setEventBus()` 须在 `initDB()` 之前调用 |
| `src/dashboard/server.ts` | Express+WebSocket。Dashboard Agent（Pi Agent + 13 个平台工具）+ 插件 ownSkills 自动注册。模块级 `agentQueue` + `runNextQueued` 排队处理 Agent 请求，`deliverReply` 按 `replyTo.plugin` 回传回复给插件（零插件特定代码）。API 路由 + 静态 UI |
| `src/dashboard/ui/` | SPA：index.html + style.css + utils.js + task-renderer.js + app.js + plugin-log.html。按 `<script>` 顺序加载，支持插件自定义 UI 标签（动态 iframe） |
| `src/platform-skills/` | 共享工具文件（sleep.ts, db_query.ts）。ToolRegistry 启动时动态 import。注意：`clear_context` 是 Dashboard Agent 工具（在 server.ts 内联），不是平台共享工具 |
| `tests/` | 3 个测试文件。core.test.ts（EventBus + Task CRUD），full-suite.test.ts（Config/Logger/DB/LLM/PluginManager/Dashboard/Skills 全覆盖），patch-workflow.test.ts（ComfyUI 工作流补丁逻辑）。需单线程跑避开 SQLite 锁 |
| `config/` | platform.json + agent-prompt.md。不含插件配置 |

## 当前插件

| 插件 | 类型 | 功能 |
|------|------|------|
| recipe-engine | 任务型 | 图片标签提取 → ComfyUI 生图 → 审计迭代。支持批量+断点 |
| x-scrape | 任务型 | X.com 图片爬取。agent-browser + LLM keep/junk |
| wechat-bot | 长生命周期 | iLink Bot 微信通道。收消息→Agent 回复。联系人模式控制 |
| wechat-sub | 长生命周期 | 公众号订阅。搜索/下载/AI摘要/定时轮询/推送 |
| llm-launcher | 长生命周期 | LLM 进程管理。spawn/监控/崩溃重启 |
| knowledge-base | 任务型 | 分子知识库。提取Agent→审计Agent→增量写入。Obsidian 可编辑 |
| article-writer | 任务型 | 公众号文章写作。自建 Agent，大纲→正文→润色三轮审计 |
| trace-character | 任务型 | 图片角色溯源。VLM特征提取→以图搜图→聚合识别→出处定位 |

## Dashboard Agent 工具

Dashboard Agent 拥有 13 个平台级工具（在 `server.ts` 中注册），全部通用不耦合特定插件：
- **平台基础**: `sleep`, `db_query`（默认查 `db/platform.db`）, `clear_context`, `check_file`, `show_image`, `read_platform_doc`
- **插件管理**: `list_plugins`, `read_plugin_doc`, `submit_task`, `reload_plugin`
- **任务管理**: `list_tasks`, `pause_task`, `retry_task`

插件特定的 Agent 工具（如微信操作、插件自有数据库查询）由插件通过 `ownSkills` 定义，平台通过 `setAgentToolRegistrar` 在插件加载时自动注册到 Dashboard Agent，不写在平台代码里。

## 目录结构

```
db/platform.db        ← 平台数据库（tasks + assets + chat_history）
logs/                 ← 所有日志（平台+插件，按名分目录）
data/                 ← 插件数据 + 资产（无日志）
config/               ← platform.json + agent-prompt.md
plugins/              ← 8 个插件（每个含 plugin.json + INPUT.md + OUTPUT.md + index.ts）
```

- 日志由平台统一管理：`ctx.logger.info()` 自动写 `logs/<plugin>/<plugin>-<ts>.log`（session log，每插件最近 5 个）+ 推 EventBus
- 插件数据独立：`data/<plugin>/`，不写 `platform.db`

## Important Notes

- 许可证：AGPL-3.0
- 平台不 import 插件代码。Agent 工具通过 `submitTask("name", params)` 调用
- **replyTo 路由**: `_agentHandler` 处理后通过 `deliverReply` 分发——`replyTo.dashboard` → broadcast，`replyTo.plugin` → `submitTask(plugin, { action: "deliver_reply", content, pluginData })` 交回插件处理。server.ts 零插件特定代码
- **deliver_reply 模式**: 需要从 Agent 接收回复的插件，在 `execute()` 中处理 `action: "deliver_reply"`，从 `content` 和 `pluginData` 自行提取文本/文件并投递
- 插件允许 import 的平台模块：`src/core/config.js`（路径常量 + `loadConfig()`）、`src/core/db.js`（`updateTaskState`、`openPluginDB`、`getChatHistory`——只读）、`src/core/error-codes.js`（错误码常量 + `errMsg()`）、`src/core/llm.js`（`createAgentModel()`）、`src/core/plugin-manager.js`（`pluginOutput()`、`pluginManager`——仅长生命周期插件在 `ctx` 不可用时使用）。不要在插件中导入未在此列出的平台内部函数
- 插件路径用 `ROOT` 拼，不用 `process.cwd()`
- 插件日志：**平台统一管理**——`ctx.logger.info()` 自动写 `logs/<plugin>/<plugin>-<ts>.log` + 推面板。不做 `plog()`/`openLog()`
- 批量任务写 checkpoint，平台恢复时合并到 `params._resumeFrom`，插件在 execute 中读取断点
- 长生命周期插件在 `init()` 恢复状态，`execute()` 只处理控制命令
- 插件热重载：`POST /api/plugins/:name/reload` 或 Dashboard ↻ 按钮。URL 加 `?t=<ts>` 破缓存
- model/baseUrl 读 `loadConfig().llm`，不硬编码
- 错误处理：`ERR_SERVICE_DOWN` → 平台暂停任务 + 通知 Agent；`ERR_CONTEXT_LIMIT` → 平台自动重试一次，再失败标 failed
- Agent 上下文：批量任务每轮清空 `agent.state.messages`，Dashboard Agent 每次 `cleanAgentContext()`
- 插件文档（INPUT.md/OUTPUT.md）被 Agent 通过 `read_plugin_doc` 读取
- 参数校验：提交任务时平台根据 INPUT.md 的 `(必需)` 标记校验，缺参拒绝提交
- tsconfig: ES2022/NodeNext/strict。tsx 直跑，不编译。`noUncheckedIndexedAccess` + `noImplicitOverride` 开启
- 测试: 推荐 `vitest run --pool=forks --poolOptions.forks.singleFork`（单线程避 SQLite 锁）
- DB 层使用 better-sqlite3（同步 native 绑定，WAL 模式），**不依赖系统 sqlite3 CLI**。所有 DB 操作必须通过 `db.ts` 导出的函数，不要在外部直接执行 SQL

## 已知技术债

`violations-audit.json` 记录了代码审查发现（大部分已在 `246f14f` 中修复）：

- **article-writer**：使用 `getChatHistory` 读取平台聊天记录——已纳入插件允许导入清单（只读函数，合法用例）

## Dashboard UI 注意事项

`src/dashboard/ui/` 已拆分为三个文件（按加载顺序）：
- `utils.js` — 纯工具函数（esc, md2html, fmtTime, elapsed, previewAsset）
- `task-renderer.js` — 任务卡片渲染（`window.TaskRenderer.renderTaskList` / `taskAction`）
- `app.js` — 协调层（WebSocket + 事件分发 + 各面板协调）

规则：
- **不硬编码插件名或插件特定格式** — 任务卡片渲染保持数据驱动
- 插件自定义 UI 通过 `<iframe>` 加载 `plugins/<name>/ui.html` 或 `plugin-log.html?name=...`
- 新增插件 UI 能力优先扩展服务端 API（如 `/api/plugins/:name/input`），前端数据驱动渲染
- 批量进度用 `step[N/M]` 通用约定 → 自动渲染子进度条

## 开发文档

- [PLUGIN_GUIDE.md](./PLUGIN_GUIDE.md) — 插件开发指南（ownSkills 注册、接口、生命周期、错误码）
- [PLATFORM_GUIDE.md](./PLATFORM_GUIDE.md) — 平台开发指南（职责边界、反模式清单、如何添加功能）
