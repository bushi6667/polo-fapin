/* 类目字段规则（单一真源）—— 语义变量 → 真实 Excel 列名。
 *
 * 为什么需要它：222/333/666/111 四个后处理脚本此前各自维护一套「同义文件名别名」
 * （袖长.txt / 袖型.txt / 袖子款式.txt，克重.txt / 面料克重.txt，特性.txt / 产品特性.txt…），
 * 且已经漂移（帽衫表头是「编织方式」，旧脚本仍按「编织方法」取；t-shirt 表头是「产品特性」，
 * 旧脚本仍按「特性」取）。现集中一处，脚本按语义角色取列名，不再各自维护别名。
 *
 * 约定：脚本最终读取的数据一律是**真实 Excel 列名**，本模块只负责把语义角色解析成列名，
 *       不生成 材质.txt / group.txt 之类的虚拟 TXT 键。
 *
 * 暴露：window.CategoryFieldRules
 */
(() => {
    'use strict';

    // 五个类目的真实表头（与 chrome_extension/映射示例/映射示例_<类目>.xlsx 表头一致）
    const CATEGORY_COLUMNS = Object.freeze({
        polo: Object.freeze(['价格', '材质', '工艺', '设计', '产品特性', '原产地', '省份', '样式', '徽标位置',
            '印花方法', '面料类型', '长度', '袖子款式', '图案类型', '性别', '面料克重', '编织方法', '标题',
            '卖点', 'FAQ', '类目', '是否废弃']),
        shirt: Object.freeze(['价格', '袖长(cm)', '材质', '工艺', '印花方法', '图案类型', '衬衫类型', '产品特性',
            '性别', '产品类型', '衣服门襟', '领型', '样式', '面料克重', '编织方法', '徽标位置', '面料类型',
            '原产地', '省份', '标题', '卖点', 'FAQ', '类目', '是否废弃']),
        't-shirt': Object.freeze(['价格', '材质', '面料克重', '印花方法', '工艺', '长度', '图案类型', '样式',
            '产品特性', '原产地', '省份', '徽标位置', '领子', '袖子款式', '板型', '编织方法', '面料类型',
            '设计', '性别', '标题', '卖点', 'FAQ', '类目', '是否废弃']),
        'hooded-sweatshirt': Object.freeze(['价格', '材质', '面料克重', '工艺', '种类', '面料类型', '图案类型',
            '款式', '印花方式', '原产地', '省份', '徽标位置', '领型', '板型', '设计', '长度', '袖型',
            '产品特性', '性别', '编织方式', '标题', '卖点', 'FAQ', '类目', '是否废弃']),
        'non-hooded-sweatshirt': Object.freeze(['价格', '材质', '面料克重', '工艺', '种类', '面料类型', '图案类型',
            '款式', '印花方式', '原产地', '省份', '徽标位置', '领型', '板型', '设计', '长度', '袖型',
            '产品特性', '性别', '编织方式', '标题', '卖点', 'FAQ', '类目', '是否废弃']),
    });

    // 语义角色 → 各类目真实列名；null 表示该类目没有这一列
    const ROLES = Object.freeze({
        material: { label: '材质', polo: '材质', shirt: '材质', 't-shirt': '材质', 'hooded-sweatshirt': '材质', 'non-hooded-sweatshirt': '材质' },
        craft: { label: '工艺', polo: '工艺', shirt: '工艺', 't-shirt': '工艺', 'hooded-sweatshirt': '工艺', 'non-hooded-sweatshirt': '工艺' },
        weave: { label: '编织方法/编织方式', polo: '编织方法', shirt: '编织方法', 't-shirt': '编织方法', 'hooded-sweatshirt': '编织方式', 'non-hooded-sweatshirt': '编织方式' },
        feature: { label: '产品特性', polo: '产品特性', shirt: '产品特性', 't-shirt': '产品特性', 'hooded-sweatshirt': '产品特性', 'non-hooded-sweatshirt': '产品特性' },
        weight: { label: '面料克重', polo: '面料克重', shirt: '面料克重', 't-shirt': '面料克重', 'hooded-sweatshirt': '面料克重', 'non-hooded-sweatshirt': '面料克重' },
        style: { label: '样式/款式', polo: '样式', shirt: '样式', 't-shirt': '样式', 'hooded-sweatshirt': '款式', 'non-hooded-sweatshirt': '款式' },
        sleeve: { label: '袖长/袖型/袖子款式', polo: '袖子款式', shirt: '袖长(cm)', 't-shirt': '袖子款式', 'hooded-sweatshirt': '袖型', 'non-hooded-sweatshirt': '袖型' },
        print: { label: '印花方法/印花方式', polo: '印花方法', shirt: '印花方法', 't-shirt': '印花方法', 'hooded-sweatshirt': '印花方式', 'non-hooded-sweatshirt': '印花方式' },
        collar: { label: '领型/领子', polo: null, shirt: '领型', 't-shirt': '领子', 'hooded-sweatshirt': '领型', 'non-hooded-sweatshirt': '领型' },
        placket: { label: '衣服门襟', polo: null, shirt: '衣服门襟', 't-shirt': null, 'hooded-sweatshirt': null, 'non-hooded-sweatshirt': null },
        design: { label: '设计', polo: '设计', shirt: null, 't-shirt': '设计', 'hooded-sweatshirt': '设计', 'non-hooded-sweatshirt': '设计' },
        fabricType: { label: '面料类型', polo: '面料类型', shirt: '面料类型', 't-shirt': '面料类型', 'hooded-sweatshirt': '面料类型', 'non-hooded-sweatshirt': '面料类型' },
        pattern: { label: '图案类型', polo: '图案类型', shirt: '图案类型', 't-shirt': '图案类型', 'hooded-sweatshirt': '图案类型', 'non-hooded-sweatshirt': '图案类型' },
        length: { label: '长度', polo: '长度', shirt: null, 't-shirt': '长度', 'hooded-sweatshirt': '长度', 'non-hooded-sweatshirt': '长度' },
        title: { label: '标题', polo: '标题', shirt: '标题', 't-shirt': '标题', 'hooded-sweatshirt': '标题', 'non-hooded-sweatshirt': '标题' },
        group: { label: '类目', polo: '类目', shirt: '类目', 't-shirt': '类目', 'hooded-sweatshirt': '类目', 'non-hooded-sweatshirt': '类目' },
    });

    // 类目归一化：去首尾空格、去末尾 (编号)、空格/下划线转连字符、统一小写
    function normalizeCategory(raw) {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) throw new Error('类目为空，无法确定字段规则（原始值：' + JSON.stringify(raw) + '）');
        const base = text
            .replace(/[（(]\s*\d+\s*[)）]\s*$/, '')
            .trim()
            .toLowerCase()
            .replace(/[\s_]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        const canonical = base === 'tshirt' ? 't-shirt' : base;
        if (!CATEGORY_COLUMNS[canonical]) {
            throw new Error('未知类目：' + text + '（归一化后 ' + JSON.stringify(canonical) + '）');
        }
        return canonical;
    }

    // 语义角色 → 该类目真实列名；该类目没有此列时抛错（调用方需按类目分支自行判断是否该取）
    function columnOf(role, category) {
        const rule = ROLES[role];
        if (!rule) throw new Error('未知字段角色：' + role);
        const cat = normalizeCategory(category);
        const column = rule[cat];
        if (!column) {
            throw new Error('类目 ' + cat + ' 没有「' + rule.label + '」对应的列（角色 ' + role + '）');
        }
        return column;
    }

    // 语义角色 → 该类目真实列名；无此列返回 null（不抛错，供「按类目分支判断」的场景用）
    function optionalColumnOf(role, category) {
        const rule = ROLES[role];
        if (!rule) throw new Error('未知字段角色：' + role);
        const cat = normalizeCategory(category);
        return rule[cat] || null;
    }

    function columnsOf(category) {
        const cat = normalizeCategory(category);
        return CATEGORY_COLUMNS[cat];
    }

    // 提示词与后处理共用角色规则；旧提示词变量名只在此转换，不读取可编辑列映射。
    const PROMPT_ALIASES = Object.freeze({ craft_suffix: 'craft', fabric_type_suffix: 'fabricType', fabric_type: 'fabricType', print_method: 'print' });
    function promptBindings(category) {
        const names = [...Object.keys(ROLES), ...Object.keys(PROMPT_ALIASES)];
        return Object.freeze(Object.fromEntries(names.map(name => [name, optionalColumnOf(PROMPT_ALIASES[name] || name, category)])));
    }

    window.CategoryFieldRules = Object.freeze({
        CATEGORY_COLUMNS,
        ROLES,
        normalizeCategory,
        columnOf,
        optionalColumnOf,
        columnsOf,
        promptBindings,
    });
})();
