# knowledge-base 输入规范

## 任务参数
- action: string (可选, 默认: search) — search | add | rebuild_index | import_from_recipes | import_from_articles | auto_curate
- query: string (可选) — 搜索关键词（search 时）
- category: string (可选) — 分类名（add 时，默认 note）
- name: string (可选) — 条目名（add 时）
- tags: string[] (可选) — 标签列表（add 时）

### auto_curate
- source: string (可选, 默认: all) — all | articles | recipes。只分析指定数据源
