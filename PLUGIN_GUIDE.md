# 插件开发指南

本指南供 AI Agent（如 Claude Code）使用。读完本文档后，应能独立开发一个可注册到平台的插件。

## 平台与插件的职责边界

```
平台提供:                        插件负责:
- 任务调度 (submitTask/dispatch)  - 业务逻辑 (execute/resume)
- 事件路由 (EventBus)             - 自己的数据 (data/<name>/)
- WebSocket Dashboard             - 自己的日志
- LLM Adapter (ctx.llm)          - 自己的配置
- 独立 Agent 实例                 - INPUT.md/OUTPUT.md
- 资产注册 (ctx.createAsset)      - 可选的 ui.html
- 任务完成通知 (notify 参数)
- 错误暂停/重试 (ERR_SERVICE_DOWN 等)
- Agent 工具注册 (ownSkills)
```

**平台不 import 插件代码**——所有交互通过接口：`submitTask("name", params)` 提交任务，`ownSkills` 注册 Agent 工具。

**平台代码内禁止硬编码插件名、插件数据结构、插件默认路径。**

## 强制约束

- `usesPiAgent: true` — plugin.json 必须声明
- LLM 调用走 `ctx.llm.chat()` — Adapter 排队，不直连
- 错误映射到标准错误码 — `ERR_TIMEOUT` / `ERR_SERVICE_DOWN` / `ERR_AUTH` / `ERR_CONTEXT_LIMIT`
- 路径用 `ROOT` — 不用 `process.cwd()`
- model 用 `loadConfig().llm` — 不硬编码
- 只用 ESM import — 不用 `require()`
- 名唯一 — 重复拒绝注册

## Plugin 接口

```typescript
interface Plugin {
  name: string; version: string; description: string;
  usesPiAgent: true;
  llm?: LLMConfig; vlm?: LLMConfig; services?: PluginServices;
  skills: string[]; ownSkills: ToolDef[];
  init(config: PluginConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): PluginStatus;
  execute(task: Task, ctx: PluginContext): Promise<TaskResult>;
  resume(taskId: string, checkpoint: unknown, ctx: PluginContext): Promise<void>;
}

interface PluginContext {
  llm: LLMAdapter;
  eventBus: { emit(event: string, data: unknown): void };
  logger: { info/warn/error/debug(msg: string): void };
  createAsset(taskId, type, filePath, filename, size, metadata?): void;
  aborted: boolean;
  output: {
    platform(data: unknown): void;  // → Dashboard 展示，Agent 不知道
    agent(data: unknown): void;     // → 发给本插件的独立 Agent
  };
}
```

`output.platform` 和 `output.agent` 是两条独立通道。需要两个都通知就各调一次。

**ctx 在 init() 后即可用**——不依赖 execute() 调用。长生命周期插件的后台 loop 可以直接用 `ctx.logger.info()`、`ctx.output.agent()`。

## 插件目录结构

```
plugins/my-plugin/          ← 删掉这个目录 = 彻底卸载，不留孤儿文件
  plugin.json     ← 必须
  INPUT.md        ← 必须。Agent 通过 read_plugin_doc 读取
  OUTPUT.md       ← 必须。含 Agent 使用指南
  index.ts        ← 必须。Plugin 实现
  ui.html         ← 可选。Dashboard 自动加标签页
  token.json      ← 可选。私有凭证
  config.json     ← 可选。自有配置
  my-plugin.db    ← 可选。自建 SQLite
  data/           ← 可选。插件产出的所有内容文件

logs/my-plugin/             ← 平台自动管理（ctx.logger），不算插件数据
```

**核心原则：插件目录自包含。删掉 `plugins/<name>/` 就清掉了该插件的一切。**
不往 `db/`、`data/assets/` 等全局目录散落文件。

## plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "描述",
  "usesPiAgent": true,
  "skills": ["db_query"],
  "workflows": [
    { "key": "wf1", "file": "workflow.json", "modes": ["generate"] }
  ]
}
```

`skills` — 依赖的平台共享工具（如 `db_query`、`sleep`）。注册时校验：缺失则拒绝加载。
`workflows[].modes` — 声明工作流适用场景（generate/extract/reverse 等），用户不需要手动指定工作流文件名。

## INPUT.md & OUTPUT.md

```markdown
# 插件名 输入规范
## 任务参数
- param_name: type (必需/可选, 默认: 值) — 描述
```

```markdown
# 插件名 输出规范
## 资产类型
- mime/type — 描述
## 文件结构
data/<plugin>/xxx
## Agent 使用指南
- 怎么做1
- 怎么做2
```

MIME 白名单：`image/png, image/jpeg, image/webp, image/gif, audio/wav, audio/mp3, audio/ogg, video/mp4, video/webm, text/markdown, text/plain, application/json, application/pdf`

### 参数校验

提交任务时平台根据 INPUT.md 自动校验：

- `(必需)` 参数缺失 → **拒绝提交，不创建任务**
- 全部可选且无默认值 → 允许提交，插件自己处理缺参逻辑
- Agent 收到校验错误后可修正参数重新提交

**插件上线前检查**：提交空参数任务，必须被平台拒绝而不是创建出无效任务。

## 任务通知 (notify)

插件完成时不需要自己通知 Agent。平台根据 `notify` 参数自动处理：

```typescript
// Agent 提交时带 notify=true，平台完成后自动通知
submit_task("recipe-engine", { prompt: "...", notify: true })

// 后台任务不需要通知
submit_task("wechat-sub", { action: "poll", notify: false })
```

| notify | 平台行为 |
|--------|---------|
| `true` | 任务完成/暂停时自动 push Agent |
| `false/不传` | 只更新任务卡片，不通知 |

## Agent 工具注册 (ownSkills)

插件的 `ownSkills` 会在注册时**自动注册到 Dashboard Agent**，用户可以在聊天面板直接调用：

```typescript
import { Type } from "@sinclair/typebox";

const myPlugin: Plugin = {
  // ...
  ownSkills: [
    {
      name: "send_wechat_reply",
      label: "回复微信",
      description: "通过微信回复文本消息",
      parameters: Type.Object({ to: Type.String(), text: Type.String() }),
      execute: async (_tid, raw) => {
        const { to, text } = raw as { to: string; text: string };
        // 通过 submitTask 模式调用自己的任务，不 import 插件代码
        await pluginManager.submitTask("wechat-bot", { action: "send_reply", to, text });
        return { content: [{ type: "text", text: `已回复 ${to}` }], details: {} };
      },
    },
  ],
};
```

**关键原则**：
- `ownSkills` 中的工具不走 `ctx.llm.chat()`，而是通过 `submitTask` 提交任务给插件执行
- 工具在插件 `init()` → `start()` 后自动注册，热重载时重新注册
- 同名工具不重复注册
- 工具描述要写清楚，这就是 Agent 的"使用手册"

## 错误码与上报

| 错误码 | 性质 | 平台行为 |
|--------|------|---------|
| `ERR_SERVICE_DOWN` | 临时 | **暂停任务**，通知 Agent。恢复后可重试 |
| `ERR_CONTEXT_LIMIT` | 永久 | 自动重试一次，失败则标失败 |
| `ERR_TIMEOUT` | 临时 | 标失败，通知 Agent |
| `ERR_AUTH` | 永久 | 标失败，通知 Agent |

上报：`ctx.eventBus.emit("task.error", { taskId, errorCode, rawError, pluginName })`

**插件只上报，平台决定。** 不要在插件里写暂停/重试/取消逻辑。

## 进度上报

```typescript
ctx.eventBus.emit("task.progress", { taskId, progress: 0.5, step: "generating" });
ctx.createAsset(taskId, "image/png", filePath, filename, size, { metadata });
```

`task.completed` 在 `execute()` 返回 `{ success: true }` 时平台自动发送。插件不需要手动 emit。

**批量进度约定**：step 字段用 `step名称[N/M]` 格式（如 `处理中[5/20]`），Dashboard 自动渲染子进度条。这是通用约定，任何插件都可以用。

## 日志

**平台统一管理。** 直接用 `ctx.logger`：

```typescript
ctx.logger.info("处理开始");
ctx.logger.warn("速率限制");
ctx.logger.error("外部服务不可用");
```

平台自动写 `logs/<plugin>/<plugin>-<ts>.log`。不推平台日志面板。插件不要自己 `createWriteStream`。

## 插件输出

```typescript
// 平台展示
ctx.output.platform({ type: "status", text: "连接成功" });

// 发给自己插件的 Agent（单参数，向后兼容）
ctx.output.agent({ prompt: "需要处理的内容..." });

// 发给平台主 LLM（双参数，推荐异步调用场景）
ctx.output.agent("dashboard", {
  prompt: "[微信 from=xxx] 用户消息",
  replyTo: { wechat: { to: "xxx", contextToken: "xxx" } }
});
```

- `platform` → WebSocket → Dashboard 展示
- `agent(name, { prompt, replyTo })` → 平台统一 Agent 路由：
  - 单参数 `agent({ prompt })` → 本插件独立 Agent（上下文隔离）
  - 双参数 `agent("dashboard", { prompt, replyTo })` → 平台主 LLM（共享大脑）

**`replyTo` 输出路由**（由平台自动分发，Agent 只管生成内容）：
```typescript
replyTo: { dashboard: true }              // → Dashboard WebSocket
replyTo: { wechat: { to, contextToken } } // → 自动发微信回复
// 两者都带 → 同时推送
```

**不在 EventBus 注册新事件。**

### 长生命周期插件的输出通道

`PluginContext` 只在 `execute()` 和 `resume()` 期间可用。长生命周期插件（如 wechat-bot）在 `start()` 中运行后台循环，此时 `ctx` 尚未存在。

后台循环中需要输出时，可从 `plugin-manager` 导入以下工具：

```typescript
import { pluginOutput, pluginManager } from "../../src/core/plugin-manager.js";
import { eventBus } from "../../src/core/event-bus.js";

// 推送到 Dashboard（等价于 ctx.output.platform）
pluginOutput().platform?.({ type: "status", text: "已连接" });

// 发送给 Dashboard Agent（等价于 ctx.output.agent("dashboard", ...)）
pluginOutput().agent?.("dashboard", { prompt: "需要处理的消息", replyTo: {...} });

// 发送事件（等价于 ctx.eventBus.emit）
eventBus.emit("task.error", { taskId, errorCode: "ERR_SERVICE_DOWN", ... });
```

**注意**：`execute()` 期间仍应使用 `ctx.output` 和 `ctx.eventBus`。以上工具仅在 `ctx` 不可用时作为替代。

这是平台的设计缺口——未来可能提供 `BackgroundContext` 统一这两种模式。

## Agent 实例

```
Dashboard Agent  ← 平台主 LLM（统一大脑），Dashboard 聊天 + 所有异步调用均复用
Plugin Agent     ← 每插件一个，ctx.output.agent({ prompt }) 自动创建，上下文隔离
```

`notify` 路由自动正确：任务谁提交的就通知回谁的 Agent。确认状态（taskConfirmed）自然隔离。

## Agent 上下文管理

批量处理时必须管理上下文：

```typescript
for (const item of items) {
  agent.state.messages = [];  // 每条独立上下文
  await agent.prompt(`处理: ${item}`);
  await agent.waitForIdle();
}
```

## 审计 Agent

输出型插件应考虑配审计 Agent——校验结构、查重、合并增量。审计通过才落盘。

## 数据与文件存放

### 两类的区别

| 类型 | 放哪 | 举例 | 删插件时 |
|------|------|------|---------|
| **插件内部** | `plugins/<name>/` | DB、凭证、配置、UI 缓存 | 一起删 |
| **成果数据** | `data/assets/<name>/` | 文章、配方、图片、知识库 | **保留** |

**插件内部** — 插件为了运行自己需要的东西。删掉插件目录就没了，反正别的插件也用不上。

**成果数据** — 插件产出的有价值内容。其他插件可能消费（knowledge-base 读 wechat-sub 的文章），用户可能手动查看。删插件不该丢成果。

### 约定

```
plugins/<name>/            ← 删掉这里 = 卸载插件
  <name>.db               ← 自建 SQLite
  token.json              ← 凭证

data/assets/<name>/       ← 成果数据（插件间共享）
  recipes/
  articles/
  images/

data/knowledge/           ← knowledge-base 的 Obsidian vault
```

### 插件自有 SQLite 数据库

```typescript
import { openPluginDB } from "../../src/core/db.js";
const db = openPluginDB(path.join(_rootDir, "my-plugin.db"));
```

### 日志

**平台统一管理。** 直接 `ctx.logger`，平台自动写 `logs/<plugin>/`。

### 插件自建 Agent 实例

插件如需要多轮有状态工作流 + 自定义工具，应使用 `createAgentModel()` 构造模型描述符：

```typescript
import { createAgentModel } from "../../src/core/llm.js";
const agent = new Agent({
  initialState: {
    systemPrompt: "你是助手...",
    model: createAgentModel({ name: "MyPlugin", supportsImages: true }),
    thinkingLevel: "high",
  },
  // ...
});
```

不要从 `loadConfig().llm` 手动拼装模型对象——`createAgentModel()` 已经封装了所有默认值。

## 生命周期

```
init() → start() → ┌─ 任务型: execute() → 返回 → 等下次
                   └─ 长周期: init 启 loop → execute 处理命令
              → stop()
```

ctx（含 output、logger）在 init() 后即可用。

## 取消信号

```typescript
for (const item of items) {
  if (ctx.aborted) return { success: false, error: "cancelled" };
}
```

## 断点恢复

```typescript
import { updateTaskState } from "../../src/core/db.js";
updateTaskState(task.id, "running", { checkpoint: { idx: N } });

// resume 读 checkpoint
async resume(taskId, checkpoint, ctx) {
  const cp = checkpoint as { idx: number } | null;
  await this.execute({ ...task, params: { ...task.params, _resumeIdx: cp?.idx ?? 0 } }, ctx);
}
```

内部参数 `_` 前缀区分。

## 热重载

↻ 按钮或 `POST /api/plugins/:name/reload`。无需重启平台。重载后 `ownSkills` 自动重新注册。

## Agent 如何使用你的插件

1. `read_plugin_doc(name)` → 读 INPUT.md + OUTPUT.md
2. `list_plugins` → 确认存在
3. `submit_task(name, params)` → 提交任务
4. 任务面板"新建任务" → INPUT.md 自动渲染表单
5. 如果插件定义了 `ownSkills`，Agent 直接调用这些工具

**写好 OUTPUT.md 和 ownSkills 描述就是给 Agent 写使用手册。**

## 最小示例

```typescript
import type { Plugin, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";

const myPlugin: Plugin = {
  name: "my-plugin", version: "1.0.0", description: "示例",
  usesPiAgent: true, skills: [], ownSkills: [],
  async init() {}, async start() {}, async stop() {},
  getStatus() { return "idle"; },
  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    ctx.logger.info("开始");
    return { success: true, data: { result: "done" } };
  },
  async resume() {},
};
export default myPlugin;
```
