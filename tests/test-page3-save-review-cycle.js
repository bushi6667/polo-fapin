const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../chrome_extension/content/page3-save-review-cycle.js'), 'utf8'), context);
const { create, step } = context.PoloSaveReviewCycle;
function harness(rows = [{ state: 'pass' }]) {
    const writes = [], calls = [];
    let identity = 'task:file:row:item';
    return { writes, calls, switch: () => { identity = 'other'; },
        identity: () => identity,
        write: async s => { writes.push(s); },
        save: async () => { calls.push('save'); assert.equal(writes.at(-1).phase, 'saving'); return { verified: true }; },
        savedEvidence: async ({ cycleId, attempt }) => ({ verified: true, cycleId, attempt }),
        inspect: async () => { calls.push('inspect'); return rows; },
        repair: async actions => { calls.push('repair:' + actions.join(',')); }
    };
}
(async () => {
    let a = harness(), s = await step(create(a.identity()), a);
    assert.equal(s.phase, 'complete'); assert.deepEqual(a.calls, ['save', 'inspect']);
    await step(s, a); assert.equal(a.calls.length, 2);
    a = harness([{ state: 'pass', action: 'title' }, { state: 'fail', action: 'unit' }]);
    s = await step(create(a.identity()), a);
    assert.equal(s.phase, 'ready'); assert.equal(s.repairs, 1);
    assert.deepEqual(a.calls, ['save', 'inspect', 'repair:unit']);
    s = await step(s, a); s = await step(s, a);
    assert.equal(s.phase, 'blocked'); assert.equal(a.calls.filter(c => c === 'repair:unit').length, 2);
    a = harness([{ state: 'unknown', action: 'unit' }]);
    assert.equal((await step(create(a.identity()), a)).phase, 'blocked'); assert(!a.calls.some(c => c.startsWith('repair')));
    a = harness(); a.save = async () => ({ verified: false });
    assert.equal((await step(create(a.identity()), a)).phase, 'blocked'); assert.equal(a.calls.length, 0);
    a = harness(); s = { ...create(a.identity()), phase: 'saving', attempt: 1 };
    assert.equal((await step(s, a)).phase, 'complete'); assert.deepEqual(a.calls, ['inspect']);
    a = harness(); a.savedEvidence = async () => ({ verified: true, attempt: 0 });
    assert.equal((await step(s, a)).phase, 'blocked'); assert.equal(a.calls.length, 0);
    a = harness(); a.savedEvidence = async ({ attempt }) => ({ verified: true, cycleId: 'older-cycle', attempt });
    assert.equal((await step(s, a)).phase, 'blocked'); assert.equal(a.calls.length, 0);
    a = harness(); a.inspect = async () => { a.switch(); return [{ state: 'pass' }]; };
    await assert.rejects(step(create(a.identity()), a), /切换/);
    a = harness(); a.write = async () => { throw Error('disk'); };
    await assert.rejects(step(create(a.identity()), a), /disk/); assert.equal(a.calls.length, 0);
    a = harness(); s = { ...create(a.identity()), phase: 'repairing', repairs: 1 };
    assert.equal((await step(s, a)).phase, 'blocked'); assert.equal(a.calls.length, 0);
    for (const rows of [[], [{ state: 'unexpected' }], [{ state: 'fail' }]]) {
        a = harness(rows); assert.equal((await step(create(a.identity()), a)).phase, 'blocked');
    }
    console.log('PASS save/review cycle: durable save, scoped repair, bounded retries, resume evidence, unknown and identity gates');
})().catch(e => { console.error(e); process.exitCode = 1; });
