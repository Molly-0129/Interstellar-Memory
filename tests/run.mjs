import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as YAML from 'yaml';
import { KEY, clone, blankState, ensureIds, tag, isStory, memoryOf, hiddenPlan, graceProgress, shouldAuto, DEFAULTS, validateSettings } from '../src/model.js';
import { parseResult } from '../src/schema.js';
import { buildRequest, ORDINARY_PROMPT, ARCHIVE_PROMPT } from '../src/prompts.js';
import { MemoryEngine } from '../src/engine.js';
import { TavernAdapter } from '../src/adapter.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });
const story = (i, user = i % 2 === 0) => ({ name: user ? '用户' : 'AI', is_user: user, is_system: false, mes: '剧情 ' + i, extra: {} });
const event = (text='抵达港口') => ({ 时间:'翌日', 地点:'港口', 参与人物:['甲'], 事件:text, 关键细节:'蓝色信封', 结果与影响:'收到约定' });
function world() {
    return { 当前时间与场景:'翌日 · 港口', 重要人物:[], 人物关系:[], 信息与秘密:[], 重要物品与资源:[], 地点与环境:[], 未决事务:[] };
}
function ordinary() {
    return { 记忆模式:'普通大总结', 总结范围:{起点:'昨日',截至:'翌日'}, 主要事件时间线:[event()],
        当前世界状态:world(), 重要细节:[] };
}
function archive() {
    return { 记忆模式:'分卷大总结', 整理范围:{起点:'昨日',截至:'翌日'},
        历史卷宗:[{卷号:'1',卷名:'港口往事',时间范围:'昨日',阶段概述:'收到信封',
            关键事件:[{时间:'昨日',地点:'港口',参与人物:['甲'],事件与因果:'因约定来到港口',重要细节:'蓝色信封',长期影响:'承诺持续'}]}],
        当前卷:{卷号:'2',卷名:'新的一天',起始时间:'翌日',事件时间线:[event('继续等待')]},
        当前世界状态:world(),跨卷重要细节:[],整理检查:{待核实事项:[]} };
}
const encode = (document, mode = 'ordinary') => {
    const name = mode === 'ordinary' ? '星间大总结' : '星间卷宗';
    return '<' + name + '>\n' + YAML.stringify(document) + '</' + name + '>';
};
class FakeAdapter {
    constructor(count = 10) {
        this.c = { chat: Array.from({ length: count }, (_, i) => story(i)), chatMetadata: {}, chatId:'one' };
        this.store = new Map(); this.saves=0; this.failAt=0; this.calls=0; this.lastRequest=null;
        this.reply = request => {
            const data=JSON.parse(request.prompt[0].content);
            if(request.systemPrompt===ARCHIVE_PROMPT) return encode(archive(),'archive');
            const document=ordinary();
            if(data.previousSummary?.trim().startsWith('<星间大总结>')) {
                const previous=parseResult(data.previousSummary,'ordinary',YAML).document;
                document.主要事件时间线=[...previous.主要事件时间线,event('本轮新增进展')];
            }
            return encode(document);
        };
    }
    context(){return this.c;}
    capture(){return {key:this.c.chatId,chatId:this.c.chatId,chat:this.c.chat,metadata:this.c.chatMetadata};}
    assertCurrent(h){if(h.key!==this.c.chatId||h.chat!==this.c.chat||h.metadata!==this.c.chatMetadata)throw new Error('聊天已切换');}
    busy(){return false;}
    lock(){return ()=>{};}
    async tokens(text){return Math.ceil(text.length/4);}
    capacity(){return 1000000;}
    yaml(){return YAML;}
    async saveVerified(h){this.assertCurrent(h);this.saves++;if(this.saves===this.failAt)throw new Error('模拟保存失败');this.store.set(h.chatId,{chat:clone(h.chat),metadata:clone(h.metadata)});}
    async checkpoint(h,id){const name='checkpoint-'+id;this.store.set(name,{chat:clone(h.chat),metadata:clone(h.metadata)});return name;}
    async read(h,name){return clone(this.store.get(name));}
    async generate(request){this.calls++;this.lastRequest=request;return this.reply(request);}
    async refresh(){}
    notify(){}
}
test('两套默认提示词与用户文本文件逐字一致',async()=>{
    assert.equal(ORDINARY_PROMPT,await fs.readFile(new URL('../docs/ordinary-prompt.txt',import.meta.url),'utf8'));
    assert.equal(ARCHIVE_PROMPT,await fs.readFile(new URL('../docs/archive-prompt.txt',import.meta.url),'utf8'));
    assert.ok(ORDINARY_PROMPT.includes('\\</任务目标>'));assert.ok(ARCHIVE_PROMPT.includes('\\- 时间:'));
});
test('每次只使用选中的完整提示词，无通用提示或 JSON Schema 注入',()=>{
    const request=buildRequest('ordinary',{previousSummary:'',newMessages:[]});
    assert.equal(request.systemPrompt,ORDINARY_PROMPT);assert.equal(request.schema,undefined);
    assert.equal(buildRequest('archive',{}).systemPrompt,ARCHIVE_PROMPT);
    assert.equal(buildRequest('ordinary',{},'自定义原文').systemPrompt,'自定义原文');
});
test('标签 YAML 解析后保留完全一致的原文',()=>{
    const raw=' \r\n'+encode(ordinary())+'\r\n ';
    assert.equal(parseResult(raw,'ordinary',YAML).raw,raw);
});
test('允许世界状态列表位于根或嵌套世界状态中',()=>{
    const flat=ordinary();Object.assign(flat,flat.当前世界状态);flat.当前世界状态=null;
    assert.equal(parseResult(encode(flat),'ordinary',YAML).document.重要人物.length,0);
    assert.ok(parseResult(encode(ordinary()),'ordinary',YAML).document.当前世界状态);
});
test('JSON、错误标签、多个标签和额外解释均拒绝',()=>{
    for(const raw of [JSON.stringify(ordinary()),encode(ordinary())+encode(ordinary()),'说明'+encode(ordinary()),encode(ordinary()).replaceAll('星间大总结','星间卷宗')]) {
        assert.throws(()=>parseResult(raw,'ordinary',YAML));
    }
});
test('YAML 重复键、非法格式和多文档均拒绝',()=>{
    assert.throws(()=>parseResult('<星间大总结>\na: 1\na: 2\n</星间大总结>','ordinary',YAML),/YAML/);
    assert.throws(()=>parseResult('<星间大总结>\na: [\n</星间大总结>','ordinary',YAML),/YAML/);
    assert.throws(()=>parseResult('<星间大总结>\na: 1\n---\nb: 2\n</星间大总结>','ordinary',YAML),/YAML/);
});
test('YAML 别名扩展和危险对象键拒绝',()=>{
    assert.throws(()=>parseResult('<星间大总结>\na: &x [a]\nb: *x\n</星间大总结>','ordinary',YAML));
    assert.throws(()=>parseResult('<星间大总结>\n__proto__: { polluted: true }\n</星间大总结>','ordinary',YAML));
    assert.equal({}.polluted,undefined);
});
test('缺少必要字段或模式不一致拒绝',()=>{
    const missing=ordinary();delete missing.当前世界状态;
    assert.throws(()=>parseResult(encode(missing),'ordinary',YAML));
    const wrong=ordinary();wrong.记忆模式='分卷大总结';
    assert.throws(()=>parseResult(encode(wrong),'ordinary',YAML));
});
test('空普通事件与空分卷归档不替换原记忆',()=>{
    const o=ordinary();o.主要事件时间线=[];assert.throws(()=>parseResult(encode(o),'ordinary',YAML),/没有可用事件/);
    const a=archive();a.历史卷宗=[];assert.throws(()=>parseResult(encode(a,'archive'),'archive',YAML),/未生成/);
});
test('人物秘密的知情范围可为模板文本或文本列表',()=>{
    const o=ordinary();o.当前世界状态.信息与秘密=[{内容:'身份',真实性:'已证实',知情范围:'只有甲'}];
    parseResult(encode(o),'ordinary',YAML);o.当前世界状态.信息与秘密[0].知情范围=['甲'];parseResult(encode(o),'ordinary',YAML);
});
test('自动触发默认关闭且两个阈值必须同时满足',()=>{
    assert.equal(shouldAuto(DEFAULTS,999,999999),false);
    const settings={...DEFAULTS,autoEnabled:true};
    assert.equal(shouldAuto(settings,200,255999),false);assert.equal(shouldAuto(settings,199,256000),false);
    assert.equal(shouldAuto(settings,200,256000),true);
});
test('立即隐藏保留四层并允许接替旧总结',()=>{
    const chat=Array.from({length:8},(_,i)=>story(i));ensureIds(chat);
    chat.splice(2,0,{mes:'旧总结',extra:{[KEY]:{id:'old',kind:'summary'}},is_system:false});
    const covered=Object.fromEntries(chat.filter(isStory).map(m=>[tag(m).id,'hash']));
    const plan=hiddenPlan(chat,covered,['old'],'new');
    assert.equal(plan.retained.length,4);assert.equal(plan.hide.length,5);assert.ok(plan.hide.includes('old'));
});
test('完整模型原文存入聊天和记忆，无程序合并或渲染',async()=>{
    const adapter=new FakeAdapter(8);const raw='\n'+encode(ordinary())+'\n';adapter.reply=()=>raw;
    const engine=new MemoryEngine(adapter);await engine.run();
    assert.equal(adapter.c.chat.at(-1).mes,raw);assert.equal(memoryOf(adapter.c.chat,engine.state()).raw,raw);
    assert.equal(adapter.c.chat.at(-1).mes.includes('<details>'),false);
});
test('第二次总结直接采用模型完整结果，不补入或合并旧事件',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const old=adapter.c.chat.at(-1);adapter.c.chat.push(story(8),story(9));
    const replacement=ordinary();replacement.主要事件时间线=[event('模型完整新版本')];const raw=encode(replacement);
    adapter.reply=()=>raw;await engine.run();
    assert.equal(old.is_system,true);assert.equal(adapter.c.chat.at(-1).mes,raw);
    assert.equal(memoryOf(adapter.c.chat,engine.state()).document.主要事件时间线.length,1);
    assert.equal(memoryOf(adapter.c.chat,engine.state()).document.主要事件时间线[0].事件,'模型完整新版本');
});
test('旧总结作为材料原样发送；锁定内容和伏笔同样作为输入',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const prior=adapter.c.chat.at(-1).mes;adapter.c.chat.push(story(8),story(9));
    engine.state().settings.lockedText='原话：我会回来';engine.state().settings.foreshadowing='寄件人未知';
    await engine.run();const data=JSON.parse(adapter.lastRequest.prompt[0].content);
    assert.equal(data.previousSummary,prior);assert.equal(data.lockedRecords,'原话：我会回来');
    assert.equal(data.latestForeshadowing,'寄件人未知');assert.equal(data.baseRevision,undefined);
});
test('四层暂留在新增三层后保留，刷新后第四层再隐藏',async()=>{
    const adapter=new FakeAdapter(10);const engine=new MemoryEngine(adapter);await engine.run();
    const summary=adapter.c.chat.at(-1);assert.equal(adapter.c.chat.filter(isStory).length,4);
    adapter.c.chat.push(story(10),story(11),story(12));await engine.tick();assert.ok(engine.state().grace);
    const reopened=new MemoryEngine(adapter);adapter.c.chat.push(story(13));await reopened.tick();
    assert.equal(reopened.state().grace,null);assert.equal(adapter.c.chat.filter(isStory).length,4);assert.equal(summary.is_system,false);
});
test('备选回复变化不增加楼层',()=>{
    const chat=[{mes:'S',extra:{[KEY]:{id:'s',kind:'summary'}}},story(0),story(1),story(2)];
    assert.equal(graceProgress(chat,{summaryId:'s'}),3);chat[2].swipe_id=2;assert.equal(graceProgress(chat,{summaryId:'s'}),3);
});
test('生成失败可恢复且原文不提前隐藏',async()=>{
    const adapter=new FakeAdapter(8);adapter.reply=()=>{throw new Error('断网');};const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/断网/);assert.equal(adapter.c.chat.some(m=>m.is_system),false);
    await engine.recover();assert.equal(engine.state().pending,null);
});
test('YAML 格式错误时不提交或隐藏原文',async()=>{
    const adapter=new FakeAdapter(8);adapter.reply=()=>'<星间大总结>\na: [\n</星间大总结>';const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/YAML/);assert.equal(engine.state().revision,0);assert.equal(adapter.c.chat.some(m=>m.is_system),false);
});
test('总结保存失败不隐藏原文',async()=>{
    const adapter=new FakeAdapter(8);adapter.failAt=3;const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/保存失败/);assert.equal(adapter.c.chat.slice(0,8).some(m=>m.is_system),false);
    await engine.recover();assert.equal(engine.state().pending,null);
});
test('隐藏提交失败恢复原文并保留恢复任务',async()=>{
    const adapter=new FakeAdapter(8);adapter.failAt=4;const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/保存失败/);assert.equal(adapter.c.chat.slice(0,8).some(m=>m.is_system),false);
    assert.equal(tag(adapter.c.chat.at(-1)).status,'aborted');assert.equal(engine.state().revision,0);
});
test('切换聊天不会写入新聊天',async()=>{
    const adapter=new FakeAdapter(8);const original=adapter.c;
    adapter.reply=()=>{adapter.c={chatId:'two',chat:[story(99)],chatMetadata:{}};return encode(ordinary());};
    const engine=new MemoryEngine(adapter);await assert.rejects(engine.run(),/聊天已切换/);
    assert.equal(adapter.c.chat.length,1);assert.deepEqual(adapter.c.chatMetadata,{});
    assert.equal(original.chat.some(m=>m.is_system),false);
});
test('生成期间编辑来源拒绝提交',async()=>{
    const adapter=new FakeAdapter(8);const reply=adapter.reply;adapter.reply=req=>{adapter.c.chat[0].mes='修改';return reply(req);};
    const engine=new MemoryEngine(adapter);await assert.rejects(engine.run(),/已变化/);assert.equal(adapter.c.chat.some(m=>m.is_system),false);
});
test('保留用户在生成期间自行隐藏的标志',async()=>{
    const adapter=new FakeAdapter(8);const reply=adapter.reply;adapter.reply=req=>{adapter.c.chat[0].is_system=true;return reply(req);};
    const engine=new MemoryEngine(adapter);await assert.rejects(engine.run(),/已变化/);
    assert.equal(adapter.c.chat[0].is_system,true);assert.equal(adapter.c.chat.slice(1).some(m=>m.is_system),false);
});
test('已总结来源改变时暂停延迟隐藏',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const id=engine.state().grace.ids[0];adapter.c.chat.find(m=>tag(m)?.id===id).mes='另一版';
    adapter.c.chat.push(...[8,9,10,11].map(i=>story(i)));await engine.tick();
    assert.ok(engine.state().error);assert.equal(adapter.c.chat.find(m=>tag(m)?.id===id).is_system,false);
});
test('延迟隐藏保存失败恢复暂留',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const ids=[...engine.state().grace.ids];adapter.failAt=5;adapter.c.chat.push(...[8,9,10,11].map(i=>story(i)));await engine.tick();
    assert.ok(engine.state().grace);assert.ok(engine.state().error);assert.ok(ids.every(id=>!adapter.c.chat.find(m=>tag(m)?.id===id).is_system));
});
test('取消不提交模型结果',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);const reply=adapter.reply;
    adapter.reply=req=>{engine.cancel();return reply(req);};await assert.rejects(engine.run(),/取消/);assert.equal(engine.state().revision,0);
});
test('检查点失败不调用模型',async()=>{
    const adapter=new FakeAdapter(8);adapter.checkpoint=()=>{throw new Error('检查点失败');};const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/检查点失败/);assert.equal(adapter.calls,0);
});
test('自动触发只执行一次普通大总结',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);
    engine.state().settings={autoEnabled:true,autoMessages:8,autoTokens:1};
    await engine.tick(false);assert.equal(adapter.calls,0);
    await engine.tick(true);assert.equal(engine.state().revision,1);assert.equal(tag(adapter.c.chat.at(-1)).mode,'ordinary');
    await engine.tick(true);assert.equal(engine.state().revision,1);
});
test('分卷未达到阈值时不调用模型',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await assert.rejects(engine.run('archive'),/尚未解锁/);assert.equal(adapter.calls,0);
});
test('分卷直接保存模型全文，不进行程序压缩或目标容量重试',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const old=adapter.c.chat.at(-1);engine.state().settings.archiveTokens=1;const raw=encode(archive(),'archive');adapter.reply=()=>raw;
    await engine.run('archive');assert.equal(adapter.c.chat.at(-1).mes,raw);assert.equal(old.is_system,true);
    assert.equal(adapter.calls,2);assert.equal(memoryOf(adapter.c.chat,engine.state()).raw,raw);
});
test('超出模型窗口时不调用模型或隐藏原文',async()=>{
    const adapter=new FakeAdapter(8);adapter.capacity=()=>10;const engine=new MemoryEngine(adapter);
    await assert.rejects(engine.run(),/超过容量/);assert.equal(adapter.calls,0);assert.equal(adapter.c.chat.some(m=>m.is_system),false);
});
test('撤销保留后续剧情并恢复旧总结',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const old=adapter.c.chat.at(-1);adapter.c.chat.push(story(8),story(9));await engine.run();
    adapter.c.chat.push(story(10),story(11));await engine.undo();assert.equal(engine.state().activeId,tag(old).id);assert.equal(old.is_system,false);assert.equal(adapter.c.chat.at(-1).mes,'剧情 11');
});
test('删除来源后要求检查点分支恢复',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();adapter.c.chat.splice(0,1);await assert.rejects(engine.undo(),/原消息已删除/);
});
test('重复点击不会创建并行总结',async()=>{
    const adapter=new FakeAdapter(8);const reply=adapter.reply;let started,release;const waiting=new Promise(r=>{started=r;});
    adapter.reply=async req=>{started();await new Promise(r=>{release=r;});return reply(req);};
    const engine=new MemoryEngine(adapter);const task=engine.run();await waiting;await assert.rejects(engine.run(),/等待/);release();await task;assert.equal(engine.state().revision,1);
});
test('未知数据版本和错误设置拒绝覆盖',()=>{
    const adapter=new FakeAdapter(2);adapter.c.chatMetadata[KEY]={schemaVersion:999};assert.throws(()=>new MemoryEngine(adapter).state(),/版本不兼容/);
    assert.throws(()=>validateSettings({...DEFAULTS,autoMessages:-1}));assert.throws(()=>validateSettings({...DEFAULTS,autoEnabled:'true'}));
});
test('服务器保存被吞掉时读回能发现',async()=>{
    const c={chat:[story(0)],chatMetadata:{[KEY]:blankState()},chatId:'one',characters:[{name:'A',avatar:'a.png'}],characterId:0,getRequestHeaders:()=>({}),saveChat:async()=>{}};ensureIds(c.chat);
    const adapter=new TavernAdapter(()=>c,async()=>({ok:true,json:async()=>[{chat_metadata:{}},story(1)]}));
    await assert.rejects(adapter.saveVerified(adapter.capture()),/读回/);
});
test('检查点有独立 integrity 且读回成功',async()=>{
    const c={chat:[story(0)],chatMetadata:{integrity:'parent',[KEY]:blankState()},chatId:'one',characters:[{name:'A',avatar:'a.png'}],characterId:0,getRequestHeaders:()=>({}),saveChat:async()=>{}};ensureIds(c.chat);let sent;
    const adapter=new TavernAdapter(()=>c,async(endpoint,args)=>{if(endpoint.endsWith('/save')){sent=JSON.parse(args.body);return{ok:true};}return{ok:true,json:async()=>clone(sent.chat)};});
    assert.equal(await adapter.checkpoint(adapter.capture(),'op'),'one - INTERSTELLAR op');assert.notEqual(sent.chat[0].chat_metadata.integrity,'parent');assert.equal(c.chatMetadata.integrity,'parent');
});
test('旧版强制 JSON 设置不影响新的 YAML 请求',async()=>{
    let args;const adapter=new TavernAdapter(()=>({generateRaw:async value=>{args=value;return'原文';}}));
    await adapter.generate(buildRequest('ordinary',{}),{...DEFAULTS,structuredOutput:true});
    assert.equal(args.jsonSchema,undefined);assert.equal(args.systemPrompt,ORDINARY_PROMPT);
});
test('入口可作为 ESM 加载',async()=>{
    const before=globalThis.addEventListener;globalThis.addEventListener=()=>{};
    try{await import('../index.js');}finally{globalThis.addEventListener=before;}
});

test('自动迁移精确旧默认提示词，保留用户自定义内容',async()=>{
    const { migratePromptSettings }=await import('../src/prompts.js');
    const source=await fs.readFile(new URL('../src/prompts.js',import.meta.url),'utf8');
    const oldOrdinary=JSON.parse(source.match(/const OLD_ORDINARY = (.*);/)[1]);
    const oldArchive=JSON.parse(source.match(/const OLD_ARCHIVE = (.*);/)[1]);
    const migrated=migratePromptSettings({ordinaryPrompt:oldOrdinary,archivePrompt:oldArchive,structuredOutput:true});
    assert.equal(migrated.ordinaryPrompt,'');assert.equal(migrated.archivePrompt,'');assert.equal(migrated.structuredOutput,undefined);
    assert.equal(migratePromptSettings({ordinaryPrompt:'我的自定义提示词'}).ordinaryPrompt,'我的自定义提示词');
});
test('旧版总结原文可作为新模型输入，升级不改写旧消息',async()=>{
    const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);await engine.run();
    const previous=adapter.c.chat.at(-1);const legacy='<details><summary>旧总结</summary>完整旧历史</details>';
    const {digest}=await import('../src/model.js');
    previous.mes=legacy;tag(previous).renderHash=await digest(legacy);
    tag(previous).memory={schemaVersion:1,revision:1,timeline:[],volumes:[],world:{},details:[]};
    adapter.c.chat.push(story(8),story(9));await engine.run();
    assert.equal(JSON.parse(adapter.lastRequest.prompt[0].content).previousSummary,legacy);
    assert.equal(previous.mes,legacy);assert.equal(previous.is_system,true);assert.equal(engine.state().revision,2);
});
test('原生界面挂载一次，设置没有 JSON 输出或消息皮肤选项',async()=>{
    const before=globalThis.document;
    class Node{
        constructor(name){this.tagName=name;this.children=[];this.listeners={};this.textContent='';this.id='';}
        append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
        setAttribute(name,value){this[name]=value;}
        addEventListener(name,handler){this.listeners[name]=handler;}
        get isConnected(){return this===doc.body||!!this.parent?.isConnected;}
    }
    const walk=node=>[node,...node.children.flatMap(walk)];
    const doc={body:new Node('body'),createElement:name=>new Node(name),getElementById:id=>walk(doc.body).find(n=>n.id===id)};
    const toolbar=new Node('div');toolbar.id='leftSendForm';doc.body.append(toolbar);globalThis.document=doc;
    try{
        const adapter=new FakeAdapter(8);const engine=new MemoryEngine(adapter);const popups=[];
        adapter.c.Popup=class{static show={confirm:async()=>true};constructor(content){this.content=content;popups.push(content);}async show(){doc.body.append(this.content);return true;}};
        adapter.c.POPUP_TYPE={DISPLAY:1};
        const {MemoryUI}=await import('../src/ui.js');const ui=new MemoryUI(engine);ui.mount();ui.mount();assert.equal(toolbar.children.length,1);
        await ui.settings();const panel=popups.at(-1);
        assert.ok(!walk(panel).some(n=>n.tagName==='select'||n.textContent.includes('JSON Schema')));
        const save=walk(panel).find(n=>n.textContent==='保存设置');await save.listeners.click();
        assert.equal(engine.state().settings.ordinaryPrompt,ORDINARY_PROMPT);
        assert.equal(engine.state().settings.archivePrompt,ARCHIVE_PROMPT);
        await ui.refresh();
    }finally{globalThis.document=before;}
});


test('空闲时不受残留生成事件标志影响',()=>{
    const before=globalThis.document;globalThis.document={body:{dataset:{}}};
    try{const adapter=new TavernAdapter(()=>({streamingProcessor:null}));adapter.generating=true;assert.equal(adapter.busy(),false);}
    finally{globalThis.document=before;}
});
test('提示词预演结束后可直接开始普通大总结',async()=>{
    const before=globalThis.document;globalThis.document={body:{dataset:{}}};
    try{
        const adapter=new FakeAdapter(8);
        const status=new TavernAdapter(()=>({streamingProcessor:{isFinished:true,isStopped:false}}));status.generating=true;
        adapter.busy=()=>status.busy();
        const engine=new MemoryEngine(adapter);await engine.run();assert.equal(adapter.calls,1);assert.equal(engine.state().revision,1);
    }finally{globalThis.document=before;}
});
test('真实原生生成、UI 生成和活动流式输出仍会拦截总结',()=>{
    const before=globalThis.document;globalThis.document={body:{dataset:{}}};
    try{
        const context={streamingProcessor:null};const adapter=new TavernAdapter(()=>context);
        adapter.nativeIsGenerating=()=>true;assert.equal(adapter.busy(),true);
        adapter.nativeIsGenerating=()=>false;globalThis.document.body.dataset.generating='true';assert.equal(adapter.busy(),true);
        delete globalThis.document.body.dataset.generating;context.streamingProcessor={isFinished:false,isStopped:false};assert.equal(adapter.busy(),true);
    }finally{globalThis.document=before;}
});
test('已完成或已停止的流式处理器不会造成永久忙碌',()=>{
    const before=globalThis.document;globalThis.document={body:{dataset:{}}};
    try{
        const context={streamingProcessor:{isFinished:true,isStopped:false}};const adapter=new TavernAdapter(()=>context);
        assert.equal(adapter.busy(),false);context.streamingProcessor={isFinished:false,isStopped:true};assert.equal(adapter.busy(),false);
    }finally{globalThis.document=before;}
});
test('总结结束释放自己的 UI 锁，但不清除真实原生生成状态',()=>{
    const before=globalThis.document;let activated=0;
    globalThis.document={body:{dataset:{}},getElementById:()=>null};
    try{
        const adapter=new TavernAdapter(()=>({deactivateSendButtons(){},activateSendButtons(){activated++;},streamingProcessor:null}));
        adapter.nativeIsGenerating=()=>false;adapter.lock()();assert.equal(activated,1);
        adapter.nativeIsGenerating=()=>true;adapter.lock()();assert.equal(activated,1);
    }finally{globalThis.document=before;}
});

export async function runTests() {
    const results=[];
    for(const {name,run} of tests){try{await run();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.stack});}}
    return{total:results.length,passed:results.filter(x=>x.pass).length,results};
}
if(typeof process!=='undefined'&&process.argv[1]?.endsWith('run.mjs')){
    const report=await runTests();for(const result of report.results)console.log((result.pass?'PASS ':'FAIL ')+result.name+(result.error?'\n'+result.error:''));
    console.log(report.passed+'/'+report.total+' passed');if(report.passed!==report.total)process.exitCode=1;
}
