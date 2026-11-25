// Сводные числа для отчёта ЛР5 — считаются из исходных отчётов инструментов (docs/lab5/{before,after}).
const fs = require('fs');
const path = require('path');

module.exports = function collect(ROOT) {
  const L5 = path.join(ROOT, 'docs', 'lab5');
  const rd = (...p) => JSON.parse(fs.readFileSync(path.join(L5, ...p), 'utf8'));
  const txt = (...p) => fs.readFileSync(path.join(L5, ...p), 'utf8');
  const has = (...p) => fs.existsSync(path.join(L5, ...p));
  const out = {};

  for (const ph of ['before', 'after']) {
    const d = out[ph] = {};
    // ---------- Semgrep
    const sg = rd(ph, 'semgrep.json');
    d.semgrep = { total: sg.results.length, ERROR: 0, WARNING: 0, INFO: 0, rules: 0, byRule: {} };
    for (const r of sg.results) { d.semgrep[r.extra.severity]++; d.semgrep.byRule[r.check_id] = (d.semgrep.byRule[r.check_id] || 0) + 1; }
    // ---------- SpotBugs (SARIF по модулям)
    const mods = ['platform', 'api-gateway', 'auth-service', 'applications-service', 'review-service', 'notifier'];
    d.spotbugs = { total: 0, byRule: {}, byPrio: { 1: 0, 2: 0, 3: 0 }, byCat: {} };
    for (const m of mods) {
      const x = fs.readFileSync(path.join(L5, ph, 'spotbugs', m + '.xml'), 'utf8');
      for (const b of x.matchAll(/<BugInstance ([^>]*)>/g)) {
        const a = Object.fromEntries([...b[1].matchAll(/(\w+)="([^"]*)"/g)].map(v => [v[1], v[2]]));
        d.spotbugs.total++; d.spotbugs.byPrio[a.priority]++;
        d.spotbugs.byCat[a.category] = (d.spotbugs.byCat[a.category] || 0) + 1;
        d.spotbugs.byRule[a.type] = (d.spotbugs.byRule[a.type] || 0) + 1;
      }
    }
    // ---------- Trivy config
    const tc = rd(ph, 'trivy-config.json');
    d.trivyConfig = { HIGH: 0, MEDIUM: 0, LOW: 0, CRITICAL: 0, byId: {} };
    for (const res of tc.Results || []) for (const m of res.Misconfigurations || []) { d.trivyConfig[m.Severity]++; d.trivyConfig.byId[m.ID] = (d.trivyConfig.byId[m.ID] || 0) + 1; }
    // ---------- gitleaks
    d.gitleaks = has(ph, 'gitleaks-history.json') ? rd(ph, 'gitleaks-history.json').length : null;
    d.gitleaksHead = has(ph, 'gitleaks-head.json') ? rd(ph, 'gitleaks-head.json').length : null;
    // ---------- Trivy по образам
    d.images = [];
    for (const f of fs.readdirSync(path.join(L5, ph, 'trivy')).filter(f => f.endsWith('.json')).sort()) {
      const r = rd(ph, 'trivy', f);
      const c = { image: r.ArtifactName, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, libHC: 0, osHC: 0 };
      const seen = new Set();
      for (const res of r.Results || []) for (const v of res.Vulnerabilities || []) {
        const k = v.VulnerabilityID + v.PkgName + v.InstalledVersion + (v.PkgPath || '');
        if (seen.has(k)) continue; seen.add(k); c[v.Severity]++;
        if (v.Severity === 'HIGH' || v.Severity === 'CRITICAL') res.Class === 'os-pkgs' ? c.osHC++ : c.libHC++;
      }
      d.images.push(c);
    }
    d.sbom = fs.readdirSync(path.join(L5, ph, 'sbom')).filter(f => f.endsWith('.json')).map(f => {
      const s = rd(ph, 'sbom', f); return { file: f, spec: s.specVersion, components: (s.components || []).length };
    });
    // ---------- ZAP
    d.zap = {};
    for (const run of ['api-unauth', 'api-auth', 'web-full']) {
      if (!has(ph, 'zap', run + '.json')) continue;
      const z = rd(ph, 'zap', run + '.json');
      const c = { High: 0, Medium: 0, Low: 0, Informational: 0, alerts: [] };
      const R = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
      for (const s of z.site || []) for (const a of s.alerts || []) { c[R[a.riskcode]]++; c.alerts.push({ risk: R[a.riskcode], id: a.pluginid, name: a.alert, n: (a.instances || []).length }); }
      const log = has(ph, 'zap', run + '.txt') ? txt(ph, 'zap', run + '.txt') : '';
      const pass = log.match(/PASS: (\d+)/g); c.passRules = pass ? +pass[pass.length - 1].split(' ')[1] : null;
      const urls = log.match(/Number of Imported URLs: (\d+)/); c.imported = urls ? +urls[1] : null;
      c.hook = (log.match(/\[lab5-hook\] токен доступа обновлён/g) || []).length;
      d.zap[run] = c;
    }
    // ---------- ручные проверки
    const mc = txt(ph, 'manual-checks.txt');
    d.manual = { ok: 0, fail: 0, byId: {} };
    for (const m of mc.matchAll(/^\[(OK|FAIL)\]\s+(\w\d+) /gm)) { d.manual[m[1] === 'OK' ? 'ok' : 'fail']++; d.manual.byId[m[2]] = m[1]; }
    // в «до» E8/E9 (NUL-байт) добавлены после прогона — воспроизведены отдельным запросом (500)
    if (ph === 'before' && /password-reset 500/.test(mc)) { d.manual.fail += 2; d.manual.byId.E8 = 'FAIL'; d.manual.byId.E9 = 'FAIL'; }
    d.runAll = has(ph, 'run-all.txt') ? (txt(ph, 'run-all.txt').match(/ИТОГО: успешно (\d+), ошибок (\d+)/) || []).slice(1) : null;
  }
  return out;
};
