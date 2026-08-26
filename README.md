# Sub-Store · Vercel 一键部署

[Sub-Store](https://github.com/sub-store-org/Sub-Store)（订阅管理/格式转换）的 Vercel 部署封装：**前后端同域名、Cloudflare R2 持久化、域名固定、自动升级**。全部网页操作，手机电脑均可，无需任何本地软件。

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

2. **推荐：Cloudflare R2 作为共享主存储**

   `/tmp` 在每个 Lambda 中相互独立，重新部署后也会清空；R2 是所有实例共用的持久对象存储。本仓库会自动把 `sub-store.json` 和 `root.json` 保存到 R2，并在冷启动时恢复。

   **Cloudflare 端：**
   1. 进入 Cloudflare 控制台 → **R2 Object Storage** → 新建一个存储桶，例如 `sub-store`；存储桶不需要开放公共访问。
   2. 在 R2 的 API Token 管理页面创建 Token，权限选择 **Object Read & Write**，最好只授权刚创建的存储桶。
   3. 保存页面给出的 **Access Key ID** 和 **Secret Access Key**；Secret 通常只显示一次。

   **Vercel 端：**进入项目 → **Settings → Environment Variables**，添加以下变量并重新部署：

   | 环境变量 | 填写内容 | 必填 |
   | --- | --- | --- |
   | `R2_ACCOUNT_ID` | Cloudflare Account ID | 是 |
   | `R2_ACCESS_KEY_ID` | R2 API Token 的 Access Key ID | 是 |
   | `R2_SECRET_ACCESS_KEY` | R2 API Token 的 Secret Access Key | 是 |
   | `R2_BUCKET_NAME` | 存储桶名称，例如 `sub-store` | 是 |
   | `R2_ENDPOINT` | 自定义 S3 端点；不填时根据 Account ID 自动生成 | 否 |
   | `R2_PREFIX` | 对象目录，默认 `sub-store-data/` | 否 |

   不要给变量名添加 `NEXT_PUBLIC_`，也不要把密钥提交到 GitHub。配置完成后访问：

   ```text
   https://你的域名/__substore_selftest
   ```

   正常结果应包含：

   ```json
   {
     "objectStorageConfigured": true,
     "objectStorageProvider": "cloudflare-r2",
     "r2Configured": true
   }
   ```

   R2 配置优先级高于 Vercel Blob。只要填写了任意一个 R2 变量但配置不完整，程序不会静默退回 Blob；自检中的 `r2MissingEnv` 会列出缺少的变量。

3. **从 Vercel Blob 迁移到 R2**
   1. 迁移前先在面板的 **我的 → 数据管理/同步** 中做一次 Gist 备份。
   2. 暂时保留项目原来的 Blob 连接和 `BLOB_READ_WRITE_TOKEN`，再添加上述四个 R2 变量并重新部署。
   3. 如果 R2 中没有数据，程序会尝试从旧 Blob 读取并一次性复制到 R2；自检的 `objectStorageStatus.migratedFrom` 会显示 `vercel-blob`。
   4. 在 R2 存储桶中确认出现 `sub-store-data/sub-store.json`（通常还会有 `root.json`），并在面板修改一次配置确认可以正常读写。
   5. 确认成功后，可以从 Vercel 项目断开旧 Blob 存储。

   如果 Blob 已经无法读取，可使用下面的 Gist 备份还原；R2 为空时，从 Gist 恢复的数据会自动写入 R2。

4. **Gist 作为额外备份/灾难恢复**
   1. 打开面板 → **我的** → **数据管理/同步** → 选 **Gist** → 填 GitHub Token（[点此创建](https://github.com/settings/tokens/new)，勾 **gist** 权限即可）→ **保存并同步/上传**；
   2. 浏览器打开 [gist.github.com](https://gist.github.com) 找到刚生成的备份 → 点 **Raw** → 复制地址栏 URL（形如 `https://gist.githubusercontent.com/用户名/<id>/raw/xxx.json`）；
   3. Vercel → **Settings → Environment Variables** 添加 `SUB_STORE_DATA_URL` = 刚复制的 Raw URL → **Deployments → Redeploy**。

   有 R2 数据时以 R2 为准；R2 为空或未配置共享存储时，`SUB_STORE_DATA_URL` 可用于冷启动恢复。Raw URL 等同于备份内容，请勿泄露。

5. **兼容 Vercel Blob**：未配置任何 R2 变量时，原来的 `BLOB_READ_WRITE_TOKEN` 逻辑仍然有效，方便平滑迁移；新部署建议直接使用 R2。

6. **国内访问** `*.vercel.app` 空白：挂代理，或在 Settings → Domains 绑定自有域名。

7. **排查**：检查 `__substore_selftest` 的 JSON。重点查看 `objectStorageProvider`、`objectStorageStatus`、`r2MissingEnv` 和 `recentErrors`。

## 📁 文件说明

| 文件 | 作用 |
| --- | --- |
| `server.js` | Serverless 入口（express 捕获 + 前端解压 + 自检/体检端点） |
| `sub-store.min.js` / `dist.zip` | 官方后端 / 前端发行文件（自动升级更新它们） |
| `version.json` | 当前版本记录（升级对比依据） |
| `update.yml` | Actions 自动升级（移入 `.github/workflows/` 生效） |
| `vercel.json` / `package*.json` | 构建路由配置 / 依赖清单 |

本项目为 GPL-3.0 官方 Sub-Store 的部署封装，版权归原作者所有。
