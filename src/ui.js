import { DEFAULTS, settingsOf, stateOf, clone, KEY } from './model.js';
import { ORDINARY_PROMPT, ARCHIVE_PROMPT } from './prompts.js';

const el = (tag, text, className = '') => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    node.className = className;
    return node;
};
function button(text, action) {
    const node = el('button', text, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
function field(parent, label, value, type = 'text') {
    const wrapper = el('label', undefined, 'im-field');
    wrapper.append(el('span', label));
    const input = el(type === 'textarea' ? 'textarea' : 'input', undefined, 'text_pole');
    if (type !== 'textarea') input.type = type;
    if (type === 'checkbox') input.checked = !!value; else input.value = String(value);
    if (type === 'number') { input.min = '0'; input.step = '1'; }
    if (type === 'textarea') { input.rows = 6; input.spellcheck = false; }
    wrapper.append(input); parent.append(wrapper);
    return input;
}
function section(parent, title) {
    const details = el('details');
    details.append(el('summary', title));
    parent.append(details);
    return details;
}
function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export class MemoryUI {
    constructor(engine) {
        this.engine = engine;
        this.panels = new Set();
    }
    context() { return this.engine.context(); }
    async popup(content) {
        const c = this.context();
        const popup = new c.Popup(content, c.POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });
        return popup.show();
    }
    async attempt(action) {
        try { return await action(); } catch (error) {
            this.engine.adapter.notify(error.message, true);
            this.refresh();
        }
    }
    mount() {
        const form = document.getElementById('send_form');
        if (form && !document.getElementById('interstellar-memory-button')) {
            const dock = el('div', undefined, 'im-launch-dock');
            dock.id = 'interstellar-memory-dock';
            const launch = button('✦', () => this.attempt(() => this.open()));
            launch.id = 'interstellar-memory-button';
            launch.title = '星间 · INTERSTELLAR 记忆';
            launch.setAttribute('aria-label', launch.title);
            dock.append(launch);
            form.prepend(dock);
        }
        this.mountSettings();
    }
    mountSettings() {
        const target = document.getElementById('extensions_settings2');
        if (!target || document.getElementById('interstellar-settings-entry')) return;
        const entry = el('div');
        entry.id = 'interstellar-settings-entry';
        const drawer = el('div', undefined, 'inline-drawer');
        const header = el('div', undefined, 'inline-drawer-toggle inline-drawer-header');
        header.append(el('b', '星间记忆'), el('div', undefined, 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); }
        });
        const content = el('div', undefined, 'inline-drawer-content');
        content.append(button('打开星间记忆设置', () => this.attempt(() => this.settings())));
        drawer.append(header, content);
        entry.append(drawer);
        target.append(entry);
    }
    async refresh() {

        for (const update of [...this.panels]) await update();
    }
    async open() {
        const captured = this.engine.adapter.capture();
        const content = el('div', undefined, 'im-panel');
        content.append(el('h3', '✦ 星间 · INTERSTELLAR'));
        const status = el('p', '正在统计…', 'im-status');
        const warning = el('p', '', 'im-warning');
        const actions = el('div', undefined, 'im-actions');
        const ordinary = button('立刻大总结', () => this.attempt(async () => {
            this.engine.adapter.assertCurrent(captured);
            const task = this.engine.run('ordinary');
            void update();
            await task;
        }));
        const archive = button('分卷总结', () => this.attempt(async () => {
            this.engine.adapter.assertCurrent(captured);
            const task = this.engine.run('archive');
            void update();
            await task;
        }));
        const cancel = button('取消本次整理', () => this.engine.cancel());
        actions.append(ordinary, archive, cancel);
        const utilities = el('div', undefined, 'im-actions');
        utilities.append(
            button('设置', () => this.attempt(() => this.settings())),
            button('恢复中断操作', () => this.attempt(async () => { this.engine.adapter.assertCurrent(captured); await this.engine.recover(); })),
            button('撤销上次整理', () => this.attempt(async () => {
                this.engine.adapter.assertCurrent(captured);
                if (await this.context().Popup.show.confirm('撤销整理', '保留后来新增的剧情，恢复上次整理前的记忆与隐藏状态？')) await this.engine.undo();
            })),
            button('打开整理前检查点', () => this.attempt(async () => {
                this.engine.adapter.assertCurrent(captured);
                const state = this.engine.state();
                const name = state.pending?.checkpoint || state.lastOperation?.checkpoint;
                if (!name) throw new Error('暂无检查点。');
                await this.engine.adapter.openCheckpoint(name);
            })),
            button('导出记忆与操作记录', () => this.attempt(async () => {
                this.engine.adapter.assertCurrent(captured);
                const c = this.context();
                download('interstellar-memory.json', { exportedAt: new Date().toISOString(), chatId: c.chatId,
                    state: clone(this.engine.state()), summaries: c.chat.filter(m => m.extra?.[KEY]?.kind === 'summary').map(clone) });
            })),
        );
        content.append(status, warning, actions, utilities);
        const note = el('p', '隐藏会将旧内容排除出模型上下文，聊天原文仍保留。分卷只整理已有记忆；新增剧情请先执行普通大总结。', 'im-note');
        content.append(note);
        let sequence = 0;
        const update = async () => {
            if (!content.isConnected) return;
            const token = ++sequence;
            ordinary.disabled = archive.disabled = true;
            cancel.disabled = !this.engine.running;
            try {
                this.engine.adapter.assertCurrent(captured);
                const stats = await this.engine.stats();
                if (token !== sequence || !content.isConnected) return;
                const settings = settingsOf(this.engine.state());
                status.textContent = '未隐藏剧情 ' + stats.count + ' 层 · ' + stats.tokens.toLocaleString() +
                    ' Token；有效记忆 ' + stats.memoryTokens.toLocaleString() + ' Token；总结版本 ' + stats.revision +
                    (stats.grace ? '\n暂留 ' + stats.grace.retained + ' 层；新增剧情 ' + Math.min(4, stats.grace.progress) + '/4 层' : '');
                warning.textContent = stats.error || (this.engine.running ? '正在整理并等待模型返回，请稍候…' : (stats.pending ? '上次操作中断，请先恢复。' : ''));
                ordinary.disabled = this.engine.running || stats.pending;
                archive.disabled = this.engine.running || stats.pending || !stats.revision || stats.memoryTokens < settings.archiveTokens;
                archive.title = archive.disabled ? '有效记忆达到 ' + settings.archiveTokens.toLocaleString() + ' Token 后开放' : '按自然故事阶段归档';
            } catch (error) { warning.textContent = error.message; }
        };
        this.panels.add(update);
        // Popup inserts the element before awaiting user close.
        const show = this.popup(content);
        await update();
        try { await show; } finally { this.panels.delete(update); }
    }
    async settings() {
        const handle = this.engine.adapter.capture();
        const settings = settingsOf(this.engine.state());
        const content = el('div', undefined, 'im-panel');
        content.append(el('h3', '星间记忆设置 · 当前聊天'));
        const automatic = section(content, '自动普通大总结');
        automatic.open = true;
        const auto = field(automatic, '启用自动触发（默认关闭）', settings.autoEnabled, 'checkbox');
        const messages = field(automatic, '未隐藏剧情层数 ≥', settings.autoMessages, 'number');
        const tokens = field(automatic, '且：未隐藏剧情 Token ≥', settings.autoTokens, 'number');
        automatic.append(el('p', '两个条件同时满足，在 AI 回复完成后触发。总结消息不计入层数和这里的 Token。', 'im-note'));
        const archive = section(content, '分卷与请求容量');
        const archiveTokens = field(archive, '分卷解锁：有效记忆 Token ≥', settings.archiveTokens, 'number');
        const response = field(archive, '总结最大输出 Token', settings.responseTokens, 'number');
        const capacity = field(archive, '模型总窗口容量（0＝使用酒馆设置）', settings.contextLimit, 'number');
        archive.append(el('p', '分卷默认 64,000 Token，需手动点击；自动触发只执行普通大总结。请求超出窗口会停止，不截断原文。', 'im-note'));
        const prompts = section(content, '独立总结提示词');
        const ordinary = field(prompts, '普通大总结提示词', settings.ordinaryPrompt || ORDINARY_PROMPT, 'textarea');
        const archival = field(prompts, '分卷总结提示词', settings.archivePrompt || ARCHIVE_PROMPT, 'textarea');
        prompts.append(button('恢复两套默认提示词', () => { ordinary.value = ORDINARY_PROMPT; archival.value = ARCHIVE_PROMPT; }));
        const sources = section(content, '不压缩内容与相关材料');
        const locks = field(sources, '用户锁定原文（完整保留；状态变化另记）', settings.lockedText, 'textarea');
        const foreshadowing = field(sources, '最新活跃伏笔清单', settings.foreshadowing, 'textarea');
        const notes = field(sources, '补充剧情档案（正文内的档案已随正文发送）', settings.archiveNotes, 'textarea');
        const lore = field(sources, '相关角色卡与世界设定（仅提供整理所需的部分）', settings.relevantSettings, 'textarea');
        sources.append(el('p', '这些材料按当前聊天保存，在下次成功总结后进入有效记忆。插件不会自动改写世界书、角色卡或其他扩展的伏笔清单。', 'im-note'));
        const notice = el('p', '', 'im-warning');
        content.append(button('保存设置', () => this.attempt(async () => {
            this.engine.adapter.assertCurrent(handle);
            await this.engine.saveSettings({
                ...settings, autoEnabled: auto.checked, autoMessages: Number(messages.value), autoTokens: Number(tokens.value),
                archiveTokens: Number(archiveTokens.value), responseTokens: Number(response.value), contextLimit: Number(capacity.value),
                ordinaryPrompt: ordinary.value, archivePrompt: archival.value,
                lockedText: locks.value, foreshadowing: foreshadowing.value, archiveNotes: notes.value,
                relevantSettings: lore.value,
            });
            notice.textContent = '已保存到当前聊天。';

        })), notice);
        await this.popup(content);
    }
}
