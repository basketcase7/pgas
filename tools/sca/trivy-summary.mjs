// Сводка Trivy: уровни по образам и список High/Critical (уникальные CVE+пакет).
// node tools/sca/trivy-summary.mjs docs/lab5/before/trivy [--hc] [--json out.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const sev = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const all = [];
console.log(['образ', ...sev, 'всего'].join('\t'));
for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const r = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const cnt = Object.fromEntries(sev.map(s => [s, 0])); const seen = new Set();
  for (const res of r.Results || []) for (const v of res.Vulnerabilities || []) {
    const k = v.VulnerabilityID + '|' + v.PkgName + '|' + v.InstalledVersion + '|' + (v.PkgPath || res.Target);
    if (seen.has(k)) continue; seen.add(k);
    cnt[v.Severity]++;
    all.push({ image: r.ArtifactName, target: res.Target, type: res.Type, cls: res.Class, id: v.VulnerabilityID, pkg: v.PkgName,
      installed: v.InstalledVersion, fixed: v.FixedVersion || '', sev: v.Severity, path: v.PkgPath || '', title: (v.Title || '').slice(0, 90),
      cvss: v.CVSS?.nvd?.V3Vector || v.CVSS?.ghsa?.V3Vector || v.CVSS?.redhat?.V3Vector || '', score: v.CVSS?.nvd?.V3Score || v.CVSS?.ghsa?.V3Score || '' });
  }
  console.log([r.ArtifactName, ...sev.map(s => cnt[s]), sev.reduce((a, s) => a + cnt[s], 0)].join('\t'));
}
if (process.argv.includes('--hc')) {
  for (const v of all.filter(v => v.sev === 'CRITICAL' || v.sev === 'HIGH').sort((a, b) => a.image.localeCompare(b.image) || a.sev.localeCompare(b.sev)))
    console.log(`${v.sev}\t${v.image}\t${v.cls}/${v.type}\t${v.id}\t${v.pkg}\t${v.installed} → ${v.fixed}\t${v.path}\t${v.title}`);
}
const j = process.argv.indexOf('--json');
if (j > 0) writeFileSync(process.argv[j + 1], JSON.stringify(all, null, 1));
