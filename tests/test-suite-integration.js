// ============================================================
// 套图跨模块集成测试：编号确认 → 后处理 → 写盘 → 索引 → 恢复核验
//
// 调用【真实业务模块】：
//   chrome_extension/suite/suite-core.js        （recognize / 编号 / saveAll / verifySavedFiles / ResultStore）
//   chrome_extension/suite/suite-postprocess.js （checkAvailability / runAll）
// 文件系统与豆包结果用 mock 注入，但被测对象始终是真实模块，不另写简化流程。
//
// 运行：node tests/test-suite-integration.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'chrome_extension/suite/suite-core.js'), 'utf8');
const POST = fs.readFileSync(path.join(ROOT, 'chrome_extension/suite/suite-postprocess.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(c, n, e) { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' :: ' + e : ''}`); } }

/* ---------- 最小内存版 indexedDB（供 ResultStore 真实调用） ---------- */
function fakeIndexedDB() {
    const dbs = {};
    const mkStore = () => ({ data: new Map(), idx: new Map() });
    function open(name) {
        if (!dbs[name]) dbs[name] = { stores: {}, names: new Set() };
        const db = dbs[name];
        return {
            objectStoreNames: { contains: (n) => db.names.has(n) },
            createObjectStore: (n) => { db.names.add(n); db.stores[n] = mkStore(); return { createIndex: () => ({}) }; },
            transaction: (n) => {
                const st = db.stores[n] || (db.stores[n] = mkStore());
                const tx = { oncomplete: null, onerror: null, error: null };
                tx.objectStore = () => ({
                    put: (rec) => { st.data.set(rec.id, JSON.parse(JSON.stringify(rec))); st.idx.set(rec.id, [rec.fileKey, rec.rowNum]); queueMicrotask(() => tx.oncomplete && tx.oncomplete()); },
                    get: (id) => { const r = { result: st.data.get(id) || null, onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; },
                    delete: (id) => { st.data.delete(id); queueMicrotask(() => tx.oncomplete && tx.oncomplete()); },
                    index: (iname) => ({ getAll: ([fk, rn]) => { const out = []; for (const [id, v] of st.data) { const k = st.idx.get(id); if (k && k[0] === fk && k[1] === rn) out.push(v); } const r = { result: out, onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; } })
                });
                return tx;
            }
        };
    }
    return { open: (name) => { const r = { result: open(name), onupgradeneeded: null, onsuccess: null, onerror: null }; queueMicrotask(() => { r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess && r.onsuccess(); }); return r; } };
}

function loadModules() {
    const env = { console: { log() {}, warn() {}, error() {} }, indexedDB: fakeIndexedDB(), queueMicrotask, setTimeout, clearTimeout, URL };
    env.globalThis = env;
    const ctx = vm.createContext(env);
    vm.runInContext(CORE, ctx, { filename: 'suite-core.js' });
    vm.runInContext(POST, ctx, { filename: 'suite-postprocess.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome_extension/suite/suite-image-transform.js'), 'utf8'), ctx);
    return env;
}

/* ---------- 目录句柄 mock（外部 API 模拟，非业务） ---------- */
function makeDir(opts = {}) {
    const files = new Map(Object.entries(opts.files || {}));   // name -> {size,type}
    return {
        kind: 'directory',
        queryPermission: async () => opts.perm || 'granted',
        getFileHandle: async (name) => {
            if (opts.throwName && opts.throwName === name) {
                const e = new Error(opts.throwType === 'SecurityError' ? '读取被拒绝' : 'not found'); e.name = opts.throwType || 'NotFoundError'; throw e;
            }
            if (!files.has(name)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
            const f = files.get(name);
            return { getFile: async () => ({ size: f.size, type: f.type || 'image/png' }), createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
        }
    };
}

const writeDir = () => { const written = new Map(); return { kind: 'directory', queryPermission: async () => 'granted', getFileHandle: async (n) => ({ createWritable: async () => ({ write: async (b) => { written.set(n, b); }, close: async () => {} }), getFile: async () => ({ size: written.has(n) ? written.get(n).size : 0, type: 'image/png', arrayBuffer: async () => written.get(n).arrayBuffer() }) }) }; };
const KEYS = ['111', '222', '333', '444', '666'];
const blob = (n = 100) => ({ size: n, arrayBuffer: async () => new ArrayBuffer(n) });

(async function main() {
    console.log('=== 套图跨模块集成测试 ===\n');

    // ================= A. 编号确认 → 后处理 → 写盘 → 索引 → 核验 =================
    console.log('【A】完整链路（真实模块）：候选 → 确认 → 后处理 → 写盘 → 索引 → 核验');
    const M = loadModules();
    const { SuiteCore, SuitePostprocess } = M;
    {
        // 1) 采到 5 张（打乱顺序：故意让候选顺序 ≠ 逻辑编号）
        const shuffled = ['u_d', 'u_b', 'u_e', 'u_a', 'u_c'];
        const cands = SuiteCore.buildNumberingCandidates(shuffled, KEYS.map(k => ({ key: k })));
        ok(cands.length === 5 && cands.every(c => c.source === 'appearance-order'), '候选标注来源为出现顺序（非已确认）');

        // 2) 用户把 111 指定为候选 4（u_a），其余顺延 —— 映射≠原始顺序
        const assignment = { '111': 3, '222': 1, '333': 4, '444': 0, '666': 2 };
        let assigned = null, assignErr = null;
        try { assigned = SuiteCore.applyNumberingAssignment(cands, assignment); } catch (e) { assignErr = e.message; }
        ok(!assignErr && assigned.length === 5, `确认全部编号通过（${assignErr || 'ok'}）`);
        ok(assigned.find(a => a.key === '111').url === 'u_a', '111 使用【确认后】的图片（u_a），而非候选第 1 张');
        ok(assigned.every(a => a.source === 'user-confirmed'), '确认项来源标记为 user-confirmed');

        // 3) 非法分配被拒
        const bad = [
            [{ '111': 3, '222': 3, '333': 4, '444': 0, '666': 2 }, /重复分配/],
            [{ '111': 3, '222': 1, '333': 4, '444': 0 }, /全部编号/],
            [{ '111': 9, '222': 1, '333': 4, '444': 0, '666': 2 }, /超出范围/],
            [{ '111': 0, '222': 1, '333': 2, '444': 3, '999': 4 }, /未知编号/]
        ];
        for (const [asg, re] of bad) {
            let err = null; try { SuiteCore.applyNumberingAssignment(cands, asg); } catch (e) { err = e.message; }
            ok(err && re.test(err), `非法分配被拒（${re}）→ ${err}`);
        }

        // 4) 按确认映射做后处理（给每编号一个能回显 key 的脚本，验证映射真的传进去了）
        const steps = assigned.map(a => ({ outputKeys: [{ key: a.key }], prompt: 'p', model: '5.0', ratio: '1:1',
            postprocess: { type: 'customJs', script: 'function process(i){ return { size: i.size, arrayBuffer(){} }; }' } }));
        const blobs = {}; assigned.forEach(a => { blobs[a.key] = blob(200); });
        const av = SuitePostprocess.checkAvailability(steps, assigned.map(a => a.key));
        ok(av.ok === true, '后处理配置预检通过');
        const post = await SuitePostprocess.runAll(steps, assigned.map(a => a.key), blobs, { getHandle: async () => null });
        ok(post.ok === true && post.results.length === 5, '后处理按确认后的 5 个编号全部执行');

        // 5) 写盘（真实 saveAll）→ 文件名与索引使用确认后的编号
        const items = post.results.map(r => ({ key: r.key, blob: r.output }));
        const saved = await SuiteCore.saveAll(writeDir(), items, { fileKey: 'A__', rowNum: 412, decodeSize: async () => ({ width: 800, height: 800 }) });
        ok(saved.ok === true && saved.savedCount === 5, '五张全部写入并回读校验通过');
        ok(saved.results.every((r, i) => r.key === assigned[i].key), '写盘结果顺序/编号与确认映射一致');
        ok(saved.results.every(r => r.filename.includes('row412') && r.filename.includes(r.key)), '文件名含行号+确认编号（跨产品不覆盖）');

        // 6) 索引（真实 ResultStore + 内存 indexedDB）
        const store = SuiteCore.ResultStore();
        for (const it of items) {
            const r = saved.results.find(x => x.key === it.key);
            await store.put({ fileKey: 'A__', rowNum: 412, key: it.key, taskId: 't1', blob: it.blob, meta: { filename: r.filename, bytes: r.bytes, width: r.width, height: r.height } });
        }
        const listed = await store.list('A__', 412);
        ok(listed.length === 5, `索引写入 5 条（${listed.length}）`);
        ok(listed.every(r => r.fileKey === 'A__' && r.rowNum === 412), '索引按 fileKey+rowNum 绑定');
        const other = await store.list('B__', 412);
        ok(other.length === 0, '其他文件标识查不到（切换产品不混图）');

        // 7) 恢复核验（真实 verifySavedFiles）——磁盘文件齐全
        const files = {}; saved.results.forEach(r => { files[r.filename] = { size: r.bytes, type: 'image/png' }; });
        const v1 = await SuiteCore.verifySavedFiles(listed, { dirHandle: makeDir({ files }), decodeSize: async () => ({ width: 800, height: 800 }) });
        ok(v1.ok === true, `磁盘核验全部通过（${JSON.stringify(v1.unverified)}）`);
        ok(v1.items.every(i => i.status === 'verified'), '状态均为 verified');
    }

    // ================= B. 磁盘核验各状态（真实 verifySavedFiles） =================
    console.log('\n【B】磁盘核验状态：verified / missing / no-permission / corrupt / replaced / cache-only / error');
    {
        const rec = (filename, bytes) => ({ key: '111', meta: { filename, bytes } });
        const deps = (dir, extra = {}) => Object.assign({ dirHandle: dir, decodeSize: async () => ({ width: 800, height: 800 }) }, extra);

        // A 正常
        let r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 100 } } })));
        ok(r.items[0].status === 'verified', 'A 缓存+磁盘正常 → verified');

        // B 文件删除（目录可访问）
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: {} })));
        ok(r.items[0].status === 'missing', 'B 文件已删除 → missing');

        // C 权限失效
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ perm: 'prompt', files: { 'f111.png': { size: 100 } } })));
        ok(r.items[0].status === 'no-permission' && /权限/.test(r.items[0].detail) && r.items[0].detail.indexOf('未找到') < 0, 'C 权限失效 → no-permission（不误报 missing）');
        ok(r.ok === false, 'C 不可核验时整体不为 ok');
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 100 } } })));
        ok(r.items[0].status === 'verified', 'C2 重新授权后可核验');

        // D 损坏：空文件 / 非图片 / 解码失败 / 尺寸无效
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 0 } } })));
        ok(r.items[0].status === 'corrupt' && /为空/.test(r.items[0].detail), 'D1 空文件 → corrupt');
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 10, type: 'text/html' } } })));
        ok(r.items[0].status === 'corrupt' && /不是图片/.test(r.items[0].detail), 'D2 非图片 → corrupt');
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 100 } } }), { decodeSize: async () => { throw new Error('坏文件'); } }));
        ok(r.items[0].status === 'corrupt', 'D3 无法解码 → corrupt');
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 100 } } }), { decodeSize: async () => ({ width: 8, height: 8 }) }));
        ok(r.items[0].status === 'corrupt' && /尺寸无效/.test(r.items[0].detail), 'D4 尺寸不合格 → corrupt');

        // E 替换：大小不同 / 内容指纹不同（即使尺寸相同）
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: { 'f111.png': { size: 999 } } })));
        ok(r.items[0].status === 'replaced' && /大小/.test(r.items[0].detail), 'E1 同名大小不同 → replaced');
        const recH = { key: '111', meta: { filename: 'f111.png', bytes: 100, contentHash: 'H_OLD' } };
        r = await SuiteCore.verifySavedFiles([recH], deps(makeDir({ files: { 'f111.png': { size: 100 } } }), { hash: async () => 'H_NEW' }));
        ok(r.items[0].status === 'replaced' && /指纹/.test(r.items[0].detail), 'E2 大小相同但内容指纹不同 → replaced（不只比尺寸）');
        r = await SuiteCore.verifySavedFiles([recH], deps(makeDir({ files: { 'f111.png': { size: 100 } } }), { hash: async () => 'H_OLD' }));
        ok(r.items[0].status === 'verified', 'E3 指纹一致 → verified');

        // F 历史记录缺定位信息
        r = await SuiteCore.verifySavedFiles([{ key: '111', meta: {} }], deps(makeDir({ files: {} })));
        ok(r.items[0].status === 'cache-only' && /无法核验/.test(r.items[0].detail), 'F 缺 filename → cache-only（不默认已保存）');

        // G 其他读取异常
        r = await SuiteCore.verifySavedFiles([rec('f111.png', 100)], deps(makeDir({ files: {}, throwName: 'f111.png', throwType: 'SecurityError' })));
        ok(r.items[0].status === 'error' && /SecurityError|读取错误/.test(r.items[0].detail), `G 非缺失异常 → error 且保留原因（${r.items[0].status}）`);

        // H 从缓存重新保存（不涉及豆包）
        const cacheRec = { key: '111', fileKey: 'A__', rowNum: 412, blob: blob(300), meta: {} };
        const reSave = await SuiteCore.saveAll(writeDir(), [{ key: '111', blob: cacheRec.blob }], { fileKey: 'A__', rowNum: 412, decodeSize: async () => ({ width: 800, height: 800 }) });
        ok(reSave.ok === true, 'H 用缓存重新保存成功');
        ok(reSave.results[0].filename.indexOf('row412') >= 0, 'H 恢复保存使用原 fileKey+行号+编号命名');
    }

    // ================= C. 失败不完成 + 可恢复 =================
    console.log('\n【C】失败路径：后处理/写盘失败不得完成，且可只重试');
    {
        const keys = KEYS;
        // 后处理失败
        const stepsBad = keys.map(k => ({ outputKeys: [{ key: k }], postprocess: { type: 'customJs', script: 'function process(){ throw new Error("333失败"); }' } }));
        const blobs = {}; keys.forEach(k => blobs[k] = blob(100));
        const pb = await SuitePostprocess.runAll(stepsBad, keys, blobs, { getHandle: async () => null });
        ok(pb.ok === false && pb.failedKeys.join(',') === '111', `后处理失败 → 不完成（失败 ${pb.failedKeys.join(',')}）`);
        ok(pb.retryProcessOnly === true, '后处理失败 → 标记可只重试处理（不重新生图）');

        // 写盘失败
        const items = keys.map(k => ({ key: k, blob: blob(100) }));
        const badDir = { kind: 'directory', queryPermission: async () => 'granted', getFileHandle: async (n) => { if (String(n).includes('444')) throw new Error('磁盘满'); return { createWritable: async () => ({ write: async () => {}, close: async () => {} }), getFile: async () => ({ size: 100, type: 'image/png' }) }; } };
        const sb = await SuiteCore.saveAll(badDir, items, { fileKey: 'A__', rowNum: 412, decodeSize: async () => ({ width: 800, height: 800 }) });
        ok(sb.ok === false && sb.savedCount === 4 && sb.failedKeys.join(',') === '444', `写盘部分失败 → 不 ok（失败 ${sb.failedKeys.join(',')}）`);
        ok(sb.retrySaveOnly === true && sb.results.length === 5, '写盘失败 → 保留全部结果且标记可只重试保存');
    }

    // ================= D. 编号确认不重新发送豆包 =================
    console.log('\n【D】确认编号不触发新的豆包请求（行为断言，非字符串匹配）');
    {
        const HTML = fs.readFileSync(path.join(ROOT, '发品助手.html'), 'utf8');
        const lines = HTML.split('\n').map(l => l.replace(/\r$/, ''));
        function extractFn(name) {
            const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(');
            let s = -1; for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { s = i; break; } }
            if (s < 0) throw new Error('未找到函数: ' + name);
            for (let j = s + 1; j < lines.length; j++) { if (lines[j] === '}') return lines.slice(s, j + 1).join('\n'); }
            throw new Error('函数未闭合: ' + name);
        }
        // finishSuiteTask 现在按「任务冻结行快照 + 面板保存的步骤」执行，因此冻结相关的真实实现
        // （excelRowSpec / freezeSuiteTaskData / persistSuiteFreeze / suiteFrozenSteps）必须一起抽出来，
        // 否则沙箱里缺少这些自由变量，确认流程会直接 ReferenceError 而不是被断言捕获。
        const src = ['confirmSuiteNumbering', 'finishSuiteTask', 'assertSuiteTaskActive', 'suiteProgressChecked', 'suiteContentHash', 'suiteBlobToDataUrl', 'persistSuitePending', 'suiteDecodeSize',
            'excelRowSpec', 'suiteFrozenSteps', 'freezeSuiteTaskData', 'readSuiteFreeze', 'persistSuiteFreeze', 'readSuiteAutoState', 'saveSuiteAutoState', 'renderSuiteAutoControls', 'suiteAutoCheckpoint'].map(extractFn).join('\n\n');
        // finishSuiteTask 的后处理失败分支会引用 SUITE_OUTPUTS（页面常量，不在函数切片内），必须一并注入。
        const suiteOutputsLine = lines.find(l => /^const SUITE_OUTPUTS =/.test(l.trim()));
        if (!suiteOutputsLine) throw new Error('页面缺少 SUITE_OUTPUTS 常量');
        const fullSrc = suiteOutputsLine.trim() + '\n' + src;
        const sent = [], reports = [];
        // 浏览器边界替身：页面用 FileReader 把结果图片转 base64 交给扩展写盘（真实浏览器自带）。
        const FileReaderStub = class {
            constructor() { this.result = null; this.onload = null; this.onerror = null; }
            readAsDataURL(b) { Promise.resolve(b.arrayBuffer()).then(bytes => { this.result = 'data:' + (b.type || 'image/png') + ';base64,' + Buffer.from(bytes).toString('base64'); this.onload && this.onload(); }, e => { this.onerror && this.onerror(e); }); }
        };
        const sandbox = {
            console: { log() {}, warn() {}, error() {} },
            suitePendingNumbering: null, suiteTaskRunning: false, suiteAutoState: null, currentProduct: { row: 412 }, currentFileKey: () => 'A__', loadedFileName: 'A__', crypto: require('crypto').webcrypto, Uint8Array, FileReader: FileReaderStub,
            SuiteCore, SuitePostprocess, SuiteImageTransform: M.SuiteImageTransform,
            // 页面消息封装：记录所有动作（真实 finishSuiteTask 会调用它）。
            // 套图输出目录桥（suiteWriteOutput）在生产里由扩展实施写盘；此处按真实语义用 SuiteCore.saveAll 写进假目录。
            suiteSend: async (action, payload) => {
                sent.push(action); if (payload && payload.report) reports.push(payload.report);
                if (action === 'suiteWriteOutput') {
                    const items = (payload.files || []).map(f => ({ key: f.key, filename: f.filename, blob: blob(100) }));
                    const saved = await SuiteCore.saveAll(writeDir(), items, { buildFilename: it => it.filename, decodeSize: async () => ({ width: 800, height: 800 }) });
                    return { ok: saved.ok, results: saved.results, savedCount: saved.savedCount, failedKeys: saved.failedKeys };
                }
                return { ok: true, task: { taskId: 't1', fileKey: 'A__', rowNum: 412, stage: 'acquired' } };
            },
            loadSuiteDirHandle: async () => writeDir(),
            createImageBitmap: async () => ({ width: 800, height: 800, close() {} }),
            fetch: async () => ({ ok: true, blob: async () => blob(100) }),
            document: {
                getElementById: () => null,
                // 既是 DOM 节点（renderSuiteAutoControls 需要 style/firstElementChild/append），
                // 也是 canvas（SuiteImageSdk.createSurface 需要 getContext/toDataURL），二者都保留。
                createElement: () => Object.assign(
                    { style: {}, firstElementChild: { textContent: '' }, textContent: '', append() {}, setAttribute() {} },
                    { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,AAAA' }
                ),
                body: { append() {} },
                addEventListener: () => {}
            },
            // 面板保存的 polo 步骤是执行期的唯一真源：出厂默认脚本为空（占位），按新规则会明确报错，
            // 因此这里给出一份「已导入脚本内容」的已保存配置，让确认链路能真正跑完。
            localStorage: { getItem: (k) => k === 'polo_custom_step_editor_v1'
                ? JSON.stringify({ polo: KEYS.map(key => ({ name: key, key, prompt: 'p', upload: 'original',
                    postprocess: [{ name: key + '.js', path: key + '.js', code: 'CustomJsSDK.run(async ({ input }) => input);' }], mappings: [] })) })
                : null, setItem: () => {} },
            products: [{ row: 412 }], renderSuiteImages: async () => {},
            showToast: () => {}, updateSuiteStatus: () => {}, hideSuiteAreaIfEmpty: () => {}, addEventListener: () => {}, URL,
            // 冻结链路经 ResultStore 读写「冻结记录 / 待确认记录」，需要真实 indexedDB（浏览器本就具备）
            indexedDB: fakeIndexedDB(), queueMicrotask,
            setTimeout, clearTimeout, Promise, JSON, Number, Array, Object, String, Math, Date, RegExp, Set, Map, Error
        };
        sandbox.globalThis = sandbox;
        sandbox.window = sandbox;   // 业务模块挂到 window.*，与页面一致
        const ctx = vm.createContext(sandbox);
        // 冻结链路依赖的真实模块：类目字段规则 → 行快照 → 默认步骤 → 面板配置真源 → 图像 SDK
        // （发品助手.html 的 finishSuiteTask 会引用 SuiteImageSdk.createSurface / .draw，沙箱需与真实页面一致地加载）
        for (const f of ['category-field-rules.js', 'excel-row.js', 'custom-step-defaults.js', 'custom-step-config.js', 'chrome_extension/suite/suite-image-sdk.js']) {
            vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
        }
        // 当前导入 Excel：polo 真实表头，第 412 行是该任务绑定的产品行
        vm.runInContext(`currentSheet = { fileName: 'A__.xlsx', sheetName: 'S1', startRow: 412, headers: Array.from(window.CategoryFieldRules.columnsOf('polo')), rows: [] };
currentSheet.rows[0] = currentSheet.headers.map(h => ({ '类目': 'polo(2)', '材质': 'Cotton / 棉', '面料克重': 180 }[h] ?? ''));`, ctx);
        vm.runInContext(fullSrc, ctx, { filename: 'page:suite-confirm' });

        // 准备待确认状态并确认
        sandbox.suitePendingNumbering = {
            taskId: 't1', fileKey: 'A__', rowNum: 412,
            steps: KEYS.map(k => ({ outputKeys: [{ key: k }], prompt: 'p', postprocess: { type: 'none' } })),
            candidates: SuiteCore.buildNumberingCandidates(['a', 'b', 'c', 'd', 'e'], KEYS.map(k => ({ key: k })))
        };
        await vm.runInContext('confirmSuiteNumbering()', ctx);
        await new Promise(r => setTimeout(r, 50));
        ok(sent.indexOf('suiteRun') < 0, `确认流程未发送 suiteRun（实际动作：${sent.join(',') || '无'}）`);
        ok(reports.some(r => r.finalStage === 'completed'), '确认后完成后处理、保存及索引并回传 completed');
        ok(sent.indexOf('suiteCreate') < 0, '确认不重新创建任务');
    }

    console.log('\n' + '='.repeat(54));
    console.log(`通过: ${pass}   失败: ${fail}`);
    if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('='.repeat(54));
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试运行异常:', e && e.stack || e); process.exit(1); });

