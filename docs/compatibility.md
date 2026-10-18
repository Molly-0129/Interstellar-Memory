# 上游兼容性记录

核验日期：2026-10-18。目标：SillyTavern release 1.19.0。
核验时 release 提交：06bde939fb1e9c4c8d8641d810f0a916b5bce127。

本记录说明源码检查，不代表已在用户实际酒馆运行成功。

## 已核对的接口

- getContext 提供 generateRaw、getTokenCountAsync、saveChat、getRequestHeaders、Popup、openCharacterChat、printMessages、chat、chatMetadata 和 eventSource。
- generateRaw 接受 prompt 消息数组、systemPrompt、responseLength、trimNames 和可选 jsonSchema；不自动携带角色卡与整段叙事预设。
- generateRawData 监听 GENERATION_STOPPED 以中断后台生成。
- getTokenCountAsync 为异步接口；Chat Completion 使用对应计数器。
- Popup.show 会同步将弹窗加入页面；支持 HTMLElement 内容与 DISPLAY 类型。
- saveChatConditional 捕获保存错误，因此仅 await 它不足以证明持久化完成。
- 单聊 /api/chats/get 返回带 chat_metadata 的首行和后续消息；扩展保存后使用此接口读回。
- /api/chats/save 可以保存新的独立聊天检查点；使用新的 integrity 标识。
- 核心隐藏函数将消息 is_system 置为 true；主上下文过滤这些消息。扩展实现等价标志更改，并独立执行可靠保存。
- clearChat 同时清除 extension_prompts，所以扩展刷新消息时不调用它。
- 当前群聊 openGroupChat 要求检查点存在于群组 chats 注册表；首版未完整接入群组检查点注册，因此群聊入口明确拒绝执行。

## 官方来源

- [UI 扩展文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [上下文 API](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js)
- [聊天保存、生成与核心上下文](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js)
- [消息隐藏](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/chats.js)
- [弹窗](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/popup.js)
- [群聊打开与保存](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/group-chats.js)

直接服务器端点封装于 src/adapter.js；未来酒馆改动时优先复查该文件。
