import { KEY, clone, digest, projection, tag, uuid } from './model.js';

// Internal endpoints are isolated here and checked against upstream release 1.19.0.
export class TavernAdapter {
    constructor(getContext = () => globalThis.SillyTavern.getContext(), fetcher = (...args) => fetch(...args)) {
        this.getContext = getContext;
        this.fetcher = fetcher;
    }
    context() { return this.getContext(); }
    capture() {
        const c = this.context();
        if (c.groupId) throw new Error('首版仅支持单角色聊天，群聊尚未开放。');
        const character = c.characters?.[c.characterId];
        const chatId = c.getCurrentChatId?.() ?? c.chatId;
        if (!chatId || (!c.groupId && !character?.avatar)) throw new Error('请先打开已保存的角色聊天。');
        return { chatId, groupId: c.groupId || null, avatar: character?.avatar, name: character?.name,
            key: c.groupId ? 'group:' + c.groupId + ':' + chatId : 'solo:' + character.avatar + ':' + chatId,
            chat: c.chat, metadata: c.chatMetadata };
    }
    assertCurrent(handle) {
        const now = this.capture();
        if (now.key !== handle.key || now.chat !== handle.chat || now.metadata !== handle.metadata) throw new Error('聊天已切换，停止提交本次任务。');
    }
    async connectNativeGenerationState() {
        // isGenerating is exported by core but not included in getContext().
        // Load it lazily so the adapter remains testable outside the browser.
        try {
            const core = await import('/script.js');
            if (typeof core.isGenerating === 'function') this.nativeIsGenerating = core.isGenerating;
        } catch { /* Older forks fall back to their actual UI/stream state. */ }
    }
    activeStream() {
        const stream = this.context().streamingProcessor;
        return !!stream && stream.isFinished !== true && stream.isStopped !== true;
    }
    nativeBusy() { return typeof this.nativeIsGenerating === 'function' && !!this.nativeIsGenerating(); }
    busy() {
        // GENERATION_STARTED also fires for dry runs and aborted commands; never latch it.
        return this.nativeBusy() || globalThis.document?.body?.dataset.generating === 'true' || this.activeStream();
    }
    async read(handle, name = handle.chatId) {
        const group = !!handle.groupId;
        const response = await this.fetcher(group ? '/api/chats/group/get' : '/api/chats/get', {
            method: 'POST', headers: this.context().getRequestHeaders(), cache: 'no-store',
            body: JSON.stringify(group ? { id: name } : { ch_name: handle.name, file_name: name, avatar_url: handle.avatar }),
        });
        if (!response.ok) throw new Error('读取服务器聊天失败：' + response.status);
        const data = await response.json();
        if (!Array.isArray(data) || !data[0]?.chat_metadata) throw new Error('服务器未返回可验证的聊天检查点。');
        return { metadata: data[0].chat_metadata, chat: data.slice(1) };
    }
    async critical(data) {
        return digest({ state: data.metadata[KEY] ?? null, chat: data.chat.map(m => ({
            ...projection(m), hidden: !!m.is_system, data: tag(m) ?? null,
        })) });
    }
    async saveVerified(handle) {
        this.assertCurrent(handle);
        const expected = await this.critical(handle);
        await this.context().saveChat();
        this.assertCurrent(handle);
        const remote = await this.read(handle);
        this.assertCurrent(handle);
        if (await this.critical(remote) !== expected) throw new Error('服务器读回与本次保存不一致，已停止隐藏。请检查连接或其他标签页。');
    }
    async checkpoint(handle, operation) {
        this.assertCurrent(handle);
        const name = handle.chatId + ' - INTERSTELLAR ' + operation;
        const metadata = clone(handle.metadata);
        metadata.main_chat = handle.chatId;
        metadata.integrity = uuid();
        const payload = [{ chat_metadata: metadata, user_name: 'unused', character_name: 'unused' }, ...clone(handle.chat)];
        const response = await this.fetcher(handle.groupId ? '/api/chats/group/save' : '/api/chats/save', {
            method: 'POST', headers: this.context().getRequestHeaders(),
            body: JSON.stringify(handle.groupId ? { id: name, chat: payload } :
                { ch_name: handle.name, file_name: name, avatar_url: handle.avatar, chat: payload }),
        });
        if (!response.ok) throw new Error('检查点保存失败，未发起总结。');
        const saved = await this.read(handle, name);
        this.assertCurrent(handle);
        if (await this.critical(saved) !== await this.critical({ metadata, chat: handle.chat })) throw new Error('检查点未通过服务器读回验证。');
        return name;
    }
    materials() {
        const c = this.context();
        const card = c.characters?.[c.characterId];
        const data = card?.data ?? card ?? {};
        return { name: card?.name ?? data.name ?? '', description: data.description ?? '', personality: data.personality ?? '', scenario: data.scenario ?? '' };
    }
    async tokens(text) {
        const count = await this.context().getTokenCountAsync(text);
        if (!Number.isFinite(count) || count < 0 || (text.trim() && count === 0)) throw new Error('Token 统计失败。');
        return count;
    }
    capacity(settings) {
        const c = this.context();
        return settings.contextLimit || (c.mainApi === 'openai' ? Number(c.chatCompletionSettings?.openai_max_context) : Number(c.maxContext));
    }
    yaml() { return globalThis.SillyTavern?.libs?.yaml; }
    async generate(request, settings) {
        const args = { systemPrompt: request.systemPrompt, prompt: request.prompt,
            responseLength: settings.responseTokens, trimNames: false };
        return this.context().generateRaw(args);
    }
    lock() {
        this.context().deactivateSendButtons?.();
        const input = globalThis.document?.getElementById('send_textarea');
        const previous = input?.disabled;
        if (input) input.disabled = true;
        return () => {
            if (input?.isConnected) input.disabled = previous;
            if (!this.nativeBusy() && !this.activeStream()) this.context().activateSendButtons?.();
        };
    }
    async refresh() {
        const c = this.context();
        if (typeof c.clearChat === 'function' && typeof c.printMessages === 'function') {
            // clearChat also clears other extensions' prompts; only rebuild visible messages.
            globalThis.document?.querySelectorAll('#chat > .mes, #chat > #show_more_messages').forEach(node => node.remove());
            await c.printMessages();
        }
    }
    notify(text, error = false) {
        if (globalThis.toastr) globalThis.toastr[error ? 'error' : 'info'](text, '星间记忆');
    }
    async openCheckpoint(name) {
        const c = this.context();
        if (c.groupId) {
            throw new Error('群聊检查点已保存为独立聊天，请在该群组的聊天管理中打开：' + name);
        }
        await c.openCharacterChat(name);
    }
}
