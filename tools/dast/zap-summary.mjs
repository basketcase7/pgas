// Сводка отчёта ZAP (-J): риск, pluginid, название, число мест, пример URL.
// node tools/dast/zap-summary.mjs docs/lab5/before/zap/api-auth.json
import { readFileSync } from 'node:fs';
const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n# ${f}`);
  const cnt = { High: 0, Medium: 0, Low: 0, Informational: 0 };
  for (const site of r.site || []) for (const a of site.alerts || []) {
    const risk = RISK[a.riskcode]; cnt[risk]++;
    const inst = a.instances || [];
    console.log(`${risk}\t${a.pluginid}\t${a.alert}\tcwe=${a.cweid}\tx${inst.length}\t${inst[0] ? inst[0].method + ' ' + inst[0].uri : ''}${inst[0]?.param ? ' [' + inst[0].param + ']' : ''}`);
  }
  console.log('Итого по уровням:', JSON.stringify(cnt));
}
