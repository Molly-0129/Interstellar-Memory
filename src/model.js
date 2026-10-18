export const KEY = 'interstellar_memory';
export const SCHEMA_VERSION = 1;
export const clone = value => structuredClone(value);
export const uuid = () => globalThis.crypto.randomUUID();
export function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
}
export async function digest(value) {
    const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stable(value));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function tag(message) { return message?.extra?.[KEY]; }
export function isSummary(message) { return tag(message)?.kind === 'summary'; }
export function isStory(message) {
    return !isSummary(message) && message?.is_system !== true && typeof message?.mes === 'string' && message.mes.trim().length > 0 &&
        !message.extra?.tool_invocations?.length && !message.extra?.[KEY]?.notification;
}
export function ensureIds(chat) {
    const seen = new Set();
    for (const message of chat) {
        message.extra ??= {};
        message.extra[KEY] ??= {};
        let id = message.extra[KEY].id;
        if (!id || seen.has(id)) id = message.extra[KEY].id = uuid();
        seen.add(id);
    }
}
export function projection(message) {
    return { id: tag(message)?.id, mes: message.mes, name: message.name, user: !!message.is_user, swipe: message.swipe_id ?? null };
}
export async function contentHash(message) { return digest(projection(message)); }
export async function chatHash(chat) {
    return digest(chat.map(message => ({ ...projection(message), hidden: !!message.is_system })));
}
export function blankMemory() {
    return { schemaVersion: 1, revision: 0, timeline: [], volumes: [], world: {
        scene: '', characters: [], relationships: [], secrets: [], items: [], locations: [], affairs: [],
    }, details: [], clues: [], foreshadowing: '', locks: '', issues: [] };
}
export function blankState() {
    return { schemaVersion: 1, activeId: null, revision: 0, grace: null, pending: null, lastOperation: null,
        settings: {}, error: '', autoAttempt: null };
}
export function stateOf(context) {
    const state = context.chatMetadata[KEY] ??= blankState();
    if (state.schemaVersion !== SCHEMA_VERSION) throw new Error('记忆数据版本不兼容，请更新扩展。');
    return state;
}
export function activeOf(chat, state) {
    if (!state.activeId) return null;
    const found = chat.find(message => tag(message)?.id === state.activeId && isSummary(message));
    if (!found || found.is_system || tag(found).status !== 'committed') throw new Error('当前有效总结缺失或被隐藏。请先恢复检查点。');
    return found;
}
export function memoryOf(chat, state) {
    const message = activeOf(chat, state);
    return message ? clone(tag(message).memory) : blankMemory();
}
export async function validateActive(chat, state) {
    const message = activeOf(chat, state);
    if (!message) return;
    const data = tag(message);
    if (await digest(message.mes) !== data.renderHash) throw new Error('当前总结正文已被修改，请先恢复检查点再整理，避免正文与记忆数据不一致。');
    const byId = new Map(chat.map(m => [tag(m)?.id, m]));
    for (const [id, hash] of Object.entries(data.coverage)) {
        const original = byId.get(id);
        if (!original || await contentHash(original) !== hash) throw new Error('已总结的剧情发生编辑、删除或备选回复变化。已暂停自动隐藏，请从检查点分支重新整理。');
    }
}
export const DEFAULTS = Object.freeze({
    autoEnabled: false, autoMessages: 200, autoTokens: 256000, archiveTokens: 64000,
    responseTokens: 16384, contextLimit: 0, structuredOutput: false,
    lockedText: '', archiveNotes: '', foreshadowing: '', relevantSettings: '',
    ordinaryPrompt: '', archivePrompt: '',
});
export function settingsOf(state) { return { ...DEFAULTS, ...state.settings }; }
export function validateSettings(value) {
    for (const key of ['autoMessages', 'autoTokens', 'archiveTokens', 'responseTokens']) {
        if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(key + ' 必须为正整数。');
    }
    if (!Number.isSafeInteger(value.contextLimit) || value.contextLimit < 0) throw new Error('上下文容量必须为非负整数；0 表示使用酒馆设置。');
    for (const key of ['autoEnabled', 'structuredOutput']) if (typeof value[key] !== 'boolean') throw new Error(key + ' 必须是开关。');
    for (const key of ['lockedText','archiveNotes','foreshadowing','relevantSettings','ordinaryPrompt','archivePrompt']) if (typeof value[key] !== 'string') throw new Error(key + ' 必须是文本。');
    return value;
}
export function eligibleStats(chat) {
    const messages = chat.filter(isStory);
    return { count: messages.length, text: messages.map(m => (m.is_user ? '用户' : m.name || 'AI') + ': ' + m.mes).join('\n\n') };
}
export function shouldAuto(settings, count, tokens) {
    return settings.autoEnabled && count >= settings.autoMessages && tokens >= settings.autoTokens;
}
const worldKeys = {
    characters: x => x.name, relationships: x => [...x.parties].sort().join('\u0000'),
    secrets: x => x.key, items: x => x.name, locations: x => x.name, affairs: x => x.key,
};
export function patchWorld(base, patch) {
    const world = clone(base);
    if (patch.scene?.trim()) world.scene = patch.scene;
    for (const [key, getKey] of Object.entries(worldKeys)) {
        for (const item of patch[key] ?? []) {
            const index = world[key].findIndex(old => getKey(old) === getKey(item));
            if (index < 0) world[key].push(clone(item)); else world[key][index] = clone(item);
        }
    }
    return world;
}
export function mergeResult(base, result, operation, locks) {
    if (result.baseRevision !== base.revision) throw new Error('模型返回的基础版本不匹配。');
    const memory = clone(base);
    memory.revision++;
    memory.locks = locks;
    memory.world = patchWorld(memory.world, result.stateUpdates);
    memory.issues = [...new Set([...memory.issues, ...result.issues])];
    memory.clues ??= [];
    for (const clue of result.foreshadowingUpdates ?? []) {
        const index = memory.clues.findIndex(x => x.key === clue.key);
        if (index < 0) memory.clues.push(clone(clue)); else memory.clues[index] = clone(clue);
    }
    for (const change of result.detailUpdates) {
        const index = memory.details.findIndex(x => x.id === change.id);
        if (index < 0) throw new Error('重要细节修订引用不存在：' + change.id);
        memory.details[index] = { id: change.id, ...clone(change.record) };
    }
    result.newDetails.forEach((record, i) => memory.details.push({ id: 'd-' + operation + '-' + i, ...clone(record) }));
    if (result.mode === 'ordinary') {
        for (const change of result.eventUpdates) {
            const index = memory.timeline.findIndex(x => x.id === change.id);
            if (index < 0) throw new Error('只能修订当前时间线的已有事件：' + change.id);
            memory.timeline[index] = { id: change.id, ...clone(change.record) };
        }
        result.newEvents.forEach((record, i) => memory.timeline.push({ id: 'e-' + operation + '-' + i, ...clone(record) }));
    } else {
        const units = [...memory.volumes.map(v => v.id), ...memory.timeline.map(e => e.id)];
        const allRefs = [...result.archives.flatMap(v => v.sourceIds), ...result.currentEventIds];
        if (new Set(allRefs).size !== allRefs.length || allRefs.length !== units.length || units.some(id => !allRefs.includes(id))) {
            throw new Error('分卷未完整且唯一地覆盖输入历史，拒绝替换记忆。');
        }
        if (!result.archives.length) throw new Error('未识别到适合归档的阶段，保留当前记忆。');
        const events = new Map(memory.timeline.map(e => [e.id, e]));
        if (result.currentEventIds.some(id => !events.has(id))) throw new Error('当前卷只能引用详细事件。');
        const ordered = memory.timeline.filter(e => result.currentEventIds.includes(e.id)).map(e => e.id);
        if (stable(ordered) !== stable(result.currentEventIds)) throw new Error('当前卷的事件顺序发生变化。');
        const first = memory.timeline.findIndex(e => result.currentEventIds.includes(e.id));
        if (first >= 0 && memory.timeline.slice(first).some(e => !result.currentEventIds.includes(e.id))) {
            throw new Error('当前卷必须保留连续的最新阶段。');
        }
        let lastPosition = -1;
        for (const volume of result.archives) {
            const positions = volume.sourceIds.map(id => units.indexOf(id));
            if (!positions.length || positions.some((position, i) => position <= (i ? positions[i - 1] : lastPosition))) throw new Error('卷宗来源顺序不正确。');
            lastPosition = positions.at(-1);
        }
        if (first >= 0 && lastPosition >= memory.volumes.length + first) throw new Error('旧卷与当前阶段交错。');
        memory.volumes = result.archives.map((v, i) => ({ id: 'v-' + operation + '-' + i, number: i + 1, ...clone(v) }));
        memory.timeline = result.currentEventIds.map(id => events.get(id));
    }
    return memory;
}
export function hiddenPlan(chat, covered, previousSummaryIds, activeId) {
    const story = chat.filter(m => isStory(m) && Object.hasOwn(covered, tag(m).id));
    const retained = story.slice(-4).map(m => tag(m).id);
    const keep = new Set(retained);
    const older = new Set(previousSummaryIds);
    const hide = chat.filter(m => !m.is_system && tag(m)?.id !== activeId &&
        ((isStory(m) && Object.hasOwn(covered, tag(m).id) && !keep.has(tag(m).id)) || older.has(tag(m)?.id)))
        .map(m => tag(m).id);
    return { retained, hide };
}
export function graceProgress(chat, grace) {
    if (!grace) return 0;
    const position = chat.findIndex(m => tag(m)?.id === grace.summaryId && isSummary(m));
    if (position < 0) throw new Error('暂留任务的总结消息缺失。');
    return chat.slice(position + 1).filter(isStory).length;
}
export function setHidden(chat, ids, hidden) {
    const byId = new Map(chat.map(m => [tag(m)?.id, m]));
    for (const id of ids) {
        const message = byId.get(id);
        if (!message) throw new Error('目标消息缺失，停止更改隐藏范围。');
        message.is_system = hidden;
    }
}
