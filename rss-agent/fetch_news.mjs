// fetch_news.mjs
// RSS tabanlı haber toplayıcı — sadece başlık + özet + link + kaynak alır,
// tam makale metnini ASLA kopyalamaz.
//
// Kurulum: npm install
// Çalıştırma: node fetch_news.mjs
// (GitHub Actions ile periyodik çalıştırmak için .github/workflows/fetch-news.yml dosyasına bakın)

import { XMLParser } from "fast-xml-parser";

// --- Supabase bağlantı bilgileri: ortam değişkeninden okunuyor, koda gömülmüyor ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "dth_haberler";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("HATA: SUPABASE_URL ve SUPABASE_SERVICE_KEY ortam değişkenlerini ayarlayın.");
  process.exit(1);
}

// --- Kaynak listesi: kısa kod (kaynak) + görünen isim (kaynak_ad) + kategori + RSS url ---
const FEEDS = [
  { kaynak: "bbc",       kaynak_ad: "BBC",                  kategori: "Dünya",   url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { kaynak: "bbc_tr",    kaynak_ad: "BBC Türkçe",           kategori: "Türkiye", url: "https://feeds.bbci.co.uk/turkce/rss.xml" },
  { kaynak: "cnn",       kaynak_ad: "CNN",                  kategori: "Dünya",   url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { kaynak: "dw",        kaynak_ad: "DW",                   kategori: "Almanya", url: "https://rss.dw.com/rdf/rss-en-ger" },
  { kaynak: "dw_tr",     kaynak_ad: "DW Türkçe",            kategori: "Almanya", url: "https://rss.dw.com/rdf/rss-tur-all" },
  { kaynak: "euronews",  kaynak_ad: "Euronews",             kategori: "Avrupa",  url: "https://www.euronews.com/rss" },
  { kaynak: "aljazeera", kaynak_ad: "Al Jazeera",           kategori: "Dünya",   url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { kaynak: "hurriyet",  kaynak_ad: "Hürriyet",             kategori: "Türkiye", url: "https://www.hurriyet.com.tr/rss/anasayfa" },
  { kaynak: "ntv",       kaynak_ad: "NTV",                  kategori: "Türkiye", url: "https://www.ntv.com.tr/son-dakika.rss" },

  // --- NRW / Köln bölgesel kaynaklar ---
  { kaynak: "wdr",       kaynak_ad: "WDR",                  kategori: "NRW",  url: "https://www.wdr.de/xml/newsticker.rdf" },
  { kaynak: "ksta",      kaynak_ad: "Kölner Stadt-Anzeiger",kategori: "Köln", url: "https://feed.ksta.de/feed/rss/index.rss" },
  { kaynak: "rundschau", kaynak_ad: "Kölnische Rundschau",  kategori: "Köln", url: "https://www.rundschau-online.de/rss-feed.rssdata.xml" },
  { kaynak: "express_koeln", kaynak_ad: "Express Köln",     kategori: "Köln", url: "https://www.express.de/feed/index.rss" },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(str = "") {
  return str.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function cleanLink(url = "") {
  try {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach(k => {
      if (/^(utm_|at_|ns_)/i.test(k)) u.searchParams.delete(k);
    });
    return u.toString();
  } catch {
    return url;
  }
}

function truncate(str = "", max = 260) {
  const clean = stripHtml(str);
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "DeutschTurkHaber-Agent/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const data = parser.parse(xml);

    const items =
      data?.rss?.channel?.item ||
      data?.["rdf:RDF"]?.item ||
      data?.feed?.entry ||
      [];
    const list = Array.isArray(items) ? items : [items];

    return list.filter(Boolean).map(item => {
      const title = stripHtml(item.title?.["#text"] || item.title || "");
      const rawSummary = item.description || item.summary || item["content:encoded"] || "";
      const ozet = truncate(rawSummary, 260);
      const link = cleanLink(
        item.link?.["@_href"] || item.link || item.guid?.["#text"] || item.guid || ""
      );
      const pubDate = item.pubDate || item.published || item.updated || new Date().toISOString();

      return {
        baslik: title,
        ozet,
        link,
        kaynak: feed.kaynak,
        kaynak_ad: feed.kaynak_ad,
        kategori: feed.kategori,
        yayin_tarihi: new Date(pubDate).toISOString(),
        durum: "yayinda",
      };
    }).filter(n => n.baslik && n.link);
  } catch (err) {
    console.error(`[UYARI] ${feed.kaynak} (${feed.url}) çekilemedi: ${err.message}`);
    return [];
  }
}

async function upsertNews(rows) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=link`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[HATA] Supabase upsert başarısız: ${res.status} ${text}`);
  } else {
    console.log(`[OK] ${rows.length} haber işlendi.`);
  }
}

async function main() {
  for (const feed of FEEDS) {
    const rows = await fetchFeed(feed);
    console.log(`${feed.kaynak}: ${rows.length} haber bulundu.`);
    await upsertNews(rows);
  }
  console.log("Tamamlandı.");
}

main();
