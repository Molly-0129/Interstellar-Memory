// Validate the tagged YAML without repairing, summarizing, merging or reserializing it.
export const SUMMARY_TAGS = Object.freeze({ ordinary: '星间大总结', archive: '星间卷宗' });
function mapping(value, at) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(at + ' 必须是 YAML 对象。');
    return value;
}
function text(value, at) {
    if (typeof value !== 'string') throw new Error(at + ' 必须是文本，未知信息可写“未知”。');
}
function list(value, at, fields = {}) {
    if (!Array.isArray(value)) throw new Error(at + ' 必须是列表，没有内容时请返回 []。');
    value.forEach((item, i) => record(item, fields, at + '[' + i + ']'));
}
function record(value, fields, at) {
    mapping(value, at);
    for (const [key, type] of Object.entries(fields)) {
        if (!Object.hasOwn(value, key)) throw new Error(at + ' 缺少字段：' + key);
        if (type === 'list') {
            if (!Array.isArray(value[key]) || value[key].some(x => typeof x !== 'string')) throw new Error(at + '.' + key + ' 必须是文本列表。');
        } else if (type === 'knowledge') {
            if (Array.isArray(value[key])) {
                if (value[key].some(x => typeof x !== 'string')) throw new Error(at + '.' + key + ' 知情范围格式不正确。');
            } else text(value[key], at + '.' + key);
        } else text(value[key], at + '.' + key);
    }
}
const eventFields = { 时间: 'text', 地点: 'text', 参与人物: 'list', 事件: 'text', 关键细节: 'text', '结果与影响': 'text' };
const worldFields = {
    重要人物: { 姓名: 'text', '身份与处境': 'text', 当前所在地: 'text', 身体及其他重要状态: 'text', 目标与正在进行的事务: 'text' },
    人物关系: { 相关人物: 'list', 关系性质: 'text', 当前状态: 'text', 重要变化与未决问题: 'text' },
    信息与秘密: { 内容: 'text', 真实性: 'text', 知情范围: 'knowledge' },
    重要物品与资源: { 名称: 'text', 当前状态: 'text', 持有者或位置: 'text' },
    地点与环境: { 地点: 'text', 当前状态: 'text' },
    未决事务: { 事项: 'text', 当前进展: 'text', 关联人物: 'list' },
};
function checkUnsafe(value, depth = 0) {
    if (depth > 80) throw new Error('YAML 嵌套过深。');
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('YAML 含有不支持的对象键。');
        checkUnsafe(value[key], depth + 1);
    }
}
export function validateDocument(document, mode) {
    mapping(document, '总结');
    const expected = mode === 'ordinary' ? '普通大总结' : '分卷大总结';
    if (document.记忆模式 !== expected) throw new Error('记忆模式应为“' + expected + '”。');
    const rangeKey = mode === 'ordinary' ? '总结范围' : '整理范围';
    if (!Object.hasOwn(document, rangeKey)) throw new Error('缺少' + rangeKey + '。');
    const range = document[rangeKey] === null ? document : document[rangeKey];
    record(range, { 起点: 'text', 截至: 'text' }, rangeKey);
    // The supplied template permits world lists at root; also accept normal nested YAML.
    if (!Object.hasOwn(document, '当前世界状态')) throw new Error('缺少当前世界状态。');
    const world = document.当前世界状态 ?? {};
    mapping(world, '当前世界状态');
    text(world.当前时间与场景 ?? document.当前时间与场景, '当前时间与场景');
    for (const [key, fields] of Object.entries(worldFields)) list(world[key] ?? document[key], key, fields);
    if (mode === 'ordinary') {
        list(document.主要事件时间线, '主要事件时间线', eventFields);
        if (!document.主要事件时间线.length) throw new Error('总结没有可用事件结果，原上下文保持不变。');
        list(document.重要细节, '重要细节', { 内容: 'text', 关联事件: 'text', 保存理由: 'text', 当前效力: 'text' });
    } else {
        list(document.历史卷宗, '历史卷宗');
        if (!document.历史卷宗.length) throw new Error('未生成可归档卷宗，保留当前记忆。');
        document.历史卷宗.forEach((volume, i) => {
            record(volume, { 卷名: 'text', 时间范围: 'text', 阶段概述: 'text' }, '历史卷宗[' + i + ']');
            if (!Object.hasOwn(volume, '卷号') || !['string', 'number'].includes(typeof volume.卷号)) throw new Error('卷号格式不正确。');
            list(volume.关键事件, '卷宗关键事件', { 时间: 'text', 地点: 'text', 参与人物: 'list', 事件与因果: 'text', 重要细节: 'text', 长期影响: 'text' });
        });
        if (!Object.hasOwn(document, '当前卷')) throw new Error('缺少当前卷。');
        const current = document.当前卷 === null ? document : document.当前卷;
        record(current, { 卷名: 'text', 起始时间: 'text' }, '当前卷');
        if (!Object.hasOwn(current, '卷号') || !['string', 'number'].includes(typeof current.卷号)) throw new Error('当前卷卷号格式不正确。');
        list(current.事件时间线, '当前卷事件时间线', eventFields);
        list(document.跨卷重要细节, '跨卷重要细节', { 内容: 'text', 来源卷宗: 'text', 保存理由: 'text', 当前效力: 'text' });
        if (!Object.hasOwn(document, '整理检查')) throw new Error('缺少整理检查。');
        const checks = document.整理检查 === null ? document : document.整理检查;
        mapping(checks, '整理检查');
        if (!Array.isArray(checks.待核实事项) || checks.待核实事项.some(x => typeof x !== 'string')) throw new Error('待核实事项必须是文本列表。');
    }
    return document;
}
export function parseResult(raw, mode, yaml) {
    if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) throw new Error('模型结果为空或过大。');
    if (!yaml?.parseDocument) throw new Error('酒馆未提供 YAML 解析库，请更新酒馆。');
    const tag = SUMMARY_TAGS[mode];
    if (!tag) throw new Error('未知总结模式。');
    const match = raw.trim().match(new RegExp('^<' + tag + '>\\s*([\\s\\S]*?)\\s*</' + tag + '>$'));
    if (!match || /<\/?星间(?:大总结|卷宗)>/.test(match[1])) throw new Error('模型必须只返回一个 <' + tag + '> YAML 标签块。');
    let document;
    try {
        const parsed = yaml.parseDocument(match[1], { schema: 'core', version: '1.2', strict: true, uniqueKeys: true });
        if (parsed.errors.length) throw parsed.errors[0];
        document = parsed.toJS({ maxAliasCount: 0 });
    } catch (error) {
        throw new Error('总结 YAML 格式不合法，未隐藏原文：' + String(error.message).split('\n')[0]);
    }
    checkUnsafe(document);
    validateDocument(document, mode);
    // Keep the exact model response, including whitespace and original YAML formatting.
    return { raw, document };
}
