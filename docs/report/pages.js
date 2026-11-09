// По тексту PDF (страницы разделены \f) находит страницу каждого заголовка -> toc.json
const fs = require('fs');
const heads = JSON.parse(fs.readFileSync(__dirname + '/heads.json', 'utf8'));
const pages = fs.readFileSync(__dirname + '/report.txt', 'utf8').split('\f');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const toc = {};
let from = 3; // пропускаем титул, реестр и содержание
for (const h of heads) {
  if (h === 'Содержание' || h.startsWith('Реестр')) continue;
  for (let i = from; i < pages.length; i++) {
    const lines = pages[i].split('\n').filter(l => !l.includes('....')).map(norm);
    if (lines.some(l => l === norm(h) || l.startsWith(norm(h)))) { toc[h] = i + 1; from = i; break; }
  }
  if (!toc[h]) console.error('не найден:', h);
}
fs.writeFileSync(__dirname + '/toc.json', JSON.stringify(toc, null, 1));
console.log(Object.keys(toc).length, 'заголовков, страниц в PDF:', pages.length - 1);
