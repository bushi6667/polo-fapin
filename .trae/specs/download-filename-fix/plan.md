# 颜色图下载文件名丢失 修复计划

## 一、问题现象

扩展下载 AI 换色图时，文件名从一开始的 `rowN_色名.png`（落到 `Polo发品_颜色图/<文件名>/rowN/`）
变成 `下载 - 2026-10-07T231332.518.png`（落到 `下载` 根目录）。

- 最后成功：row214（2026-10-07 21:30:00）
- 首次失败：row215（2026-10-07 23:13:32）
- 之后 row215–row599 全部失效，**不再恢复**

## 二、根因

提交 `6be477c`（2026-08-03）把下载 URL 从「原始 HTTP 链接」改成「data: base64」，
并新增了 `onDeterminingFilename` 监听器 + 内存 `downloadFilenameMap`。二者叠加产生两个缺陷：

**缺陷 1（粘性主因）**：`downloadViaFetch` 兜底路径**从不写 `downloadFilenameMap`**。
一旦主路径失败转入兜底，`onDeterminingFilename` 匹配不到映射 → 不调用 `suggest()`
→ Chrome 因「有扩展注册了该监听器」而忽略 `DownloadOptions.filename`
→ 落到默认名 `下载 - 时间戳.png`。

**缺陷 2（竞态）**：主路径的映射只在 `downloads.download()` **回调里**写入。
`onDeterminingFilename` 对 `data:` URL（MIME 无需联网即可确定）可能**先于回调**触发
→ 同样匹配不到。

## 三、证据

| 项 | 数据 |
|---|---|
| 尺寸跳变 | row205–214 平均 3.41–3.82MB；row215 起跳到 4.79–5.39MB，峰值 6.82MB |
| 粘性反证 | row243 后尺寸回落至 ~3.6MB（与成功的 205–214 相同），命名**仍未恢复** |
| 代码 | `downloadViaFetch`（L1866）全程无 `downloadFilenameMap.set` |
| 官方文档 | 「If any extension has registered an onDeterminingFilename listener, the filename will be ignored」 |
| 竞态 | 源码注释自述「download() 回调与 onDeterminingFilename 的触发顺序无硬性保证」 |

**推测触发**：豆包开会员后出图体积变大 → data URL 跨过 `downloads.download` 上限 → 主路径被拒 → 转入兜底 → 文件名永久丢失。尺寸变化只是导火索，粘住的是缺陷 1。

## 四、改动清单（全部手工编辑，禁脚本改写）

### 改动 1 — `chrome_extension/background.js` L91–111
`onDeterminingFilename` 监听器：未命中映射时**显式调用一次 `suggest()`**（符合 API 契约）。

改前（尾段）：
```js
    if (mapping) {
        console.log(`[download] 强制文件名: id=${downloadItem.id} -> ${mapping.relativePath}`);
        suggest({ filename: mapping.relativePath, conflictAction: 'overwrite' });
        for (const [k, v] of downloadFilenameMap) {
            if (v === mapping) { downloadFilenameMap.delete(k); break; }
        }
    }
});
```

改后（尾段）：
```js
    if (mapping) {
        console.log(`[download] 强制文件名: id=${downloadItem.id} -> ${mapping.relativePath}`);
        suggest({ filename: mapping.relativePath, conflictAction: 'overwrite' });
        for (const [k, v] of downloadFilenameMap) {
            if (v === mapping) { downloadFilenameMap.delete(k); break; }
        }
    } else {
        // 契约：listener 必须恰好调用一次 suggest；未命中时显式空参调用
        suggest();
    }
});
```

### 改动 2 — 主路径 `downloadDoubaoImage` L1683–1695
下载前**按 URL 预登记**映射；顺带补 data URL 体积护栏（与兜底一致）。

改前：
```js
            const downloadUrl = dataUrl || url;
            console.log(`[download] using url type: ${dataUrl ? 'data' : 'original'}, filename: ${relativePath}`);
            
            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                // 在回调里存储映射，onDeterminingFilename 会用 downloadId 匹配
                if (downloadId !== undefined) {
                    downloadFilenameMap.set(downloadId, { filename, relativePath, url: downloadUrl });
                }
```

改后：
```js
            const downloadUrl = dataUrl && dataUrl.length <= 5 * 1024 * 1024 ? dataUrl : url;
            console.log(`[download] using url type: ${downloadUrl === dataUrl ? 'data' : 'original'}, filename: ${relativePath}`);

            // 关键：download() 之前按 URL 预登记。onDeterminingFilename 可能先于回调触发
            // （data: URL 无需联网即可定 MIME），只在回调里登记会漏匹配 → suggest() 不调 → 丢文件名
            const preKey = 'pre:' + downloadUrl;
            downloadFilenameMap.set(preKey, { filename, relativePath, url: downloadUrl });

            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                // 回调里把预登记条目迁移到真实 downloadId
                downloadFilenameMap.delete(preKey);
                if (downloadId !== undefined) {
                    downloadFilenameMap.set(downloadId, { filename, relativePath, url: downloadUrl });
                }
```

### 改动 3 — 兜底路径 `downloadViaFetch` L1863–1876
同样预登记（本次修复的核心）。

改前：
```js
        const downloadUrl = dataUrl && dataUrl.length <= 5 * 1024 * 1024 ? dataUrl : url;

        return new Promise((resolve) => {
            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
```

改后：
```js
        const downloadUrl = dataUrl && dataUrl.length <= 5 * 1024 * 1024 ? dataUrl : url;

        // 关键：兜底路径同样要按 URL 预登记，否则走这里必然丢文件名
        const preKey = 'pre:' + downloadUrl;
        downloadFilenameMap.set(preKey, { filename, relativePath, url: downloadUrl });

        return new Promise((resolve) => {
            chrome.downloads.download({
                url: downloadUrl,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false
            }, (downloadId) => {
                downloadFilenameMap.delete(preKey);
                if (chrome.runtime.lastError) {
```

### 不改动的部分
- `SAFE_FILENAME_RE` / `isReservedWindowsName` / `isRasterImageType` 等安全校验
- IndexedDB 预取、`onChanged` 清理逻辑、`isTrustedSender`
- 其他功能（页2/页3/PS 编辑/上传）

## 五、验证步骤

1. **静态**：`node --check chrome_extension/background.js` 通过
2. **回归**：跑 `tests/` 现有断言（12 个文件，含 `test-background-p1/p2/h2-m2`）
3. **人工 diff 复查**：逐处对照本计划，确认无越界改动
4. **实测**：
   - `chrome://extensions` 重新加载扩展
   - 换色 1 套，确认落到 `Polo发品_颜色图/<文件名>/rowN/rowN_色名.png`
   - 重点验证 **>5MB 大图**（会员出图）也能正确命名
5. **回归确认**：连续跑 3 套以上，确认不再中途失效

## 六、约束

- **全程手工编辑**，禁止用脚本改写代码（图片提取/Excel 写入/字符统计除外）
- 每处改动单独一次编辑，改完人工重读文件复核（不得凭记忆判断）
- 不改动计划外的任何逻辑

## 七、可选后续（不在本次范围）

- pending 映射落 `chrome.storage.session`，防 MV3 SW 被回收时丢映射
- 调研用 Offscreen Document + `URL.createObjectURL` 替代 data URL，从根上绕开体积限制
