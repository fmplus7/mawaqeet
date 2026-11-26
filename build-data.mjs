// يبني بيانات التطبيق: مدن العالم + مصحف المدينة (تجريبي) + الخطوط + مكتبة الحساب.
// الاستخدام:  node scripts/build-data.mjs [cities|quran|assets]   (بدون وسيط = الكل)
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const OUT = process.env.OUT_DIR || (existsSync('www') ? 'www' : 'dist');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'mawaqeet-build' } });
      if (r.ok) return r;
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(`HTTP ${r.status} ${url}`);
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
}
const buf = async u => Buffer.from(await (await get(u)).arrayBuffer());

export function unzip(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('ملف ZIP غير صالح');
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16); const out = {};
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csz = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl);
    const ds = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28), data = b.subarray(ds, ds + csz);
    out[name] = method === 0 ? data : inflateRawSync(data);
    p += 46 + nl + el + cl;
  }
  return out;
}

export function parseCSV(s) {
  s = s.replace(/^\uFEFF/, ''); const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export async function buildCities() {
  console.log('⏳ تنزيل مدن العالم (GeoNames cities15000)…');
  const z = unzip(await buf('https://download.geonames.org/export/dump/cities15000.zip'));
  const key = Object.keys(z).find(k => k.endsWith('.txt'));
  const ar = /[\u0600-\u06FF]/, rows = [];
  for (const line of z[key].toString('utf8').split('\n')) {
    if (!line) continue;
    const f = line.split('\t'); if (f.length < 18) continue;
    const nameAr = (f[3] ? f[3].split(',') : []).find(a => ar.test(a)) || '';
    rows.push([nameAr, f[1], f[8], +(+f[4]).toFixed(4), +(+f[5]).toFixed(4), f[17], +f[14] || 0]);
  }
  rows.sort((a, b) => b[6] - a[6]);
  await writeFile(`${OUT}/data/cities.json`, JSON.stringify(rows));
  console.log(`✅ cities.json: ${rows.length} مدينة`);
}

export async function buildQuran() {
  console.log('⏳ تنزيل خط ونص المصحف (Hafs_20 – QuranEnc)…');
  const z = unzip(await buf('https://quranenc.com/downloads/assets/Hafs_20.zip'));
  const names = Object.keys(z), woff = names.find(k => /\.woff2$/i.test(k)), csvk = names.find(k => /Quran_text\.csv$/i.test(k));
  if (!woff || !csvk) throw new Error('محتوى Hafs_20.zip مختلف عن المتوقع: ' + names.join(', '));
  await writeFile(`${OUT}/fonts/Hafs_20.woff2`, z[woff]);
  const text = {};
  for (const r of parseCSV(z[csvk].toString('utf8'))) if (/^\d+$/.test(r[1] || '')) text[`${+r[1]}:${+r[2]}`] = (r[3] || '').trim();
  const nText = Object.keys(text).length;
  if (nText !== 6236) console.warn(`⚠️ عدد الآيات في CSV = ${nText} (المتوقع 6236)`);

  console.log('⏳ تنزيل بيانات السور…');
  const chj = await (await get('https://api.quran.com/api/v4/chapters?language=ar')).json();
  const chapters = chj.chapters.map(c => [c.id, c.name_arabic, c.verses_count, c.pages ? c.pages[0] : 0, c.revelation_place, (c.bismillah_pre ?? (c.id !== 1 && c.id !== 9)) ? 1 : 0]);

  console.log('⏳ تنزيل تقسيم صفحات مصحف المدينة (604 صفحة)…');
  const pages = [null], juz = []; let mismatch = 0, curJuz = 0;
  for (let p = 1; p <= 604; p++) {
    const j = await (await get(`https://api.quran.com/api/v4/verses/by_page/${p}?words=true&word_fields=text_uthmani,line_number&fields=verse_key&per_page=50`)).json();
    const lines = new Map(), starts = [];
    for (const v of j.verses) {
      const [s, a] = v.verse_key.split(':').map(Number);
      const ws = v.words.filter(w => w.char_type_name !== 'end');
      if (!ws.length || ws[0].line_number == null) throw new Error(`صفحة ${p}: لا توجد أرقام أسطر في استجابة API`);
      const cw = text[v.verse_key] ? text[v.verse_key].split(/\s+/).filter(Boolean) : null;
      const same = cw && cw.length === ws.length; if (cw && !same) mismatch++;
      ws.forEach((w, i) => { if (!lines.has(w.line_number)) lines.set(w.line_number, [w.line_number]); lines.get(w.line_number).push(same ? cw[i] : w.text_uthmani); });
      lines.get(ws[ws.length - 1].line_number).push(a);
      if (a === 1) starts.push([ws[0].line_number, s]);
      if (v.juz_number && v.juz_number !== curJuz) { curJuz = v.juz_number; juz[curJuz - 1] = p; }
    }
    pages.push([[...lines.values()].sort((x, y) => x[0] - y[0]), starts]);
    if (p % 50 === 0) console.log(`   ${p}/604`);
    await sleep(120);
  }
  if (mismatch) console.warn(`ℹ️ ${mismatch} آية اختلف فيها عدد الكلمات بين المصدرين؛ استُخدم نص الصفحة لها.`);
  const q = { basmala: text['1:1'], chapters, juz, pages };
  await writeFile(`${OUT}/data/quran.json`, JSON.stringify(q));
  console.log('✅ quran.json');
}

export async function copyAssets() {
  const nm = path.resolve('node_modules');
  // الخطوط (Cairo) من حزمة fontsource
  const fdir = `${nm}/@fontsource/cairo/files`;
  let nf = 0;
  for (const w of [300, 400, 500, 600, 700, 800]) for (const sub of ['arabic', 'latin']) {
    const f = `cairo-${sub}-${w}-normal.woff2`;
    if (existsSync(`${fdir}/${f}`)) { await copyFile(`${fdir}/${f}`, `${OUT}/fonts/${f}`); nf++; }
  }
  console.log(`✅ خطوط Cairo: ${nf} ملف`);
  // مكتبة الحساب: من node_modules، وإلا من الإنترنت
  const dest = `${OUT}/vendor/adhan.umd.min.js`, local = `${nm}/adhan/lib/bundles/adhan.umd.min.js`;
  if (existsSync(local)) { await copyFile(local, dest); console.log('✅ مكتبة adhan (محلية)'); }
  else {
    console.warn('⚠️ adhan غير موجودة في node_modules، سأنزّلها من الإنترنت');
    await writeFile(dest, await buf('https://cdn.jsdelivr.net/npm/adhan@4.4.3/lib/bundles/adhan.umd.min.js'));
    console.log('✅ مكتبة adhan (منزّلة)');
  }
}

export async function copyStatic() {
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'])
    if (existsSync(f)) await copyFile(f, `${OUT}/${f}`); else console.warn('⚠️ ملف ناقص:', f);
  console.log('✅ ملفات الموقع');
}

async function main() {
  const t = process.argv[2];
  await mkdir(`${OUT}/data`, { recursive: true }); await mkdir(`${OUT}/fonts`, { recursive: true }); await mkdir(`${OUT}/vendor`, { recursive: true });
  const flat = !existsSync('www'), safe = async (f) => { try { await f(); } catch (e) { if (!flat) throw e; console.warn('⚠️ تخطّيت جزءاً:', e.message); } };
  if (flat) await copyStatic();
  if (!t || t === 'assets') await copyAssets();
  console.log('محتويات مجلد', OUT, ':'); for (const d of ['', '/data', '/fonts', '/vendor']) { try { console.log(' ', d || '/', (await import('node:fs')).readdirSync(OUT + d).join(' ')); } catch {} }
  if (!t || t === 'cities') await safe(buildCities);
  if (!t || t === 'quran') await safe(buildQuran);
  console.log('\n🎉 تمّ. شغّل:  npm run serve');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error('❌', e.message); process.exit(1); });
