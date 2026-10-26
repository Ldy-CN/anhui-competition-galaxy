#!/usr/bin/env node
/**
 * 将 ai/data-meta.json（DeepSeek 自动更新的字段覆盖）合并进 index.html 的 META 对象。
 * 运行时机：① pages.yml 部署前（Actions）② 本地 build.py 构建后
 * 幂等：同一条目重复运行时替换已有 AI 覆盖行，不累积。
 * 无数据文件或无内容时静默退出（退出码 0）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META_PATH = join(ROOT, 'ai', 'data-meta.json');
const INDEX = join(ROOT, 'index.html');

if (!existsSync(META_PATH)) { console.log('apply-ai-meta: 无 ai/data-meta.json，跳过'); process.exit(0); }
let metaDb;
try { metaDb = JSON.parse(readFileSync(META_PATH, 'utf-8')); } catch (e) { console.log('apply-ai-meta: meta 文件损坏，跳过'); process.exit(0); }
const names = Object.keys(metaDb || {});
if (!names.length) { console.log('apply-ai-meta: meta 为空，跳过'); process.exit(0); }

let html = readFileSync(INDEX, 'utf-8');
const anchor = html.indexOf('Object.keys(META)');
if (anchor < 0) { console.log('apply-ai-meta: index.html 无 META 段，跳过'); process.exit(0); }
const close = html.lastIndexOf('};', anchor);
if (close < 0) { console.log('apply-ai-meta: 未找到 META 闭合，跳过'); process.exit(0); }

let applied = 0, replaced = 0;
for (const name of names) {
  const v = metaDb[name];
  const fields = {};
  ['sS', 'sE', 'when', 'team', 'site', 'lvl'].forEach(k => { if (v[k] !== undefined) fields[k] = v[k]; });
  if (!Object.keys(fields).length) continue;
  const escName = name.replace(/'/g, "\\'");
  const line = `\n  '${escName}': ${JSON.stringify(fields).replace(/"/g, "'")},   // 🤖 AI 更新 ${new Date(v._ts || Date.now()).toISOString().slice(0, 10)}: ${String(v._aiSummary || '').slice(0, 60)}`;
  // 幂等：替换已有同名 AI 行（匹配 `'条目名': {...},   // 🤖 AI 更新`）
  const rowRe = new RegExp(`\\n  '${escName.replace(/[.*+?^${}()|[\]\\\\]/g, '\\$&')}': \\{[^}]*\\},   // 🤖 AI 更新[^\\n]*`);
  if (rowRe.test(html)) { html = html.replace(rowRe, line); replaced++; }
  else { html = html.slice(0, close) + line + '\n' + html.slice(close); applied++; }
}

writeFileSync(INDEX, html);
console.log(`apply-ai-meta: 新增 ${applied} 条，替换 ${replaced} 条`);
