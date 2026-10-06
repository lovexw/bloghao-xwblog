# xwblog 自托管 POC（docker-poc/）

> **这是独立实验目录**：全部内容都是新文件，不修改仓库主代码的任何文件、
> 不动根 `package.json` / `tsconfig.json`、不装任何新依赖进主工程。
> 验证完整个删掉 `docker-poc/` 即可，主工程零残留。

## 这是什么

把跑在 Cloudflare Workers（D1 + R2）上的 xwblog，**业务代码零改动**地搬到一个
普通 Node 进程里，单进程按域名跑多个完全独立的博客租户——验证「一台服务器托管
N 个博客」的可行性。Cloudflare 在目标架构里只做 DNS + CDN，不再运行代码。

```
一个 Node 进程（Docker 容器）
 ├─ Host 路由：按域名切租户
 │    ├─ data/tenants/demo.localhost/blog.db     ← D1 → node:sqlite（WAL）
 │    ├─ data/tenants/demo.localhost/uploads/    ← R2 → 磁盘目录
 │    ├─ data/tenants/main.localhost/blog.db     ← 每个租户完全独立，互不可见
 │    └─ …
 ├─ 静态资源 public/ 直出（对齐 wrangler assets 行为）
 └─ cron：每分钟定时发布；北京时间 00:30 备份/清理（复用 src/index.ts 的 scheduled）
```

## 适配层（shim）只覆盖实际用到的 API 面

对 `src/` 全量 grep 过，Workers 专有 API 的使用面就这些，两个 shim 各一两百行：

| Workers 侧 | 本 POC 侧 | 备注 |
|---|---|---|
| D1 `prepare().bind().first/all/run`、`batch`、`meta.changes/last_row_id` | Node 内置 `node:sqlite` | 行统一转普通对象（node:sqlite 返回 null 原型对象）；batch 用事务实现 |
| R2 `put/get/head/delete/list`、流式 `body`、`httpEtag`、`writeHttpMetadata` | 磁盘目录 + 旁车 `.meta.json` | 正文流式读出，导出 zip「边流边算 CRC」不变；etag 带引号，304 协商同口径 |
| `ExecutionContext.waitUntil` | 记日志的 Promise 兜底 | 经 Hono `app.fetch(req, env, ctx)` 第三参注入 |
| wrangler assets（`public/`） | server.ts 内置静态文件层 | 文件命中才返回，其余进应用 |
| `triggers.crons` | 进程内 setInterval | 分钟级扫定时发布；UTC 16:30 触发备份窗口 |

未触任何雷区的证据：`crypto.subtle`/`getRandomValues`/`TextEncoder` 是全局标准 API，
`src/` 里没有 `HTMLRewriter`/`caches`/KV/Durable Objects。

## 本地跑（不需要 Docker）

```bash
cd docker-poc
npm install          # 只装 esbuild 一个开发依赖（装在本目录，不碰主工程）
npm run build        # 打包成 dist/server.js 单文件（css/sql 以文本内联，同 Workers Text 规则）
npm start            # 默认 127.0.0.1:8787
```

浏览器直接开（`*.localhost` 现代浏览器自动解析到 127.0.0.1）：

- http://demo.localhost:8787 —— 演示租户，首次访问自动建表+播种（demo 账号 demo / demo1234）
- http://t1.localhost:8787 —— 第二个演示租户（种子内容相同，库完全独立）
- http://main.localhost:8787 —— 空库真实租户：首次进 `/admin/` 走「创建管理员」

## 冒烟验证

```bash
npm run smoke
```

覆盖：三租户健康检查、演示租户播种与 RSS、真实租户 注册→登录→发文→传图→图片回读、
**跨租户隔离**（A 租户的文章/图片在 B 租户 404）、后台 SPA 静态直出。

## 存储后端二选一：本地盘 / Cloudflare R2

每个租户独立选择图片存哪：`storage` 缺省/`"local"` = 本地磁盘目录（默认，快、零依赖）；
`"r2"` = Cloudflare R2 共享桶（服务器可随时重建、磁盘无天花板、备份自动异地）。
R2 **零出口流量费**，200GB 图片约 $3/月。

**Cloudflare 后台一次性准备（约 2 分钟）**：

1. R2 → 创建桶（如 `xwblog-images`，位置选 APAC 更近）
2. R2 概览右侧记下 **账户 ID**
3. R2 → 管理 R2 API 令牌 → 创建 API 令牌（权限：对象读和写）→ 记下**访问密钥 ID** 和**机密访问密钥**（只显示一次）

**tenants.json 切到新格式**（旧平铺格式仍兼容）：

```json
{
  "r2": {
    "accountId": "你的账户ID",
    "bucket": "xwblog-images",
    "accessKeyId": "xxx",
    "secretAccessKey": "xxx"
  },
  "tenants": {
    "poc.xiaowuleyi.com": { "demo": false, "storage": "r2" },
    "main.localhost": { "demo": false }
  }
}
```

多租户共享一个桶时按 `<域名>/` 前缀隔离，互相不可见；`chmod 600 tenants.json` 保护密钥。

**启用步骤**：

```bash
git pull && XWLBLOG_BIND=127.0.0.1 docker compose up --build -d
# 启动日志出现 [r2] 自检通过：桶 xxx 可达 即配置正确（凭据错会直接启动失败并说明原因）
# 存量图片迁移（幂等，跳过已存在；本地目录保留作回退）：
docker compose exec xwblog node docker-poc/dist/server.js --copy-local-to-r2 poc.xiaowuleyi.com
```

**顺带收益**：应用自带的每晚备份 cron 把数据库快照写进图床桶 `backups/`——桶在 R2 上时
备份自动变成异地备份。进阶（可选）：给桶绑自定义域名后，让 openresty 把 `/images/*`
映射过去，图片请求连服务器都不回源。

## Docker 跑

```bash
cd docker-poc
docker compose up --build      # 镜像约 70MB（node:26-alpine + server.js + public/）
```

数据落在 `docker-poc/data/<域名>/`（挂载进容器 `/data/tenants`）。Linux 服务器上
宿主目录属主不用手工准备——容器入口 `entrypoint.sh` 以 root 起步把数据卷 chown
给 node 后降权运行（与官方 postgres 镜像同款模式，只递归一次，之后跳过）。

## 加一个租户（新博客）

1. `tenants.json` 加一行 `"新域名": { "demo": false }`
2. 重启进程（或未来做成热加载）
3. 域名 DNS 指到这台服务器（Cloudflare 橙云代理即可）

## 与生产化的差距（POC 之外要做的事）

- **TLS**：前置 Caddy/nginx 终结 HTTPS（`X-Forwarded-Proto: https` 传进来后，
  会话 cookie 的 Secure 自动恢复）；图片可让反代直接吐 `uploads/` 目录并带
  `Cache-Control: immutable`，连应用都不过
- **CDN**：Cloudflare 橙云代理 + Cache Rule 缓存 `/images/*` 与静态资源
- **备份**：SQLite 文件 litestream 实时复制到 S3/B2，或每晚打包（现有备份逻辑也随
  cron 在跑，落每个租户的 `uploads/backups/`）
- **扩容**：进程内 SQLite 连接与租户注册表已是按需懒建形态，横向扩容时把
  「Host→租户」路由换成一致性哈希/分片即可
- **热加载租户**：当前加租户要重启进程（重启 < 1s）
- **本机验证边界**：本机无 docker，镜像构建与 compose 未实际跑过；
  单进程入口已用 Node 直接全链路验证，Linux 数据卷属主坑已由 entrypoint
  设计层修掉（macOS 本地测不出它）。首次上服务器照 `DEPLOY.md` 清单实测一遍

## 文件清单

| 文件 | 说明 |
|---|---|
| `server.ts` | 多租户入口：http 适配、Host 路由、静态资源、cron |
| `shims/d1.ts` | D1 → node:sqlite |
| `shims/r2disk.ts` | R2 → 磁盘 |
| `tenants.json` | 域名 → 租户配置（demo 种子开关） |
| `smoke.sh` | 端到端冒烟 |
| `entrypoint.sh` | 容器入口：修数据卷属主 → 降权 node 运行 |
| `Dockerfile` / `docker-compose.yml` | 容器化（构建上下文 = 仓库根目录） |
| `DEPLOY.md` | 上服务器排练清单（选型 / 步骤 / Cloudflare 配置 / 排练后事项） |
