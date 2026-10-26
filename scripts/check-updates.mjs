#!/usr/bin/env node
/**
 * 数据更新监控：定时抓取各赛事官网通知页，检测变化并生成提醒。
 * - 只做「变化侦测」（页面指纹对比），不自动解析/修改数据
 * - 有变化时自动在仓库开一个 Issue 提醒人工核实
 * - 运行环境：GitHub Actions（node 20，自带 fetch）或本地 node scripts/check-updates.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = JSON.parse(readFileSync(join(ROOT, 'monitor', 'sources.json'), 'utf-8'));
const STATE_FILE = join(ROOT, 'monitor', 'monitor-state.json');
const REPO = process.env.GITHUB_REPOSITORY || 'Ldy-CN/anhui-competition-galaxy';
const TOKEN = process.env.GITHUB_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const hashText = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function probe(src) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return { name: src.name, url: src.url, status: 'http-' + res.status };
    const text = htmlToText(await res.text()).slice(0, 6000);
    return { name: src.name, url: src.url, status: 'ok', hash: hashText(text), text };
  } catch (e) {
    return { name: src.name, url: src.url, status: 'error', error: String(e.message || e).slice(0, 80) };
  }
}

async function openIssue(title, body) {
  if (!TOKEN) { console.log('(无 GITHUB_TOKEN，跳过开 Issue)'); return; }
  try {
    // 防轰炸：已有 3 个以上未关闭的监控 Issue 则不再新建
    const q = encodeURIComponent(`repo:${REPO} is:issue is:open label:monitor`);
    const res = await fetch(`https://api.github.com/search/issues?q=${q}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
    });
    if (res.ok) {
      const data = await res.json();
      if ((data.total_count || 0) >= 3) { console.log('已有 3 个未关闭的监控 Issue，跳过新建'); return; }
    }
    const res2 = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
      body: JSON.stringify({ title, body, labels: ['monitor'] }),
    });
    console.log('Issue 创建:', res2.status);
  } catch (e) { console.log('开 Issue 失败:', e.message); }
}

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  : { lastCheck: null, sources: {} };

console.log(`监控 ${SOURCES.length} 个来源，开始检查 @ ${now()}`);
const results = [];
for (const src of SOURCES) {
  const r = await probe(src);
  const prev = state.sources[src.name];
  r.changed = false;
  if (r.status === 'ok' && prev && prev.hash && prev.hash !== r.hash) {
    r.changed = true;
    r.lastChanged = now();
  }
  results.push(r);
  console.log(`${r.changed ? '★变化' : (r.status === 'ok' ? ' 无变化' : ' ✗' + r.status)}  ${src.name}`);
  await new Promise(res => setTimeout(res, 1500)); // 控制请求节奏
}

const changedOnes = results.filter(r => r.changed);
const newState = {
  lastCheck: new Date().toISOString(),
  sources: Object.fromEntries(results.map(r => [r.name, {
    hash: r.hash || (state.sources[r.name] || {}).hash || '',
    lastChanged: r.changed ? r.lastChanged : (state.sources[r.name] || {}).lastChanged || '',
    lastStatus: r.status,
  }])),
};

/* ---- DeepSeek 站长侧数据更新：检测到官网变化 → AI 比对新内容 → 更新 META 覆盖字段 ---- */
let aiSummaryLines = [];
if (changedOnes.length && process.env.DEEPSEEK_KEY) {
  try {
    // 当前数据库条目（从 index.html 提取 DATA 摘要字段）
    const idx = readFileSync(join(ROOT, 'index.html'), 'utf-8');
    const mData = idx.match(/const DATA = \[([\s\S]*?)\n\];/);
    const entries = [];
    if (mData) {
      const re = /name:\s*'((?:[^'\\]|\\.)*)'\s*,\s*cat:\s*'(\w+)'[\s\S]*?sS:'([\d-]+)',\s*sE:'([\d-]+)'[\s\S]*?when:'([^']*)'[\s\S]*?team:'((?:[^'\\]|\\.)*)'/g;
      let mm;
      while ((mm = re.exec(mData[1])) !== null)
        entries.push({ name: mm[1].replace(/\\'/g, "'"), c: mm[2], sS: mm[3], sE: mm[4], when: mm[5], team: mm[6] });
    }
    console.log('数据库条目提取:', entries.length);

    const changes = changedOnes.filter(r => r.text && r.text.length > 80).map(r => ({
      source: r.name, url: r.url, newContent: r.text.slice(0, 2500),
    }));
    if (changes.length && entries.length) {
      const sysPrompt =
        '你是竞赛数据库维护员。数据库存有安徽省大学生竞赛条目（name/c 类别/sS 报名开始 MM-DD/sE 报名结束/when 比赛节奏/team 组队/lvl 级别）。' +
        '现提供若干「官网页面的最新文本」（刚检测到内容变化的来源）。' +
        '任务：仅当新文本中**明确出现**与某条目相关的最新信息（报名日期调整、比赛时间、组队规则、官网渠道变化等），才输出对该条目的字段更新。' +
        '严格输出 JSON（不要 markdown 代码块）：' +
        '{"updates":[{"name":"条目名（逐字来自数据库）","fields":{"sS":"MM-DD","sE":"MM-DD","when":"...","team":"...","site":"..."},"summary":"不超过50字变更摘要"}]}。' +
        '规则：sS/sE 必须是 MM-DD 格式；fields 只放确有变化的字段；推断不出就返回 {"updates":[]}；' +
        '禁止编造日期与规则；宁可漏报不可误报。';
      const userPrompt = JSON.stringify({ 数据库条目: entries, 官网变化: changes });

      const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.2, max_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
      });
      if (dsRes.ok) {
        const out = JSON.parse((await dsRes.json()).choices?.[0]?.message?.content || '{}');
        const updates = (Array.isArray(out.updates) ? out.updates : [])
          .filter(u => u && u.name && u.fields && typeof u.fields === 'object');
        console.log('DeepSeek 建议更新:', updates.length, '条');
        if (updates.length) {
          const validKeys = new Set(entries.map(e => e.name));
          const META_PATH = join(ROOT, 'ai', 'data-meta.json');
          let metaDb = {};
          try { metaDb = JSON.parse(readFileSync(META_PATH, 'utf-8')); } catch (e) { metaDb = {}; }
          let n = 0;
          for (const u of updates) {
            if (!validKeys.has(u.name)) continue;
            const f = {};
            ['sS', 'sE'].forEach(k => { if (/^\d{2}-\d{2}$/.test(String(u.fields[k] || ''))) f[k] = u.fields[k]; });
            ['when', 'team', 'site', 'lvl'].forEach(k => {
              if (typeof u.fields[k] === 'string' && u.fields[k].trim()) f[k] = u.fields[k].trim().slice(0, 120);
            });
            if (!Object.keys(f).length) continue;
            metaDb[u.name] = { ...f, _aiSummary: String(u.summary || '').slice(0, 80), _ts: Date.now() };
            n++;
            console.log('  更新:', u.name, JSON.stringify(f));
          }
          if (n) {
            fs.mkdirSync(join(ROOT, 'ai'), { recursive: true });
            writeFileSync(META_PATH, JSON.stringify(metaDb, null, 1));
            newState.dataUpdatedAt = new Date().toISOString();
            aiSummaryLines = Object.entries(metaDb).filter(([,v]) => v._aiSummary).slice(-n)
              .map(([name, v]) => `- **${name}**：${v._aiSummary}（${Object.keys(v).filter(k=>!k.startsWith('_')).join('/')}）`);
            console.log('ai/data-meta.json 已更新:', n, '条');
          }
        }
      } else {
        console.log('DeepSeek 调用失败', dsRes.status, '（跳过 AI 更新，走人工流程）');
      }
    }
  } catch (e) {
    console.log('AI 更新环节异常（不影响主流程）:', String(e).slice(0, 150));
  }
}
if (!newState.dataUpdatedAt && state.dataUpdatedAt) newState.dataUpdatedAt = state.dataUpdatedAt;   // 保留历史更新日期

writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
console.log(`状态已写入 monitor-state.json（${changedOnes.length} 个来源有变化）`);

if (changedOnes.length) {
  const aiNote = aiSummaryLines.length
    ? '\n\n🤖 **DeepSeek 已根据官网新内容自动更新以下数据库字段**（写入 META，可回滚）：\n' + aiSummaryLines.join('\n') + '\n请人工复核。'
    : '\n\n🤖 AI 已比对新内容：**未发现需要更新的数据库字段**（可能是页面无关改动）。请人工确认。';
  const list = changedOnes.map(r => `- **${r.name}**：[${r.url}](${r.url})`).join('\n');
  await openIssue(
    `🔍 官网监控：${changedOnes.length} 个赛事来源页面有更新（${now()}）`,
    `自动监控检测到以下赛事官网页面内容发生变化：\n\n${list}${aiNote}\n\n---\n*本 Issue 由 [check-updates 工作流](https://github.com/${REPO}/actions/workflows/check-updates.yml) 自动创建。核实完成后请关闭此 Issue。*`
  );
}
console.log('done');
