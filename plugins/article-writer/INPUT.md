# article-writer 输入规范

## clearify
- topic: string (必需) — 文章主题
- style: string (可选, 默认: 公众号长文)

Agent 生成 5-10 个盘问问题，帮你理清内容需求。

## write
- topic: string (必需) — 文章主题
- answers: string (必需) — 对 clearify 问题的回答（或直接描述需求）
- style: string (可选, 默认: 公众号长文)
- ref_dirs: string (可选, 默认: all) — 参考知识库目录
