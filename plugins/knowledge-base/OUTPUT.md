# knowledge-base 输出规范

## 资产类型
- application/json — 知识条目

## 文件结构
data/knowledge/
  clothing/   ← 服装条目
  scene/      ← 场景条目
  pose/       ← 姿势条目
  style/      ← 画风/艺术家条目
  article/    ← 文章引用条目
  note/       ← 笔记条目

## Agent 使用指南
- 搜索: submit_task("knowledge-base", { action: "search", query: "猫娘" })
- 添加: submit_task("knowledge-base", { action: "add", category: "clothing", name: "兔女郎装", tags: ["兔耳","比基尼"] })
- 重建索引: submit_task("knowledge-base", { action: "rebuild_index" })

## 条目格式（JSON）
{ "name": "名称", "tags": ["标签1", "标签2"] }
