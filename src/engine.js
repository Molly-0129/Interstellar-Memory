import {
    KEY, clone, uuid, digest, tag, isStory, isSummary, ensureIds, chatHash, contentHash,
    blankState, stateOf, settingsOf, activeOf, memoryOf, validateActive, hiddenPlan, graceProgress,
    setHidden, eligibleStats, shouldAuto, validateSettings,
} from './model.js';
import { buildRequest } from './prompts.js';
import { parseResult } from './schema.js';

export class MemoryEngine {
    constructor(adapter, changed = () => {}) {
        this.adapter = adapter;
        this.changed = changed;
        this.running = false;
        this.cancelled = false;
    }
    context() { return this.adapter.context(); }
    state() { return stateOf(this.context()); }
    async settings() { return settingsOf(this.state()); }
    async saveSettings(settings) {
        if (this.running) throw new Error('整理期间暂不能更改设置。');
        const handle = this.adapter.capture();
        const state = this.state();
        if (state.pending) throw new Error('请先恢复中断操作，再保存设置。');
        const before = clone(state.settings);
        state.settings = validateSettings(settings);
        try { await this.adapter.saveVerified(handle); } catch (e) { state.settings = before; throw e; }
        this.changed();
    }
    async stats() {
        const handle = this.adapter.capture();
        const state = this.state();
        const stats = eligibleStats(handle.chat);
        const memory = memoryOf(handle.chat, state);
        const [tokens, memoryTokens] = await Promise.all([
            this.adapter.tokens(stats.text), this.adapter.tokens(activeOf(handle.chat, state)?.mes ?? ''),
        ]);
        this.adapter.assertCurrent(handle);
        return { count: stats.count, tokens, memoryTokens, revision: state.revision, error: state.error,
            grace: state.grace ? { retained: state.grace.ids.length, progress: graceProgress(handle.chat, state.grace) } : null,
            pending: !!state.pending, checkpoint: state.lastOperation?.checkpoint ?? state.pending?.checkpoint ?? null };
    }
    cancel() {
        this.cancelled = true;
        if (this.running) {
            const c = this.context();
            // generateRaw uses GENERATION_STOPPED as its abort hook.
            void c.eventSource?.emit(c.eventTypes.GENERATION_STOPPED);
        }
    }
    guard(handle, expected = null) {
        if (this.cancelled) throw new Error('本次整理已取消。');
        this.adapter.assertCurrent(handle);
        return expected ? chatHash(handle.chat).then(hash => {
            if (hash !== expected) throw new Error('整理期间聊天内容或隐藏状态已变化，未提交总结。');
        }) : undefined;
    }
    async run(mode = 'ordinary', automatic = false) {
        if (!['ordinary', 'archive'].includes(mode)) throw new Error('未知总结模式。');
        if (this.running || this.adapter.busy()) throw new Error('请等待当前生成完成。');
        const handle = this.adapter.capture();
        const state = this.state();
        if (state.pending) throw new Error('有中断操作需要先恢复。');
        this.running = true;
        this.cancelled = false;
        const unlock = this.adapter.lock();
        let staged = null;
        let operation = null;
        let responseRaw = null;
        try {
            ensureIds(handle.chat);
            await validateActive(handle.chat, state);
            const settings = settingsOf(state);
            const previous = activeOf(handle.chat, state);
            const memory = memoryOf(handle.chat, state);
            const coverage = clone(previous ? tag(previous).coverage : {});
            const fresh = handle.chat.filter(m => isStory(m) && !Object.hasOwn(coverage, tag(m).id));
            if (mode === 'ordinary' && !fresh.length) throw new Error('没有尚未总结的新剧情。');
            const memoryTokens = await this.adapter.tokens(previous?.mes ?? '');
            if (mode === 'archive' && (!previous || memoryTokens < settings.archiveTokens)) throw new Error('分卷尚未解锁：有效记忆需达到 ' + settings.archiveTokens + ' Token。');
            // Archive only reorganizes covered memory; fresh prose stays visible until an ordinary summary.
            const selected = mode === 'ordinary' ? fresh : [];
            const records = await Promise.all(selected.map(async m => ({ id: tag(m).id, role: m.is_user ? 'user' : 'assistant', name: m.name, text: m.mes })));
            const input = {
                previousSummary: previous?.mes ?? '',
                newMessages: records,
                characterContext: this.adapter.materials?.() ?? {},
                relatedSettings: settings.relevantSettings,
                latestForeshadowing: settings.foreshadowing,
                additionalArchives: settings.archiveNotes,
                lockedRecords: settings.lockedText,
            };
            const custom = mode === 'ordinary' ? settings.ordinaryPrompt : settings.archivePrompt;
            const request = buildRequest(mode, input, custom);
            const requestTokens = await this.adapter.tokens(request.systemPrompt + '\n' + JSON.stringify(request.prompt));
            const capacity = this.adapter.capacity(settings);
            // Reserve output plus a conservative format margin; never silently truncate.
            if (!Number.isFinite(capacity) || capacity <= 0) throw new Error('无法读取模型上下文容量，请在设置中填写。');
            if (requestTokens + settings.responseTokens + 2048 > capacity) {
                throw new Error('请求约需 ' + requestTokens + ' Token，另预留输出 ' + settings.responseTokens + ' 与格式余量 2048，超过容量 ' + capacity + '。请调整容量/输出上限，或使用更大窗口模型。原文未隐藏。');
            }
            this.guard(handle);
            const sourceHash = await chatHash(handle.chat);
            state.error = '';
            await this.adapter.saveVerified(handle);
            this.guard(handle);
            const id = uuid();
            const checkpoint = await this.adapter.checkpoint(handle, id);
            await this.guard(handle, sourceHash);
            operation = {
                id, mode, checkpoint, beforeState: clone(state), beforeHidden: Object.fromEntries(handle.chat.map(m => [tag(m).id, !!m.is_system])),
                sourceHash, phase: 'generating', summaryId: null, createdAt: new Date().toISOString(),
            };
            // Avoid recursively embedding all past operations.
            operation.beforeState.lastOperation = state.lastOperation ? { ...clone(state.lastOperation), beforeState: undefined } : null;
            state.pending = operation;
            if (automatic) state.autoAttempt = sourceHash;
            await this.adapter.saveVerified(handle);
            this.changed();
            responseRaw = await this.adapter.generate(request, settings);
            const result = parseResult(responseRaw, mode, this.adapter.yaml());
            await this.guard(handle, sourceHash);
            // The model owns the complete summary; no narrative transformation is performed here.
            const next = { schemaVersion: 1, revision: memory.revision + 1,
                mode, raw: result.raw, document: result.document };
            if (mode === 'ordinary') {
                for (const message of selected) coverage[tag(message).id] = await contentHash(message);
            }
            await this.guard(handle, sourceHash);
            const summaryId = uuid();
            const text = result.raw;
            const ancestors = previous ? [tag(previous).id, ...tag(previous).ancestors] : [];
            staged = {
                name: '星间 · INTERSTELLAR', is_user: false, is_system: false, send_date: Date.now(),
                mes: text, extra: { [KEY]: { id: summaryId, kind: 'summary', status: 'staged', operationId: id,
                    mode, memory: next, coverage, ancestors, renderHash: await digest(text) } },
            };
            const plan = hiddenPlan(handle.chat, coverage, ancestors, summaryId);
            operation.summaryId = summaryId;
            operation.hideIds = plan.hide;
            operation.retained = plan.retained;
            operation.phase = 'staged';
            handle.chat.push(staged);
            // Persist and read back summary before touching ANY source hidden flag.
            await this.adapter.saveVerified(handle);
            this.guard(handle);
            // Ensure source chat is still identical, apart from the new summary.
            if (await chatHash(handle.chat.slice(0, -1)) !== sourceHash) throw new Error('提交时来源已变化，原上下文保持不变。');
            tag(staged).status = 'committed';
            state.activeId = summaryId;
            state.revision = next.revision;
            state.grace = plan.retained.length ? { summaryId, ids: plan.retained, operationId: id } : null;
            operation.appliedIds = [...plan.hide];
            setHidden(handle.chat, plan.hide, true);
            operation.phase = 'committed';
            state.pending = null;
            state.lastOperation = { ...operation, draft: undefined };
            state.error = '';
            await this.adapter.saveVerified(handle);
            await this.adapter.refresh();
            this.adapter.notify(mode === 'archive' ? '分卷总结已保存，旧记忆已安全接替。' : '总结已保存，暂留最近四层剧情供衔接。');
            return next;
        } catch (error) {
            // Never restore or write through a newly selected chat.
            try {
                this.adapter.assertCurrent(handle);
                if (operation) {
                    if (responseRaw !== null) operation.responseRaw = responseRaw;
                    const before = operation.beforeHidden;
                    for (const message of handle.chat) {
                        const id = tag(message)?.id;
                        if (operation.appliedIds?.includes(id) && message.is_system === true) message.is_system = before[id];
                    }
                    const restored = clone(operation.beforeState);
                    if (staged) { staged.is_system = true; tag(staged).status = 'aborted'; }
                    restored.error = error.message;
                    restored.pending = { ...operation, phase: 'failed', error: error.message };
                    handle.metadata[KEY] = restored;
                    // Best effort restore. A failed readback leaves a persistent pending record to recover.
                    try { await this.adapter.saveVerified(handle); } catch { /* recovery rechecks actual server state */ }
                    await this.adapter.refresh();
                } else {
                    state.error = error.message;
                }
            } catch { /* switched chats: leave original pending operation for explicit recovery */ }
            throw error;
        } finally {
            this.running = false;
            unlock();
            this.changed();
        }
    }
    async tick(allowAuto = false) {
        if (this.running || this.adapter.busy()) return;
        let handle;
        try { handle = this.adapter.capture(); } catch { return; }
        const state = this.state();
        if (state.pending || state.error) return;
        if (state.grace && graceProgress(handle.chat, state.grace) >= 4) {
            this.running = true;
            const unlock = this.adapter.lock();
            const before = clone(state);
            const priorFlags = new Map(handle.chat.map(m => [tag(m)?.id, !!m.is_system]));
            try {
                await validateActive(handle.chat, state);
                const active = activeOf(handle.chat, state);
                const ids = state.grace.ids.filter(id => id !== state.activeId && !isSummary(handle.chat.find(m => tag(m)?.id === id)));
                const covered = tag(active).coverage;
                if (ids.some(id => !Object.hasOwn(covered, id))) throw new Error('暂留消息未包含在总结范围内。');
                setHidden(handle.chat, ids, true);
                state.grace = null;
                await this.adapter.saveVerified(handle);
                await this.adapter.refresh();
            } catch (error) {
                this.adapter.assertCurrent(handle);
                for (const message of handle.chat) if (tag(message)?.id && priorFlags.has(tag(message).id)) message.is_system = priorFlags.get(tag(message).id);
                handle.metadata[KEY] = { ...before, error: error.message };
                try { await this.adapter.saveVerified(handle); } catch { /* keep data for recovery */ }
                this.adapter.notify(error.message, true);
            } finally { this.running = false; unlock(); this.changed(); }
        }
        if (!allowAuto || this.running || this.adapter.busy()) return;
        this.adapter.assertCurrent(handle);
        const current = this.state();
        const settings = settingsOf(current);
        if (!settings.autoEnabled || current.pending || current.error) return;
        const stories = handle.chat.filter(isStory);
        if (!stories.length || stories.at(-1).is_user) return; // completed assistant turn only
        const stats = eligibleStats(handle.chat);
        if (stats.count < settings.autoMessages) return;
        const tokens = await this.adapter.tokens(stats.text);
        this.adapter.assertCurrent(handle);
        if (!shouldAuto(settings, stats.count, tokens)) return;
        ensureIds(handle.chat);
        const hash = await chatHash(handle.chat);
        if (current.autoAttempt === hash) return;
        try { await this.run('ordinary', true); } catch (error) { this.adapter.notify(error.message, true); }
    }
    async recover() {
        if (this.running || this.adapter.busy()) throw new Error('请等待当前生成结束。');
        const handle = this.adapter.capture();
        const state = this.state();
        const op = state.pending;
        if (!op) { state.error = ''; await this.adapter.saveVerified(handle); this.changed(); return; }
        const backup = await this.adapter.read(handle, op.checkpoint);
        this.adapter.assertCurrent(handle);
        const saved = new Map(backup.chat.map(m => [tag(m)?.id, m]));
        const currentIds = new Set(handle.chat.map(m => tag(m)?.id));
        if (backup.chat.some(m => !currentIds.has(tag(m)?.id))) throw new Error('原消息已删除，请打开整理前检查点建立恢复分支。');
        for (const message of handle.chat) {
            const id = tag(message)?.id;
            const prior = saved.get(id);
            if (prior) {
                if (await contentHash(prior) !== await contentHash(message)) throw new Error('原文已变化，请打开整理前检查点建立恢复分支。');
            }
        }
        // Restore hidden flags only; never overwrite new chat messages or source text.
        for (const message of handle.chat) {
            const prior = saved.get(tag(message)?.id);
            if (prior) message.is_system = !!prior.is_system;
            if (tag(message)?.operationId === op.id && isSummary(message)) {
                message.is_system = true; tag(message).status = 'aborted';
            }
        }
        handle.metadata[KEY] = clone(backup.metadata[KEY] ?? blankState());
        handle.metadata[KEY].error = '';
        handle.metadata[KEY].pending = null;
        await this.adapter.saveVerified(handle);
        await this.adapter.refresh();
        this.changed();
    }
    async undo() {
        const state = this.state();
        if (state.pending) return this.recover();
        const operation = state.lastOperation;
        if (!operation?.checkpoint) throw new Error('尚无可撤销的整理。');
        if (this.running || this.adapter.busy()) throw new Error('请等待当前生成结束。');
        state.pending = clone(operation);
        await this.recover();
    }
}
