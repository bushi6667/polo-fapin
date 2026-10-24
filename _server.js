// ============================================================
// Polo发品助手 - 本地辅助服务器
// 职责：① 接收 Photopea 在线 PS 保存的图片（POST /photopea-save）
//       ② 提供发品助手.html 及项目静态资源的本地文件服务
// 启动：node _server.js （默认端口 8765，仅监听本机 127.0.0.1）
// 安全边界（security_review 修复）：
//   - 仅监听 127.0.0.1，不暴露到局域网
//   - CORS 白名单：仅 photopea.com 与 file:// 页面（Origin: null），其余跨源请求 403
//   - 静态服务路径归一化后强制在 BASE_DIR 内（防路径遍历读取）
//   - /photopea-save 文件名强制 basename（防任意文件写入）
//   - decodeURIComponent 异常兜底（防本地 DoS）
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

// 测试可用 POLO_PORT 覆盖，避免占用生产端口（vm 沙箱里没有 process，需 typeof 防御）
const PORT = (typeof process !== 'undefined' && process.env && Number(process.env.POLO_PORT)) || 8765;
const BASE_DIR = __dirname;

// 静态资源 MIME 类型映射（支持中文页面的 charset）
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const ALLOWED_ORIGINS = new Set([
  'https://www.photopea.com',
  'null',                        // file:// 页面（<img> 读图不需要 CORS，但保存配置需要）
  'http://127.0.0.1:' + PORT,    // 页面经本地服务打开时同源，仍会带 Origin
  'http://localhost:' + PORT
]);

// 解析请求来源：返回 允许的 Origin 字符串 / null（无 Origin，无需 CORS 头）/ false（拒绝）
function resolveCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null; // 同源/curl：无跨源语义
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  // 本地解包扩展需要通过本机服务读取用户明确配置的图片目录。
  if (/^chrome-extension:\/\/[a-zA-Z]{32}$/.test(origin)) return origin;
  return false;
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(String(root || ''));
  const resolvedCandidate = path.resolve(String(candidate || ''));
  return !!resolvedRoot && (resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep));
}

// ---------- 路径配置（网页为唯一来源；服务端只存白名单用于限制读取范围） ----------
const PATH_CONFIG_FILE = path.join(BASE_DIR, '_path_config.json');
const PATH_KEYS = ['colorImgDir', 'imageDir', 'scriptDir', 'suiteDir'];

function loadPathConfig() {
  try {
    const raw = fs.readFileSync(PATH_CONFIG_FILE, 'utf8');
    const data = JSON.parse(raw);
    const out = {};
    for (const k of PATH_KEYS) {
      const v = data && typeof data[k] === 'string' ? data[k].trim() : '';
      out[k] = v ? v.replace(/[\\/]+$/, '') : '';
    }
    return out;
  } catch (_) { return { colorImgDir: '', imageDir: '', scriptDir: '', suiteDir: '' }; }
}

function savePathConfig(payload) {
  const cur = loadPathConfig();
  const next = { ...cur };
  const items = [];
  for (const k of PATH_KEYS) {
    if (!payload || payload[k] === undefined) continue;
    const raw = String(payload[k] || '').trim();
    if (!raw) { next[k] = ''; items.push({ key: k, path: '', status: 'unset' }); continue; }
    if (/^polo-dir:/.test(raw)) { items.push({ key: k, path: raw, status: 'invalid' }); continue; }
    if (!path.isAbsolute(raw)) { items.push({ key: k, path: raw, status: 'not-absolute' }); continue; }
    const normalized = raw.replace(/[\\/]+$/, '');
    let status = 'missing';
    try { if (fs.statSync(normalized).isDirectory()) status = 'ok'; } catch (_) { status = 'missing'; }
    next[k] = normalized;
    items.push({ key: k, path: normalized, status });
  }
  try { fs.writeFileSync(PATH_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch (_) {}
  return { config: next, items };
}

// 允许读取的根目录集合：只认已保存的路径配置（服务端白名单，客户端不能自报 root）
function allowedRoots() {
  const cfg = loadPathConfig();
  return PATH_KEYS.map(k => cfg[k]).filter(v => v && path.isAbsolute(v));
}

// 静态服务白名单：只放行页面真正需要的资源类型，敏感文件（API Key / 路径配置 / .git / ADS）一律 403
const STATIC_ALLOWED_EXT = new Set(['.html', '.htm', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.wasm', '.onnx', '.txt', '.ico', '.woff2']);
const STATIC_DENY_BASENAME = new Set(['api_config.json', '_path_config.json', '_path_config.json.tmp', '_server.js']);

function isStaticAllowed(filePath, rawUrl) {
  const url = String(rawUrl || '');
  // NTFS 备用数据流（file.json::$DATA）与任何冒号写法
  if (url.includes(':') || /%3a/i.test(url)) return false;
  const rel = path.relative(BASE_DIR, filePath);
  if (!rel || rel.startsWith('..')) return false;
  // 任意以 . 开头的路径段（.git / .trae / .env …）
  if (rel.split(/[\/]/).some(seg => seg.startsWith('.'))) return false;
  const base = path.basename(filePath).toLowerCase();
  if (STATIC_DENY_BASENAME.has(base) || base.endsWith('.key')) return false;
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_ALLOWED_EXT.has(ext);
}

// 写接口鉴权：只接受「本地服务自身的同源页面」或「本机无 Origin 的本机进程」。
// 关键：沙箱 iframe（Origin: null）与任意网页都无法伪装成 http://127.0.0.1:PORT 同源，
// 因此这里不用 'null'，也不依赖 Host 校验来区分。
function isTrustedWriteSource(req) {
  const origin = String(req.headers.origin || '');
  const sameOrigin = 'http://127.0.0.1:' + PORT;
  const sameOrigin2 = 'http://localhost:' + PORT;
  if (origin === sameOrigin || origin === sameOrigin2) return true;
  // 扩展页面转发的写入：file:// 页面无法证明身份，改由扩展（Origin 为 chrome-extension://自身ID）代发。
  // 任意网页与沙箱 iframe 的 Origin 只能是 https://… 或 'null'，无法伪造成扩展来源。
  if (/^chrome-extension:\/\/[a-zA-Z]{32}$/.test(origin)) return true;
  if (!origin) return true; // 本机进程 / curl（无跨源语义）
  return false;             // 'null'（file:// 与沙箱 iframe）与任何外部站点一律拒绝
}

function isInsideAnyAllowedRoot(target) {
  return allowedRoots().some(root => isPathInside(root, target));
}

// 静态文件安全路径：URL 解码异常返回 null；路径归一化后强制在 BASE_DIR 内（防 ../ 穿越），否则 null
// 注意：前缀比较需带 path.sep 边界，防止「兄弟目录同名前缀」绕过（如 ..\xlsx发品-备份\x）
function buildSafeFilePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }
  const p = path.normalize(path.join(BASE_DIR, decoded));
  if (p !== BASE_DIR && !p.startsWith(BASE_DIR + path.sep)) return null;
  return p;
}

// Photopea 保存文件名净化：剥离一切目录部分（防任意文件写入），空名兜底 image.png
function sanitizeFileName(source) {
  const s = String(source || ''); // 先统一为字符串（path.basename 对 undefined 会抛错）
  const match = s.match(/local,\d+,(.+)/);
  return path.basename(match ? match[1] : path.basename(s)) || 'image.png';
}

const server = http.createServer((req, res) => {
  // ---------- 统一：跨源来源校验（带 Origin 的请求必须命中白名单） ----------
  const origin = resolveCorsOrigin(req);
  if (origin === false) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  // 组装响应头（无 Origin 的请求不加 CORS 头；白名单来源回显其 Origin）
  const corsHeaders = origin === null ? {} : { 'Access-Control-Allow-Origin': origin };

  // ---------- 扩展读取本地颜色图 ----------
  // 仅允许扩展来源；目标必须位于请求声明的根目录内，且只能读取常见图片。
  if (req.method === 'POST' && req.url === '/local-image') {
    if (!/^chrome-extension:\/\//.test(String(origin || ''))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
      res.end('Forbidden'); return;
    }
    let chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= 16384) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 16384) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
        res.end('Request too large'); return;
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
        res.end('Invalid request'); return;
      }
      // 白名单只认服务端已保存的路径配置：客户端不能自报 root（否则等于读整盘图片）
      const target = path.resolve(String(payload?.path || ''));
      const ext = path.extname(target).toLowerCase();
      if (!path.isAbsolute(String(payload?.path || '')) || !isInsideAnyAllowedRoot(target) ||
          !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
        res.end('Forbidden'); return;
      }
      fs.readFile(target, (err, data) => {
        if (err) {
          res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
          res.end(err.code === 'ENOENT' ? 'Not Found' : 'Read failed'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext], 'Cache-Control': 'no-store', ...corsHeaders });
        res.end(data);
      });
    });
    return;
  }

  // ---------- 页面读取本地图片（路径模式） ----------
  // 只允许已配置根目录内的 PNG/JPG/JPEG/WebP；禁止读取 api_config.json / .key / .git 等。
  if (req.method === 'GET' && req.url.startsWith('/local-image')) {
    let target = '';
    try {
      const q = new URL(req.url, 'http://127.0.0.1');
      target = path.resolve(String(q.searchParams.get('path') || ''));
    } catch (_) { target = ''; }
    const ext = path.extname(target).toLowerCase();
    const baseName = path.basename(target).toLowerCase();
    const denied = !target || !path.isAbsolute(target) || !isInsideAnyAllowedRoot(target) ||
      !['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ||
      baseName === 'api_config.json' || baseName.startsWith('.') || target.includes('..');
    if (denied) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: '该路径不在已配置目录内，或不是允许的图片格式' })); return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        const code = err.code === 'ENOENT' ? 404 : 500;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: code === 404 ? '文件不存在（磁盘上确实没有这张图）' : '读取失败' })); return;
      }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length, ...corsHeaders });
      res.end(data);
    });
    return;
  }

  // ---------- 路径配置读写 ----------
  if (req.url === '/path-config' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, config: loadPathConfig(), roots: allowedRoots() }));
      return;
    }
    if (!isTrustedWriteSource(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: '写入被拒绝：只有通过 http://127.0.0.1:' + PORT + '/发品助手.html 打开的页面可以保存路径配置' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) body = body.slice(0, 8192); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' })); return;
      }
      const result = savePathConfig(payload || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, ...result }));
    });
    return;
  }

  // ---------- Photopea 保存图片接收 ----------
  // Photopea 的保存协议：请求体 = 前 2000 字节 JSON 元数据 + 图片二进制数据，
  // 元数据含 versions[]（每版 format/start/size），按 png/jpg 版本切片取图落盘。
  if (req.method === 'POST' && req.url === '/photopea-save') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(body);
      // 解析头部 JSON 元数据（最多取前 2000 字节，去掉 NUL 填充）
      const jsonStr = buf.slice(0, 2000).toString('utf-8').replace(/\0/g, '').trim();
      let jsonEnd = jsonStr.lastIndexOf('}');
      let meta;
      try {
        meta = JSON.parse(jsonStr.slice(0, jsonEnd + 1));
      } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ message: 'Invalid JSON' }));
          return;
      }
      // 从 source 字段解析原始文件名（格式：local,<row>,<fileName>）
      // 安全：sanitizeFileName 强制 basename，剥离一切目录部分，防任意文件写入
      if (!meta || typeof meta !== 'object' || !Array.isArray(meta.versions)) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ message: 'Invalid metadata' })); return;
      }
      const fileName = sanitizeFileName(meta.source);
      // 取 png/jpg 版本，按 start/size 从缓冲区切片出图片数据
      const versions = meta.versions || [];
      const pngVer = versions.find(v => v && (v.format === 'png' || v.format === 'jpg'));
      if (!pngVer) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ message: 'No image version' }));
        return;
      }
      if (!Number.isInteger(pngVer.start) || !Number.isInteger(pngVer.size) || pngVer.start < 0 || pngVer.size <= 0 || 2000 + pngVer.start + pngVer.size > buf.length) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ message: 'Invalid image range' })); return;
      }
      const jsonPad = 2000; // 与元数据截断长度一致
      const imgStart = jsonPad + pngVer.start;
      const imgEnd = imgStart + pngVer.size;
      const imgData = buf.slice(imgStart, imgEnd);
      // 落盘到 extracted_images 目录（与发品助手.html 的图片提取目录一致）
      const targetPath = path.join(BASE_DIR, 'extracted_images', fileName);
      fs.writeFile(targetPath, imgData, err => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ message: 'Save failed' }));
          return;
        }
        console.log(`✅ Photopea saved: ${fileName}`);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ message: '✅ 已保存', script: 'app.echoToOE("已保存到本地");' }));
      });
    });
    return;
  }

  // ---------- CORS 预检 ----------
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      ...corsHeaders,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // ---------- 静态文件服务 ----------
  // 根路径映射到 index.html；按扩展名返回对应 MIME；文件不存在返回 404
  // 安全：URL 解码统一在 buildSafeFilePath 内完成（单次解码 + 异常兜底 + BASE_DIR 前缀校验）
  let rawPath = req.url.split('?')[0];
  if (rawPath === '/') rawPath = '/index.html';
  const filePath = buildSafeFilePath(rawPath);
  if (filePath && !isStaticAllowed(filePath, rawPath)) {
    // 拒绝：api_config.json / _path_config.json / .key / .git / 任意点开头段 / NTFS 数据流(::) / 非白名单扩展名
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });res.end('Forbidden');return;
  }
  if (!filePath) {
    // 路径逃逸 BASE_DIR（../ 穿越）、畸形 URL 编码或兄弟前缀绕过
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeType, ...corsHeaders });
    res.end(data);
  });
});

// 仅监听本机回环地址，不暴露到局域网；被 require 时导出纯逻辑供单元测试
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running at http://127.0.0.1:${PORT}/`);
  });
} else {
  module.exports = { resolveCorsOrigin, buildSafeFilePath, sanitizeFileName, isPathInside };
}
