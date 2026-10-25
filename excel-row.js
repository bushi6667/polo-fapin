/* Excel 行数据接口 —— 任务绑定的「当前产品行」快照。
 *
 * 背景：后处理脚本原先通过 ctx.data.loadResource('dataFolder') 读取「属性TXT文件夹」
 *      （{文件名: 内容}），现改为读取当前导入 Excel 的**当前产品行**。
 *
 * 关键约束（对应验收要求）：
 *   1. 任务开始时锁定 文件 / 工作表 / 实际 Excel 行号 / 行数据快照，之后不可变；
 *   2. 行号必须是导入时记录的**实际 Excel 行号**（1 基），不得写死第 2 行、
 *      也不得用界面列表下标冒充；
 *   3. 保留**原始中文列名**，不做 material_en 之类的页面转换；
 *   4. 单元格数值 0 必须保留（不能用 `value || ''` 吞掉）；
 *   5. 区分「整列不存在」（配置错误，抛错）与「本行该格为空」（返回空串）；
 *   6. 报错必须带 文件 / 工作表 / 行号 / 列名。
 *
 * 暴露：window.ExcelRow
 */
(() => {
    'use strict';

    function describe(fileName, sheetName, rowNumber) {
        return '文件「' + fileName + '」工作表「' + sheetName + '」第 ' + rowNumber + ' 行';
    }

    // 值 → 展示文本：null/undefined → ''，数字/布尔 → String()（0 保留为 "0"）
    function toText(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
        if (value instanceof Date) return value.toISOString();
        return String(value).trim();
    }

    /**
     * 构建行快照。
     * @param {object} spec
     * @param {string} spec.fileName   实际 Excel 文件名
     * @param {string} spec.sheetName  实际工作表名
     * @param {number} spec.rowNumber  实际 Excel 行号（1 基，表头行不算数据行）
     * @param {Array}  spec.headers    表头行原始单元格（按列顺序）
     * @param {Array|object} spec.values 该行原始单元格：数组按列顺序，或 {列名: 原值}
     */
    function build(spec) {
        const src = spec || {};
        const fileName = toText(src.fileName);
        const sheetName = toText(src.sheetName);
        const rowNumber = Number(src.rowNumber);

        if (!fileName) throw new Error('Excel 行数据缺少文件名');
        if (!sheetName) throw new Error('Excel 行数据缺少工作表名');
        if (!Number.isInteger(rowNumber) || rowNumber < 1) {
            throw new Error(describe(fileName, sheetName, '?') + '：行号必须是 ≥1 的整数，收到 ' + JSON.stringify(src.rowNumber));
        }
        if (!Array.isArray(src.headers)) {
            throw new Error(describe(fileName, sheetName, rowNumber) + '：缺少表头数组');
        }

        const headers = src.headers.map(h => toText(h));
        const columnIndex = new Map();
        headers.forEach((name, index) => {
            if (name && !columnIndex.has(name)) columnIndex.set(name, index);
        });
        if (columnIndex.size === 0) {
            throw new Error(describe(fileName, sheetName, rowNumber) + '：表头为空，无法按列名取值');
        }

        const rawByColumn = new Map();
        if (Array.isArray(src.values)) {
            for (const [name, index] of columnIndex) rawByColumn.set(name, src.values[index]);
        } else if (src.values && typeof src.values === 'object') {
            for (const [key, value] of Object.entries(src.values)) {
                const name = toText(key);
                if (columnIndex.has(name)) rawByColumn.set(name, value);
            }
        } else {
            throw new Error(describe(fileName, sheetName, rowNumber) + '：缺少该行数据');
        }

        function requireColumn(column) {
            const name = toText(column);
            if (!name) throw new Error(describe(fileName, sheetName, rowNumber) + '：列名为空');
            if (!columnIndex.has(name)) {
                throw new Error(describe(fileName, sheetName, rowNumber) + '：整列不存在「' + name + '」');
            }
            return name;
        }

        // 整列是否存在（不抛错）
        function has(column) {
            const name = toText(column);
            return !!name && columnIndex.has(name);
        }

        // 原始值（区分：整列不存在 → 抛错；本行该格为空 → 返回 null/undefined）
        function raw(column) {
            const name = requireColumn(column);
            return rawByColumn.get(name);
        }

        // 展示文本（整列不存在 → 抛错；本行该格为空 → 空串；0 → "0"）
        function cell(column) {
            return toText(raw(column));
        }

        // 语义角色 → 该类目真实列名 + 值；该类目没有此列时抛错
        function role(roleName) {
            const rules = window.CategoryFieldRules;
            if (!rules) throw new Error('缺少 CategoryFieldRules 模块，无法按角色取列名');
            const column = rules.columnOf(roleName, category());
            return { role: roleName, column, value: cell(column) };
        }

        // 语义角色 → { column: null, value: '' }（该类目无此列时不抛错）
        function optionalRole(roleName) {
            const rules = window.CategoryFieldRules;
            if (!rules) throw new Error('缺少 CategoryFieldRules 模块，无法按角色取列名');
            const column = rules.optionalColumnOf(roleName, category());
            if (!column) return { role: roleName, column: null, value: '' };
            return { role: roleName, column, value: cell(column) };
        }

        // 归一化类目（取「类目」列）
        function category() {
            const rules = window.CategoryFieldRules;
            if (!rules) throw new Error('缺少 CategoryFieldRules 模块，无法解析类目');
            if (!has('类目')) {
                throw new Error(describe(fileName, sheetName, rowNumber) + '：整列不存在「类目」，无法确定字段规则');
            }
            try {
                return rules.normalizeCategory(raw('类目'));
            } catch (e) {
                throw new Error(describe(fileName, sheetName, rowNumber) + '：' + e.message);
            }
        }

        const snapshot = {
            fileName,
            sheetName,
            rowNumber,
            headers: Object.freeze(headers.slice()),
            describe: () => describe(fileName, sheetName, rowNumber),
            has,
            raw,
            cell,
            role,
            optionalRole,
            category,
        };
        return Object.freeze(snapshot);
    }

    // 生成用值：双语单元格取英文，原始快照与表格数据保持不变。
    function englishText(value) {
        const text=toText(value).trim();
        if (!/[\u3400-\u9fff]/.test(text)) return text;
        const parts=text.split(/\s*[\/／]\s*/);
        const english=parts.filter(p=>p.trim()&&!/[\u3400-\u9fff]/.test(p));
        if(english.length) return english.join(' / ').trim();
        const unbracketed=text.replace(/[（(][^()（）]*[\u3400-\u9fff][^()（）]*[)）]/g,'').trim();
        if(unbracketed&&!/[\u3400-\u9fff]/.test(unbracketed))return unbracketed;
        throw new Error('产品属性缺少独立英文内容，请补充英文后再生成：'+text);
    }

    window.ExcelRow = Object.freeze({ build, toText, describe, englishText });
})();
