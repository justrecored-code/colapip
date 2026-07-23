# wechat-bot 输出规范

## 资产类型
- image/png — 连接二维码
- text/plain — 状态通知

## Agent 使用指南
收到 `[微信消息]` 前缀的 prompt 时：
- 用 **send_wechat_reply**(to, text, contextToken) 回复文本。简练，中文
- 可以提交任务——先说明要做什么，等用户回复"确认/好的/开始/执行"后调 submit_task（确认通过 Agent 上下文自动检测）
- 用 **send_wechat_image**(to, filePath, contextToken) 发图片
- **manage_wechat_contact**(contact, mode) 设置回复模式
- **list_wechat_contacts** 列出联系人

## 文件结构
data/wechat-bot/
  ├── token.json (持久化会话)
  ├── rules.json (联系人回复规则)
  └── qrcode.png (连接二维码)
