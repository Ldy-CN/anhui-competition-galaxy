# ✨ AI 点评：工作原理与开启方法（唯一一步配置）

> AI 点评功能已内置在网站里，**只差一个 DeepSeek Key**（存放在仓库加密配置里，不会出现在任何网页代码中）。

## 它是怎么工作的（全自动）

```
访客在竞赛详情点「提交 AI 点评生成请求」
  → 自动打开 GitHub Issue（画像已预填，访客直接提交）
  → GitHub Actions 自动触发：调 DeepSeek 生成点评
  → 结果写入仓库 ai/recommendations.json（"数据库"）
  → Pages 自动重新部署，全站生效
  → 同画像的其他访客直接看到缓存结果，不重复消耗
```

无外部服务器、无域名依赖、零成本（Actions 免费额度内）。
单次生成约 6k tokens ≈ **0.02 元**，月成本预计 **< 5 元**。

## 开启方法（唯一一步，约 2 分钟）

1. 打开本仓库 → **Settings** → 左侧 **Secrets and variables → Actions**
2. 点 **「New repository secret」**
3. Name 填：`DEEPSEEK_KEY`
   Secret 填：你的 DeepSeek Key（[platform.deepseek.com](https://platform.deepseek.com) → API Keys → 创建复制）
4. 点 **Add secret** → 完成 ✅

之后任何访客请求点评都会自动生成，无需再手动干预。

## 验证

随便打开一个竞赛详情 → 点「✦ 提交 AI 点评生成请求」→ 在 GitHub 上提交那个 Issue
→ 仓库 **Actions** 标签页看到 "AI recommendation generate" 在跑（约 1 分钟）
→ 完成后 Issue 被自动关闭并评论 ✅ → 刷新网站，AI 点评出现。

## 管理缓存

- 所有已生成的点评存在仓库文件 `ai/recommendations.json`（按画像指纹索引）
- 想清掉某条：直接编辑该文件删除对应指纹段落并提交
- 想全部重来：删除该文件即可（下次请求自动重建）

## 费用参考

| 项目 | 费用 |
|---|---|
| GitHub Actions | 免费额度内（每次生成约 1 分钟，公共仓库不限时） |
| DeepSeek | 约 **0.02 元/次**；同画像命中缓存 **0 元**；月成本预计 **< 5 元** |
