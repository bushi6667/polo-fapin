const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const source = fs.readFileSync(__dirname + '/../chrome_extension/content/page3-review-company.js', 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
    const gallery = (value, images) => ({ value, enName: 'Group ' + value, imageList: images.map(name => ({ fileName: name, imgURL: 'https://img.test/' + name })) });
    const before = { companyImage: [gallery('400', ['custom-a']), gallery('550', options.emptyGroup ? [] : ['custom-b']), gallery('750', ['custom-c']), gallery('custom', ['extra'])],
        companyDesc: options.emptyText ? '' : '  Custom company text  ', companyFaqDesc: [{ question: 'Custom Q', answers: ['Custom A'] }] };
    if (options.absentGroup) before.companyImage.splice(1, 1);
    let value = copy(before), applied = 0, readCount = 0, lastPatch;
    const template = { companyImage: [gallery('400', ['template-a']), gallery('550', ['template-b1', 'template-b2']), gallery('750', ['template-c'])],
        companyDesc: 'Template text', companyFaqDesc: [{ question: 'Wrong template Q', answers: ['Wrong A'] }] };
    const widget = { state: { templateList: [{ label: 'Shirt', value: 123 }] }, async: { getTemplateDetailUrl: '/read-template' },
        props: { scene: 'companyInfoTemplate', getTemplateData: async () => { readCount++; return copy(value); },
            commonPuck: { get: async () => {
                if (options.hangFetch) return new Promise(() => {});
                if (options.changedDuringFetch) value.companyDesc = 'user typed';
                if (options.switchedPage) context.performance.timeOrigin = 2;
                if (options.expiredDuringFetch) context.Date = { now: () => Date.now() + 20000 };
                return { body: { code: options.fetchFails ? 500 : 200, data: { templateData: JSON.stringify(template) } } };
            } },
            onChange: async data => {
                applied++; lastPatch = JSON.parse(data.templateData);
                value = { ...value, ...copy(lastPatch) };
                if (options.reorderKeys) value.companyImage = value.companyImage.map(group => Object.fromEntries(Object.entries(group).reverse()));
                if (options.engineChangesFaq) value.companyFaqDesc = [];
            } } };
    if (options.duplicateTemplate) widget.state.templateList.push({ label: 'Shirt', value: 456 });
    if (options.duplicateGroup) before.companyImage.push(copy(before.companyImage[0])), value = copy(before);
    const fiber = { memoizedProps: widget.props, stateNode: widget };
    const control = { __reactFiber$test: fiber };
    const heading = { querySelector: () => control };
    const card = { querySelector: () => heading, scrollIntoView: () => {} };
    const context = { URLSearchParams, location: { hostname: 'post.alibaba.com', search: '?itemId=123' }, performance: { timeOrigin: 1 },
        document: { querySelector: () => card }, setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 1)), clearTimeout };
    vm.createContext(context); vm.runInContext(source, context);
    return { before, template, widget, context, value: () => value, applied: () => applied, patch: () => lastPatch,
        run: extra => context.PoloReviewCompany.applyMain({ label: 'Shirt', itemId: '123', origin: 1, deadline: Date.now() + 15000, ...extra }) };
}
(async () => {
    let f = fixture({ emptyGroup: true, emptyText: true }), result = await f.run();
    assert.equal(result.ok, true); assert.equal(f.applied(), 1);
    assert.deepEqual(f.value().companyImage[1].imageList, f.template.companyImage[1].imageList);
    assert.equal(f.value().companyDesc, f.template.companyDesc);
    assert.deepEqual(f.value().companyFaqDesc, f.before.companyFaqDesc);
    assert(!Object.hasOwn(f.patch(), 'companyFaqDesc'));
    for (const index of [0, 2, 3]) assert.deepEqual(f.value().companyImage[index], f.before.companyImage[index]);
    f = fixture({ emptyGroup: true }); await f.run();
    assert.equal(f.value().companyDesc, f.before.companyDesc); assert(!Object.hasOwn(f.patch(), 'companyDesc'));
    f = fixture({ emptyText: true }); await f.run();
    assert(!Object.hasOwn(f.patch(), 'companyImage')); assert.deepEqual(f.value().companyImage, f.before.companyImage);
    f = fixture({ absentGroup: true }); await f.run();
    assert.equal(f.value().companyImage.length, 4);
    for (let i = 0; i < f.before.companyImage.length; i++) assert.deepEqual(f.value().companyImage[i], f.before.companyImage[i]);
    f = fixture(); result = await f.run(); assert.equal(result.applied, false); assert.equal(f.applied(), 0);
    f = fixture({ emptyGroup: true }); result = await f.run({ readOnly: true }); assert.equal(result.applied, false); assert.equal(f.applied(), 0);
    f = fixture({ emptyGroup: true, reorderKeys: true }); assert.equal((await f.run()).ok, true);
    for (const options of [{ changedDuringFetch: true }, { switchedPage: true }, { expiredDuringFetch: true }, { duplicateTemplate: true }, { duplicateGroup: true }, { fetchFails: true }, { hangFetch: true }]) {
        f = fixture({ emptyGroup: true, ...options }); await assert.rejects(f.run()); assert.equal(f.applied(), 0);
    }
    f = fixture({ emptyGroup: true, engineChangesFaq: true }); await assert.rejects(f.run(), /已有内容发生变化/);
    f = fixture(); await assert.rejects(f.run({ itemId: 'other' })); assert.equal(f.applied(), 0);
    f = fixture(); await assert.rejects(f.run({ deadline: Date.now() - 1 }), /过期/); assert.equal(f.applied(), 0);
    f = fixture({ emptyText: true }); f.context.location.search = '?row=2&task=task';
    assert.equal((await f.run({ itemId: '' })).ok, true); // 首次保存前尚无itemId，仍绑定文档身份。
    const lines = fs.readFileSync(__dirname + '/../chrome_extension/content/page3.js', 'utf8').split('\n');
    const start = lines.findIndex(line => line.startsWith('function pickCompanyIntroTemplate('));
    const end = lines.findIndex((line, index) => index > start && line.trimEnd() === '}');
    assert(start >= 0 && end > start);
    f = fixture(); vm.runInContext(lines.slice(start, end + 1).join('\n'), f.context);
    assert.equal(f.context.pickCompanyIntroTemplate({ category: 'unknown' }), 'Polo衫'); // 原填入默认口径保留。
    assert.equal(f.context.pickCompanyIntroTemplate({ category: 'unknown' }, { strict: true }), '');
    const sent = [];
    f.context.PoloSaveStability = { request: send => send() };
    f.context.sendMessageRetry = async request => { sent.push(request); return { ok: true, changed: [] }; };
    await assert.rejects(f.context.PoloReviewCompany.repair(f.context.document, { category: 'unknown' }), /来源不明确/);
    assert.equal(sent.length, 0);
    await f.context.PoloReviewCompany.repair(f.context.document, { category: 'shirt(3)', row: 2, _publishFileKey: 'file' });
    assert.equal(sent.length, 1); assert.equal(sent[0].label, 'Shirt'); assert.equal(sent[0].row, 2);
    assert.equal(sent[0].origin, 1); assert(sent[0].deadline > Date.now());
    console.log('PASS company missing-only: original callback, empty groups/text only, custom images/text/FAQ preserved, no-op, stale source and identity guards');
})().catch(e => { console.error(e); process.exitCode = 1; });
