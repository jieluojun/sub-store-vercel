# Sub-Store · Vercel 一键部署

[Sub-Store](https://github.com/sub-store-org/Sub-Store)（订阅管理/格式转换）的 Vercel 部署封装：**前后端同域名、Cloudflare R2 / Vercel Global Config 持久化、域名固定、自动升级**。全部网页操作，手机电脑均可，无需任何本地软件。

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

   自动模式的存储优先级为 **R2 → Global Config（配置写 Token 后）→ Vercel Blob**。只要填写了任意一个 R2 变量但配置不完整，程序不会静默回退；自检中的 `r2MissingEnv` 会列出缺少的变量。

3. **可选：使用 Vercel Global Config 存储**

   Global Config（原 Edge Config）适合**读取频繁、修改较少**的配置。每个 Store 最大 1 MB，写入后全球同步最长可能需要约 10 秒；如果数据接近 1 MB 或经常修改，仍建议使用 R2。

   1. Vercel 项目 → **Storage → Create Database → Global Config**，创建并连接到当前项目。连接后 Vercel 会自动添加 `GLOBAL_CONFIG` 环境变量。
   2. 在 Vercel 的 API Token 页面创建一个有权访问该账户/Team 的 Token，并在项目环境变量中添加 `GLOBAL_CONFIG_WRITE_TOKEN`。Global Config 自动生成的连接字符串只能读取，写入必须使用 API Token。
   3. 添加 `SUB_STORE_STORAGE_PROVIDER=global-config`，然后重新部署。
   4. 如果 Store 属于 Team 且写入提示无权限，再添加 `GLOBAL_CONFIG_TEAM_ID=team_xxx`。

   | 环境变量 | 填写内容 | 必填 |
   | --- | --- | --- |
   | `SUB_STORE_STORAGE_PROVIDER` | `global-config` | 是 |
   | `GLOBAL_CONFIG` | 连接 Store 后由 Vercel 自动添加 | 是 |
   | `GLOBAL_CONFIG_WRITE_TOKEN` | Vercel API Token，请保存为 Secret | 是 |
   | `GLOBAL_CONFIG_TEAM_ID` | Store 所属 Team ID | Team 项目按需 |
   | `GLOBAL_CONFIG_ID` | `ecfg_...`；通常可从连接字符串自动识别 | 否 |
   | `GLOBAL_CONFIG_ITEM_PREFIX` | 键名前缀，默认 `sub_store` | 否 |

   数据保存为两个 Item：`sub_store_data` 和 `sub_store_root`。建议使用专用 Store，不要和其它应用配置混用。配置成功后，自检应包含：

   ```json
   {
     "objectStorageConfigured": true,
     "objectStorageProvider": "vercel-global-config",
     "globalConfigConfigured": true
   }
   ```

   程序会把两个文件合并为一次 PATCH，以减少写入次数。旧的 `EDGE_CONFIG` 连接字符串也兼容。不要将 `GLOBAL_CONFIG_WRITE_TOKEN` 提交到 GitHub，或添加 `NEXT_PUBLIC_` 前缀。

   **迁移现有数据到 Global Config：**先在面板生成最新 Gist 备份并设置 `SUB_STORE_DATA_URL`，然后启用上述 Global Config 环境变量并重新部署。Store 为空时，Gist 恢复的数据会自动写入 Global Config。

4. **从 Vercel Blob 迁移到 R2**
   1. 迁移前先在面板的 **我的 → 数据管理/同步** 中做一次 Gist 备份。
   2. 暂时保留项目原来的 Blob 连接和 `BLOB_READ_WRITE_TOKEN`，再添加上述四个 R2 变量并重新部署。
   3. 如果 R2 中没有数据，程序会尝试从旧 Blob 读取并一次性复制到 R2；自检的 `objectStorageStatus.migratedFrom` 会显示 `vercel-blob`。
   4. 在 R2 存储桶中确认出现 `sub-store-data/sub-store.json`（通常还会有 `root.json`），并在面板修改一次配置确认可以正常读写。
   5. 确认成功后，可以从 Vercel 项目断开旧 Blob 存储。

   如果 Blob 已经无法读取，可使用下面的 Gist 备份还原；R2 为空时，从 Gist 恢复的数据会自动写入 R2。

5. **Gist 作为额外备份/灾难恢复**
   1. 打开面板 → **我的** → **数据管理/同步** → 选 **Gist** → 填 GitHub Token（[点此创建](https://github.com/settings/tokens/new)，勾 **gist** 权限即可）→ **保存并同步/上传**；
   2. 浏览器打开 [gist.github.com](https://gist.github.com) 找到刚生成的备份 → 点 **Raw** → 复制地址栏 URL（形如 `https://gist.githubusercontent.com/用户名/<id>/raw/xxx.json`）；
   3. Vercel → **Settings → Environment Variables** 添加 `SUB_STORE_DATA_URL` = 刚复制的 Raw URL → **Deployments → Redeploy**。

   有共享存储数据时以共享存储为准；存储为空或未配置时，`SUB_STORE_DATA_URL` 可用于冷启动恢复。Raw URL 等同于备份内容，请勿泄露。

6. **兼容 Vercel Blob**：未选择 R2 或 Global Config 时，原来的 Blob 逻辑仍然有效，方便平滑迁移。

7. **国内访问** `*.vercel.app` 空白：挂代理，或在 Settings → Domains 绑定自有域名。

8. **排查**：检查 `__substore_selftest` 的 JSON。重点查看 `objectStorageRequestedProvider`、`objectStorageProvider`、`objectStorageStatus`、`globalConfigMissingEnv`、`r2MissingEnv` 和 `recentErrors`。

## 📁 文件说明

| 文件 | 作用 |
| --- | --- |
| `server.js` | Serverless 入口（express 捕获 + 前端解压 + 自检/体检端点） |
| `sub-store.min.js` / `dist.zip` | 官方后端 / 前端发行文件（自动升级更新它们） |
| `version.json` | 当前版本记录（升级对比依据） |
| `update.yml` | Actions 自动升级（移入 `.github/workflows/` 生效） |
| `vercel.json` / `package*.json` | 构建路由配置 / 依赖清单 |
| `.env.example` | R2、Global Config、Gist 环境变量示例 |

本项目为 GPL-3.0 官方 Sub-Store 的部署封装，版权归原作者所有。
