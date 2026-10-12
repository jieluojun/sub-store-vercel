# Sub-Store · Vercel 一键部署

[Sub-Store](https://github.com/sub-store-org/Sub-Store)（订阅管理/格式转换）的 Vercel 部署封装：**前后端同域名、GitHub 私有仓库持久化、域名固定、自动升级**。全部网页操作，手机电脑均可，无需任何本地软件。

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

1. **务必自设私密路径**（部署时的环境变量），否则节点信息可能暴露。

2. **推荐：GitHub 私有仓库作为共享主存储**

   `/tmp` 在每个 Lambda 中相互独立，重新部署后也会清空；私有仓库是所有实例共用的持久存储。本仓库会自动把 `sub-store.json` 和 `root.json` 通过 GitHub Contents API 提交到你的私有仓库，并在冷启动/每次请求时拉取最新数据。数据带完整 commit 历史，误删可回滚，还不占用 R2 免费额度。

   **GitHub 端：**
   1. 新建一个**私有**仓库，例如 `sub-store-data`（⚠️ 必须是**独立的**数据仓库，**不要**用 Vercel 正在部署的代码仓库——每次保存数据都会产生 commit，指向部署仓库会让 Vercel 不停重新部署）。创建时勾选 **Add a README** 保证仓库非空。
   2. 创建 Token（二选一）：
      - [Classic Token](https://github.com/settings/tokens/new)：勾选 **repo** 权限（私有库必须）；
      - Fine-grained Token：只授权该仓库，权限给 **Contents: Read and write**。

   **Vercel 端：**进入项目 → **Settings → Environment Variables**，添加以下变量并重新部署：

   | 环境变量 | 填写内容 | 必填 |
   | --- | --- | --- |
   | `GITHUB_REPO_USER` | GitHub 用户名（或组织名） | `GITHUB_REPO_NAME` 为 `owner/repo` 形式时可省略 |
   | `GITHUB_REPO_TOKEN` | 上一步创建的 Token | 是 |
   | `GITHUB_REPO_NAME` | 仓库名称，纯名称 / `owner/repo` / 完整 URL 均可 | 是 |
   | `GITHUB_REPO_BRANCH` | 存储分支，不填 = 仓库默认分支 | 否 |
   | `SUB_STORE_STORAGE_PREFIX` | 仓库内存储目录，默认 `sub-store-data/` | 否 |

   不要给变量名添加 `NEXT_PUBLIC_`，也不要把密钥提交到 GitHub。配置完成后访问：

   ```text
   https://你的域名/__substore_selftest
   ```

   正常结果应包含：

   ```json
   {
     "objectStorageConfigured": true,
     "objectStorageProvider": "github-repo",
     "githubRepoConfigured": true
   }
   ```

   之后每次在面板保存订阅/配置，私有仓库的 `sub-store-data/` 目录下都会出现对应 commit，即为持久化成功。

   **速率与额度说明**：读取走条件请求（内容未变时 304，不计入限额），写入才会产生 API 调用；Token 每小时 5000 次，日常使用绰绰有余。单文件超过 100MB 无法用此 API 提交（Sub-Store 配置通常只有几十 KB，无需担心）。

3. **从旧方案（R2 / Vercel Blob）换用 GitHub 仓库**

   程序不会自动搬运旧存储里的数据。换用时：先在旧部署的面板 **我的 → 数据管理/同步** 做一次 Gist 备份 → 配置好 GitHub 仓库变量（可同时移除 R2/Blob 变量）并重新部署 → 按下面第 4 条设置 `SUB_STORE_DATA_URL`，冷启动会从 Gist 还原数据，之后在面板随便保存一次即写入私有仓库 → 确认 `sub-store-data/sub-store.json` 出现在私有仓库后，移除 `SUB_STORE_DATA_URL` 完成切换。

4. **Gist 作为额外备份/灾难恢复**
   1. 打开面板 → **我的** → **数据管理/同步** → 选 **Gist** → 填 GitHub Token（[点此创建](https://github.com/settings/tokens/new)，勾 **gist** 权限即可）→ **保存并同步/上传**；
   2. 浏览器打开 [gist.github.com](https://gist.github.com) 找到刚生成的备份 → 点 **Raw** → 复制地址栏 URL（形如 `https://gist.githubusercontent.com/用户名/<id>/raw/xxx.json`）；
   3. Vercel → **Settings → Environment Variables** 添加 `SUB_STORE_DATA_URL` = 刚复制的 Raw URL → **Deployments → Redeploy**。

   有共享存储数据时以共享存储为准；存储为空或未配置共享存储时，`SUB_STORE_DATA_URL` 可用于冷启动恢复。Raw URL 等同于备份内容，请勿泄露。

5. **兼容旧方案**：未配置任何 GitHub 仓库变量时，原来的 R2 / Vercel Blob（`BLOB_READ_WRITE_TOKEN`）逻辑仍然有效，方便平滑迁移；新部署建议直接使用 GitHub 私有仓库。

6. **自定义域名 / 任意前端**：已**完全去除 CORS 白名单拦截**——绑定任意自定义域名、或用任何第三方前端（官方在线版 `sub-store.vercel.app`、Stash 等）调用后端，均无需任何配置。⚠️ 因此**私密路径是后端唯一防线**，务必保持足够长的随机字符串；`SUB_STORE_CORS_ALLOWED_ORIGINS` 变量已无作用，无需设置。

7. **国内访问** `*.vercel.app` 空白：挂代理，或在 Settings → Domains 绑定自有域名。

8. **排查**：检查 `__substore_selftest` 的 JSON。重点查看 `objectStorageProvider`、`objectStorageStatus`、`githubRepoMissingEnv` 和 `recentErrors`。

## 📁 文件说明

| 文件 | 作用 |
| --- | --- |
| `server.js` | Serverless 入口（express 捕获 + 前端解压 + 自检/体检端点） |
| `sub-store.min.js` / `dist.zip` | 官方后端 / 前端发行文件（自动升级更新它们） |
| `version.json` | 当前版本记录（升级对比依据） |
| `update.yml` | Actions 自动升级（移入 `.github/workflows/` 生效） |
| `vercel.json` / `package*.json` | 构建路由配置 / 依赖清单 |

本项目为 GPL-3.0 官方 Sub-Store 的部署封装，版权归原作者所有。
