'use strict';
/**
 * Sub-Store · Vercel 一键部署 (平铺版 + 自动升级)
 * ------------------------------------------------------------------
 * 纯网页操作: 仓库根目录平铺 8 个文件, 手机/电脑 GitHub 网页直接上传.
 *
 * 自动升级设计 (Serverless 下唯一持久有效的方式):
 *   检查官方最新 Release -> 若非最新 -> 下载发行文件 -> 通过 GitHub API
 *   直接提交到本仓库 -> Vercel Git 集成自动重新部署 -> 新版本上线.
 *   已是最新则不做任何拉取.
 *   · 手动: 浏览器访问 https://你的域名/<私密路径>/__update
 *   · 定时: Vercel Cron Jobs (vercel.json 已配置, 详见 README)
 * 其它原理:
 *   · 加载官方后端前劫持 require.cache 中的 express, 捕获 app 实例,
 *     请求直接 capturedApp(req,res), 不依赖 Lambda 内端口监听;
 *   · 前端 dist.zip 在冷启动时用零依赖 mini-unzip 解压到 /tmp 托管;
 *   · /__substore_selftest 提供部署自检.
 * ------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ENTRY_VERSION = 'v8-blob-not-gist-boot-2026-08-19';

/* ================= 默认配置 (可在 Vercel 环境变量中覆盖) ================= */

// 后端私密路径, 相当于管理密码. 公网部署【务必】改成一串随机字符!
// 方式: Vercel 环境变量 SUB_STORE_FRONTEND_BACKEND_PATH, 或直接改这里,
// 或编辑 GitHub 仓库里的本文件 (改完 Vercel 会自动重新部署).
const DEFAULT_BACKEND_PATH = '/sst-change-me-9f2b7a4d';

// 打包时内置的版本兜底; 运行时优先读 version.json (GitHub Actions 升级时同步更新),
// 读不到再尝试从文件内容动态识别, 最后才用兜底常量
const FALLBACK_FRONTEND_VERSION = '2.29.10';
const FALLBACK_BACKEND_VERSION = '2.36.38';

const VERSIONS = { frontend: null, backend: null };
try {
  const v = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'),
  );
  if (v.frontend) VERSIONS.frontend = String(v.frontend);
  if (v.backend) VERSIONS.backend = String(v.backend);
} catch (e) {
  /* 落动态识别 */
}

// 官方仓库
const FRONTEND_REPO = 'sub-store-org/Sub-Store-Front-End';
const BACKEND_REPO = 'sub-store-org/Sub-Store';

/* ======================================================================== */

// ---- 运行时异步错误收集 (自检/诊断时透出) ----
const recentErrors = [];
function pushError(where, e) {
  const msg =
    e && e.stack
      ? e.stack.split('\n').slice(0, 2).join(' | ')
      : String(e && e.message ? e.message : e);
  recentErrors.push(`[${where}] ${msg}`);
  if (recentErrors.length > 10) recentErrors.shift();
}
const origConsoleError = console.error.bind(console);
console.error = (...args) => {
  const line = args
    .map((x) => String(x && x.stack ? x.stack.split('\n')[0] : x))
    .join(' ');
  if (!/依赖 .* 加载失败/.test(line)) pushError('console', line);
  origConsoleError(...args);
};
process.on('uncaughtException', (e) => pushError('uncaughtException', e));
process.on('unhandledRejection', (e) => pushError('unhandledRejection', e));

/* ---------- 前端准备: web/ 目录, 或 dist.zip 零依赖解压 (mini-unzip) ---------- */

function readCString(buf) {
  return buf.toString('utf8').replace(/\0[\s\S]*$/, '').trim();
}

// 零依赖 ZIP 解压 (支持 Stored/Deflate), 自动剥离官方包内的顶层目录
function unzipTo(zipPath, destDir, stripTopDir = 'dist/') {
  const buf = fs.readFileSync(zipPath);
  // 定位 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('无效 ZIP: 未找到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let written = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = readCString(buf.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 目录条目
    const rel = name.startsWith(stripTopDir)
      ? name.slice(stripTopDir.length)
      : name;
    if (!rel) continue;
    // local file header 的真实数据偏移 (本地头的 name/extra 长度以本地头为准)
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw; // 8=Deflate 0=Stored
    const filePath = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
    written++;
  }
  return written;
}

let frontendPath = null;
let frontendError = null;
let frontendVersion = VERSIONS.frontend || FALLBACK_FRONTEND_VERSION;
try {
  const repoWeb = path.join(__dirname, 'web');
  if (fs.existsSync(path.join(repoWeb, 'index.html'))) {
    frontendPath = repoWeb;
  } else {
    const dest = '/tmp/sub-store-web';
    if (!fs.existsSync(path.join(dest, 'index.html'))) {
      const n = unzipTo(path.join(__dirname, 'dist.zip'), dest);
      origConsoleError(`[sub-store] 前端已解压: ${n} 个文件 -> ${dest}`);
    }
    frontendPath = dest;
  }
  // version.json 缺失时, 从前端 index.html 的 <meta name="version"> 动态识别
  if (!VERSIONS.frontend) {
    const html = fs.readFileSync(path.join(frontendPath, 'index.html'), 'utf8');
    const m = html.match(/<meta\s+name="version"\s+content="([^"]+)"/);
    if (m) frontendVersion = m[1].trim();
  }
} catch (e) {
  frontendError = e;
  pushError('frontend prepare', e);
}

// 后端版本: version.json 缺失时从 bundle 文件动态识别 (兜底为打包常量)
let backendVersion = VERSIONS.backend || FALLBACK_BACKEND_VERSION;
if (!VERSIONS.backend) {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'sub-store.min.js'), 'utf8');
    const m = src.match(/[a-zA-Z_$][\w$]*="(\d+\.\d+\.\d+)"/);
    if (m) backendVersion = m[1];
  } catch (e) {
    /* 保持兜底 */
  }
}

/* ----------------------------- 环境与目录 ----------------------------- */

function setDefaultEnv(key, value) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

setDefaultEnv('SUB_STORE_BACKEND_API_PORT', '3001');
setDefaultEnv('SUB_STORE_BACKEND_API_HOST', '127.0.0.1');
setDefaultEnv('SUB_STORE_FRONTEND_BACKEND_PATH', DEFAULT_BACKEND_PATH);
setDefaultEnv('SUB_STORE_BACKEND_MERGE', 'true'); // 前后端同域名
if (frontendPath) setDefaultEnv('SUB_STORE_FRONTEND_PATH', frontendPath);
setDefaultEnv('SUB_STORE_DATA_BASE_PATH', '/tmp/sub-store-data'); // 仅 /tmp 可写

// 启动还原成功后把官方 Env 实例挂到全局, 供每次请求把 Gist 写进内存 (解决多 Lambda /tmp 不一致)
{
  const userPost = process.env.SUB_STORE_DATA_URL_POST || '';
  process.env.SUB_STORE_DATA_URL_POST =
    'try{globalThis.__ssT=T;globalThis.__ssRestore=function(c){T.write(JSON.stringify(c,null,"  "),"#sub-store");T.cache=c;T.persistCache();if(typeof Fc==="function")try{Fc()}catch(e){}}}catch(e){}' +
    (userPost ? ';' + userPost : '');
}

// 私密路径自动补 / 前缀 (MERGE 模式强制要求)
{
  const p = process.env.SUB_STORE_FRONTEND_BACKEND_PATH || '';
  process.env.SUB_STORE_FRONTEND_BACKEND_PATH =
    ('/' + p.replace(/^\/+|\/+$/g, '')).replace(/\/+$/, '') || '/';
}
const BACKEND_PATH = process.env.SUB_STORE_FRONTEND_BACKEND_PATH;

// Node < 22 的 markAsUncloneable 补丁
try {
  const workerThreads = require('node:worker_threads');
  if (typeof workerThreads.markAsUncloneable !== 'function') {
    workerThreads.markAsUncloneable = () => {};
  }
} catch (e) {
  pushError('workerThreads patch', e);
}

try {
  fs.mkdirSync(process.env.SUB_STORE_DATA_BASE_PATH, { recursive: true });
} catch (e) {
  pushError('mkdir data dir', e);
}

/* ---------- 劫持 express: 捕获后端 app (必须早于后端加载) ---------- */

let capturedApp = null;
try {
  const expressPath = require.resolve('express');
  const realExpress = require(expressPath);
  const wrappedExpress = new Proxy(realExpress, {
    apply(target, thisArg, argArray) {
      const app = Reflect.apply(target, thisArg, argArray);
      if (!capturedApp && app && typeof app.listen === 'function') {
        capturedApp = app;
        try {
          app.listen = () => {
            console.log('[sub-store] 已捕获 Express app, 跳过内部端口监听');
            return {
              address: () => ({ address: '127.0.0.1', port: 0 }),
              on: () => {},
              once: () => {},
            };
          };
        } catch (e) {
          pushError('stub listen', e);
        }
      }
      return app;
    },
  });
  require.cache[expressPath].exports = wrappedExpress;
} catch (e) {
  pushError('hook express', e);
}

/* --- 后端 eval(require('xxx')) 的依赖, 字面量静态 require 以便 nft 打包 --- */

const warnLoad = (name, e) =>
  origConsoleError(`[sub-store] 依赖 ${name} 加载失败:`, e && e.message);
try { require('body-parser'); } catch (e) { warnLoad('body-parser', e); }
try { require('mime-types'); } catch (e) { warnLoad('mime-types', e); }
try { require('cron'); } catch (e) { warnLoad('cron', e); }
try { require('ms'); } catch (e) { warnLoad('ms', e); }
try { require('nanoid'); } catch (e) { warnLoad('nanoid', e); }
try { require('dotenv'); } catch (e) { warnLoad('dotenv', e); }
try { require('undici'); } catch (e) { warnLoad('undici', e); }
try { require('dns-packet'); } catch (e) { warnLoad('dns-packet', e); }
try { require('fetch-socks'); } catch (e) { warnLoad('fetch-socks', e); }
try { require('http-proxy-middleware'); } catch (e) { warnLoad('http-proxy-middleware', e); }
try { require('connect-history-api-fallback'); } catch (e) { warnLoad('connect-history-api-fallback', e); }
try { require('@maxmind/geoip2-node'); } catch (e) { warnLoad('@maxmind/geoip2-node', e); }
try { require('core-js/actual/promise/with-resolvers'); } catch (e) { warnLoad('core-js', e); }
try { require('@vercel/blob'); } catch (e) { warnLoad('@vercel/blob', e); }

/* --------------------------- 启动 Sub-Store 后端 (延后到 Blob 灌盘之后) --------------------------- */

let backendError = null;
let backendReady = false;
let backendBoot = null;

/* ------------------------------- 通用工具 ------------------------------- */

function sendJson(res, statusCode, payload) {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  try {
    res.end(JSON.stringify(payload, null, 2));
  } catch (e) {}
}

function dataDirWritable() {
  try {
    const f = path.join(
      process.env.SUB_STORE_DATA_BASE_PATH || '/tmp/sub-store-data',
      '.write-test',
    );
    fs.writeFileSync(f, 'ok');
    fs.unlinkSync(f);
    return true;
  } catch (e) {
    return String(e && e.message);
  }
}

function selfTest(res) {
  const p = BACKEND_PATH || '';
  sendJson(res, 200, {
    status: 'success',
    entryVersion: ENTRY_VERSION,
    node: process.version,
    isVercel: !!process.env.VERCEL,
    backendLoaded: !backendError,
    backendError: backendError ? String(backendError.message) : null,
    expressAppCaptured: !!capturedApp,
    backendPathLength: p.length,
    usingDefaultBackendPath: p === DEFAULT_BACKEND_PATH,
    frontendVersion,
    backendVersion,
    frontendReady: frontendPath ? 'ok' : null,
    frontendError: frontendError ? String(frontendError.message) : null,
    autoUpdateVia: 'GitHub Actions (定时每天 + 手动 Run workflow)',
    dataRestoreConfigured: !!process.env.SUB_STORE_DATA_URL,
    blobConfigured: blobConfigured(),
    blobStatus: lastBlobStatus,
    gistSyncHookReady: typeof globalThis.__ssRestore === 'function',
    gistTokenConfigured: !!(
      process.env.SUB_STORE_GIST_TOKEN || process.env.GITHUB_TOKEN
    ),
    dataDir: process.env.SUB_STORE_DATA_BASE_PATH,
    dataDirWritable: dataDirWritable(),
    recentErrors,
  });
}

/* ------------------------------ 自动升级 ------------------------------ */

const normVer = (v) => String(v || '').trim().replace(/^v/i, '');

async function ghFetchJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'sub-store-vercel-updater',
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    redirect: 'follow',
  });
  if (!r.ok) {
    throw new Error(`GitHub API ${r.status}: ${url}`);
  }
  return r.json();
}

async function getLatestRelease(repo) {
  const j = await ghFetchJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );
  return {
    tag: normVer(j.tag_name),
    assets: (j.assets || []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
    })),
  };
}

// GET /<私密路径>/__update —— 只读版本检查 (前后端是否最新一目了然)
// 升级动作由 GitHub Actions 执行 (定时 + 手动 Run workflow),
// 有新版本时会自动拉取并提交回仓库, Vercel 随即自动重新部署.
async function handleUpdateCheck(res) {
  const result = {
    status: 'success',
    entryVersion: ENTRY_VERSION,
    frontend: { file: 'dist.zip', current: frontendVersion },
    backend: { file: 'sub-store.min.js', current: backendVersion },
  };
  try {
    const [feLatest, beLatest] = await Promise.all([
      getLatestRelease(FRONTEND_REPO),
      getLatestRelease(BACKEND_REPO),
    ]);
    result.frontend.latest = feLatest.tag;
    result.backend.latest = beLatest.tag;
    result.frontend.isLatest = normVer(frontendVersion) === feLatest.tag;
    result.backend.isLatest = normVer(backendVersion) === beLatest.tag;

    if (result.frontend.isLatest && result.backend.isLatest) {
      result.message = '🎉 前端与后端均已是最新版本, 无需拉取';
    } else {
      result.message =
        '发现新版本! 请到 GitHub 仓库 → Actions → "更新 Sub-Store" → Run workflow ' +
        '手动拉取 (或等待每日定时检查自动执行)。提交后 Vercel 会自动重新部署。';
    }
    sendJson(res, 200, result);
  } catch (e) {
    pushError('update-check', e);
    result.status = 'failed';
    result.message = `版本检查失败: ${e && e.message}`;
    sendJson(res, 500, result);
  }
}

/* ---------- Gist 作为唯一数据源: 每次 API 请求拉最新, 覆盖本实例 /tmp ---------- */

function normalizeGistRawUrl(url) {
  try {
    const u = new URL(url);
    // gist.githubusercontent.com/<user>/<id>/raw/<40hex>/<file> → 去掉 commit, 永远指向最新
    const m = u.pathname.match(
      /^\/([^/]+)\/([0-9a-fA-F]+)\/raw\/[0-9a-fA-F]{32,40}\/(.+)$/,
    );
    if (u.hostname === 'gist.githubusercontent.com' && m) {
      u.pathname = `/${m[1]}/${m[2]}/raw/${m[3]}`;
      u.search = '';
      return u.toString();
    }
  } catch (e) {}
  return url;
}

function parseGistId(url) {
  try {
    const u = new URL(url);
    const m =
      u.pathname.match(/^\/(?:[^/]+\/)?([0-9a-fA-F]{20,})(?:\/|$)/) ||
      u.pathname.match(/\/([0-9a-fA-F]{20,})\//);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

function parseBackupPayload(text) {
  if (text == null) return null;
  let content = text;
  try {
    content = JSON.parse(
      Buffer.from(String(text), 'base64').toString('utf8'),
    );
  } catch (e) {
    try {
      content = JSON.parse(String(text));
    } catch (e2) {
      return null;
    }
  }
  if (!content || typeof content !== 'object' || !content.settings) return null;
  return content;
}

let gistPullInflight = null;
let gistPullAt = 0;
const GIST_PULL_MIN_MS = 2000;

async function pullGistIntoMemory() {
  const dataUrl = process.env.SUB_STORE_DATA_URL;
  if (!dataUrl) return { skipped: 'no SUB_STORE_DATA_URL' };
  if (!globalThis.__ssRestore) return { skipped: 'restore hook not ready' };

  const now = Date.now();
  if (gistPullInflight) return gistPullInflight;
  if (now - gistPullAt < GIST_PULL_MIN_MS) return { skipped: 'throttled' };

  gistPullInflight = (async () => {
    const token =
      process.env.SUB_STORE_GIST_TOKEN ||
      process.env.GITHUB_TOKEN ||
      '';
    const gistId = parseGistId(dataUrl);
    let text = null;
    let via = 'raw';

    if (gistId && token) {
      via = 'api';
      const apiRes = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'sub-store-vercel',
        },
      });
      if (!apiRes.ok) {
        throw new Error(`GitHub gist API ${apiRes.status}`);
      }
      const gist = await apiRes.json();
      const files = gist.files || {};
      const names = Object.keys(files);
      const prefer =
        names.find((n) => /\.json$/i.test(n)) ||
        names[0];
      if (!prefer) throw new Error('gist has no files');
      const f = files[prefer];
      if (f.truncated && f.raw_url) {
        const rawRes = await fetch(f.raw_url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'sub-store-vercel',
            'Cache-Control': 'no-cache',
          },
        });
        text = await rawRes.text();
      } else {
        text = f.content;
      }
    } else {
      const raw = normalizeGistRawUrl(dataUrl);
      const bust = raw + (raw.includes('?') ? '&' : '?') + '_ts=' + Date.now();
      const rawRes = await fetch(bust, {
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'User-Agent': 'sub-store-vercel',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!rawRes.ok) throw new Error(`gist raw ${rawRes.status}`);
      text = await rawRes.text();
    }

    const payload = parseBackupPayload(text);
    if (!payload) throw new Error('invalid gist backup payload');
    globalThis.__ssRestore(payload);
    gistPullAt = Date.now();
    return { ok: true, via };
  })()
    .catch((e) => {
      pushError('gist-pull', e);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    })
    .finally(() => {
      gistPullInflight = null;
    });

  return gistPullInflight;
}

function shouldPullGist(reqPath) {
  const p = BACKEND_PATH || '';
  if (!p || p === '/') return false;
  if (!reqPath.startsWith(p)) return false;
  // 订阅下载也走最新备份; 静态前端不拉
  if (/\.(js|css|png|jpg|svg|ico|woff2?|map|html)$/i.test(reqPath)) return false;
  return true;
}

function prependMiddleware(app, fn) {
  if (!app || typeof app.use !== 'function') return;
  app.use(fn);
  try {
    const stack = app._router && app._router.stack;
    if (stack && stack.length) {
      const layer = stack.pop();
      stack.unshift(layer);
    }
  } catch (e) {
    pushError('prependMiddleware', e);
  }
}

function installGistSync(app) {
  prependMiddleware(app, (req, res, next) => {
    const reqPath = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (!shouldPullGist(reqPath)) return next();
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();
    // 有 Blob 时以 Blob 为准, 不再每次打 Gist
    const pull = blobConfigured() ? pullBlobIntoMemory() : pullGistIntoMemory();
    Promise.resolve(pull)
      .then(() => next())
      .catch(() => next());
  });
}

/* ---------- Vercel Blob: 多实例共享盘 (替代各 Lambda 自己的 /tmp) ---------- */

const BLOB_PREFIX = 'sub-store-data/';
const BLOB_FILES = ['sub-store.json', 'root.json'];
let blobLastEtag = '';
let blobPullInflight = null;
let blobPullAt = 0;
let blobPutTimer = null;
let blobFsHooked = false;
let lastBlobStatus = { configured: false };

function blobConfigured() {
  return !!(
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.VERCEL_OIDC_TOKEN
  );
}

function blobTokenOpts() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

async function streamToString(stream) {
  if (stream == null) return '';
  if (typeof stream === 'string') return stream;
  if (Buffer.isBuffer(stream)) return stream.toString('utf8');
  if (typeof stream.text === 'function') return stream.text();
  const chunks = [];
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(typeof value === 'string' ? value : dec.decode(value, { stream: true }));
    }
    return chunks.join('');
  }
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf8');
}

async function blobPutFile(name, body) {
  const { put } = require('@vercel/blob');
  const pathname = BLOB_PREFIX + name;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const base = {
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 0,
    ...blobTokenOpts(),
  };
  try {
    return await put(pathname, payload, { ...base, access: 'private' });
  } catch (e1) {
    return await put(pathname, payload, { ...base, access: 'public' });
  }
}

async function blobReadFile(name) {
  const blob = require('@vercel/blob');
  const pathname = BLOB_PREFIX + name;
  const opts = { ...blobTokenOpts(), access: 'private' };
  if (typeof blob.get === 'function') {
    try {
      const r = await blob.get(pathname, opts);
      if (!r || r.statusCode === 404) return null;
      const text = await streamToString(r.stream || r);
      const etag = (r.blob && r.blob.etag) || r.etag || '';
      return { text, etag };
    } catch (e) {
      try {
        const r = await blob.get(pathname, { ...blobTokenOpts(), access: 'public' });
        if (!r || r.statusCode === 404) return null;
        return { text: await streamToString(r.stream || r), etag: (r.blob && r.blob.etag) || '' };
      } catch (e2) {
        /* fall through to list */
      }
    }
  }
  const { blobs } = await blob.list({ prefix: pathname, ...blobTokenOpts() });
  const hit = (blobs || []).find((b) => b.pathname === pathname);
  if (!hit) return null;
  const res = await fetch(hit.url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) return null;
  return { text: await res.text(), etag: hit.etag || hit.uploadedAt || '' };
}

async function flushDataDirToBlob() {
  if (!blobConfigured()) return { skipped: true };
  const dir = process.env.SUB_STORE_DATA_BASE_PATH;
  const written = [];
  for (const name of BLOB_FILES) {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) continue;
    await blobPutFile(name, fs.readFileSync(fp));
    written.push(name);
  }
  lastBlobStatus = { configured: true, lastPut: Date.now(), files: written };
  return lastBlobStatus;
}

function hookFsWritesToBlob() {
  if (blobFsHooked || !blobConfigured()) return;
  blobFsHooked = true;
  const dir = path.resolve(process.env.SUB_STORE_DATA_BASE_PATH);
  const orig = fs.writeFileSync;
  fs.writeFileSync = function patchedWrite(p, data, opts, cb) {
    const ret = orig.apply(this, arguments);
    try {
      const abs = path.resolve(String(p));
      if (abs.startsWith(dir + path.sep) && BLOB_FILES.includes(path.basename(abs))) {
        clearTimeout(blobPutTimer);
        blobPutTimer = setTimeout(() => {
          flushDataDirToBlob().catch((e) => pushError('blob-put', e));
        }, 200);
      }
    } catch (e) {}
    return ret;
  };
}

async function hydrateFromBlob() {
  if (!blobConfigured()) {
    lastBlobStatus = { configured: false };
    return lastBlobStatus;
  }
  const dir = process.env.SUB_STORE_DATA_BASE_PATH;
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  let etagJoin = '';
  for (const name of BLOB_FILES) {
    try {
      const r = await blobReadFile(name);
      if (r && r.text) {
        fs.writeFileSync(path.join(dir, name), r.text);
        got.push(name);
        etagJoin += r.etag || '';
      }
    } catch (e) {
      pushError('blob-hydrate:' + name, e);
    }
  }
  blobLastEtag = etagJoin;
  lastBlobStatus = { configured: true, hydrated: got, etag: blobLastEtag || null };
  return lastBlobStatus;
}

async function pullBlobIntoMemory() {
  if (!blobConfigured()) return { skipped: 'no blob token' };
  if (blobPullInflight) return blobPullInflight;
  if (Date.now() - blobPullAt < 1500) return { skipped: 'throttled' };

  blobPullInflight = (async () => {
    const r = await blobReadFile('sub-store.json');
    if (!r || !r.text) return { skipped: 'empty' };
    if (r.etag && r.etag === blobLastEtag) {
      blobPullAt = Date.now();
      return { skipped: 'same etag' };
    }
    fs.writeFileSync(
      path.join(process.env.SUB_STORE_DATA_BASE_PATH, 'sub-store.json'),
      r.text,
    );
    const payload = parseBackupPayload(r.text);
    if (payload && typeof globalThis.__ssRestore === 'function') {
      globalThis.__ssRestore(payload);
    }
    blobLastEtag = r.etag || blobLastEtag;
    blobPullAt = Date.now();
    lastBlobStatus = { configured: true, pulled: true, etag: blobLastEtag };
    return { ok: true };
  })()
    .catch((e) => {
      pushError('blob-pull', e);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    })
    .finally(() => {
      blobPullInflight = null;
    });
  return blobPullInflight;
}

async function ensureBackend() {
  if (backendReady || backendError) return;
  if (backendBoot) return backendBoot;
  backendBoot = (async () => {
    hookFsWritesToBlob();
    let hydratedOk = false;
    try {
      const h = await hydrateFromBlob();
      hydratedOk = !!(h && h.hydrated && h.hydrated.includes('sub-store.json'));
    } catch (e) {
      pushError('blob-hydrate', e);
    }
    // 启动还原若走 Gist Raw, 可能用过期缓存盖掉 Blob. 有 Blob 数据时让官方 DATA_URL 下载改读本地文件.
    if (hydratedOk && process.env.SUB_STORE_DATA_URL) {
      const localBoot = path.join(
        process.env.SUB_STORE_DATA_BASE_PATH,
        'sub-store.json',
      );
      const origFetch = global.fetch;
      if (typeof origFetch === 'function') {
        const bootUrl = process.env.SUB_STORE_DATA_URL;
        global.fetch = async function (url, opts) {
          try {
            if (String(url).indexOf(String(bootUrl).split('?')[0]) === 0) {
              const text = fs.readFileSync(localBoot, 'utf8');
              return new Response(text, {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }
    }
    try {
      require('./sub-store.min.js');
      backendReady = true;
    } catch (e) {
      backendError = e;
      origConsoleError('[sub-store] 后端启动失败:', e && e.stack ? e.stack : e);
    }
  })();
  return backendBoot;
}

/* ------------------------------- 请求处理 ------------------------------- */

module.exports = async function handler(req, res) {
  try {
    res.setHeader('x-substore-entry', ENTRY_VERSION);
  } catch (e) {}

  const reqPath = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

  try {
    await ensureBackend();
  } catch (e) {
    pushError('ensureBackend', e);
  }

  // 公开自检 (只读, 无敏感信息)
  if (reqPath === '/__substore_selftest') {
    selfTest(res);
    return;
  }

  // 版本检查端点 (需命中私密路径, 外部无法触发)
  if (reqPath === `${BACKEND_PATH}/__update`) {
    await handleUpdateCheck(res);
    return;
  }

  if (backendError) {
    sendJson(res, 500, {
      status: 'failed',
      message: `Sub-Store 后端初始化失败: ${backendError.message}`,
      debug: recentErrors,
    });
    return;
  }

  const deadline = Date.now() + 10000;
  while (!capturedApp && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!capturedApp) {
    sendJson(res, 500, {
      status: 'failed',
      message: 'Sub-Store 后端未捕获到 Express app',
      debug: recentErrors,
      node: process.version,
    });
    return;
  }

  if (!capturedApp.__gistSyncInstalled) {
    installGistSync(capturedApp);
    capturedApp.__gistSyncInstalled = true;
  }

  try {
    capturedApp(req, res);
  } catch (e) {
    pushError('dispatch', e);
    sendJson(res, 500, {
      status: 'failed',
      message: `请求处理异常: ${e && e.message}`,
    });
  }
};
