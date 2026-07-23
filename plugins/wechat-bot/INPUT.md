# wechat-bot 输入规范

## 任务参数
- action: string (可选, 默认: connect) — connect | disconnect | set_rule | send_reply | send_image | list_rules

### send_reply — 回复文本消息
- to: string (必需) — 目标联系人 ID
- text: string (必需) — 回复文本内容
- contextToken: string (可选) — 消息上下文 token，从收到的消息中获取

### send_image — 发送图片
- to: string (必需) — 目标联系人 ID
- filePath: string (必需) — 图片文件绝对路径
- contextToken: string (可选) — 消息上下文 token

### set_rule — 设置联系人规则
- contact: string (必需) — 联系人 ID
- mode: string (必需) — auto_reply | notify | ignore

### deliver_reply — Agent 回复投递（平台内部调用）

### connect / disconnect / list_rules — 无额外参数
