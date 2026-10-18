export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function item(lines, title, value) { if (value?.length) lines.push('- **' + title + '**：' + escapeHtml(Array.isArray(value) ? value.join('、') : value)); }
export function renderMemory(memory, mode, number) {
    const lines = [];
    for (const volume of memory.volumes) {
        lines.push('### 卷 ' + volume.number + ' · ' + escapeHtml(volume.title), escapeHtml(volume.timeRange), escapeHtml(volume.overview));
        for (const event of volume.keyEvents) {
            lines.push('- ' + escapeHtml(event.time) + ' · ' + escapeHtml(event.location) + '：' + escapeHtml(event.causality) + '；' + escapeHtml(event.lastingImpact));
        }
    }
    lines.push('### ' + (memory.volumes.length ? '当前卷 · 事件时间线' : '主要事件时间线'));
    for (const event of memory.timeline) {
        lines.push('#### ' + escapeHtml(event.time || '时间未知') + ' · ' + escapeHtml(event.location || '地点未知'));
        item(lines, '人物', event.participants); item(lines, '事件', event.event); item(lines, '关键细节', event.details); item(lines, '结果与影响', event.impact);
    }
    const world = memory.world;
    lines.push('### 当前世界状态');
    item(lines, '当前时间与场景', world.scene);
    for (const person of world.characters) item(lines, person.name, [person.identity, person.location, person.condition, person.goals].filter(Boolean).join('；'));
    for (const relationship of world.relationships) item(lines, relationship.parties.join(' / '), [relationship.nature, relationship.status, relationship.changes].filter(Boolean).join('；'));
    for (const secret of world.secrets) item(lines, '信息与秘密', secret.content + '；真实性：' + secret.truth + '；知情：' + secret.knownBy.join('、'));
    for (const object of world.items) item(lines, object.name, object.status + '；持有者或位置：' + object.owner);
    for (const location of world.locations) item(lines, location.name, location.status);
    for (const affair of world.affairs) item(lines, affair.matter, affair.progress + '；关联：' + affair.people.join('、'));
    lines.push('### 重要细节');
    for (const detail of memory.details) item(lines, detail.content, detail.reason + '；当前效力：' + detail.currentEffect);
    if (memory.clues?.length || memory.foreshadowing) {
        lines.push('### 活跃伏笔与线索');
        for (const clue of memory.clues ?? []) item(lines, clue.clue, clue.status + '；依据：' + clue.evidence);
        if (memory.foreshadowing) lines.push('<pre>' + escapeHtml(memory.foreshadowing) + '</pre>');
    }
    if (memory.locks) lines.push('### 用户锁定记录', '<pre>' + escapeHtml(memory.locks) + '</pre>');
    if (memory.issues.length) { lines.push('### 待核实'); memory.issues.forEach(issue => lines.push('- ' + escapeHtml(issue))); }
    return '<details class="interstellar-summary"><summary>✦ 星间记忆 · ' + (mode === 'archive' ? '分卷总结' : '普通大总结') + ' #' + number + '</summary>\n\n' + lines.join('\n\n') + '\n\n</details>';
}
