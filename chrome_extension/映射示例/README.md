# 映射示例（当前有效内容）

本目录只保留 5 份「单类目示例表」，每份的表头就是该类目真实的 Excel 列名，供后处理脚本按真实列名取值时对照：

| 文件 | 类目 | 列数 |
|---|---|---|
| `映射示例_polo.xlsx` | polo | 22 |
| `映射示例_shirt.xlsx` | shirt | 24 |
| `映射示例_t-shirt.xlsx` | t-shirt | 24 |
| `映射示例_hooded-sweatshirt.xlsx` | hooded-sweatshirt | 25 |
| `映射示例_non-hooded-sweatshirt.xlsx` | non-hooded-sweatshirt | 25 |

字段规则（语义角色 → 真实列名）的单一真源见项目根的 `category-field-rules.js`。

## 已归档的旧示例（勿再使用）

以下旧内容已整体移入 `xlsx发品/归档/属性TXT数据源_2026-10-19/`：

- 旧结构的 `映射示例.xlsx`（变量／字段文件名／示例值／备注，描述 `*.txt` 映射）
- `polo/`、`shirt/`、`t-shirt/`、`hooded-sweatshirt/`、`non-hooded-sweatshirt/` 五个「属性TXT文件夹」样例

脚本已不再读取任何 `*.txt` 属性文件，也不再生成 `标题.txt` / `group.txt` 之类的虚拟键。
