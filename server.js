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

const ENTRY_VERSION = 'v12-github-storage-memory-sync-2026-10-17';

let sharedStorageBootstrapActive = false;
let userDataRestoreConfigured = false;

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

// 启动还原成功后把官方 Env 实例挂到全局, 供共享存储/Gist 快照更新后刷新后端内存 (解决多 Lambda /tmp 不一致)
{
  const userPost = process.env.SUB_STORE_DATA_URL_POST || '';
  process.env.SUB_STORE_DATA_URL_POST =
    'try{globalThis.__ssT=T;globalThis.__ssRestore=function(c){globalThis.__ssStorageHydrating=true;T.write(JSON.stringify(c,null,"  "),"#sub-store");T.cache=c;T.persistCache();if(typeof Fc==="function")try{Fc()}catch(e){}}}catch(e){}' +
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
    dataRestoreConfigured: userDataRestoreConfigured,
    sharedStorageBootstrapActive,
    objectStorageConfigured: storageConfigured(),
    objectStorageProvider: storageProvider(),
    objectStorageStatus: lastStorageStatus,
    githubRepoConfigured: githubRepoConfigured(),
    githubRepoMissingEnv: githubRepoHasAnyConfig() ? githubRepoMissingEnv() : [],
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
    // 有共享存储 (GitHub 仓库) 时以共享存储为准，不再每次请求 Gist。
    const pull = storageConfigured() ? pullStorageIntoMemory() : pullGistIntoMemory();
    Promise.resolve(pull)
      .then(() => next())
      .catch(() => next());
  });
}

/* ---------- 开放 CORS: 完全去除白名单拦截 ----------
 * 官方后端默认按固定白名单校验 Origin, 绑定自定义域名或第三方前端
 * 调用时全部 403。这里在请求进入后端前统一放通:
 *   · OPTIONS 预检 (带 Access-Control-Request-Method) → 直接 204 返回
 *     全放通响应头, 不再进入后端;
 *   · 其余带 Origin 的请求 → 摘掉 Origin (后端按非 CORS 请求放行),
 *     并给响应补 Access-Control-Allow-Origin: *, 让浏览器端能读到响应。
 * ⚠️ 此后私密路径 (SUB_STORE_FRONTEND_BACKEND_PATH) 是后端唯一防线,
 *    务必保持足够长的随机字符串。
 */
/* ---------- 前端入口文件禁缓存: 防止升级后白屏 ----------
 * 前端分块文件名带内容哈希 (可安全强缓存一年), 但入口文件
 * (index.html / index.js / sw.js 等) 是固定文件名: 官方后端给它们
 * 设置了 max-age=14400, 经过 Cloudflare 等代理和浏览器缓存后,
 * 重新部署 (分块哈希全部变化) 时, 客户端可能仍拿着旧入口文件去
 * 加载已不存在的旧分块 → 白屏。
 * 这里强制入口文件 Cache-Control: no-cache (每次校验), 分块维持
 * immutable 强缓存; 拦截 setHeader 以覆盖官方静态服务的默认值。
 */
const FRONTEND_ENTRY_FILES = [
  '/',
  '/index.html',
  '/index.js',
  '/sw.js',
  '/registerSW.js',
  '/manifests.json',
  '/manifest.webmanifest',
];

function isFrontendEntryFile(reqPath) {
  return (
    FRONTEND_ENTRY_FILES.includes(reqPath) || reqPath.startsWith('/favicon')
  );
}

function installCacheHeaders(app) {
  prependMiddleware(app, (req, res, next) => {
    const reqPath = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (
      (req.method || 'GET').toUpperCase() === 'GET' &&
      isFrontendEntryFile(reqPath)
    ) {
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = function patchedSetHeader(name, value) {
        if (String(name).toLowerCase() === 'cache-control') {
          return origSetHeader('Cache-Control', 'no-cache');
        }
        return origSetHeader(name, value);
      };
      res.setHeader('Cache-Control', 'no-cache');
    }
    next();
  });
}

function installOpenCors(app) {
  prependMiddleware(app, (req, res, next) => {
    const origin = req.headers && req.headers.origin;
    if (origin && typeof origin === 'string') {
      if (
        (req.method || '').toUpperCase() === 'OPTIONS' &&
        req.headers['access-control-request-method'] !== undefined
      ) {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
        );
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] || '*',
        );
        res.setHeader('Access-Control-Max-Age', '86400');
        res.end();
        return;
      }
      try {
        delete req.headers.origin;
      } catch (e) {}
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    next();
  });
}

/* ---------- 共享存储: GitHub 私有仓库 ---------- */

const STORAGE_FILES = ['sub-store.json', 'root.json'];
let storageLastEtag = '';
let storagePullInflight = null;
let storagePullAt = 0;
let storagePutTimer = null;
let storageFlushInflight = null;
let storageDirty = false;
let storageFsHooked = false;
let storageHydrating = false;
let lastStorageStatus = { configured: false, provider: null };

/* ----------------------- GitHub 私有仓库存储 -----------------------
 * 环境变量:
 *   GITHUB_REPO_USER   GitHub 用户名 (或组织名)
 *   GITHUB_REPO_NAME   仓库名称, 纯名称 / "owner/repo" / 完整 URL 均可
 *   GITHUB_REPO_TOKEN  Personal Access Token
 *                      · classic:        勾选 repo 权限 (私有库必须)
 *                      · fine-grained:   该仓库 Contents: Read and write
 * 可选:
 *   GITHUB_REPO_BRANCH      存储分支, 不填 = 仓库默认分支
 *   SUB_STORE_STORAGE_PREFIX              仓库内的存储目录, 默认 sub-store-data/
 *
 * ⚠️ 强烈建议使用【独立的私有数据仓库】, 不要指向 Vercel 正在部署的代码仓库:
 *    每次保存数据都会产生一个 commit, 指向部署仓库会导致 Vercel 频繁重新部署。
 *
 * 读写走 GitHub Contents API:
 *   · 读: GET /repos/{slug}/contents/{path} (带 If-None-Match 条件请求,
 *     未变化时返回 304, 不消耗 API 速率限额)
 *   · 写: PUT /repos/{slug}/contents/{path} (自动携带 sha, 冲突时刷新重试)
 * ------------------------------------------------------------------ */

const githubShaCache = new Map(); // 存储路径 -> { sha, etag, text }

function githubRepoToken() {
  return String(process.env.GITHUB_REPO_TOKEN || '').trim();
}

// 仓库名称归一化: 去掉 https://github.com/ 前缀与 .git 后缀
function githubRepoNameRaw() {
  return String(process.env.GITHUB_REPO_NAME || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '');
}

function githubRepoOwner() {
  const name = githubRepoNameRaw();
  if (name.includes('/')) return name.split('/')[0];
  return String(process.env.GITHUB_REPO_USER || '').trim();
}

function githubRepoShortName() {
  const name = githubRepoNameRaw();
  return name.includes('/') ? name.split('/')[1] : name;
}

function githubRepoSlug() {
  const owner = githubRepoOwner();
  const repo = githubRepoShortName();
  return owner && repo ? `${owner}/${repo}` : '';
}

function githubRepoBranch() {
  return String(process.env.GITHUB_REPO_BRANCH || '').trim();
}

function githubRepoHasAnyConfig() {
  return !!(
    process.env.GITHUB_REPO_USER ||
    process.env.GITHUB_REPO_NAME ||
    process.env.GITHUB_REPO_TOKEN
  );
}

function githubRepoMissingEnv() {
  const missing = [];
  if (!githubRepoToken()) missing.push('GITHUB_REPO_TOKEN');
  if (!githubRepoSlug()) {
    if (!process.env.GITHUB_REPO_NAME) {
      missing.push('GITHUB_REPO_NAME (仓库名称)');
    } else {
      missing.push(
        'GITHUB_REPO_USER (仓库名称不是 owner/repo 形式时必须提供用户名)',
      );
    }
  }
  return missing;
}

function githubRepoConfigured() {
  return githubRepoMissingEnv().length === 0;
}

function encodeRepoPath(p) {
  return String(p)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

async function githubApi(pathname, init) {
  // 超时兜底: GitHub 偶发卡顿时快速失败, 拉取用旧数据兜底, 不拖死面板请求
  const timeoutMs = (init && init.timeoutMs) || 6000;
  const { timeoutMs: _drop, ...rest } = init || {};
  return fetch(`https://api.github.com${pathname}`, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubRepoToken()}`,
      'User-Agent': 'sub-store-vercel',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init && init.headers ? init.headers : {}),
    },
  });
}

async function githubRepoReadFile(name) {
  const key = storageKey(name);
  const cached = githubShaCache.get(key);
  const ref = githubRepoBranch()
    ? `?ref=${encodeURIComponent(githubRepoBranch())}`
    : '';
  const r = await githubApi(
    `/repos/${githubRepoSlug()}/contents/${encodeRepoPath(key)}${ref}`,
    {
      headers: cached && cached.etag ? { 'If-None-Match': cached.etag } : {},
    },
  );
  // 304 = 仓库内容未变化, 直接用本实例缓存 (不消耗速率限额)
  if (r.status === 304 && cached) {
    return { text: cached.text, etag: cached.sha };
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub contents API ${r.status} (${key})`);
  const meta = await r.json();
  let text;
  if (meta.type === 'file' && meta.content && !meta.truncated) {
    text = Buffer.from(
      String(meta.content).replace(/\s+/g, ''),
      'base64',
    ).toString('utf8');
  } else if (meta.type === 'file' && meta.sha) {
    // >1MB 的文件 JSON 响应不带 content, 用 Git Blobs API 兜底 (上限 100MB)
    const b = await githubApi(
      `/repos/${githubRepoSlug()}/git/blobs/${meta.sha}`,
      { timeoutMs: 15000 },
    );
    if (!b.ok) throw new Error(`GitHub blobs API ${b.status} (${key})`);
    const blob = await b.json();
    if (blob.encoding !== 'base64' || !blob.content) return null;
    text = Buffer.from(
      String(blob.content).replace(/\s+/g, ''),
      'base64',
    ).toString('utf8');
  } else {
    return null;
  }
  const sha = String(meta.sha || '');
  githubShaCache.set(key, {
    sha,
    etag: r.headers.get('etag') || (sha ? `"${sha}"` : ''),
    text,
  });
  return { text, etag: sha };
}

async function githubRepoPutFile(name, body) {
  const key = storageKey(name);
  const slug = githubRepoSlug();
  const branch = githubRepoBranch();
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(String(body), 'utf8');
  const urlPath = `/repos/${slug}/contents/${encodeRepoPath(key)}`;

  const attempt = (sha) =>
    githubApi(urlPath, {
      method: 'PUT',
      body: JSON.stringify({
        message: `sub-store: sync ${name} (${new Date().toISOString()})`,
        content: payload.toString('base64'),
        ...(branch ? { branch } : {}),
        ...(sha ? { sha } : {}),
      }),
    });

  const cached = githubShaCache.get(key);
  let r = await attempt(cached ? cached.sha : null);

  // 409/422: 文件已存在但未带 sha, 或 sha 过期 (其它实例先写入了) →
  // 取服务端最新 sha 重试一次
  if (r.status === 409 || r.status === 422) {
    const cur = await githubApi(
      urlPath + (branch ? `?ref=${encodeURIComponent(branch)}` : ''),
      {},
    );
    const sha = cur.ok ? ((await cur.json()).sha || null) : null;
    r = await attempt(sha);
  }

  if (!r.ok) {
    let detail = '';
    try {
      detail = (await r.json()).message || '';
    } catch (e) {}
    throw new Error(`GitHub contents API ${r.status} (${key}): ${detail}`);
  }
  const j = await r.json();
  const sha = String((j.content && j.content.sha) || '');
  githubShaCache.set(key, {
    sha,
    etag: sha ? `"${sha}"` : '',
    text: payload.toString('utf8'),
  });
  // 自己刚写入的数据即最新, 后续拉取可直接按 etag 跳过
  if (name === 'sub-store.json' && sha) storageLastEtag = sha;
  return { etag: sha };
}

function storagePrefix() {
  const raw = String(
    process.env.SUB_STORE_STORAGE_PREFIX || 'sub-store-data/',
  )
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return raw ? raw + '/' : '';
}

function storageKey(name) {
  return storagePrefix() + name;
}

function storageProvider() {
  // 仅支持 GitHub 私有仓库存储; 配置不完整时为 null, 缺项在自检中明确显示
  return githubRepoConfigured() ? 'github-repo' : null;
}

function storageConfigured() {
  return !!storageProvider();
}

async function flushDataDirToStorage() {
  if (storageFlushInflight) return storageFlushInflight;
  const provider = storageProvider();
  if (!provider) return { skipped: true, configured: false };

  storageFlushInflight = (async () => {
    const dir = process.env.SUB_STORE_DATA_BASE_PATH;
    const written = new Set();
    // 上传过程中如果配置再次被修改，再循环一次，避免后写入的数据丢失。
    do {
      storageDirty = false;
      for (const name of STORAGE_FILES) {
        const fp = path.join(dir, name);
        if (!fs.existsSync(fp)) continue;
        await githubRepoPutFile(name, fs.readFileSync(fp));
        written.add(name);
      }
    } while (storageDirty);

    lastStorageStatus = {
      configured: true,
      provider,
      lastPut: Date.now(),
      files: Array.from(written),
    };
    return lastStorageStatus;
  })()
    .catch((e) => {
      // 上传失败: 保留脏标记, 后续写请求会自动重试上传, 数据不丢
      storageDirty = true;
      throw e;
    })
    .finally(() => {
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
        !globalThis.__ssStorageHydrating &&
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
    const missingEnv = githubRepoHasAnyConfig()
      ? githubRepoMissingEnv()
      : null;
    lastStorageStatus = {
      configured: false,
      provider: null,
      ...(missingEnv ? { missingEnv } : {}),
    };
    return lastStorageStatus;
  }
  const dir = process.env.SUB_STORE_DATA_BASE_PATH;
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  storageHydrating = true;
  try {
    // 两个数据文件并行拉取, 冷启动少一次 GitHub 往返
    const results = await Promise.all(
      STORAGE_FILES.map(async (name) => {
        try {
          const r = await githubRepoReadFile(name);
          if (r && r.text) {
            fs.writeFileSync(path.join(dir, name), r.text);
            return { name, etag: r.etag || '' };
          }
        } catch (e) {
          pushError('storage-hydrate:' + name, e);
        }
        return null;
      }),
    );
    for (const item of results) {
      if (!item) continue;
      got.push(item.name);
      if (item.name === 'sub-store.json') storageLastEtag = item.etag || '';
    }
  } finally {
    storageHydrating = false;
  }
  // hydrate 刚拉过即为最新, 打上节流标记, 避免首个请求立刻再拉一次
  if (got.length) storagePullAt = Date.now();
  lastStorageStatus = {
    configured: true,
    provider,
    hydrated: got,
    etag: storageLastEtag || null,
  };
  return lastStorageStatus;
}

async function pullStorageIntoMemory() {
  if (!storageConfigured()) return { skipped: 'no object storage' };
  if (storagePullInflight) return storagePullInflight;
  if (Date.now() - storagePullAt < 1500) return { skipped: 'throttled' };

  storagePullInflight = (async () => {
    const r = await githubRepoReadFile('sub-store.json');
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
      globalThis.__ssStorageHydrating = false;
    }
    storageLastEtag = r.etag || storageLastEtag;
    lastStorageStatus = {
      configured: true,
      provider: storageProvider(),
      pulled: true,
      etag: storageLastEtag,
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
    const configuredDataUrl = String(process.env.SUB_STORE_DATA_URL || '').trim();
    userDataRestoreConfigured = Boolean(configuredDataUrl);
    sharedStorageBootstrapActive = false;
    if (configuredDataUrl) process.env.SUB_STORE_DATA_URL = configuredDataUrl;

    // 共享仓库是主存储时，让官方后端从本实例刚刚 hydrate 的文件启动。
    // Sub-Store 的 DATA_URL 加载器支持绝对本地路径；这会执行 DATA_URL_POST，
    // 安装 __ssRestore，使之后每次发现 GitHub ETag 变化都能同步内存缓存。
    if (hydratedOk && storageConfigured()) {
      const localBoot = path.join(
        process.env.SUB_STORE_DATA_BASE_PATH,
        'sub-store.json',
      );
      try {
        const localText = fs.readFileSync(localBoot, 'utf8');
        if (!parseBackupPayload(localText)) {
          throw new Error('共享仓库 sub-store.json 不包含有效的 settings 数据');
        }
        process.env.SUB_STORE_DATA_URL = localBoot;
        sharedStorageBootstrapActive = true;
      } catch (e) {
        if (!configuredDataUrl) pushError('storage-bootstrap-prepare', e);
      }
    }
    try {
      require('./sub-store.min.js');
      // Sub-Store 的 DATA_URL_POST 在异步恢复完成时才安装内存恢复钩子。
      // 等待钩子就绪，避免冷启动首批 API 请求先返回旧内存数据。
      if (hydratedOk && process.env.SUB_STORE_DATA_URL) {
        const hookDeadline = Date.now() + 10000;
        while (
          typeof globalThis.__ssRestore !== 'function' &&
          Date.now() < hookDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (typeof globalThis.__ssRestore !== 'function') {
          pushError(
            'storage-restore-hook',
            new Error('共享存储启动后未能安装内存恢复钩子'),
          );
        } else {
          // 启动期恢复完成后解除写入抑制；恢复本身不应再次提交到共享仓库。
          globalThis.__ssStorageHydrating = false;
        }
      }
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
    installOpenCors(capturedApp); // 置于最前: 预检请求不触发存储拉取
    installCacheHeaders(capturedApp);
    capturedApp.__gistSyncInstalled = true;
  }

  // 写请求返回前等待共享存储 (GitHub 仓库) 上传完成，避免 Serverless 在定时器执行前冻结。
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
