/**
 * AI 点评生成脚本（GitHub Actions 运行）
 * 触发：新 Issue 标题以 [AI点评请求] 开头
 * 流程：解析 Issue 里的画像+竞赛列表 → 查静态库（已有指纹跳过）→ 调 DeepSeek → 合并 ai/recommendations.json → commit → 关单评论
 * 环境：DEEPSEEK_KEY（repo Secret）、ISSUE_NUMBER、GITHUB_TOKEN（自动注入）
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_BODY = process.env.ISSUE_BODY || '';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const DB_PATH = 'ai/recommendations.json';
const DB_DIR = 'ai';

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
if (!process.env.DEEPSEEK_KEY) fail('缺少 DEEPSEEK_KEY secret（仓库 Settings → Secrets → Actions 里添加）');
if (!ISSUE_NUMBER) fail('缺少 ISSUE_NUMBER');

/* ---- 解析 Issue body 中的 json 代码块 ---- */
const m = ISSUE_BODY.match(/```json\s*([\s\S]*?)```/);
if (!m) fail('Issue 中未找到 json 代码块');
let payload;
try { payload = JSON.parse(m[1].trim()); } catch (e) { fail('Issue JSON 解析失败: ' + e.message); }
const { profile, competitions } = payload || {};
if (!profile || !Array.isArray(competitions) || !competitions.length) fail('Issue 数据不完整（缺 profile 或 competitions）');

/* ---- 画像指纹（与页面端 aiFp() 同算法） ---- */
const src = [
  profile.major || '', profile.sub || '', profile.grade || '', profile.school || '',
  [...(profile.skills || [])].sort().join(','),
  [...(profile.interests || [])].sort().join(','),
  [...(profile.goals || [])].sort().join(','),
].join('|');
const fp = crypto.createHash('sha256').update(src).digest('hex').slice(0, 20);
console.log('画像指纹:', fp);

/* ---- 读静态库（不存在则空） ---- */
fs.mkdirSync(DB_DIR, { recursive: true });
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) { db = {}; }

if (db[fp] && db[fp].summary) {
  console.log('该画像已有点评，跳过生成（直接关单）');
  await closeIssue('该画像组合已有 AI 点评（全站共享），刷新页面即可看到，无需重复生成 ✅');
  process.exit(0);
}

/* ---- 调 DeepSeek ---- */
const sysPrompt =
  '你是安徽省大学生竞赛资深顾问，服务对象是机械电子工程背景为主的本科生。' +
  '给定竞赛列表 JSON（n=名称 c=类别）与用户画像，输出严格 JSON（不要 markdown 代码块），格式：' +
  '{"summary":"不超过120字的总评：结合画像点出最值得投入的2-3个方向与整体策略",' +
  '"picks":[{"name":"竞赛名（必须逐字来自列表）","reason":"不超过80字的个性化理由，必须引用画像里的具体技能/年级/目标，给出可行动建议"}],' +
  '"avoid":[{"name":"竞赛名（来自列表）","reason":"不超过40字为什么暂不建议"}]}。' +
  'picks 3-6 条按匹配度降序；avoid 0-2 条；禁止编造列表外的竞赛；禁止照抄列表原文。';

let ds;
const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: JSON.stringify({ 画像: profile, 竞赛列表: competitions }) }],
    temperature: 0.4, max_tokens: 1200,
    response_format: { type: 'json_object' },
  }),
});
if (!dsRes.ok) fail('DeepSeek 调用失败 ' + dsRes.status + ': ' + (await dsRes.text()).slice(0, 200));
try { ds = JSON.parse((await dsRes.json()).choices?.[0]?.message?.content || '{}'); }
catch (e) { fail('DeepSeek 响应解析失败: ' + e.message); }

const validNames = new Set(competitions.map(c => c.n));
const data = {
  summary: String(ds.summary || '').slice(0, 300),
  picks: (Array.isArray(ds.picks) ? ds.picks : []).filter(p => p && validNames.has(p.name)).slice(0, 6)
    .map(p => ({ name: String(p.name), reason: String(p.reason || '').slice(0, 200) })),
  avoid: (Array.isArray(ds.avoid) ? ds.avoid : []).filter(p => p && validNames.has(p.name)).slice(0, 2)
    .map(p => ({ name: String(p.name), reason: String(p.reason || '').slice(0, 120) })),
  ts: Date.now(),
};
if (!data.picks.length) fail('DeepSeek 返回内容为空');

/* ---- 合并入库 ---- */
db[fp] = data;
fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 1));

/* ---- git 提交（由 workflow 负责 add/commit/push 的部分在这里直接用命令也行；此处导出给 workflow） ---- */
fs.writeFileSync('ai/.last-fp', fp);
console.log('OK: 点评已写入', DB_PATH, '指纹', fp);

/* ---- 关单 + 评论 ---- */
async function ghApi(path, method, bodyObj) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'ai-generate-bot' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  if (!res.ok) console.error('GitHub API', path, res.status, (await res.text()).slice(0, 150));
  return res;
}
async function closeIssue(comment) {
  await ghApi(`/issues/${ISSUE_NUMBER}/comments`, 'POST', { body: comment });
  await ghApi(`/issues/${ISSUE_NUMBER}`, 'PATCH', { state: 'closed' });
}
await closeIssue('✅ AI 点评已生成并上线（约 1-2 分钟内全站生效）。刷新网站详情页即可查看你的专属点评。');
