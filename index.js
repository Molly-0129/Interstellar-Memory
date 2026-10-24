import { TavernAdapter, compatibilityIssues } from './src/adapter.js';
import { MemoryEngine } from './src/engine.js';
import { MemoryUI } from './src/ui.js';

const adapter = new TavernAdapter();
const engine = new MemoryEngine(adapter, () => { void ui.refresh(); });
const ui = new MemoryUI(engine);
let timer;
let pendingAuto = false;
let initialized = false;
let initializing = false;
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
async function initialize() {
    if (initialized || initializing) return;
    const c = adapter.context();
    const missing = compatibilityIssues(c, globalThis.SillyTavern?.libs);
    if (missing.length) {
        adapter.notify('当前酒馆缺少必要接口：' + missing.join('、') + '。星间记忆支持官方 SillyTavern 1.14.0 及以上版本；请检查版本或分支。', true);
        return;
    }
    initializing = true;
    await adapter.connectNativeGenerationState();
    initialized = true;
    initializing = false;
    ui.mount();
    bind('GENERATION_ENDED', () => schedule(true));
    bind('GENERATION_STOPPED', () => {
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
    bind('GROUP_WRAPPER_FINISHED', () => schedule(true));
    schedule(false);
}
if (globalThis.SillyTavern?.getContext) {
    const c = adapter.context();
    if (c.eventSource?.on && c.eventTypes?.APP_READY) c.eventSource.on(c.eventTypes.APP_READY, initialize);
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
