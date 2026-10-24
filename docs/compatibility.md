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

## 0.2.0 补充

重新核对 release 仍为上述提交，public/lib.js 明确导出 yaml。实际扩展使用 SillyTavern.libs.yaml.parseDocument 校验 YAML；不再调用供应商 jsonSchema。旧版 JSON 增量校验与程序渲染模块已经移除。

## 0.2.1 生成状态修复

上游 Generate 会在 dryRun=true 时以及命令提前中止前发出 GENERATION_STARTED，不能将该事件直接锁存为忙碌。改为延迟读取 /script.js 导出的 isGenerating，并结合实际 UI 标志与 StreamingProcessor.isFinished/isStopped。

## 0.2.6：官方 1.14–1.19 兼容核验（2026-10-24）

最低版本为 1.14.0。按官方发布标签核对，不通过版本号猜测接口存在。详细源码契约、提交与链接见 [核验矩阵](compatibility-matrix.json)。

| 版本 | 核心生成状态 | 验证范围 |
| --- | --- | --- |
| 1.14.0 | 读取 live binding is_send_press | 上下文、事件、YAML、模型参数、UI 容器、弹窗、隐藏过滤、检查点端点；适配器模拟流程 |
| 1.15.0–1.17.0 | isGenerating | 上下文、事件、YAML、模型参数、隐藏过滤源码契约 |
| 1.18.0、1.19.0 | isGenerating | 同 1.14 核验范围；适配器模拟流程 |

这些版本均提供 generateRaw 的对象参数与消息数组输入、getTokenCountAsync、Popup、saveChat、printMessages、openCharacterChat 及 SillyTavern.libs.yaml。1.14 的 YAML 依赖为 2.8.1；1.18、1.19 为 2.8.3，使用的 parseDocument/strict/uniqueKeys/maxAliasCount 接口兼容。

1.14 的 /api/chats/save 成功响应为 {result: "ok"}，较新版本为 {ok: true}。插件不依赖成功响应体判定持久化完成，始终通过 /api/chats/get 读回核对元数据、正文与隐藏标志。所有版本继续保留完整原始聊天。

验证边界：65 项自动化检查通过；按三个目标版本契约模拟运行真实适配器和记忆引擎，涵盖请求、检查点、读回、普通总结、四层过渡、分卷及已有失败恢复回归。没有在完整 1.14/1.18 酒馆安装中连接真实供应商实测；手机封装版、第三方分支及其主题仍需实际检查。

### 版本固定的官方来源

- [1.14 上下文接口](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/scripts/st-context.js)
- [1.14 核心生成与状态](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/script.js)
- [1.14 保存端点](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/src/endpoints/chats.js)
- [1.18 上下文接口](https://github.com/SillyTavern/SillyTavern/blob/1.18.0/public/scripts/st-context.js)
- [1.18 保存端点](https://github.com/SillyTavern/SillyTavern/blob/1.18.0/src/endpoints/chats.js)
