// Сводка SpotBugs/FindSecBugs по XML-отчётам: категория, приоритет, тип, место.
// node tools/sast/spotbugs-summary.mjs docs/lab5/before/spotbugs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const rows = [];
for (const f of readdirSync(dir).filter(f => f.endsWith('.xml'))) {
  const x = readFileSync(path.join(dir, f), 'utf8');
  for (const m of x.matchAll(/<BugInstance ([^>]*)>([\s\S]*?)<\/BugInstance>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(v => [v[1], v[2]]));
    const src = m[2].match(/<SourceLine [^>]*sourcepath="([^"]*)"[^>]*?(?:start="(\d+)")?[^>]*\/>/);
    const line = m[2].match(/<SourceLine [^>]*start="(\d+)"/);
    rows.push({ module: f.replace('.xml', ''), category: a.category, priority: a.priority, rank: +a.rank, type: a.type,
      where: (src ? src[1] : '?') + ':' + (line ? line[1] : '') });
  }
}
const by = (k) => rows.reduce((o, r) => (o[r[k]] = (o[r[k]] || 0) + 1, o), {});
console.log('Всего', rows.length);
console.log('По категориям', JSON.stringify(by('category')));
console.log('По приоритету (1=High,2=Medium,3=Low)', JSON.stringify(by('priority')));
if (process.argv.includes('--list')) for (const r of rows.sort((a, b) => a.priority - b.priority || a.rank - b.rank))
  console.log(`${r.priority} r${r.rank} ${r.category} ${r.type} ${r.module} ${r.where}`);
