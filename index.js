import { TavernAdapter } from './src/adapter.js';
import { MemoryEngine } from './src/engine.js';
import { MemoryUI } from './src/ui.js';

const adapter = new TavernAdapter();
const engine = new MemoryEngine(adapter, () => { void ui.refresh(); });
const ui = new MemoryUI(engine);
let timer;
let pendingAuto = false;
let initialized = false;
const bindings = [];
function schedule(allowAuto = false) {
    pendingAuto ||= allowAuto;
    clearTimeout(timer);
    timer = setTimeout(() => {
        const auto = pendingAuto; pendingAuto = false;
        void engine.tick(auto).catch(error => adapter.notify(error.message, true)).finally(() => { void ui.refresh(); });
    }, 700);
}
function bind(name, action) {
    const c = adapter.context();
    const event = c.eventTypes[name];
    if (event) { c.eventSource.on(event, action); bindings.push([event, action]); }
}
function initialize() {
    if (initialized) return;
    const c = adapter.context();
    for (const key of ['generateRaw', 'getTokenCountAsync', 'saveChat', 'getRequestHeaders', 'Popup']) {
        if (!c[key]) { adapter.notify('当前酒馆缺少接口 ' + key + '，需要 SillyTavern 1.19.0 或兼容版本。', true); return; }
    }
    initialized = true;
    ui.mount();
    bind('GENERATION_STARTED', () => { adapter.generating = true; });
    bind('GENERATION_ENDED', () => { adapter.generating = false; schedule(true); });
    bind('GENERATION_STOPPED', () => {
        adapter.generating = false;
        if (engine.running) engine.cancelled = true;
        schedule(false);
    });
    bind('CHAT_CHANGED', () => {
        pendingAuto = false; clearTimeout(timer);
        if (engine.running) engine.cancel();
        schedule(false);
        ui.mount();
    });
    for (const event of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED']) {
        bind(event, () => schedule(false));
    }
    bind('CHAT_LOADED', () => schedule(false));
    bind('GROUP_WRAPPER_STARTED', () => { adapter.generating = true; });
    bind('GROUP_WRAPPER_FINISHED', () => { adapter.generating = false; schedule(true); });
    // A simple settings entry opens the same native settings panel.
    const target = document.getElementById('extensions_settings2');
    if (target && !document.getElementById('interstellar-settings-entry')) {
        const button = document.createElement('button');
        button.id = 'interstellar-settings-entry'; button.className = 'menu_button'; button.type = 'button';
        button.textContent = '✦ 星间记忆设置';
        button.addEventListener('click', () => ui.attempt(() => ui.settings()));
        target.append(button);
    }
    schedule(false);
}
if (globalThis.SillyTavern?.getContext) {
    const c = adapter.context();
    c.eventSource.on(c.eventTypes.APP_READY, initialize);
    // Also support loading the extension after APP_READY.
    if (document.readyState === 'complete') initialize();
    else globalThis.addEventListener('load', initialize, { once: true });
}
globalThis.addEventListener('beforeunload', () => {
    clearTimeout(timer);
    if (initialized) {
        const c = adapter.context();
        for (const [event, action] of bindings) c.eventSource.removeListener(event, action);
    }
});
