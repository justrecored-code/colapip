# recipe-engine 输出规范

## 资产类型
- image/png — ComfyUI 生成图（每轮迭代，每 workflow 一张）
- application/json — recipe 标签数据（模块化标签，按 workflow 分组）
- text/markdown — 审计报告（每轮迭代一份 audit_iter{N}.md）
- text/markdown — 总结报告（中文描述 + 迭代日记 summary.md）

## 文件结构
data/assets/recipes/<run_id>/
  ├── original.png
  ├── gen_iter1_seed{N}_basic(anima).png
  ├── gen_iter1_seed{N}_basic(il).png
  ├── audit_iter1.md
  ├── recipe.json
  └── summary.md
