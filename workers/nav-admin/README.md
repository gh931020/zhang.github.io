# 免费导航管理 API

该 Worker 只处理管理员登录和 GitHub 内容提交；GitHub Token、管理密码和会话密钥均由 Cloudflare Secrets 保存，不会进入仓库或浏览器。

## 部署

1. 在 Cloudflare 注册免费账号并启用 `workers.dev` 子域名。
2. 进入 `workers/nav-admin`，将 `wrangler.jsonc` 中的 `ALLOWED_ORIGIN` 改为你实际的 GitHub Pages 域名；必要时也修改仓库信息。
3. 使用 Cloudflare Dashboard 创建 Worker，粘贴 `src/index.js`，并按配置页添加三个 **Secret**：
   - `ADMIN_PASSWORD`：管理页登录密码
   - `SESSION_SECRET`：至少 32 位的随机字符串
   - `GITHUB_TOKEN`：GitHub Fine-grained PAT，仅授权此仓库的 Contents 读写权限
4. 部署后获得 `https://<worker>.<account>.workers.dev`，将这个地址写入将要创建的管理页配置。

接口：`POST /auth/login`、`GET /navigation`、`PUT /navigation`。免费方案每天 100,000 次请求，足以覆盖个人维护场景。

> Token 只能作为 Cloudflare Secret 保存，绝不能写入页面、JavaScript、`wrangler.jsonc` 或 Git 仓库。
