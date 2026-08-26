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
const crypto = require('crypto');

const ENTRY_VERSION = 'v11-global-config-api-scope-fix-2026-08-26';

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
try { require('@aws-sdk/client-s3'); } catch (e) { warnLoad('@aws-sdk/client-s3', e); }
try { require('@vercel/global-config'); } catch (e) { warnLoad('@vercel/global-config', e); }

/* ------------------------ 启动 Sub-Store 后端 (延后到共享存储灌盘之后) ------------------------ */

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
    objectStorageConfigured: storageConfigured(),
    objectStorageRequestedProvider: requestedStorageProvider(),
    objectStorageProvider: storageProvider(),
    objectStorageStatus: lastStorageStatus,
    r2Configured: r2Configured(),
    r2MissingEnv: r2HasAnyConfig() ? r2MissingEnv() : [],
    globalConfigConfigured: globalConfigConfigured(),
    globalConfigMissingEnv:
      globalConfigHasAnyConfig() || requestedStorageProvider() === 'vercel-global-config'
        ? globalConfigMissingEnv()
        : [],
    globalConfigTeamScopeConfigured: !!(
      process.env.GLOBAL_CONFIG_TEAM_ID ||
      process.env.VERCEL_TEAM_ID ||
      process.env.GLOBAL_CONFIG_TEAM_SLUG
    ),
    globalConfigOidcScopeAvailable: !!globalConfigOidcOwnerId(),
    globalConfigWriteDiagnostic: lastGlobalConfigWriteDiagnostic,
    // 保留旧字段，方便已有排查脚本；这里仅表示 Vercel Blob 本身。
    blobConfigured: vercelBlobConfigured(),
    blobStatus:
      storageProvider() === 'vercel-blob'
        ? lastStorageStatus
        : { configured: vercelBlobConfigured() },
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
    // 有 R2 / Global Config / Blob 时以共享存储为准，不再每次请求 Gist。
    const pull = storageConfigured() ? pullStorageIntoMemory() : pullGistIntoMemory();
    Promise.resolve(pull)
      .then(() => next())
      .catch(() => next());
  });
}

/* ---------- 共享存储：Cloudflare R2 / Vercel Global Config / Blob ---------- */

const STORAGE_FILES = ['sub-store.json', 'root.json'];
let storageLastEtag = '';
let storageLastPutAt = 0;
let storagePullInflight = null;
let storagePullAt = 0;
let storagePutTimer = null;
let storageFlushInflight = null;
let storageDirty = false;
let storageFsHooked = false;
let storageHydrating = false;
let storageMigratedFrom = null;
let lastStorageStatus = { configured: false, provider: null };
let cachedR2Client = null;
let cachedGlobalConfigClient = null;
let globalConfigReadCache = null;
let globalConfigReadCacheAt = 0;
let globalConfigReadInflight = null;
let cachedGlobalConfigWriteTarget = null;
let lastGlobalConfigWriteDiagnostic = null;

function requestedStorageProvider() {
  const value = String(process.env.SUB_STORE_STORAGE_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
  if (!value || value === 'auto') return 'auto';
  if (value === 'r2' || value === 'cloudflare-r2') return 'cloudflare-r2';
  if (
    value === 'global-config' ||
    value === 'vercel-global-config' ||
    value === 'edge-config'
  ) {
    return 'vercel-global-config';
  }
  if (value === 'blob' || value === 'vercel-blob') return 'vercel-blob';
  return value;
}

function storagePrefix() {
  const raw = String(
    process.env.SUB_STORE_STORAGE_PREFIX ||
      process.env.R2_PREFIX ||
      'sub-store-data/',
  )
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return raw ? raw + '/' : '';
}

function storageKey(name) {
  return storagePrefix() + name;
}

function r2BucketName() {
  return String(process.env.R2_BUCKET_NAME || process.env.R2_BUCKET || '').trim();
}

function r2Endpoint() {
  const explicit = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  return accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : '';
}

function r2HasAnyConfig() {
  return !!(
    process.env.R2_ACCOUNT_ID ||
    process.env.R2_ENDPOINT ||
    process.env.R2_ACCESS_KEY_ID ||
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.R2_BUCKET_NAME ||
    process.env.R2_BUCKET
  );
}

function r2MissingEnv() {
  const missing = [];
  if (!r2Endpoint()) missing.push('R2_ACCOUNT_ID (or R2_ENDPOINT)');
  if (!process.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!process.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!r2BucketName()) missing.push('R2_BUCKET_NAME');
  return missing;
}

function r2Configured() {
  return r2MissingEnv().length === 0;
}

function globalConfigConnectionString() {
  return String(
    process.env.SUB_STORE_GLOBAL_CONFIG ||
      process.env.GLOBAL_CONFIG ||
      process.env.EDGE_CONFIG ||
      '',
  ).trim();
}

function globalConfigWriteToken() {
  return String(
    process.env.GLOBAL_CONFIG_WRITE_TOKEN ||
      process.env.VERCEL_API_TOKEN ||
      process.env.VERCEL_TOKEN ||
      '',
  ).trim();
}

function globalConfigId() {
  const explicit = String(
    process.env.GLOBAL_CONFIG_ID || process.env.EDGE_CONFIG_ID || '',
  ).trim();
  if (explicit) return explicit;
  const connection = globalConfigConnectionString();
  if (!connection) return '';
  try {
    const parsed = require('@vercel/global-config').parseConnectionString(
      connection,
    );
    return parsed && parsed.id ? String(parsed.id) : '';
  } catch (e) {
    return '';
  }
}

function globalConfigItemPrefix() {
  return String(process.env.GLOBAL_CONFIG_ITEM_PREFIX || 'sub_store').trim();
}

function globalConfigItemKey(name) {
  const suffix = name === 'root.json' ? 'root' : 'data';
  return `${globalConfigItemPrefix()}_${suffix}`;
}

function globalConfigHasAnyConfig() {
  return !!(
    process.env.SUB_STORE_GLOBAL_CONFIG ||
    process.env.GLOBAL_CONFIG ||
    process.env.EDGE_CONFIG ||
    process.env.GLOBAL_CONFIG_ID ||
    process.env.EDGE_CONFIG_ID ||
    process.env.GLOBAL_CONFIG_WRITE_TOKEN ||
    process.env.VERCEL_API_TOKEN ||
    process.env.VERCEL_TOKEN ||
    process.env.GLOBAL_CONFIG_TEAM_ID ||
    process.env.GLOBAL_CONFIG_TEAM_SLUG ||
    process.env.GLOBAL_CONFIG_ITEM_PREFIX
  );
}

function globalConfigMissingEnv() {
  const missing = [];
  if (!globalConfigConnectionString()) {
    missing.push('GLOBAL_CONFIG (connect the store to this project)');
  }
  if (!globalConfigId()) missing.push('GLOBAL_CONFIG_ID (normally auto-detected)');
  if (!globalConfigWriteToken()) {
    missing.push('GLOBAL_CONFIG_WRITE_TOKEN (or VERCEL_API_TOKEN)');
  }
  const prefix = globalConfigItemPrefix();
  if (!/^[A-Za-z0-9_-]+$/.test(prefix) || prefix.length > 240) {
    missing.push('GLOBAL_CONFIG_ITEM_PREFIX (letters/numbers/_/-, max 240)');
  }
  return missing;
}

function globalConfigConfigured() {
  return globalConfigMissingEnv().length === 0;
}

function vercelBlobConfigured() {
  return !!(
    process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)
  );
}

function storageProvider() {
  const requested = requestedStorageProvider();
  if (requested === 'cloudflare-r2') {
    return r2Configured() ? 'cloudflare-r2' : null;
  }
  if (requested === 'vercel-global-config') {
    return globalConfigConfigured() ? 'vercel-global-config' : null;
  }
  if (requested === 'vercel-blob') {
    return vercelBlobConfigured() ? 'vercel-blob' : null;
  }
  if (requested !== 'auto') return null;

  // 自动模式：R2 优先；配置了 Global Config 写 Token 时再选它；最后兼容 Blob。
  // 手动填写了部分 R2 变量时不静默回退，缺项会在自检中显示。
  if (r2HasAnyConfig()) return r2Configured() ? 'cloudflare-r2' : null;
  if (globalConfigWriteToken()) {
    return globalConfigConfigured() ? 'vercel-global-config' : null;
  }
  if (vercelBlobConfigured()) return 'vercel-blob';
  return null;
}

function storageConfigured() {
  return !!storageProvider();
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
      chunks.push(
        typeof value === 'string'
          ? value
          : dec.decode(value, { stream: true }),
      );
    }
    return chunks.join('');
  }
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

function cleanEtag(etag) {
  return String(etag || '').replace(/^"|"$/g, '');
}

function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  if (!r2Configured()) {
    throw new Error(`R2 配置不完整: ${r2MissingEnv().join(', ')}`);
  }
  // 当前锁定的 SDK 仍支持 Node 20；关闭其面向 2027 年的预告警，避免污染自检错误列表。
  if (process.env.AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED === undefined) {
    process.env.AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED = 'true';
  }
  const { S3Client } = require('@aws-sdk/client-s3');
  cachedR2Client = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint: r2Endpoint(),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return cachedR2Client;
}

async function r2PutFile(name, body) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(String(body), 'utf8');
  const result = await getR2Client().send(
    new PutObjectCommand({
      Bucket: r2BucketName(),
      Key: storageKey(name),
      Body: payload,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store',
    }),
  );
  return { etag: cleanEtag(result && result.ETag) };
}

function isObjectNotFound(e) {
  const code = String((e && (e.name || e.Code || e.code)) || '');
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  return status === 404 || code === 'NoSuchKey' || code === 'NotFound';
}

async function r2ReadFile(name) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const result = await getR2Client().send(
      new GetObjectCommand({
        Bucket: r2BucketName(),
        Key: storageKey(name),
      }),
    );
    return {
      text: await streamToString(result.Body),
      etag: cleanEtag(result.ETag) || String(result.VersionId || ''),
    };
  } catch (e) {
    if (isObjectNotFound(e)) return null;
    throw e;
  }
}

function contentEtag(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function getGlobalConfigClient() {
  if (cachedGlobalConfigClient) return cachedGlobalConfigClient;
  if (!globalConfigConnectionString()) {
    throw new Error('Global Config 缺少连接字符串 GLOBAL_CONFIG');
  }
  const { createClient } = require('@vercel/global-config');
  cachedGlobalConfigClient = createClient(globalConfigConnectionString(), {
    cache: 'no-store',
    staleIfError: 0,
    disableDevelopmentCache: true,
  });
  return cachedGlobalConfigClient;
}

async function globalConfigReadItems() {
  const now = Date.now();
  if (globalConfigReadCache && now - globalConfigReadCacheAt < 1000) {
    return globalConfigReadCache;
  }
  if (globalConfigReadInflight) return globalConfigReadInflight;

  globalConfigReadInflight = getGlobalConfigClient()
    .getAll(STORAGE_FILES.map(globalConfigItemKey))
    .then((items) => {
      globalConfigReadCache = items && typeof items === 'object' ? items : {};
      globalConfigReadCacheAt = Date.now();
      return globalConfigReadCache;
    })
    .finally(() => {
      globalConfigReadInflight = null;
    });
  return globalConfigReadInflight;
}

function globalConfigValueToText(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function globalConfigBodyToValue(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

async function globalConfigReadFile(name) {
  const items = await globalConfigReadItems();
  const key = globalConfigItemKey(name);
  if (!Object.prototype.hasOwnProperty.call(items, key)) return null;
  const text = globalConfigValueToText(items[key]);
  return { text, etag: contentEtag(text) };
}

function globalConfigApiBaseUrls() {
  const custom = String(process.env.GLOBAL_CONFIG_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (custom) return [{ url: custom, api: 'custom' }];
  return [
    { url: 'https://api.vercel.com/v1/global-config', api: 'global-config' },
    // Global Config 是 Edge Config 的新名称；旧端点作为兼容回退。
    { url: 'https://api.vercel.com/v1/edge-config', api: 'edge-config' },
  ];
}

function globalConfigOidcOwnerId() {
  const token = String(process.env.VERCEL_OIDC_TOKEN || '').trim();
  if (!token) return '';
  try {
    const part = token.split('.')[1];
    if (!part) return '';
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return String((payload && payload.owner_id) || '').trim();
  } catch (e) {
    return '';
  }
}

function globalConfigScopeCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = (param, value, source) => {
    const v = String(value || '').trim();
    const key = `${param || 'none'}:${v}`;
    if ((!param || v) && !seen.has(key)) {
      seen.add(key);
      candidates.push({ param, value: v, source });
    }
  };

  add('teamId', process.env.GLOBAL_CONFIG_TEAM_ID, 'GLOBAL_CONFIG_TEAM_ID');
  add('teamId', process.env.VERCEL_TEAM_ID, 'VERCEL_TEAM_ID');
  add('teamId', globalConfigOidcOwnerId(), 'OIDC owner_id');
  add('teamId', process.env.VERCEL_ORG_ID, 'VERCEL_ORG_ID');
  add('slug', process.env.GLOBAL_CONFIG_TEAM_SLUG, 'GLOBAL_CONFIG_TEAM_SLUG');
  add(null, '', 'personal account');
  return candidates;
}

function globalConfigWriteTargets() {
  const targets = [];
  const seen = new Set();
  const add = (target) => {
    if (!target) return;
    const key = `${target.baseUrl}|${target.param || ''}|${target.value || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  };
  add(cachedGlobalConfigWriteTarget);
  for (const base of globalConfigApiBaseUrls()) {
    for (const scope of globalConfigScopeCandidates()) {
      add({
        baseUrl: base.url,
        api: base.api,
        param: scope.param,
        value: scope.value,
        scopeSource: scope.source,
      });
    }
  }
  return targets;
}

function globalConfigSmartOperations(values) {
  const current = globalConfigReadCache || {};
  return Object.entries(values).map(([key, value]) => ({
    operation: Object.prototype.hasOwnProperty.call(current, key)
      ? 'update'
      : 'create',
    key,
    value,
  }));
}

async function globalConfigPatchTarget(target, items) {
  const url = new URL(
    `${target.baseUrl}/${encodeURIComponent(globalConfigId())}/items`,
  );
  if (target.param && target.value) {
    url.searchParams.set(target.param, target.value);
  }
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${globalConfigWriteToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sub-store-vercel',
    },
    body: JSON.stringify({ items }),
  });
  const responseText = await response.text();
  let result = null;
  try {
    result = responseText ? JSON.parse(responseText) : null;
  } catch (e) {}
  const message =
    (result && result.error && (result.error.message || result.error.code)) ||
    responseText.slice(0, 300) ||
    `HTTP ${response.status}`;
  return {
    ok: response.ok && !(result && result.error),
    status: response.status,
    message,
  };
}

async function globalConfigPutFiles(files) {
  if (!globalConfigConfigured()) {
    throw new Error(
      `Global Config 配置不完整: ${globalConfigMissingEnv().join(', ')}`,
    );
  }

  const values = {};
  for (const file of files) {
    values[globalConfigItemKey(file.name)] = globalConfigBodyToValue(file.body);
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(values));
  // Global Config 每个 Store 上限 1 MB；预留键名及其它元数据空间。
  if (payloadBytes > 950 * 1024) {
    throw new Error(
      `Global Config 数据过大 (${payloadBytes} bytes)，请改用 Cloudflare R2`,
    );
  }

  const baseItems = globalConfigSmartOperations(values);
  const attempts = [];
  let successfulTarget = null;
  let successfulOperations = null;
  let last = { status: 0, message: 'no write target' };

  for (const target of globalConfigWriteTargets()) {
    let items = baseItems;
    let response = await globalConfigPatchTarget(target, items);
    attempts.push({
      api: target.api,
      scope: target.scopeSource,
      status: response.status,
    });

    // SDK 缓存可能比写入 API 慢：update 找不到时改 create，create 冲突时改 update。
    if (
      !response.ok &&
      response.status === 404 &&
      items.some((item) => item.operation === 'update')
    ) {
      items = items.map((item) => ({ ...item, operation: 'create' }));
      response = await globalConfigPatchTarget(target, items);
      attempts.push({
        api: target.api,
        scope: `${target.scopeSource} (create retry)`,
        status: response.status,
      });
    } else if (
      !response.ok &&
      (response.status === 400 || response.status === 409) &&
      items.some((item) => item.operation === 'create')
    ) {
      items = items.map((item) => ({ ...item, operation: 'update' }));
      response = await globalConfigPatchTarget(target, items);
      attempts.push({
        api: target.api,
        scope: `${target.scopeSource} (update retry)`,
        status: response.status,
      });
    }

    last = response;
    if (response.ok) {
      successfulTarget = target;
      successfulOperations = Array.from(
        new Set(items.map((item) => item.operation)),
      );
      break;
    }
    // 401 表示 Token 本身无效，继续尝试其它 scope/端点也不会成功。
    if (response.status === 401) break;
  }

  if (!successfulTarget) {
    cachedGlobalConfigWriteTarget = null;
    lastGlobalConfigWriteDiagnostic = {
      ok: false,
      status: last.status,
      message: last.message,
      attempts,
    };
    throw new Error(
      `Global Config 写入失败 (${last.status}): ${last.message}; ` +
        `已尝试 ${attempts.length} 个 API/scope 组合`,
    );
  }

  cachedGlobalConfigWriteTarget = successfulTarget;
  lastGlobalConfigWriteDiagnostic = {
    ok: true,
    api: successfulTarget.api,
    scope: successfulTarget.scopeSource,
    operations: successfulOperations,
    attempts,
  };
  globalConfigReadCache = {
    ...(globalConfigReadCache || {}),
    ...values,
  };
  globalConfigReadCacheAt = Date.now();
  const etags = {};
  for (const file of files) {
    etags[file.name] = contentEtag(
      globalConfigValueToText(values[globalConfigItemKey(file.name)]),
    );
  }
  return { etags, bytes: payloadBytes };
}

async function globalConfigPutFile(name, body) {
  const result = await globalConfigPutFiles([{ name, body }]);
  return { etag: result.etags[name], bytes: result.bytes };
}

async function vercelBlobPutFile(name, body) {
  const { put } = require('@vercel/blob');
  const pathname = storageKey(name);
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(String(body), 'utf8');
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
    return put(pathname, payload, { ...base, access: 'public' });
  }
}

async function vercelBlobReadFile(name) {
  const blob = require('@vercel/blob');
  const pathname = storageKey(name);
  const opts = { ...blobTokenOpts(), access: 'private' };
  if (typeof blob.get === 'function') {
    try {
      const r = await blob.get(pathname, opts);
      if (!r || r.statusCode === 404) return null;
      return {
        text: await streamToString(r.stream || r),
        etag: cleanEtag((r.blob && r.blob.etag) || r.etag),
      };
    } catch (e) {
      try {
        const r = await blob.get(pathname, {
          ...blobTokenOpts(),
          access: 'public',
        });
        if (!r || r.statusCode === 404) return null;
        return {
          text: await streamToString(r.stream || r),
          etag: cleanEtag((r.blob && r.blob.etag) || r.etag),
        };
      } catch (e2) {
        /* fall through to list */
      }
    }
  }
  const { blobs } = await blob.list({
    prefix: pathname,
    ...blobTokenOpts(),
  });
  const hit = (blobs || []).find((b) => b.pathname === pathname);
  if (!hit) return null;
  const res = await fetch(hit.url, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) return null;
  return {
    text: await res.text(),
    etag: cleanEtag(hit.etag) || String(hit.uploadedAt || ''),
  };
}

async function storagePutFile(name, body) {
  const provider = storageProvider();
  if (provider === 'cloudflare-r2') return r2PutFile(name, body);
  if (provider === 'vercel-global-config') {
    return globalConfigPutFile(name, body);
  }
  if (provider === 'vercel-blob') return vercelBlobPutFile(name, body);
  throw new Error('未配置共享存储');
}

async function storageReadFile(name) {
  const provider = storageProvider();
  if (provider === 'vercel-global-config') {
    return globalConfigReadFile(name);
  }
  if (provider === 'vercel-blob') return vercelBlobReadFile(name);
  if (provider !== 'cloudflare-r2') return null;

  const fromR2 = await r2ReadFile(name);
  if (fromR2) return fromR2;

  // 迁移辅助：R2 中还没有对象、旧 Blob Token 尚未移除时，从 Blob 读取并写入 R2。
  // 只在 R2 缺少该对象时发生，迁移完成后不会继续消耗 Blob 请求。
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const fromBlob = await vercelBlobReadFile(name);
    if (fromBlob && fromBlob.text) {
      const copied = await r2PutFile(name, fromBlob.text);
      storageMigratedFrom = 'vercel-blob';
      return { text: fromBlob.text, etag: copied.etag || fromBlob.etag };
    }
  }
  return null;
}

async function flushDataDirToStorage() {
  if (storageFlushInflight) return storageFlushInflight;
  const provider = storageProvider();
  if (!provider) return { skipped: true, configured: false };

  storageFlushInflight = (async () => {
    const dir = process.env.SUB_STORE_DATA_BASE_PATH;
    const written = new Set();
    let globalConfigBytes = null;
    // 上传过程中如果配置再次被修改，再循环一次，避免后写入的数据丢失。
    do {
      storageDirty = false;
      const files = [];
      for (const name of STORAGE_FILES) {
        const fp = path.join(dir, name);
        if (!fs.existsSync(fp)) continue;
        files.push({ name, body: fs.readFileSync(fp) });
      }

      if (provider === 'vercel-global-config' && files.length) {
        // 两个文件合并成一次 PATCH，减少 Global Config 写入次数。
        const result = await globalConfigPutFiles(files);
        globalConfigBytes = result.bytes;
        for (const file of files) written.add(file.name);
        if (result.etags['sub-store.json']) {
          storageLastEtag = result.etags['sub-store.json'];
        }
      } else {
        for (const file of files) {
          const result = await storagePutFile(file.name, file.body);
          written.add(file.name);
          if (file.name === 'sub-store.json' && result && result.etag) {
            storageLastEtag = cleanEtag(result.etag);
          }
        }
      }
    } while (storageDirty);

    storageLastPutAt = Date.now();
    lastStorageStatus = {
      configured: true,
      provider,
      lastPut: storageLastPutAt,
      files: Array.from(written),
      ...(globalConfigBytes == null ? {} : { bytes: globalConfigBytes }),
      ...(provider === 'vercel-global-config'
        ? { propagation: 'up to 10 seconds' }
        : {}),
      ...(storageMigratedFrom ? { migratedFrom: storageMigratedFrom } : {}),
    };
    return lastStorageStatus;
  })().finally(() => {
    storageFlushInflight = null;
  });

  return storageFlushInflight;
}

function hookFsWritesToStorage() {
  if (storageFsHooked || !storageConfigured()) return;
  storageFsHooked = true;
  const dir = path.resolve(process.env.SUB_STORE_DATA_BASE_PATH);
  const orig = fs.writeFileSync;
  fs.writeFileSync = function patchedWrite(p, data, opts, cb) {
    const ret = orig.apply(this, arguments);
    try {
      const abs = path.resolve(String(p));
      if (
        !storageHydrating &&
        abs.startsWith(dir + path.sep) &&
        STORAGE_FILES.includes(path.basename(abs))
      ) {
        storageDirty = true;
        clearTimeout(storagePutTimer);
        storagePutTimer = setTimeout(() => {
          flushDataDirToStorage().catch((e) => pushError('storage-put', e));
        }, 200);
      }
    } catch (e) {}
    return ret;
  };
}

function flushStorageBeforeResponseEnd(res) {
  if (!storageConfigured() || !res || res.__storageFlushInstalled) return;
  res.__storageFlushInstalled = true;
  const origEnd = res.end;
  let ending = false;
  res.end = function patchedEnd() {
    if (ending) return this;
    if (!storageDirty && !storageFlushInflight) {
      return origEnd.apply(this, arguments);
    }

    ending = true;
    const args = arguments;
    clearTimeout(storagePutTimer);
    Promise.resolve(flushDataDirToStorage())
      .catch((e) => pushError('storage-put-before-response', e))
      .finally(() => {
        try {
          origEnd.apply(res, args);
        } catch (e) {
          pushError('response-end-after-storage', e);
        }
      });
    return this;
  };
}

async function hydrateFromStorage() {
  const provider = storageProvider();
  if (!provider) {
    const requested = requestedStorageProvider();
    let missingEnv = [];
    if (requested === 'cloudflare-r2') {
      missingEnv = r2MissingEnv();
    } else if (requested === 'vercel-global-config') {
      missingEnv = globalConfigMissingEnv();
    } else if (requested === 'auto' && r2HasAnyConfig()) {
      missingEnv = r2MissingEnv();
    }
    lastStorageStatus = {
      configured: false,
      provider: null,
      requestedProvider: requested,
      ...(missingEnv.length ? { missingEnv } : {}),
    };
    return lastStorageStatus;
  }
  const dir = process.env.SUB_STORE_DATA_BASE_PATH;
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  storageHydrating = true;
  try {
    for (const name of STORAGE_FILES) {
      try {
        const r = await storageReadFile(name);
        if (r && r.text) {
          fs.writeFileSync(path.join(dir, name), r.text);
          got.push(name);
          if (name === 'sub-store.json') storageLastEtag = r.etag || '';
        }
      } catch (e) {
        pushError('storage-hydrate:' + name, e);
      }
    }
  } finally {
    storageHydrating = false;
  }
  lastStorageStatus = {
    configured: true,
    provider,
    hydrated: got,
    etag: storageLastEtag || null,
    ...(storageMigratedFrom ? { migratedFrom: storageMigratedFrom } : {}),
  };
  return lastStorageStatus;
}

async function pullStorageIntoMemory() {
  if (!storageConfigured()) return { skipped: 'no shared storage' };
  if (storagePullInflight) return storagePullInflight;
  if (Date.now() - storagePullAt < 1500) return { skipped: 'throttled' };
  if (
    storageProvider() === 'vercel-global-config' &&
    Date.now() - storageLastPutAt < 10000
  ) {
    return { skipped: 'waiting for Global Config propagation' };
  }

  storagePullInflight = (async () => {
    const r = await storageReadFile('sub-store.json');
    storagePullAt = Date.now();
    if (!r || !r.text) return { skipped: 'empty' };
    if (r.etag && r.etag === storageLastEtag) {
      return { skipped: 'same etag' };
    }
    storageHydrating = true;
    try {
      fs.writeFileSync(
        path.join(process.env.SUB_STORE_DATA_BASE_PATH, 'sub-store.json'),
        r.text,
      );
      const payload = parseBackupPayload(r.text);
      if (payload && typeof globalThis.__ssRestore === 'function') {
        globalThis.__ssRestore(payload);
      }
    } finally {
      storageHydrating = false;
    }
    storageLastEtag = r.etag || storageLastEtag;
    lastStorageStatus = {
      configured: true,
      provider: storageProvider(),
      pulled: true,
      etag: storageLastEtag,
      ...(storageMigratedFrom ? { migratedFrom: storageMigratedFrom } : {}),
    };
    return { ok: true };
  })()
    .catch((e) => {
      pushError('storage-pull', e);
      return {
        ok: false,
        error: String(e && e.message ? e.message : e),
      };
    })
    .finally(() => {
      storagePullInflight = null;
    });
  return storagePullInflight;
}

async function ensureBackend() {
  if (backendReady || backendError) return;
  if (backendBoot) return backendBoot;
  backendBoot = (async () => {
    hookFsWritesToStorage();
    let hydratedOk = false;
    try {
      const h = await hydrateFromStorage();
      hydratedOk = !!(h && h.hydrated && h.hydrated.includes('sub-store.json'));
    } catch (e) {
      pushError('storage-hydrate', e);
    }
    // 启动还原若走 Gist Raw，可能用过期缓存盖掉共享存储；已有对象时让官方 DATA_URL 改读本地文件。
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

  // 写请求返回前等待 R2 / Global Config / Blob 写入完成，避免 Serverless 提前冻结。
  flushStorageBeforeResponseEnd(res);

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
