import assert from 'node:assert/strict';
import {
    KEY, clone, blankMemory, blankState, ensureIds, tag, isStory, contentHash, chatHash, memoryOf,
    mergeResult, hiddenPlan, graceProgress, shouldAuto, DEFAULTS, validateActive, validateSettings,
} from '../src/model.js';
import { outputSchema, parseResult } from '../src/schema.js';
import { MemoryEngine } from '../src/engine.js';
import { TavernAdapter } from '../src/adapter.js';
import { escapeHtml, renderMemory } from '../src/render.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
const story = (i, user = i % 2 === 0) => ({ name: user ? '用户' : 'AI', is_user: user, is_system: false, mes: '剧情 ' + i, extra: {} });
const event = (text = '抵达港口', sources = []) => ({ time: '翌日', location: '港口', participants: ['甲'], event: text, details: '蓝色信封', impact: '收到约定', sources });
function ordinary(revision = 0) {
    return { schemaVersion: 1, mode: 'ordinary', baseRevision: revision,
        stateUpdates: (() => { const { scene, characters, relationships, secrets, items, locations, affairs } = blankMemory().world; return { scene, characters, relationships, secrets, items, locations, affairs }; })(), foreshadowingUpdates: [], newDetails: [], detailUpdates: [], issues: [], newEvents: [], eventUpdates: [] };
}
class FakeAdapter {
    constructor(count = 10) {
        this.c = { chat: Array.from({ length: count }, (_, i) => story(i)), chatMetadata: {}, chatId: 'one' };
        this.store = new Map(); this.saves = 0; this.failAt = 0;
        this.reply = request => {
            const data = JSON.parse(request.prompt[0].content);
            const result = ordinary(data.baseRevision);
            result.newEvents.push(event('进展', data.newMessages.map(m => m.id)));
            return JSON.stringify(result);
        };
    }
    context() { return this.c; }
    capture() { return { key: this.c.chatId, chatId: this.c.chatId, chat: this.c.chat, metadata: this.c.chatMetadata }; }
    assertCurrent(h) { if (h.key !== this.c.chatId || h.chat !== this.c.chat || h.metadata !== this.c.chatMetadata) throw new Error('聊天已切换'); }
    busy() { return false; }
    lock() { return () => {}; }
    async tokens(text) { return Math.ceil(text.length / 4); }
    capacity() { return 1000000; }
    async saveVerified(h) {
        this.assertCurrent(h); this.saves++;
        if (this.saves === this.failAt) throw new Error('模拟保存失败');
        this.store.set(h.chatId, { chat: clone(h.chat), metadata: clone(h.metadata) });
    }
    async checkpoint(h, id) {
        const name = 'checkpoint-' + id;
        this.store.set(name, { chat: clone(h.chat), metadata: clone(h.metadata) });
        return name;
    }
    async read(h, name) { return clone(this.store.get(name)); }
    async generate(request) { return this.reply(request); }
    async refresh() {}
    notify() {}
}
test('普通增量保留未提及的旧历史与卷宗', () => {
    const base = blankMemory();
    base.timeline = [{ id: 'e-old', ...event('旧事件') }];
    base.volumes = [{ id: 'v-old', title: '旧卷' }];
    const result = ordinary();
    result.newEvents.push(event('新事件'));
    const next = mergeResult(base, result, 'op', '锁定原文');
    assert.equal(next.timeline.length, 2); assert.equal(next.volumes[0].id, 'v-old'); assert.equal(next.locks, '锁定原文');
    assert.equal(base.timeline.length, 1);
});
test('重要细节更新效力而保留锁定原文', () => {
    const base = blankMemory(); base.details = [{ id: 'd-one', content: '承诺', reason: '关系', related: [], currentEffect: '有效' }];
    const result = ordinary(); result.detailUpdates = [{ id: 'd-one', evidence: '已履行', record: { ...base.details[0], currentEffect: '已履行' } }];
    delete result.detailUpdates[0].record.id;
    const next = mergeResult(base, result, 'op', '原话：我会回来');
    assert.equal(next.details[0].currentEffect, '已履行'); assert.equal(next.locks, '原话：我会回来');
});
test('未知修订引用或版本不匹配拒绝合并', () => {
    const bad = ordinary(1); assert.throws(() => mergeResult(blankMemory(), bad, 'x', ''));
    const result = ordinary(); result.eventUpdates.push({ id: '不存在', record: event(), evidence: '无' });
    assert.throws(() => mergeResult(blankMemory(), result, 'x', ''));
});
test('空状态列表保留原实体，状态转移更新同一物品', () => {
    const base = blankMemory(); base.world.items = [{ name: '信封', status: '完整', owner: '甲' }];
    assert.equal(mergeResult(base, ordinary(), 'a', '').world.items.length, 1);
    const result = ordinary(); result.stateUpdates.items = [{ name: '信封', status: '已转交', owner: '乙' }];
    assert.equal(mergeResult(base, result, 'b', '').world.items[0].owner, '乙');
});
test('自动触发默认关闭，且必须同时达到两个阈值', () => {
    assert.equal(shouldAuto(DEFAULTS, 999, 999999), false);
    const settings = { ...DEFAULTS, autoEnabled: true };
    assert.equal(shouldAuto(settings, 200, 255999), false);
    assert.equal(shouldAuto(settings, 199, 256000), false);
    assert.equal(shouldAuto(settings, 200, 256000), true);
});
test('立即隐藏保留最近四层，旧总结可被接替，当前总结受保护', () => {
    const chat = Array.from({ length: 8 }, (_, i) => story(i)); ensureIds(chat);
    const old = { mes: '旧总结', extra: { [KEY]: { id: 'old', kind: 'summary' } }, is_system: false };
    chat.splice(2, 0, old);
    const covered = Object.fromEntries(chat.filter(isStory).map(m => [tag(m).id, 'hash']));
    const plan = hiddenPlan(chat, covered, ['old'], 'new');
    assert.equal(plan.retained.length, 4); assert.equal(plan.hide.length, 5); assert.ok(plan.hide.includes('old'));
    assert.equal(plan.retained.includes('old'), false);
});
test('延迟计数排除总结、隐藏与同楼备选回复', () => {
    const chat = [{ mes: 'S', extra: { [KEY]: { id: 's', kind: 'summary' } } }];
    chat.push(story(0), story(1), story(2));
    assert.equal(graceProgress(chat, { summaryId: 's' }), 3);
    chat[2].swipe_id = 2; assert.equal(graceProgress(chat, { summaryId: 's' }), 3);
    chat.push(story(3)); assert.equal(graceProgress(chat, { summaryId: 's' }), 4);
});
test('非法 JSON、额外字段和错误类型不能触发提交', () => {
    assert.throws(() => parseResult('{}', 'ordinary'));
    assert.throws(() => parseResult(JSON.stringify({ ...ordinary(), extra: true }), 'ordinary'));
    assert.throws(() => parseResult('解释：' + JSON.stringify(ordinary()), 'ordinary'));
    assert.equal(parseResult(JSON.stringify(ordinary()), 'ordinary').mode, 'ordinary');
    assert.throws(() => parseResult(JSON.stringify({ ...ordinary(), newEvents: 'bad' }), 'ordinary'));
});
test('JSON 围栏只在包裹完整对象时解开', () => {
    const text = String.fromCharCode(96).repeat(3);
    assert.equal(parseResult(text + 'json\n' + JSON.stringify(ordinary()) + '\n' + text, 'ordinary').mode, 'ordinary');
});
test('分卷来源完整且唯一并保持最新阶段', () => {
    const base = blankMemory(); base.timeline = ['a','b','c'].map(id => ({ id, ...event(id) }));
    const result = { ...ordinary(), mode: 'archive', archives: [{ title: '一卷', timeRange: '早期', overview: '经过', sourceIds: ['a','b'], keyEvents: [] }], currentEventIds: ['c'], capacityNote: '' };
    delete result.newEvents; delete result.eventUpdates;
    const memory = mergeResult(base, result, 'op', '原文');
    assert.equal(memory.volumes.length, 1); assert.equal(memory.timeline[0].id, 'c');
    result.archives[0].sourceIds = ['a']; assert.throws(() => mergeResult(base, result, 'op', ''));
    result.archives[0].sourceIds = ['a', 'c']; result.currentEventIds = ['b'];
    assert.throws(() => mergeResult(base, result, 'op', ''));
});
test('总结展示转义 HTML，保留锁定文本', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    const memory = blankMemory(); memory.locks = '<script>恶意</script>';
    const html = renderMemory(memory, 'ordinary', 1);
    assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
});
test('完整普通总结→新增三层→第四层后隐藏暂留，刷新后仍有效', async () => {
    const adapter = new FakeAdapter(10); const engine = new MemoryEngine(adapter);
    await engine.run(); const state = engine.state();
    assert.equal(state.revision, 1); assert.equal(adapter.c.chat.filter(isStory).length, 4);
    const current = adapter.c.chat.at(-1); assert.equal(current.is_system, false);
    adapter.c.chat.push(story(10), story(11), story(12)); await engine.tick();
    assert.equal(adapter.c.chat.filter(isStory).length, 7); assert.ok(state.grace);
    const reopened = new MemoryEngine(adapter);
    adapter.c.chat.push(story(13)); await reopened.tick();
    assert.equal(adapter.c.chat.filter(isStory).length, 4); assert.equal(reopened.state().grace, null); assert.equal(current.is_system, false);
});
test('第二次总结隐藏旧总结但完整继承历史', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    const old = adapter.c.chat.at(-1); adapter.c.chat.push(story(8), story(9));
    await engine.run();
    assert.equal(old.is_system, true); assert.equal(adapter.c.chat.at(-1).is_system, false);
    assert.equal(memoryOf(adapter.c.chat, engine.state()).timeline.length, 2);
});
test('生成失败不隐藏任何原消息，并可从持久化检查点恢复', async () => {
    const adapter = new FakeAdapter(8); adapter.reply = () => { throw new Error('断网'); };
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /断网/);
    assert.equal(adapter.c.chat.filter(m => m.is_system).length, 0); assert.ok(engine.state().pending);
    await engine.recover(); assert.equal(engine.state().pending, null); assert.equal(engine.state().revision, 0);
});
test('总结消息保存失败不隐藏原文', async () => {
    const adapter = new FakeAdapter(8); adapter.failAt = 3;
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /模拟保存失败/);
    assert.equal(adapter.c.chat.slice(0, 8).some(m => m.is_system), false); assert.equal(engine.state().activeId, null);
    await engine.recover(); assert.equal(engine.state().pending, null);
});
test('隐藏提交保存失败恢复原文并保留可恢复任务', async () => {
    const adapter = new FakeAdapter(8); adapter.failAt = 4;
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /模拟保存失败/);
    assert.equal(adapter.c.chat.slice(0, 8).some(m => m.is_system), false); assert.equal(engine.state().revision, 0);
    assert.equal(tag(adapter.c.chat.at(-1)).status, 'aborted');
});
test('生成期间切换聊天不会写入新聊天', async () => {
    const adapter = new FakeAdapter(8); const original = adapter.c;
    adapter.reply = () => { adapter.c = { chatId: 'two', chat: [story(99)], chatMetadata: {} }; return JSON.stringify(ordinary()); };
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /聊天已切换/);
    assert.equal(adapter.c.chat.length, 1); assert.deepEqual(adapter.c.chatMetadata, {});
    assert.equal(original.chat.some(m => m.is_system), false); assert.ok(original.chatMetadata[KEY].pending);
});
test('生成期间编辑来源拒绝提交', async () => {
    const adapter = new FakeAdapter(8); const reply = adapter.reply;
    adapter.reply = req => { adapter.c.chat[0].mes = '修改'; return reply(req); };
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /已变化/);
    assert.equal(adapter.c.chat.some(m => m.is_system), false);
});
test('已总结来源切换备选回复，暂停延迟隐藏', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    const retained = engine.state().grace.ids;
    adapter.c.chat.find(m => tag(m).id === retained[0]).mes = '另一版';
    adapter.c.chat.push(...[8,9,10,11].map(i => story(i))); await engine.tick();
    assert.ok(engine.state().error); assert.equal(adapter.c.chat.find(m => tag(m).id === retained[0]).is_system, false);
});
test('撤销保留后续新剧情，恢复上一份有效总结', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    const old = adapter.c.chat.at(-1); adapter.c.chat.push(story(8),story(9)); await engine.run();
    adapter.c.chat.push(story(10),story(11)); await engine.undo();
    assert.equal(engine.state().activeId, tag(old).id); assert.equal(old.is_system, false);
    assert.equal(adapter.c.chat.at(-1).mes, '剧情 11');
});
test('分卷未解锁时不调用模型', async () => {
    const adapter = new FakeAdapter(8); adapter.reply = () => { throw new Error('不应调用'); };
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run('archive'), /尚未解锁/);
    assert.equal(adapter.saves, 0);
});
test('请求超容量拒绝调用，不隐藏原文', async () => {
    const adapter = new FakeAdapter(8); adapter.capacity = () => 10;
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /超过容量/);
    assert.equal(adapter.saves, 0); assert.equal(adapter.c.chat.some(m => m.is_system), false);
});
test('服务器吞掉保存错误时，适配器读回校验能识别', async () => {
    const c = { chat: [story(0)], chatMetadata: { [KEY]: blankState() }, chatId: 'one', characters: [{ name: 'A', avatar: 'a.png' }], characterId: 0,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveChat: async () => {} };
    ensureIds(c.chat);
    const adapter = new TavernAdapter(() => c, async () => ({ ok: true, json: async () => [{ chat_metadata: {} }, story(1)] }));
    await assert.rejects(adapter.saveVerified(adapter.capture()), /读回/);
});
test('设置拒绝负数与非布尔开关', () => {
    assert.throws(() => validateSettings({ ...DEFAULTS, autoMessages: -1 }));
    assert.throws(() => validateSettings({ ...DEFAULTS, autoEnabled: 'true' }));
});

test('格式正确但没有事件结果时不隐藏剧情', async () => {
    const adapter = new FakeAdapter(8); adapter.reply = () => JSON.stringify(ordinary());
    const engine = new MemoryEngine(adapter);
    await assert.rejects(engine.run(), /没有可用事件/);
    assert.equal(adapter.c.chat.some(m => m.is_system), false);
});
test('生成期间用户手动隐藏消息时，不回滚用户的操作', async () => {
    const adapter = new FakeAdapter(8); const reply = adapter.reply;
    adapter.reply = request => { adapter.c.chat[0].is_system = true; return reply(request); };
    const engine = new MemoryEngine(adapter);
    await assert.rejects(engine.run(), /已变化/);
    assert.equal(adapter.c.chat[0].is_system, true);
    assert.equal(adapter.c.chat.slice(1).some(m => m.is_system), false);
});
test('取消生成不提交总结', async () => {
    const adapter = new FakeAdapter(8); const reply = adapter.reply;
    const engine = new MemoryEngine(adapter);
    adapter.reply = request => { engine.cancel(); return reply(request); };
    await assert.rejects(engine.run(), /取消/);
    assert.equal(engine.state().revision, 0); assert.equal(adapter.c.chat.some(m => m.is_system), false);
});
test('检查点失败时不调用模型', async () => {
    const adapter = new FakeAdapter(8); let calls = 0;
    adapter.checkpoint = () => { throw new Error('检查点失败'); }; adapter.reply = () => { calls++; };
    const engine = new MemoryEngine(adapter); await assert.rejects(engine.run(), /检查点失败/);
    assert.equal(calls, 0); assert.equal(adapter.c.chat.some(m => m.is_system), false);
});
test('延迟隐藏保存失败时还原暂留范围', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    const retained = [...engine.state().grace.ids];
    adapter.failAt = 5; adapter.c.chat.push(...[8,9,10,11].map(i=>story(i)));
    await engine.tick();
    assert.ok(engine.state().grace); assert.ok(engine.state().error);
    assert.equal(retained.every(id => !adapter.c.chat.find(m=>tag(m)?.id===id).is_system), true);
});
test('自动开关启用且 AND 达标后只运行普通总结', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter);
    engine.state().settings = { autoEnabled: true, autoMessages: 8, autoTokens: 1 };
    await engine.tick(false); assert.equal(engine.state().revision, 0);
    await engine.tick(true); assert.equal(engine.state().revision, 1);
    assert.equal(tag(adapter.c.chat.at(-1)).mode, 'ordinary');
    await engine.tick(true); assert.equal(engine.state().revision, 1);
});
test('分卷成功完整接替历史并保护当前总结', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    const old = adapter.c.chat.at(-1);
    adapter.tokens = async text => text.includes('"revision":1') ? 65000 : text.includes('"revision":2') ? 12000 : 10000;
    adapter.reply = request => {
        const input = JSON.parse(request.prompt[0].content);
        const result = { ...ordinary(input.baseRevision), mode: 'archive',
            archives: [{ title: '港口往事', timeRange: '翌日', overview: '已经发生的阶段', sourceIds: input.units,
                keyEvents: [{ time: '翌日', location: '港口', participants: ['甲'], causality: '抵达并收到信封', lastingImpact: '承诺持续' }] }],
            currentEventIds: [], capacityNote: '' };
        delete result.newEvents; delete result.eventUpdates;
        return JSON.stringify(result);
    };
    await engine.run('archive');
    assert.equal(old.is_system, true); assert.equal(adapter.c.chat.at(-1).is_system, false);
    const memory = memoryOf(adapter.c.chat, engine.state());
    assert.equal(memory.volumes.length, 1); assert.equal(memory.revision, 2);
});
test('活跃伏笔未被本轮提及也继续继承', () => {
    const memory = blankMemory(); memory.clues = [{ key: '信封', clue: '寄件人未知', status: '活跃', evidence: '无署名', related: [] }];
    const next = mergeResult(memory, ordinary(), 'op', '');
    assert.equal(next.clues.length, 1); assert.equal(next.clues[0].status, '活跃');
});
test('适配器保存成功后必须与服务器数据逐项一致', async () => {
    const c = { chat: [story(0)], chatMetadata: { [KEY]: blankState() }, chatId: 'one', characters: [{ name: 'A', avatar: 'a.png' }], characterId: 0,
        getRequestHeaders: () => ({}), saveChat: async () => {} };
    ensureIds(c.chat);
    const adapter = new TavernAdapter(() => c, async () => ({ ok: true, json: async () => [{ chat_metadata: clone(c.chatMetadata) }, ...clone(c.chat)] }));
    await adapter.saveVerified(adapter.capture());
    c.chat[0].mes = '新内容';
    const stale = clone(c.chat); stale[0].mes = '旧内容';
    adapter.fetcher = async () => ({ ok: true, json: async () => [{ chat_metadata: clone(c.chatMetadata) }, ...stale] });
    await assert.rejects(adapter.saveVerified(adapter.capture()), /读回/);
});


test('原生 UI 挂载一次且设置没有消息皮肤选项', async () => {
    const previousDocument = globalThis.document;
    class Node {
        constructor(name) { this.tagName = name; this.children = []; this.listeners = {}; this.textContent = ''; this.id = ''; }
        append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
        setAttribute(name, value) { this[name] = value; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        get isConnected() { return this === doc.body || !!this.parent?.isConnected; }
    }
    const doc = { body: new Node('body'), createElement: name => new Node(name),
        getElementById: id => walk(doc.body).find(n=>n.id === id) };
    const walk = node => [node, ...node.children.flatMap(walk)];
    const toolbar = new Node('div'); toolbar.id = 'leftSendForm'; doc.body.append(toolbar);
    globalThis.document = doc;
    try {
        const adapter = new FakeAdapter(8);
        const engine = new MemoryEngine(adapter);
        const popups = [];
        adapter.c.Popup = class {
            static show = { confirm: async () => true };
            constructor(content) { this.content = content; popups.push(content); }
            async show() { doc.body.append(this.content); return true; }
        };
        adapter.c.POPUP_TYPE = { DISPLAY: 1 };
        const { MemoryUI } = await import('../src/ui.js');
        const ui = new MemoryUI(engine); ui.mount(); ui.mount();
        assert.equal(toolbar.children.length, 1);
        assert.equal(toolbar.children[0]['aria-label'], '星间 · INTERSTELLAR 记忆');
        await ui.open();
        assert.ok(walk(popups[0]).some(n=>n.textContent==='立刻大总结'));
        await ui.settings();
        const settingsPanel = popups.at(-1);
        assert.ok(!walk(settingsPanel).some(n=>n.tagName==='select'));
        const inputs = walk(settingsPanel).filter(n=>n.tagName==='input');
        assert.equal(inputs.find(n=>n.type==='checkbox').checked, false);
        const save = walk(settingsPanel).find(n=>n.textContent==='保存设置');
        await save.listeners.click();
        assert.equal(engine.state().settings.autoMessages, 200);
        await ui.refresh();
    } finally { globalThis.document = previousDocument; }
});
test('扩展入口可作为 ESM 加载', async () => {
    const previous = globalThis.addEventListener;
    globalThis.addEventListener = () => {};
    try { await import('../index.js'); } finally { globalThis.addEventListener = previous; }
});


test('已删除来源不能通过原地恢复悄悄略过', async () => {
    const adapter = new FakeAdapter(8); const engine = new MemoryEngine(adapter); await engine.run();
    adapter.c.chat.splice(0, 1);
    await assert.rejects(engine.undo(), /原消息已删除/);
});
test('未知数据版本拒绝覆盖', async () => {
    const adapter = new FakeAdapter(2);
    adapter.c.chatMetadata[KEY] = { schemaVersion: 999 };
    const engine = new MemoryEngine(adapter);
    assert.throws(() => engine.state(), /版本不兼容/);
});
test('重复点击不会并行创建总结', async () => {
    const adapter = new FakeAdapter(8); const reply = adapter.reply;
    let release;
    let started;
    const waiting = new Promise(resolve=>{ started=resolve; });
    adapter.reply = async request => { started(); await new Promise(resolve=>{ release=resolve; }); return reply(request); };
    const engine = new MemoryEngine(adapter); const task = engine.run();
    await waiting;
    await assert.rejects(engine.run(), /等待/);
    release(); await task;
    assert.equal(engine.state().revision, 1);
});
test('单聊检查点保存并读回验证，使用独立 integrity', async () => {
    const c = { chat: [story(0)], chatMetadata: { integrity: 'parent', [KEY]: blankState() }, chatId: 'one', characters: [{ name: 'A', avatar: 'a.png' }], characterId: 0,
        getRequestHeaders: () => ({}), saveChat: async () => {} };
    ensureIds(c.chat);
    let sent;
    const adapter = new TavernAdapter(() => c, async (endpoint, args) => {
        const body = JSON.parse(args.body);
        if (endpoint.endsWith('/save')) { sent = body; return { ok: true }; }
        return { ok: true, json: async () => clone(sent.chat) };
    });
    const name = await adapter.checkpoint(adapter.capture(), 'op');
    assert.equal(name, 'one - INTERSTELLAR op');
    assert.notEqual(sent.chat[0].chat_metadata.integrity, 'parent');
    assert.equal(c.chatMetadata.integrity, 'parent');
    assert.equal(sent.chat[0].chat_metadata.main_chat, 'one');
});

export async function runTests() {
    const results = [];
    for (const { name, run } of tests) {
        try { await run(); results.push({ name, pass: true }); }
        catch (error) { results.push({ name, pass: false, error: error.stack }); }
    }
    return { total: results.length, passed: results.filter(x => x.pass).length, results };
}
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('run.mjs')) {
    const report = await runTests();
    for (const item of report.results) console.log((item.pass ? 'PASS ' : 'FAIL ') + item.name + (item.error ? '\n' + item.error : ''));
    console.log(report.passed + '/' + report.total + ' passed');
    if (report.passed !== report.total) process.exitCode = 1;
}
