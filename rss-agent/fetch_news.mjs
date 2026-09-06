// fetch_news.mjs
// RSS tabanlı haber toplayıcı — sadece başlık + özet + link + kaynak alır,
// tam makale metnini ASLA kopyalamaz. Supabase tablosuna upsert eder.
//
// Kurulum: npm install
// Çalıştırma: node fetch_news.mjs
// (GitHub Actions ile periyodik çalıştırmak için .github/workflows/fetch-news.yml dosyasına bakın)

import { XMLParser } from "fast-xml-parser";

// --- Supabase bağlantı bilgileri: ortam değişkeninden okunuyor, koda gömülmüyor ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key (yazma yetkisi için)
// Hangi tabloya yazılacağı ortam değişkeninden ayarlanır — mevcut çalışmanız dth_haberler üzerinde
// olduğu için varsayılan onu kullanıyor. haberler tablosunu kullanmak isterseniz
// SUPABASE_TABLE=haberler olarak ayarlamanız yeterli, kod değişikliği gerekmez.
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "dth_haberler";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("HATA: SUPABASE_URL ve SUPABASE_SERVICE_KEY ortam değişkenlerini ayarlayın.");
  process.exit(1);
}

// --- Kaynak listesi: kategori + kaynak adı + RSS url ---
// NOT: RSS adresleri yayıncılar tarafından zaman zaman değiştirilebilir.
// Bir feed 404 verirse ilgili yayıncının "RSS feeds" sayfasından güncel adresi bulup buradan değiştirin.
const FEEDS = [
  { kaynak: "BBC",       kategori: "Dünya",    url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { kaynak: "BBC Türkçe",kategori: "Türkiye",  url: "https://feeds.bbci.co.uk/turkce/rss.xml" },
  { kaynak: "CNN",       kategori: "Dünya",    url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { kaynak: "DW",        kategori: "Almanya",  url: "https://rss.dw.com/rdf/rss-en-ger" },
  { kaynak: "DW Türkçe", kategori: "Almanya",  url: "https://rss.dw.com/rdf/rss-tur-all" },
  { kaynak: "Euronews",  kategori: "Avrupa",   url: "https://www.euronews.com/rss" },
  { kaynak: "Al Jazeera",kategori: "Dünya",    url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { kaynak: "Hürriyet",  kategori: "Türkiye",  url: "https://www.hurriyet.com.tr/rss/anasayfa" },
  { kaynak: "NTV",       kategori: "Türkiye",  url: "https://www.ntv.com.tr/son-dakika.rss" },

  // --- NRW / Köln bölgesel kaynaklar ---
  { kaynak: "WDR",              kategori: "NRW",  url: "https://www.wdr.de/xml/newsticker.rdf" },
  { kaynak: "Kölner Stadt-Anzeiger", kategori: "Köln", url: "https://feed.ksta.de/feed/rss/index.rss" },
  { kaynak: "Kölnische Rundschau",   kategori: "Köln", url: "https://www.rundschau-online.de/rss-feed.rssdata.xml" },
  { kaynak: "Express Köln",     kategori: "Köln", url: "https://www.express.de/feed/index.rss" },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(str = "") {
  return str.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function cleanLink(url = "") {
  try {
    const u = new URL(url);
    // izleme parametrelerini temizle (utm_*, ?at_medium vs.)
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

    // RSS 2.0 ve RDF/Atom farklarını basitçe ele al
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
        kaynak_url: link,
        kaynak: feed.kaynak,
        kategori: feed.kategori,
        yayin_tarihi: new Date(pubDate).toISOString(),
        durum: "yayinda",
      };
    }).filter(n => n.baslik && n.kaynak_url);
  } catch (err) {
    console.error(`[UYARI] ${feed.kaynak} (${feed.url}) çekilemedi: ${err.message}`);
    return [];
  }
}

async function upsertNews(rows) {
  if (rows.length === 0) return;
  // kaynak_url üzerinde UNIQUE constraint olduğunu varsayıyoruz (aynı haberi iki kez eklememek için).
  // Tabloda yoksa: alter table ${SUPABASE_TABLE} add constraint ${SUPABASE_TABLE}_kaynak_url_key unique (kaynak_url);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=kaynak_url`, {
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
