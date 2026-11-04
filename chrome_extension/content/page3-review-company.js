/* 公司介绍只补缺项。复用平台模板的原 onChange，不选择整套模板、不给FAQ赋值。
 * applyMain 会作为独立函数注入MAIN，内部不得依赖外层闭包。
 */
(() => {
    'use strict';
    async function applyMain(request) {
        const ensurePage = () => {
            if (!Number.isFinite(request.deadline) || Date.now() >= request.deadline) throw Error('公司模板请求已过期，不再补填');
            if (location.hostname !== 'post.alibaba.com'
                || (new URLSearchParams(location.search).get('itemId') || '') !== request.itemId
                || performance.timeOrigin !== request.origin) throw Error('商品或页面已变化，停止公司介绍补缺');
        };
        const locate = () => {
            const card = document.querySelector('#detail-company-introduction-card');
            const heading = card?.querySelector('h2,h3');
            // 模板选择器在卡片标题中；拒绝借用物流/定制服务的选择器。
            const control = heading?.querySelector('.select-template');
            if (!control) throw Error('公司介绍模板选择器尚未加载');
            let fiber = control[Object.keys(control).find(k => /^__react(Fiber|InternalInstance)/.test(k))];
            for (let i = 0; fiber && i < 18; i++, fiber = fiber.return) {
                if (fiber.memoizedProps?.scene === 'companyInfoTemplate' && fiber.stateNode) return fiber.stateNode;
            }
            throw Error('公司介绍模板原回调未定位，不修改');
        };
        const clone = value => JSON.parse(JSON.stringify(value));
        // 平台回调可能重新构造对象并改变字段插入顺序；比较值及数组顺序，不能把键顺序当数据变化。
        const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
        const same = (a, b) => stable(a) === stable(b);
        const key = group => String(group?.value ?? '');
        const uniqueGroups = groups => {
            if (!Array.isArray(groups) || groups.some(g => !key(g))
                || new Set(groups.map(key)).size !== groups.length) throw Error('公司图片组身份不唯一，不修改');
        };
        ensurePage();
        let widget = locate();
        const candidates = widget.state?.templateList?.filter(t => t.label === request.label) || [];
        if (candidates.length !== 1) throw Error('公司介绍模板未唯一匹配：' + request.label);
        if (typeof widget.props?.getTemplateData !== 'function' || typeof widget.props?.onChange !== 'function'
            || typeof widget.props?.commonPuck?.get !== 'function' || !widget.async?.getTemplateDetailUrl) {
            throw Error('公司介绍平台接口不完整，不修改');
        }
        const before = clone(await widget.props.getTemplateData());
        uniqueGroups(before.companyImage);
        if (typeof before.companyDesc !== 'string') throw Error('公司介绍文案未定位，不修改');
        // 与原模板选择读取同一个详情接口；不新建、不编辑或保存平台模板。
        let response, timer;
        try {
            response = await Promise.race([
                widget.props.commonPuck.get(widget.async.getTemplateDetailUrl, { data: { id: candidates[0].value } }),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(Error('公司模板读取超时，不再补填')), Math.max(0, request.deadline - Date.now()));
                })
            ]);
        } finally { clearTimeout(timer); }
        ensurePage();
        if (response?.body?.code !== 200 || !response.body.data?.templateData) throw Error('公司模板详情读取失败');
        const source = JSON.parse(response.body.data.templateData);
        uniqueGroups(source.companyImage);
        if (!source.companyImage.length) throw Error('公司模板图片来源为空');
        const merged = clone(before.companyImage), changed = [];
        for (const group of source.companyImage) {
            const index = merged.findIndex(g => key(g) === key(group));
            const existing = index >= 0 ? merged[index] : null;
            if (existing?.imageList && !Array.isArray(existing.imageList)) throw Error('公司图片格式无法确认');
            if (existing?.imageList?.length) continue;
            if (!Array.isArray(group.imageList) || !group.imageList.length) throw Error('缺少图片组的模板来源');
            if (existing) merged[index] = { ...existing, imageList: clone(group.imageList) };
            else merged.push(clone(group));
            changed.push(group.enName || group.cnName || key(group));
        }
        const patch = {};
        if (changed.length) patch.companyImage = merged;
        if (!before.companyDesc.trim()) {
            if (typeof source.companyDesc !== 'string' || !source.companyDesc.trim()) throw Error('公司模板文案来源为空');
            patch.companyDesc = source.companyDesc;
            changed.push('公司介绍文案');
        }
        // 请求期间用户可能修改了内容，写入前重新读取，不能使用旧快照覆盖。
        widget = locate();
        const now = await widget.props.getTemplateData();
        ensurePage();
        if (!same(now, before)) throw Error('公司介绍内容已变化，停止使用旧补缺计划');
        if (!changed.length || request.readOnly === true) return { ok: true, changed, applied: false };
        // 原回调按templateData中的字段逐个更新；故意不包含companyFaqDesc。
        await widget.props.onChange({ ...response.body.data, templateData: JSON.stringify(patch) });
        for (let i = 0; i < 30; i++) {
            ensurePage();
            const after = await locate().props.getTemplateData();
            const images = after.companyImage;
            const complete = (!patch.companyDesc || after.companyDesc === patch.companyDesc)
                && (!patch.companyImage || images?.length === patch.companyImage.length && patch.companyImage.every(wanted => images.some(actual =>
                    key(actual) === key(wanted) && same(actual.imageList, wanted.imageList))));
            if (complete) {
                if (!same(after.companyFaqDesc, before.companyFaqDesc)
                    || before.companyDesc.trim() && after.companyDesc !== before.companyDesc
                    || before.companyImage.some(group => group.imageList?.length && !images?.some(actual =>
                        key(actual) === key(group) && same(actual, group)))) {
                    throw Error('公司介绍补缺后已有内容发生变化，请核对，不继续保存');
                }
                return { ok: true, applied: true, changed, faqPreserved: true, existingPreserved: true };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error('公司介绍补缺结果未确认，不继续保存');
    }
    async function repair(doc, product, options = {}) {
        const current = () => { if (options.isCurrent && !options.isCurrent()) throw Error('商品已切换，停止公司介绍补缺'); };
        current();
        const area = doc.querySelector('#detail-company-introduction-card');
        if (!area) throw Error('公司介绍区域未定位');
        area.scrollIntoView({ block: 'start' });
        await new Promise(resolve => setTimeout(resolve, 600));
        current();
        const label = typeof pickCompanyIntroTemplate === 'function' ? pickCompanyIntroTemplate(product, { strict: true }) : '';
        if (!label) throw Error('公司介绍模板来源不明确');
        const request = { action: 'repairCompanyTemplateMissing', label, origin: performance.timeOrigin,
            deadline: Date.now() + 15000,
            row: Number(product.row), taskId: product._publishTaskId || '', fileKey: product._publishFileKey,
            itemId: new URLSearchParams(location.search).get('itemId') || '' };
        const response = await globalThis.PoloSaveStability.request(() => sendMessageRetry(request, 0));
        current();
        if (!response?.ok) throw Error(response?.error || '公司介绍补缺未确认');
        if (typeof log === 'function') log(response.changed.length
            ? '✅ 公司介绍仅补缺：' + response.changed.join('、') + '；已有内容及FAQ保留' : '✅ 公司介绍已有内容，未重新选模板', 'info');
        return response;
    }
    globalThis.PoloReviewCompany = { applyMain, repair };
})();
