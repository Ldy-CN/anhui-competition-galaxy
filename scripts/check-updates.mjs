#!/usr/bin/env node
/**
 * 数据更新监控：定时抓取各赛事官网通知页，检测变化并生成提醒。
 * - 只做「变化侦测」（页面指纹对比），不自动解析/修改数据
 * - 有变化时自动在仓库开一个 Issue 提醒人工核实
 * - 运行环境：GitHub Actions（node 20，自带 fetch）或本地 node scripts/check-updates.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
    return { name: src.name, url: src.url, status: 'ok', hash: hashText(text) };
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
writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2));
console.log(`状态已写入 monitor-state.json（${changedOnes.length} 个来源有变化）`);

if (changedOnes.length) {
  const list = changedOnes.map(r => `- **${r.name}**：[${r.url}](${r.url})`).join('\n');
  await openIssue(
    `🔍 官网监控：${changedOnes.length} 个赛事来源页面有更新（${now()}）`,
    `自动监控检测到以下赛事官网页面内容发生变化，请人工核实是否有新通知，确认后更新 \`index.html\` 并推送：\n\n${list}\n\n---\n*本 Issue 由 [check-updates 工作流](https://github.com/${REPO}/actions/workflows/check-updates.yml) 自动创建。核实完成后请关闭此 Issue。*`
  );
}
console.log('done');
