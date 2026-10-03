// rss-agent/build_pages.mjs
// Supabase'deki haberlerden statik sayfalar (/haber/ID.html) ve sitemap.xml üretir.
// Sadece "yorum" (özgün editör notu) olan haberler için sayfa üretilir ve sitemap'e girer.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://deutschturkhaber.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const TABLE = process.env.SUPABASE_TABLE || "dth_haberler";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("HATA: SUPABASE_URL ve SUPABASE_KEY gerekli.");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "haber");

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmtDate = (d) => {
  try { return new Date(d).toLocaleDateString("tr-TR", { day: "2-digit", month: "long", year: "numeric" }); }
  catch { return ""; }
};

async function load() {
  const base = `${SUPABASE_URL}/rest/v1/${TABLE}`;
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const common = "baslik,ozet,link,kategori,kaynak,kaynak_ad,yayin_tarihi,gorsel_url,arsiv_url";
  const q = (cols) =>
    `${base}?select=id,${cols}&durum=eq.yayinda&order=yayin_tarihi.desc&limit=1000`;

  let res = await fetch(q(common + ",yorum"), { headers });
  if (!res.ok) res = await fetch(q(common), { headers });
  if (!res.ok) throw new Error(`Supabase hata: ${res.status} ${await res.text()}`);
  return res.json();
}

function pageHtml(n, related) {
  const url = `${SITE}/haber/${encodeURIComponent(n.id)}.html`;
  const eu = encodeURIComponent(url);
  const et = encodeURIComponent(n.baslik || "");
  const desc = esc((n.yorum || n.ozet || "").slice(0, 155));
  const kaynak = esc(n.kaynak_ad || n.kaynak || "");

  const yorumBlock = `<section class="note"><h2>Almanya'daki Türkler için ne anlama geliyor?</h2><p>${esc(n.yorum).replace(/\n+/g, "</p><p>")}</p></section>`;

  const relHtml = related.map(r =>
    `<li><a href="/haber/${encodeURIComponent(r.id)}.html">${esc(r.baslik)}</a></li>`).join("");

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(n.baslik)} | DeutschTürkHaber</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(n.baslik)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
${n.gorsel_url ? `<meta property="og:image" content="${esc(n.gorsel_url)}">` : ""}
<style>
:root{--bg:#0a0a0a;--card:#141414;--accent:#ffcc00;--text:#fff;--dim:#a0a0a0;--border:#262626}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
header{padding:14px 20px;border-bottom:1px solid var(--border)}
header a{color:var(--accent);font-weight:900;text-decoration:none;letter-spacing:-.5px}
main{max-width:760px;margin:0 auto;padding:20px}
.badge{display:inline-block;font-size:10px;font-weight:800;color:#000;background:var(--accent);padding:3px 8px;border-radius:2px;text-transform:uppercase}
.cat{font-size:11px;color:var(--dim);margin-left:8px;text-transform:uppercase}
h1{font-size:26px;line-height:1.3;margin:14px 0 8px}
.date{font-size:12px;color:var(--dim);margin-bottom:16px}
img.hero{width:100%;max-height:380px;object-fit:cover;background:var(--border);margin-bottom:16px}
.sum{color:#d0d0d0;font-size:16px;margin-bottom:20px}
.note{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);padding:16px;margin:20px 0}
.note h2{font-size:16px;color:var(--accent);margin-bottom:8px}.note p{margin-bottom:10px;font-size:15px}
.btn{display:inline-block;padding:12px 18px;background:var(--accent);color:#000;font-weight:800;text-decoration:none;border-radius:3px;margin-right:10px;font-size:13px}
.btn.alt{background:transparent;color:var(--dim);border:1px solid var(--border)}
.share{display:flex;gap:8px;margin:22px 0;padding-top:16px;border-top:1px solid var(--border)}
.share a{flex:1;text-align:center;padding:10px 0;font-size:11px;font-weight:800;border:1px solid var(--border);color:#fff;text-decoration:none;border-radius:3px}
.rel h3{font-size:14px;color:var(--accent);margin:24px 0 8px;text-transform:uppercase}
.rel li{list-style:none;border-bottom:1px solid var(--border);padding:10px 0}
.rel a{color:#fff;text-decoration:none;font-size:14px}
footer{border-top:1px solid var(--border);padding:24px 20px;text-align:center;font-size:12px;color:var(--dim)}
footer a{color:var(--dim);margin:0 8px}
</style>
</head>
<body>
<header><a href="/">DEUTSCHTÜRKHABER</a></header>
<main>
  <span class="badge">${kaynak}</span><span class="cat">${esc(n.kategori || "")}</span>
  <h1>${esc(n.baslik)}</h1>
  <div class="date">${fmtDate(n.yayin_tarihi)}</div>
  ${n.gorsel_url ? `<img class="hero" src="${esc(n.gorsel_url)}" alt="" loading="lazy">` : ""}
  <p class="sum">${esc(n.ozet || "")}</p>
  ${yorumBlock}
  <a class="btn" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">Haberin tamamı: ${kaynak} →</a>
  ${n.arsiv_url ? `<a class="btn alt" href="${esc(n.arsiv_url)}" target="_blank" rel="noopener noreferrer">Arşiv</a>` : ""}
  <div class="share">
    <a href="https://wa.me/?text=${et}%20${eu}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
    <a href="https://twitter.com/intent/tweet?url=${eu}&text=${et}" target="_blank" rel="noopener noreferrer">X</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=${eu}" target="_blank" rel="noopener noreferrer">Facebook</a>
    <a href="https://t.me/share/url?url=${eu}&text=${et}" target="_blank" rel="noopener noreferrer">Telegram</a>
  </div>
  ${relHtml ? `<div class="rel"><h3>İlgili haberler</h3><ul>${relHtml}</ul></div>` : ""}
</main>
<footer>
  <p>Başlık ve özetler ilgili kaynaklardan derlenir; telif hakları yayıncılara aittir.</p>
  <p><a href="/">Ana sayfa</a><a href="/hakkimizda.html">Hakkımızda</a><a href="/impressum.html">Impressum</a><a href="/gizlilik.html">Gizlilik</a></p>
</footer>
</body>
</html>`;
}

async function main() {
  const news = await load();
  console.log(`${news.length} haber alındı.`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const indexed = news.filter(n => n.yorum && n.yorum.trim().length > 120);
  for (const n of indexed) {
    const related = indexed.filter(r => r.kategori === n.kategori && r.id !== n.id).slice(0, 5);
    await writeFile(path.join(OUT_DIR, `${n.id}.html`), pageHtml(n, related), "utf8");
  }

  const urls = [
    `  <url><loc>${SITE}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${SITE}/hakkimizda.html</loc><priority>0.3</priority></url>`,
    `  <url><loc>${SITE}/impressum.html</loc><priority>0.3</priority></url>`,
    `  <url><loc>${SITE}/gizlilik.html</loc><priority>0.3</priority></url>`,
    ...indexed.map(n => {
      const d = new Date(n.yayin_tarihi || Date.now()).toISOString().slice(0, 10);
      return `  <url><loc>${SITE}/haber/${encodeURIComponent(n.id)}.html</loc><lastmod>${d}</lastmod><priority>0.7</priority></url>`;
    }),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  await writeFile(path.join(ROOT, "sitemap.xml"), sitemap, "utf8");

  console.log(`${indexed.length} haber sayfası üretildi, sitemap güncellendi.`);
}

main().catch(e => { console.error(e); process.exit(1); });
