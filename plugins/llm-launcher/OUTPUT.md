# llm-launcher 输出规范

## 资产类型
- text/plain — 状态通知 + LLM 日志

## 文件结构
data/llm-launcher/
  └── (LLM 进程日志通过 stdout 流式输出，不写文件)

## Agent 使用指南
- 启动 LLM: submit_task("llm-launcher", { action: "start", command: "llama-server", args: "-m model.gguf --port 12315" })
- 停止: submit_task("llm-launcher", { action: "stop" })
- 状态: submit_task("llm-launcher", { action: "status" })
