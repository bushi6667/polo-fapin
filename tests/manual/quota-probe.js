/* ===== 豆包「额度已用完」探针 v1（只读）=====
 用法：打开豆包对话页 → F12 → Console → 粘贴本文件全部内容 → 回车
       若提示 "Don't paste code…"，先在 Console 里输入 allow pasting 回车，再粘贴
       然后 __qp.help() 看用法，__qp.scan() 先摸底
 只读声明：本脚本只读页面 DOM，不发消息、不点击、不改页面内容，
           唯一副作用是在页面全局定义 __qp。
 与产品同源：判定逻辑逐字复制 chrome_extension/content/doubao.js，
            探针命中 = 扩展能命中（区别只在扩展用「发消息前快照」限定范围）。
*/
(function () {
    'use strict';

    // ================= 以下 10 个函数/变量与 content/doubao.js 逐字一致，请勿改动 =================

    // 锚点文本截断长度：快照存文本与判定比文本必须同一口径，否则截断差异会被误当成「变长」
    var QUOTA_ANCHOR_MAX = 200;

    // 状态用 var：内容脚本被重复注入时不因重复声明抛错
    var quotaSnapshot = null;

    // 归一化：去掉所有空白 + 全角转半角，避免「额度 ， 已用完」「额度\u00a0已用完」漏判
    function normalizeQuotaText(t) {
        return String(t || '').replace(/[\s\u00a0]+/g, '').replace(/，/g, ',').replace(/：/g, ':');
    }

    // 命中规则（按优先级）：① /额度,?已用完/ ② 兜底 /升级到标准套餐/ 且 /预计.*恢复/
    function isQuotaExhaustedText(t) {
        const n = normalizeQuotaText(t);
        if (!n) return false;
        if (/额度,?已用完/.test(n)) return true;
        return /升级到标准套餐/.test(n) && /预计.*恢复/.test(n);
    }

    // 恢复时间：从原文抓「预计 … 恢复」，原样返回（如「10月25日03:24」，不转 Date）
    function parseQuotaResumeAt(t) {
        try {
            const n = normalizeQuotaText(t);
            const m = n.match(/预计(.{2,30}?)恢复/);
            return m ? m[1] : null;
        } catch (_) { return null; }
    }

    // 额度检测专用：只用精确稳定的选择器，div[data-message-id] > .chat-message > [class*="message-item"]
    // 禁用 [class*="message"]（命中容器/气泡外层/内层段落，数量抖动）、
    // [class*="chat-item"] 与 [class*="conversation-item"]（命中侧边栏会话列表）
    function collectQuotaMessageNodes() {
        try {
            const precise = ['div[data-message-id]', '.chat-message', '[class*="message-item"]'];
            for (const sel of precise) {
                const found = document.querySelectorAll(sel);
                if (found && found.length) return Array.from(found);
            }
            const loose = ['[class*="msg-content"]', 'div[data-testid*="message"]'];
            for (const sel of loose) {
                const found = document.querySelectorAll(sel);
                if (found && found.length) return Array.from(found);
            }
        } catch (_) {}
        return [];
    }

    // 快照锚点文本：最后一个「有文本且可见」的节点，截断到 QUOTA_ANCHOR_MAX
    function lastQuotaMessageText(nodes) {
        let fallback = '';
        for (let i = nodes.length - 1; i >= 0; i--) {
            const el = nodes[i];
            if (!el) continue;
            const t = String(el.innerText || '');
            if (!t) continue;
            if (!fallback) fallback = t;
            if (!isQuotaVisibleNode(el)) continue;
            return t.slice(0, QUOTA_ANCHOR_MAX);
        }
        return fallback.slice(0, QUOTA_ANCHOR_MAX);
    }

    // 排除：输入框内的文本（刚输入的提示词）与我们自己注入的节点
    function isQuotaExcludedNode(el) {
        try {
            if (!el) return true;
            if (typeof el.closest === 'function') {
                if (el.closest('textarea, [contenteditable="true"], [role="textbox"]')) return true;
                if (el.closest('[data-polo-injected="1"]')) return true;
            }
            return false;
        } catch (_) { return true; }
    }

    function isQuotaVisibleNode(el) {
        try {
            if (!el) return false;
            if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
            if (typeof el.offsetHeight === 'number' && el.offsetHeight === 0) return false;
            return true;
        } catch (_) { return false; }
    }

    // 提示条 / toast / 弹窗：类名随站点改版，语义属性与常见类名段一起找
    function collectQuotaNoticeTexts() {
        const out = [];
        try {
            const sels = [
                '[role="alert"]', '[role="alertdialog"]', '[role="dialog"]',
                '[class*="toast"]', '[class*="notice"]', '[class*="banner"]', '[class*="warning"]',
                '[class*="quota"]', '[class*="limit"]', '[class*="upgrade"]', '[class*="modal"]',
            ];
            for (const sel of sels) {
                let list = [];
                try { list = Array.from(document.querySelectorAll(sel) || []); } catch (_) { continue; }
                for (const el of list) {
                    if (!isQuotaVisibleNode(el) || isQuotaExcludedNode(el)) continue;
                    const t = String(el.innerText || el.textContent || '').trim();
                    if (!t || t.length > 500) continue;
                    if (out.indexOf(t) < 0) out.push(t);
                }
            }
        } catch (_) {}
        return out;
    }

    // 发送前调用：记录本轮的时间边界快照（发送失败/超时后只用它之后的内容判定）
    function markQuotaBaseline() {
        try {
            const nodes = collectQuotaMessageNodes();
            quotaSnapshot = {
                count: nodes.length,
                lastText: lastQuotaMessageText(nodes),
                notices: collectQuotaNoticeTexts(),
                at: Date.now()
            };
        } catch (_) {
            quotaSnapshot = null;
        }
        return quotaSnapshot;
    }

    // 返回 null 或 { exhausted:true, text, resumeAt }  ← check() 的判定以本函数为准
    function detectQuotaExhausted() {
        try {
            const snap = quotaSnapshot;
            if (!snap) return null;                        // 无快照 → 不判
            const nodes = collectQuotaMessageNodes();
            const needle = String(snap.lastText || '');

            // ① 文本锚点：找仍包含快照末条文本的节点（从后往前 = 取最后一个匹配，
            //    文本重复时靠后的那个才最接近快照的末条消息，避免把上一轮旧气泡算成本轮证据）
            let anchorIdx = -1;
            if (needle) {
                for (let i = nodes.length - 1; i >= 0; i--) {
                    const t = String((nodes[i] && nodes[i].innerText) || '');
                    if (t && t.indexOf(needle) >= 0) { anchorIdx = i; break; }
                }
                // 锚点彻底找不到 → 会话被换掉/清空，基线不可信 → 宁漏不误
                if (anchorIdx < 0) return null;
            } else {
                // 快照时没有可作锚点的文本：只能按位置兜底，节点数变少时依旧不判
                const baseCount = (typeof snap.count === 'number' && snap.count > 0) ? snap.count : 0;
                if (nodes.length < baseCount) return null;
                anchorIdx = baseCount - 1;
            }

            // ② 从锚点之后开始扫；锚点节点原地追加了内容（比快照长）时把它自己也纳入
            let from = anchorIdx + 1;
            if (anchorIdx >= 0) {
                const anchorEl = nodes[anchorIdx];
                const cur = String((anchorEl && anchorEl.innerText) || '').slice(0, QUOTA_ANCHOR_MAX);
                if (cur && cur !== needle) from = anchorIdx;
            }
            const candidates = nodes.slice(Math.max(0, from));

            for (let i = candidates.length - 1; i >= 0; i--) {
                const el = candidates[i];
                if (isQuotaExcludedNode(el)) continue;
                const text = String((el && el.innerText) || '');
                if (!isQuotaExhaustedText(text)) continue;
                return { exhausted: true, text: text.trim().slice(0, 200), resumeAt: parseQuotaResumeAt(text) };
            }

            const knownNotices = (snap && Array.isArray(snap.notices)) ? snap.notices : [];
            for (const t of collectQuotaNoticeTexts()) {
                if (knownNotices.indexOf(t) >= 0) continue;   // 发送前就存在的提示条不算本轮证据
                if (!isQuotaExhaustedText(t)) continue;
                return { exhausted: true, text: t.slice(0, 200), resumeAt: parseQuotaResumeAt(t) };
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    // ================= 以下为探针自身代码（只读，仅影响输出） =================

    const GREEN = 'color:#0a0;font-weight:bold';
    const RED = 'color:#c00;font-weight:bold';
    const YELLOW = 'color:#c60;font-weight:bold';
    const GRAY = 'color:#888';
    const CYAN = 'color:#099;font-weight:bold';

    function out(style, line) {
        console.log('%c' + line, style);
    }

    function cut(s, n) {
        const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return one.length > n ? one.slice(0, n) + '…' : one;
    }

    function describe(el) {
        if (!el || !el.tagName) return '?';
        let s = String(el.tagName).toLowerCase();
        if (el.id) s += '#' + el.id;
        const cls = String(typeof el.className === 'string' ? el.className : '')
            .trim().split(/\s+/).filter(Boolean).slice(0, 3);
        if (cls.length) s += '.' + cls.join('.');
        return s;
    }

    function nodePath(el, depth) {
        const parts = [];
        let cur = el;
        let i = 0;
        while (cur && i < depth) {
            parts.push(describe(cur));
            cur = cur.parentElement;
            i++;
        }
        return parts.length ? parts.join(' < ') : '(未知容器)';
    }

    const NOTICE_SELS = [
        '[role="alert"]', '[role="alertdialog"]', '[role="dialog"]',
        '[class*="toast"]', '[class*="notice"]', '[class*="banner"]', '[class*="warning"]',
        '[class*="quota"]', '[class*="limit"]', '[class*="upgrade"]', '[class*="modal"]',
    ];

    // 全量扫描用：提示条候选（不做文本去重，方便逐条看容器）
    function collectNoticeElements() {
        const outList = [];
        try {
            for (const sel of NOTICE_SELS) {
                let list = [];
                try { list = Array.from(document.querySelectorAll(sel) || []); } catch (_) { continue; }
                for (const el of list) if (outList.indexOf(el) < 0) outList.push(el);
            }
        } catch (_) {}
        return outList;
    }

    // 兜底：站点改版后类名全变时，按「叶子节点里带额度字样」硬找
    function collectLeafTextElements() {
        const outList = [];
        try {
            const all = Array.from(document.querySelectorAll('*') || []);
            for (const el of all) {
                if (el && el.children && el.children.length) continue;
                const t = String((el && (el.innerText || el.textContent)) || '');
                if (t.length < 4 || t.length > 500) continue;
                if (normalizeQuotaText(t).indexOf('额度') < 0) continue;
                outList.push(el);
            }
        } catch (_) {}
        return outList;
    }

    function elementText(el) {
        return String((el && (el.innerText || el.textContent)) || '');
    }

    // 气泡取文本口径与 detectQuotaExhausted 一致：只认 innerText（隐藏节点不算）
    function bubbleText(el) {
        return String((el && el.innerText) || '');
    }

    function scan() {
        out(CYAN, '══ __qp.scan() 全量摸底（忽略快照，只读页面）══');
        const groups = [
            { tag: '气泡', els: collectQuotaMessageNodes() },
            { tag: '提示条', els: collectNoticeElements() },
            { tag: '兜底叶子', els: collectLeafTextElements() },
        ];
        let hits = 0;
        let excludedHits = 0;
        let checked = 0;
        const seenEls = [];
        for (const g of groups) {
            for (const el of g.els) {
                if (!el || seenEls.indexOf(el) >= 0) continue;
                seenEls.push(el);
                checked++;
                const text = g.tag === '气泡' ? bubbleText(el) : elementText(el);
                if (!isQuotaExhaustedText(text)) continue;
                hits++;
                const excluded = isQuotaExcludedNode(el);
                if (excluded) excludedHits++;
                const resumeAt = parseQuotaResumeAt(text);
                const line = (excluded ? '⚠️ ' : '✅ ') + hits + ') [' + g.tag + '] '
                    + '恢复=' + (resumeAt || '未解析到')
                    + ' 排除=' + (excluded ? '是(输入框/我方注入)' : '否')
                    + ' 容器=' + nodePath(el, 3)
                    + ' 原文="' + cut(text, 120) + '"';
                out(excluded ? YELLOW : GREEN, line);
            }
        }
        out(GRAY, '   检查节点 ' + checked + ' 个（气泡 ' + groups[0].els.length
            + ' / 提示条 ' + groups[1].els.length + ' / 兜底 ' + groups[2].els.length + '）');
        if (!hits) {
            out(RED, '❌ 扫不到：整页未命中「额度已用完」。先确认页面上确实显示该提示，再跑 __qp.dump() 看采集到了什么。');
        } else if (excludedHits === hits) {
            out(RED, '❌ 命中的 ' + hits + ' 条全部位于输入框/我方注入节点内，按规则不算命中。');
        } else {
            out(GREEN, '✅ 命中 ' + hits + ' 条（其中 ' + (hits - excludedHits) + ' 条有效），扩展在同一时刻也能判到额度。');
        }
        return hits;
    }

    function arm() {
        const snap = markQuotaBaseline();
        if (!snap) {
            out(RED, '❌ 快照失败（DOM 异常）。页面刷新后重新粘贴本文件再试。');
            return null;
        }
        out(CYAN, '📌 已打快照 = 发消息前的时间边界');
        out(CYAN, '   消息节点数=' + snap.count
            + ' 已有提示条=' + snap.notices.length + ' 条'
            + ' 时间=' + new Date(snap.at).toLocaleTimeString());
        out(CYAN, '   锚点（最后一条可见消息）前40字="' + cut(snap.lastText, 40) + '"');
        out(GRAY, '   判定靠这个锚点定位，不看节点数（节点数只用来显示）：先找仍含锚点文本的节点，'
            + '只扫它之后的「新增/原地追加」内容；锚点彻底消失才算基线失效');
        if (snap.notices.length) {
            out(GRAY, '   已存在的提示条（之后出现同样的不算新增）：'
                + snap.notices.slice(0, 3).map(function (t) { return '"' + cut(t, 30) + '"'; }).join(' | '));
        }
        out(GRAY, '   → 现在去页面正常发一条消息，回来输入 __qp.check()');
        return snap;
    }

    // 与 detectQuotaExhausted 同序同判，只多记录「为什么没命中」
    function detectWithReason() {
        try {
            const snap = quotaSnapshot;
            if (!snap) return { hit: null, reason: '无快照（先执行 __qp.arm() 再发消息）' };
            const nodes = collectQuotaMessageNodes();
            const needle = String(snap.lastText || '');
            let anchorIdx = -1;
            if (needle) {
                for (let i = nodes.length - 1; i >= 0; i--) {
                    const t = String((nodes[i] && nodes[i].innerText) || '');
                    if (t && t.indexOf(needle) >= 0) { anchorIdx = i; break; }
                }
                if (anchorIdx < 0) {
                    return {
                        hit: null,
                        reason: '锚点消息已找不到（快照末条「' + cut(needle, 30) + '」在现有 '
                            + nodes.length + ' 个节点里都不存在）→ 会话被换掉/清空，产品规则一律不判'
                    };
                }
            } else {
                const baseCount = (typeof snap.count === 'number' && snap.count > 0) ? snap.count : 0;
                if (nodes.length < baseCount) {
                    return {
                        hit: null,
                        reason: '快照时无锚点文本，且节点数变少（快照 ' + snap.count + ' → 现在 '
                            + nodes.length + '），基线不可信，按产品规则一律不判'
                    };
                }
                anchorIdx = baseCount - 1;
            }
            let from = anchorIdx + 1;
            if (anchorIdx >= 0) {
                const anchorEl = nodes[anchorIdx];
                const cur = String((anchorEl && anchorEl.innerText) || '').slice(0, QUOTA_ANCHOR_MAX);
                if (cur && cur !== needle) from = anchorIdx;   // 锚点原地追加 → 纳入扫描
            }
            const candidates = nodes.slice(Math.max(0, from));
            for (let i = candidates.length - 1; i >= 0; i--) {
                const el = candidates[i];
                if (isQuotaExcludedNode(el)) continue;
                const text = String((el && el.innerText) || '');
                if (!isQuotaExhaustedText(text)) continue;
                return { hit: { text: text.trim().slice(0, 200), resumeAt: parseQuotaResumeAt(text) }, reason: '' };
            }
            const known = (snap && Array.isArray(snap.notices)) ? snap.notices : [];
            const fresh = collectQuotaNoticeTexts().filter(function (t) { return known.indexOf(t) < 0; });
            for (const t of fresh) {
                if (!isQuotaExhaustedText(t)) continue;
                return { hit: { text: t.slice(0, 200), resumeAt: parseQuotaResumeAt(t) }, reason: '' };
            }
            return {
                hit: null,
                reason: '无新增命中（锚点定位在第 ' + (anchorIdx + 1) + ' 个节点/共 ' + nodes.length
                    + ' 个，锚点后候选 ' + candidates.length + ' 条 / 新增提示条 ' + fresh.length
                    + ' 条，均不含额度字样）'
            };
        } catch (e) {
            return { hit: null, reason: '检测异常：' + cut(e && e.message, 60) };
        }
    }

    function check() {
        out(CYAN, '══ __qp.check() 只认新增（按 __qp.arm() 的快照）══');
        const detail = detectWithReason();
        const hit = detectQuotaExhausted();     // 判定以产品原函数为准
        if (detail.hit && !hit) out(RED, '⚠️ 两份实现结论不一致，请把本行截图反馈（detail=命中 / 产品函数=未命中）');
        if (!hit) {
            out(YELLOW, '❌ 未命中｜原因：' + detail.reason);
            return null;
        }
        out(GREEN, '✅ 命中｜resumeAt=' + (hit.resumeAt || '未解析到')
            + '｜原文="' + cut(hit.text, 120) + '"');
        return hit;
    }

    function dump() {
        out(CYAN, '══ __qp.dump() 采集到的候选节点（前 20 条）══');
        const items = [];
        for (const el of collectQuotaMessageNodes()) items.push({ tag: '气泡', el: el });
        for (const el of collectNoticeElements()) {
            if (!items.some(function (x) { return x.el === el; })) items.push({ tag: '提示条', el: el });
        }
        for (const el of collectLeafTextElements()) {
            if (!items.some(function (x) { return x.el === el; })) items.push({ tag: '兜底叶子', el: el });
        }
        if (!items.length) {
            out(RED, '❌ 一个候选节点都没采到：页面可能还没加载完，或站点结构已大改（把本行截图反馈）。');
            return 0;
        }
        items.slice(0, 20).forEach(function (it, i) {
            const text = elementText(it.el);
            const mark = isQuotaExhaustedText(text) ? '✅含额度' : '—';
            out(isQuotaExhaustedText(text) ? GREEN : GRAY,
                (i + 1) + ') [' + it.tag + '] ' + mark
                + ' 容器=' + nodePath(it.el, 2)
                + ' 文本="' + cut(text, 80) + '"');
        });
        if (items.length > 20) out(GRAY, '   …还有 ' + (items.length - 20) + ' 条未显示');
        out(GRAY, '   共 ' + items.length + ' 个候选节点');
        return items.length;
    }

    function reset() {
        quotaSnapshot = null;
        out(GRAY, '🧹 快照已清空（下次 __qp.check() 会报「无快照」）');
    }

    function help() {
        out(CYAN, '══ __qp 额度探针用法（只读，不发消息/不点击/不改页面）══');
        out(GRAY, '__qp.scan()   全量摸底：忽略快照，扫整页所有「额度已用完」文本，逐条给出恢复时间/容器/是否被排除');
        out(GRAY, '__qp.arm()    打快照：等价「发消息前」，记录锚点文本（最后一条可见消息）、节点数、已有提示条');
        out(GRAY, '__qp.check()  只认新增：按快照判定本轮是否出现额度提示（← 扩展的行为就是这一条）');
        out(GRAY, '__qp.dump()   排查用：列出采集到的候选文本前 20 条（扫不到时看它）');
        out(GRAY, '__qp.reset()  清空快照');
        out(GRAY, '判定规则：① 文本去掉空白、全角逗号/冒号转半角后含 /额度,?已用完/ ② 或同时含 /升级到标准套餐/ 与 /预计.*恢复/');
        out(GRAY, '排除规则：位于 textarea / contenteditable / role=textbox / [data-polo-injected="1"] 内的文本不算');
        out(GRAY, '结论读法：scan 命中=能抓到；arm 后 check 命中=扩展会在这一轮判额度；check 未命中但 scan 命中=文案是旧的（正常，防误判）');
    }

    const api = { help: help, scan: scan, arm: arm, check: check, dump: dump, reset: reset };
    if (typeof window !== 'undefined') window.__qp = api;
    if (typeof globalThis !== 'undefined') globalThis.__qp = api;

    out(GRAY, '已就绪，输入 __qp.help() 查看用法');
    return api;
})();
