# Sub-Store · Vercel 一键部署

[Sub-Store](https://github.com/sub-store-org/Sub-Store)（订阅管理/格式转换）的 Vercel 部署封装：**前后端同域名、域名固定、自动升级**。全部网页操作，手机电脑均可，无需任何本地软件。

## 🚀 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjieluojun%2Fsub-store-vercel&env=SUB_STORE_FRONTEND_BACKEND_PATH&envDescription=后端私密路径，相当于管理密码，填一串长随机字符（如%20Kx9f2mQ7pL4wR8eT）&project-name=sub-store-vercel&repository-name=sub-store-vercel)

点击按钮 → Vercel 会 Fork 本仓库 → 环境变量 `SUB_STORE_FRONTEND_BACKEND_PATH` 填**一串长随机字符**（= 管理密码）→ **Deploy**。

**手动部署**：[vercel.com/new](https://vercel.com/new) → Import 本仓库 → 同上设环境变量 → Deploy。
⚠️ 不要用 /new 页的拖拽上传（会产生一次性项目）。

## ✅ 部署后使用

```
自检:  https://域名/__substore_selftest        → backendLoaded/expressAppCaptured 为 true 即正常
面板:  https://域名/?api=https://域名/你的私密路径   → 打开一次前端即记住后端
版本体检: https://域名/你的私密路径/__update     → 查看前后端是否为最新(只读)
```

## 🤖 自动升级（定时 + 手动）

把仓库根目录的 **`update.yml`** 在网页上移动到 `.github/workflows/update.yml`：打开该文件 → ✏️ 编辑 → 文件名输入框改路径（输入 `/` 自动建目录）→ Commit。

| 方式 | 说明 |
| --- | --- |
| 定时 | 每天北京时间 9:00 自动检查官方最新版 |
| 手动 | 仓库 → Actions → 更新 Sub-Store → **Run workflow**（手机可点） |

逻辑：读 `version.json` 对比官方 Release，**已是最新则跳过不拉取**；有新版才下载、提交回仓库，Vercel 随即自动重新部署（域名不变）。

## ⚠️ 必读

1. **务必自设私密路径**（部署时的环境变量），否则节点信息全网裸奔。
2. **数据持久化（Gist 自动备份还原，一次配置）**：
   1. 打开面板 → **我的** → **数据管理/同步** → 选 **Gist** → 填 GitHub Token（[点此创建](https://github.com/settings/tokens/new)，勾 **gist** 权限即可）→ **保存并同步/上传**；
   2. 浏览器打开 [gist.github.com](https://gist.github.com) 找到刚生成的备份 → 点 **Raw** → 复制地址栏 URL（形如 `https://gist.githubusercontent.com/用户名/<id>/raw/xxx.json`）；
   3. Vercel → **Settings → Environment Variables** 添加 `SUB_STORE_DATA_URL` = 刚复制的 Raw URL → **Deployments → Redeploy**。
   ✅ 之后**每次重新部署/冷启动都会自动从 Gist 拉取最新备份还原**。注意：改动配置后记得再到面板点一次同步，未同步的改动会被下次启动时的 Gist 备份覆盖；Raw URL 别泄漏（等同于备份内容）。

5. **推荐：用 Vercel Blob 当共享盘（解决刷新「上次上传」乱跳）**  
   `/tmp` 每个 Lambda 一份，Blob 是全项目共用。  
   1. Vercel 项目 → **Storage → Create Database → Blob** → 接到本项目（会自动注入 `BLOB_READ_WRITE_TOKEN`）；  
   2. 把本仓库更新后的 `server.js` / `package.json` 推上去并 Redeploy；  
   3. 打开 `https://域名/__substore_selftest`，应看到 `blobConfigured: true`，`blobStatus.hydrated` 或 `lastPut` 有值。  
   之后改配置会自动写入 Blob，其它实例打开面板会拉同一份，不必再靠 Gist 当主库。Gist 仍可作额外备份。
3. **国内访问** `*.vercel.app` 空白：挂代理，或在 Settings → Domains 绑自有域名（Cloudflare 托管 DNS 可直连）。
4. 排查：发我 `__substore_selftest` 的 JSON 即可定位（`dataRestoreConfigured: true` 表示自动还原已配置）。

## 📁 文件说明

| 文件 | 作用 |
| --- | --- |
| `server.js` | Serverless 入口（express 捕获 + 前端解压 + 自检/体检端点） |
| `sub-store.min.js` / `dist.zip` | 官方后端 / 前端发行文件（自动升级更新它们） |
| `version.json` | 当前版本记录（升级对比依据） |
| `update.yml` | Actions 自动升级（移入 `.github/workflows/` 生效） |
| `vercel.json` / `package*.json` | 构建路由配置 / 依赖清单 |

本项目为 GPL-3.0 官方 Sub-Store 的部署封装，版权归原作者所有。
