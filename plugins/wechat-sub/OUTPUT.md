# wechat-sub 输出规范

## 资产类型
- text/markdown — 下载的文章
- application/json — 分析报告
- text/plain — 搜索结果

## 文件结构
data/wechat-sub/
  ├── sub.db (订阅 + 文章索引)
  ├── token.json (微信登录凭证)
  └── articles/ (下载的文章 .md)

## Agent 使用指南
- 搜索公众号: submit_task("wechat-sub", { action: "search", query: "公众号名" })
- 订阅: submit_task("wechat-sub", { action: "subscribe", query: "fakeid" })
- 查看订阅列表: submit_task("wechat-sub", { action: "list" })
- 手动触发轮询: submit_task("wechat-sub", { action: "poll" })
