# recipe-engine 输入规范

## 任务参数（二选一）
- prompt: string (可选) — 英文提示词，逗号分隔（提示词生图）
- image: string (可选) — 图片路径/"all"（图片反推生图）
- max_iterations: number (可选) — 迭代次数（extract 默认 3, generate 忽略）

至少填一个。有 prompt 就生图，有 image 就反推，都没有报错。
