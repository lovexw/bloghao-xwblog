# 工作日志 · 2026-10-17 大事批次二（断点记录）

> **这份文档是本批次的断点记录与恢复指南**——每个检查点一行，出问题可逐件回退。
> 恢复点：分支 `backup/20261017-pre-batch`（= a6c04bc，WXR 导入完成后、本批次开始前的完整快照，已推 origin）。
> **整批回退**：`git checkout main && git reset --hard backup/20261017-pre-batch && git push --force-with-lease origin main`（强推 = 主站回滚部署，慎用）。
> **单件回退**：`git revert <该件的提交哈希>`（每件一个独立提交，可单独撤销）。

## 批次目标（站长指令：自选 3-5 件长期价值最高的事）

1. **B22 旧 slug 301**——文章改 slug 后旧链接永久 301，SEO 断链止痛。
2. **B13 管理员安全包**——TOTP 两步验证 + 活跃会话管理 + 登录失败 TG 告警（招牌焊牢）。
3. **后台 PWA 可安装（C10）**——手机操作站长的「像 App」收尾。
4. **B3 通知渠道三插件**——飞书 / 企业微信 / Bark 官方通知插件（国内触达）。

emlog / Typecho 导入（B5 第二批）**刻意押后**：两家系统没有 WXR 那样的标准导出格式（都是 MySQL dump），拿不到真实备份样本盲写解析器风险大，待拿到样本再开工。

## 检查点

- [x] **CP0 · 2026-10-17** 基线 a6c04bc（typecheck ✓ / test 797/797 / smoke 265/265，主站部署中）。备份分支 `backup/20261017-pre-batch` 已推 origin；本工作日志建立。
- [x] **CP1 · B22 旧 slug 301**——提交见 git log（feat(slug)）；800/800 + smoke 268/268 全绿，已推 origin
- [x] **CP2 · B13 管理员安全包**——806/806 + smoke 268/268 全绿，已推 origin（含 smoke 301 用例真实 slug 修复）
- [ ] **CP3 · 后台 PWA**
- [ ] **CP4 · B3 通知三插件**
- [ ] **CP5 · 收工**（AGENTS/AI-COLLAB 收工动作 + 本日志终稿）

## 恢复速查

| 想恢复到 | 动作 |
| --- | --- |
| 本批次开始前（WXR 导入完成态） | `git reset --hard backup/20261017-pre-batch` + 强推 origin（回滚主站） |
| 撤销单件 | `git revert <提交>`（每件独立提交） |
| 只想要代码不要功能 | 对应功能全部有 settings / 无 schema 破坏性变更则可退；涉及加列的（B22 的 posts.old_slugs）列留在库里无害（默认 `[]`） |
