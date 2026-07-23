# 平台开发指南

本指南供修改平台代码的 AI Agent（如 Claude Code）使用。核心原则：**平台代码不耦合任何特定插件**。

## 职责边界（铁律）

```
✅ 平台可以做的:                    ❌ 平台绝对不能做的:
- 任务调度 + 并发控制               - 硬编码插件名 ("wechat-bot", "x-scrape")
- EventBus 事件路由                 - 硬编码插件参数/数据结构
- SQLite 持久化（tasks/assets/       - 硬编码插件默认路径
  chat_history 三表）                - import 插件代码
- LLM Adapter 排队                  - 在通用 UI 里写插件特定的渲染逻辑
- WebSocket Dashboard + Agent       - 在平台工具描述里写插件表结构
- 插件生命周期管理（init/start/     - 假设某个插件一定存在
  execute/stop/reload）
- ownSkills → Agent 工具自动注册
```

**判断标准**：删掉任何一个插件，平台应能正常启动且无报错。如果在平台代码里搜到插件名，那就有问题。

## 架构速览

```
cli.ts (Commander start 命令)
  → loadConfig (config/platform.json → PlatformConfig 单例)
  → initDB (tasks/assets/chat_history 三表)
  → ToolRegistry.loadFromDir (src/platform-skills/*.ts → 共享工具)
  → startDashboard (Express + WebSocket + Dashboard Agent；设置 output handlers)
  → PluginManager.scanAndRegister (plugins/*/plugin.json → dynamic import → init → start；ownSkills 在此注册到 Agent)
  → cleanupOrphanTasks
  → recoverTasks (pending/running/paused → resume)

核心模块:
  config.ts    — ROOT/DATA_DIR/DB_PATH/PLUGINS_DIR 等路径常量 + loadConfig()
  db.ts        — SQLite better-sqlite3 封装（参数化查询，WAL 模式）+ TaskRow/AssetRow 类型
  event-bus.ts — 单例 pub/sub，9 种事件，handler 错误不中断
  plugin.ts    — Plugin 接口 + PluginContext + ToolDef + Task 类型
  plugin-manager.ts — 扫描/注册/派发/恢复/热重载/ownSkills 注册
  llm.ts       — OpenAICompatibleAdapter，请求排队，健康检查
  logger.ts    — 平台日志（文件 + EventBus）
  server.ts    — Express + WebSocket + Dashboard Agent + API 路由
```

## 如何添加平台功能

### 添加共享工具（platform-skill）

在 `src/platform-skills/` 新建 `.ts` 文件，export 一个 `ToolDef` 对象。ToolRegistry 启动时自动加载。

**规则**：
- 工具描述和默认参数**必须通用**，不能引用特定插件的数据
- ❌ 坏：`默认查 x-scrape 的 images.db。表结构: images(id, is_valid, tweet_hash...)`
- ✅ 好：`默认查平台数据库 db/platform.db。表结构: tasks(id, plugin_name, state...)`

示例（`db_query.ts`）：
```typescript
export const dbQuery = {
  name: "db_query",
  label: "查询数据库",
  description: "执行 SQL 查询。默认查平台数据库。可指定 db 参数。",
  parameters: Type.Object({ sql: Type.String(), db: Type.Optional(Type.String()) }),
  execute: async (_tid, raw) => { /* ... */ },
};
```

### 添加 Dashboard Agent 工具

在 `src/dashboard/server.ts` 的 `dashAgent.state.tools` 数组中添加。只加**平台级通用工具**，不加任何插件特定的。

**例子**：
- ✅ `list_plugins` — 通用，列所有插件
- ✅ `submit_task` — 通用，提交任意插件任务
- ✅ `read_plugin_doc` — 通用，读任意插件的 INPUT/OUTPUT
- ❌ `send_wechat_reply` — 插件特定，属于 wechat-bot 的 `ownSkills`
- ❌ `query_db` 默认查 x-scrape 的 images.db — 插件特定

**如果插件需要 Agent 工具**：插件在 `ownSkills` 中定义，平台启动时通过 `setAgentToolRegistrar` 自动注册到 Dashboard Agent。

### 插件 ownSkills → Agent 工具注册流程

```
1. server.ts 调用 setAgentToolRegistrar(callback)
2. PluginManager.scanAndRegister() 加载每个插件
3. 如果 plugin.ownSkills.length > 0，回调注册到 Agent
4. 同名工具不重复注册
5. 热重载时重新注册
```

插件 `ownSkills` 里的工具走 `submitTask` 模式调用自己：
```typescript
{
  name: "my_tool",
  execute: async (_tid, raw) => {
    // 不 import 插件代码，通过 submitTask 提交
    await pluginManager.submitTask("my-plugin", { action: "xxx", ...raw });
    return { content: [...], details: {} };
  },
}
```

### 扩展 PluginContext

如果需要给插件提供新的平台能力，改 `src/core/plugin.ts` 的 `PluginContext` 接口，然后在 `plugin-manager.ts` 的 `createPluginContext()` 中实现。插件不需要改代码就能用到新能力。

### 输出路由（replyTo）

平台主 LLM（Dashboard Agent）是统一的大脑，不绑定任何输出通道。调用方通过 `replyTo` 指定输出目标，`_agentHandler` 自动分发：

```typescript
// 插件调用
ctx.output.agent("dashboard", {
  prompt: "需要处理的消息",
  replyTo: { dashboard: true }                                    // → Dashboard
  replyTo: { plugin: "wechat-bot", pluginData: { to: "xxx" } }   // → 投递给目标插件
  // 两者都带 → 同时推送
});

// _agentHandler 自动提取 Agent 回复，deliverReply 按 replyTo 分发
```

规则：
- `replyTo.dashboard` → `broadcast("plugin.output", ...)` 推 WebSocket
- `replyTo.plugin` → `pluginManager.submitTask(plugin, { action: "deliver_reply", content, pluginData })` 投递
- 不传 `replyTo` → 默认 `{ dashboard: true }`（向后兼容）
- Agent 只生成内容，不知道输出去哪

### 添加新 EventBus 事件

在 `src/core/event-bus.ts` 的 `EventName` 类型中添加。目前 9 种事件：
- `log`, `task.progress`, `task.error`, `task.completed`, `task.state_change`
- `plugin.registered`, `plugin.error`, `service.error`, `asset.created`

只有平台层 emit 事件。插件通过 `ctx.eventBus.emit()` 上报错误和进度，但不注册新事件类型。

## Dashboard UI 开发规则

```
src/dashboard/ui/
  utils.js          ← 纯工具函数，无副作用
  task-renderer.js  ← 任务卡片渲染，数据驱动
  app.js            ← 协调层（WebSocket + 事件分发 + 面板）
  index.html        ← 骨架
  style.css         ← 样式
  plugin-log.html   ← 插件日志查看器（独立页面）
```

### 任务卡片渲染规则

- **不硬编码插件名** — 不写 `if (t.plugin_name === "xxx")`
- **不解析插件特定的 step 格式** — `batchMatch` 的 `[N/M]` 是通用约定，不是针对某个插件的
- **数据驱动** — 卡片渲染只看 `t.state`、`t.progress`、`t.step`、`t.error` 这些通用字段
- **插件自定义 UI** — 通过 `plugins/<name>/ui.html` 的 iframe 标签页实现，不在 app.js 里加分支

### 插件标签页

`refreshPluginTabs()` 动态查询 `/api/plugins`，自动为有 `ui.html` 的插件创建 iframe 标签页。不需要在 index.html 里硬编码。

## 反模式清单

以下是从本平台代码中实际清理掉的反模式：

### 1. 在 server.ts 硬编码插件 Agent 工具

```typescript
// ❌ 坏 — 平台代码里出现插件名
{ name: "send_wechat_reply", execute: () => pluginManager.submitTask("wechat-bot", ...) }
{ name: "query_db", description: "默认查 x-scrape 的 images.db。表结构: images(...)" }
```

**正确做法**：插件在 `ownSkills` 中定义这些工具，平台自动注册。

### 2. 在平台工具里硬编码插件默认路径

```typescript
// ❌ 坏
const DEFAULT_DB = path.join(ROOT, "data", "x-scrape", "images.db");
```

**正确做法**：默认路径指向平台数据库或要求显式传参。

### 3. 在平台工具描述里写插件表结构

```typescript
// ❌ 坏
description: "表结构: images(id, is_valid, tweet_hash)..."
```

**正确做法**：描述平台表结构（tasks/assets/chat_history）。插件数据表由插件自己的 Agent 工具描述。

### 4. 在通用 UI 里解析插件特定格式

```javascript
// ❌ 坏 — 解析特定插件的 step 格式
if (t.plugin_name === "recipe-engine") { /* special rendering */ }
```

**正确做法**：通用约定（如 `step[N/M]` → 子进度条），或插件提供自己的 `ui.html`。

## 测试

```bash
npm test                  # vitest run（全部测试）
npm run test:watch        # vitest watch 模式
npx vitest run --pool=forks --poolOptions.forks.singleFork  # 推荐（避免 SQLite 锁）
```

测试文件：`tests/core.test.ts`、`tests/full-suite.test.ts`、`tests/patch-workflow.test.ts`

注意：测试需单线程跑避开 SQLite 锁竞争。

## 添加新功能检查清单

在提交平台代码修改前，确认：

- [ ] 代码中没有硬编码任何插件名（grep 检查）
- [ ] 代码中没有硬编码插件数据路径或表结构
- [ ] Dashboard Agent 新工具是通用的（删掉任意插件仍正常工作）
- [ ] UI 渲染逻辑不依赖特定插件的输出格式
- [ ] `npm run typecheck` 通过
- [ ] 新能力通过 PluginContext 或 ownSkills 暴露给插件，不是反过来
- [ ] 如果修改了 Plugin 接口，同步更新 PLUGIN_GUIDE.md

## 未来改进

- **BackgroundContext**：长生命周期插件（wechat-bot 等）在 `start()` 后台循环中需要输出能力，但 `PluginContext` 只在 `execute()`/`resume()` 期间存在。目前插件通过直接 import `plugin-manager` 的 `pluginOutput()` 和 `event-bus` 的 `eventBus` 绕过。应提供 `BackgroundContext`——一个在 `start()` 期间同样可用的轻量 context，使插件不需要直接依赖平台内部模块。
