const str = { type: 'string' };
const strings = { type: 'array', items: str };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = items => ({ type: 'array', items });
const event = object({ time: str, location: str, participants: strings, event: str, details: str, impact: str, sources: strings });
const detail = object({ content: str, reason: str, related: strings, currentEffect: str });
const update = record => object({ id: str, record, evidence: str });
export const worldPatch = object({
    scene: str,
    characters: list(object({ name: str, identity: str, location: str, condition: str, goals: str })),
    relationships: list(object({ parties: strings, nature: str, status: str, changes: str })),
    secrets: list(object({ key: str, content: str, truth: str, knownBy: strings })),
    items: list(object({ name: str, status: str, owner: str })),
    locations: list(object({ name: str, status: str })),
    affairs: list(object({ key: str, matter: str, progress: str, people: strings })),
});
const shared = {
    schemaVersion: { type: 'integer', const: 1 }, mode: str, baseRevision: { type: 'integer', minimum: 0 },
    foreshadowingUpdates: list(object({ key: str, clue: str, status: { type: 'string', enum: ['活跃', '已解决', '待核实'] }, evidence: str, related: strings })),
    stateUpdates: worldPatch, newDetails: list(detail), detailUpdates: list(update(detail)), issues: strings,
};
export function outputSchema(mode) {
    return object(mode === 'ordinary' ? { ...shared, mode: { type: 'string', const: 'ordinary' }, newEvents: list(event), eventUpdates: list(update(event)) } : {
        ...shared, mode: { type: 'string', const: 'archive' },
        archives: list(object({ title: str, timeRange: str, overview: str, sourceIds: strings,
            keyEvents: list(object({ time: str, location: str, participants: strings, causality: str, lastingImpact: str })) })),
        currentEventIds: strings, capacityNote: str,
    });
}
export function validate(value, schema, at = '$') {
    if (schema.const !== undefined && value !== schema.const) throw new Error(at + ' 固定值不匹配。');
    if (schema.enum && !schema.enum.includes(value)) throw new Error(at + ' 枚举值不合法。');
    const type = schema.type;
    if (type === 'string' && typeof value !== 'string') throw new Error(at + ' 必须是文本。');
    if (type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity))) throw new Error(at + ' 整数不合法。');
    if (type === 'array') {
        if (!Array.isArray(value)) throw new Error(at + ' 必须是列表。');
        value.forEach((x, i) => validate(x, schema.items, at + '[' + i + ']'));
    }
    if (type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(at + ' 必须是对象。');
        for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(at + ' 缺少 ' + key);
        for (const key of Object.keys(value)) {
            if (!Object.hasOwn(schema.properties, key)) throw new Error(at + ' 未知字段 ' + key);
            validate(value[key], schema.properties[key], at + '.' + key);
        }
    }
    return value;
}
export function parseResult(raw, mode) {
    if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) throw new Error('模型结果为空或过大。');
    const clean = raw.trim();
    // Only unwrap a complete JSON fence; never extract fragments from explanatory prose.
    const text = clean.replace(/^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i, '$1');
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('总结未返回完整 JSON，原上下文保持不变。'); }
    return validate(value, outputSchema(mode));
}
