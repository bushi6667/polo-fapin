/* ctx.data 数据域 —— 执行器向脚本提供的「当前产品行」数据接口。
 *
 * 定位：参考扩展的 SDK（pages/utils/custom-js-sdk-v2.js）里 ctx.data 由 _buildDataApi()
 *      构造，含 loadResource / text / hasResource / weightTier 等。本项目尚无 SDK，
 *      本次只补「行数据读取」这一层，图像（ctx.draw / ctx.rembg）与生图执行不在本次范围。
 *
 * 脚本用法（A 方案，直接用真实 Excel 列名）：
 *     const t = ctx.data.excelRow;          // 行快照（含 文件/工作表/行号/表头）
 *     ctx.data.cell('材质')                  // 按真实列名取值，0 保留为 "0"（t 是快照对象，不是 {列名:值} 字典）
 *     ctx.data.cell('袖长(cm)')              // 同上（列不存在时抛错并带 文件/表/行/列）
 *     ctx.data.role('sleeve')                // 按类目规则解析成真实列名后取值
 *     ctx.data.optionalRole('placket')       // 该类目无此列时返回 { column:null, value:'' }
 *     ctx.data.category()                    // 归一化类目（polo / t-shirt / non-hooded-sweatshirt…）
 *
 * 暴露：window.CustomJsDataDomain
 */
(() => {
    'use strict';

    const NO_ROW = '本次任务未绑定 Excel 行数据（excelRow 为空），无法读取产品属性';

    function create(options) {
        const opts = options || {};
        const excelRow = opts.excelRow || null;
        const resources = opts.resources || {};
        // 生成执行器启用英文投影；raw 与 excelRow 继续保留原始双语值供核验。
        const display=value=>opts.englishOnly ? window.ExcelRow.englishText(value) : value;
        const displayRole=result=>Object.freeze({...result,value:display(result.value)});

        function requireRow() {
            if (!excelRow) throw new Error(NO_ROW);
            return excelRow;
        }

        async function hasResource(key) {
            return Object.prototype.hasOwnProperty.call(resources, key);
        }

        async function loadResource(key) {
            if (!Object.prototype.hasOwnProperty.call(resources, key)) {
                throw new Error('缺少资源：' + key);
            }
            const value = resources[key];
            return typeof value === 'function' ? await value() : value;
        }

        return Object.freeze({
            // 行快照：任务开始时锁定，含 fileName / sheetName / rowNumber / headers
            excelRow,
            cell: column => display(requireRow().cell(column)),
            raw: column => requireRow().raw(column),
            has: column => requireRow().has(column),
            role: roleName => displayRole(requireRow().role(roleName)),
            optionalRole: roleName => displayRole(requireRow().optionalRole(roleName)),
            category: () => requireRow().category(),
            // 非行数据类资源（如 444叠加 的白底卡片图）保持原用途
            hasResource,
            loadResource,
        });
    }

    window.CustomJsDataDomain = Object.freeze({ create, NO_ROW });
})();
