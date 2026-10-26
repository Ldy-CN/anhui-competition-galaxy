# ✨ AI 定制点评 · 部署指南（DeepSeek 后端）

> 目标：访客点「生成 AI 定制点评」→ 后端查缓存 → 未命中才调 DeepSeek → **结果固化共享**。
> 成本：**同画像访客只有第一次花约 0.02 元**，之后全部命中缓存零消耗。学生月成本预计 < 5 元。

## 架构

```
访客浏览器 ──画像+精简竞赛数据──▶ Cloudflare Worker（免费后端）
                                    ├─ 命中 KV 缓存 ──▶ 直接返回（0 消耗）
                                    └─ 未命中 ──▶ 调 DeepSeek API ──▶ 结果存 KV ──▶ 返回
```

- **API Key 只存在 Worker 环境变量**，前端代码里没有任何密钥，访客扒不走。
- 页面把精简竞赛数据随请求发送，Worker 无需内置数据——数据更新自动同步。

## 部署步骤（约 15 分钟，全程免费）

### 1. Cloudflare Worker

1. 注册/登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧 **Workers & Pages → Create → Create Worker**，名字随意（如 `galaxy-ai`）→ Deploy
3. 点 **Edit code**，清空默认代码，**粘贴 `worker/deepseek-worker.js` 全部内容** → Deploy

### 2. 绑定 KV（缓存"数据库"）

1. 左侧 **Storage & Databases → KV → Create namespace**，名字填 `AI_CACHE`
2. 回到 Worker → **Settings → Bindings → Add → KV namespace**
   - Variable name 填 `KV`，Namespace 选刚建的 `AI_CACHE` → Deploy

### 3. 配置环境变量

Worker → **Settings → Variables and Secrets → Add**，逐个添加：

| 类型 | Variable name | 值 |
|---|---|---|
| **Secret**（加密） | `DEEPSEEK_KEY` | 你的 DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com) → API Keys 创建） |
| Text | `ALLOW_ORIGIN` | `https://ldy-cn.github.io` |

每次改动后 Worker 自动重新部署。

### 4. 页面接入（改 1 行）

打开 `anhui-competitions-3d.html`，搜索 `AI_ENDPOINT`，把空串改为你的 Worker 地址：

```js
const AI_ENDPOINT = 'https://galaxy-ai.你的子域名.workers.dev';
```

5. 本地 `python build.py` 重建 → 提交推送 → 手机/电脑打开网站，点任意竞赛详情里的
   **「✦ 生成 AI 定制点评」** 验证。

## 省钱机制（已内建）

| 机制 | 效果 |
|---|---|
| 画像指纹缓存（KV 永久） | 同画像组合（专业+年级+层次+技能+兴趣+目标）全站访客共享一次生成 |
| 按需触发 | 访客点按钮才调用，无人点 = 零消耗 |
| 每日限频 | 每个访客每天最多 6 次真实生成（缓存命中不计次） |
| 精简数据 | 只传 83 项竞赛的核心字段，单次约 6k tokens ≈ **0.02 元** |

## 常见问题

- **详情面板看不到 AI 区块**：`AI_ENDPOINT` 还是空串（未接入，自动隐藏）。
- **提示「该访客今日生成次数已达上限」**：限频生效，次日恢复；其他访客的同画像缓存仍可直接用。
- **提示 DeepSeek 调用失败**：检查 `DEEPSEEK_KEY` 是否有效、账户是否有余额。
- **想清空缓存重新生成**：Cloudflare → KV → `AI_CACHE` → 删除对应 key（`rec:开头`）。
