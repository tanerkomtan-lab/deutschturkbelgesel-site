// fetch_news.mjs
// RSS tabanlı haber toplayıcı — sadece başlık + özet + link + kaynak + görsel alır,
// tam makale metnini ASLA kopyalamaz.

import { XMLParser } from "fast-xml-parser";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "dth_haberler";

// Wayback Machine (archive.org) entegrasyonu isteğe bağlıdır ve varsayılan
// olarak KAPALIDIR, çünkü her haber için ek bir/iki istek gönderdiği için
// script'in çalışma süresini ciddi şekilde uzatabilir ve archive.org'u
// gereksiz yere yorabilir. Açmak için ortam değişkenini "true" yapın:
//   ENABLE_WAYBACK=true node fetch_news.mjs
const ENABLE_WAYBACK = (process.env.ENABLE_WAYBACK || "false").toLowerCase() === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("HATA: SUPABASE_URL ve SUPABASE_SERVICE_KEY ortam değişkenlerini ayarlayın.");
  process.exit(1);
}

// NOT: Supabase tablonuza arsiv_url (text, nullable) sütununu eklemeniz gerekir:
//   alter table dth_haberler add column if not exists arsiv_url text;

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

  // --- archive.org / Internet Archive TV News Archive kanalları ---
  // archive.org, her TV kanalını kendi koleksiyonunda (ör. "TV-CNNW") tutuyor
  // ve her koleksiyon için gerçek bir RSS besliyor: aşağıdaki URL şablonu budur:
  //   https://archive.org/services/collection-rss.php?collection=TV-{KANAL_KODU}
  // Bu satırlar diğer kaynaklarla (BBC, CNN, DW...) TAMAMEN AYNI mekanizmayı
  // (fetchFeed) kullanır — özel kod gerekmez. Aşağıdakiler tarayıcıda test
  // edilip DOĞRULANDI (link, başlık, özet, görsel geliyor):
  { kaynak: "ia_cnnw",     kaynak_ad: "Internet Archive - CNN",      kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-CNNW" },
  { kaynak: "ia_foxnewsw", kaynak_ad: "Internet Archive - Fox News", kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-FOXNEWSW" },
  { kaynak: "ia_msnbcw",   kaynak_ad: "Internet Archive - MSNBC",    kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-MSNBCW" },

  // Aşağıdakiler DOĞRULANMADI (deneme sırasında geçici sunucu hatası aldım /
  // kanal kodunu kesin teyit edemedim). Muhtemelen doğrudur ama devreye almadan
  // önce URL'yi tarayıcıda açıp gerçekten haber döndürdüğünü kontrol edin:
  // { kaynak: "ia_bbcnews", kaynak_ad: "Internet Archive - BBC News", kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-BBCNEWS" },
  // { kaynak: "ia_dw",      kaynak_ad: "Internet Archive - DW",       kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-DW" },
  // { kaynak: "ia_aljazam", kaynak_ad: "Internet Archive - Al Jazeera", kategori: "Arşiv", url: "https://archive.org/services/collection-rss.php?collection=TV-ALJAZAM" },
];

// RSS'te görsel bulunamayan haberler için makale sayfasından og:image çekilirken
// aynı anda kaç istek gönderileceği (siteleri/host'u yormamak için sınırlı tutulur).
const OG_IMAGE_CONCURRENCY = 5;
// og:image için sayfa çekme zaman aşımı (ms)
const OG_IMAGE_TIMEOUT_MS = 8000;

// Wayback Machine istekleri için eşzamanlılık ve zaman aşımı. "Save Page Now"
// isteği (yeni arşivleme) mevcut kopya kontrolünden çok daha yavaş olduğu için
// düşük tutulur.
const WAYBACK_CONCURRENCY = 3;
const WAYBACK_TIMEOUT_MS = 12000;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(str = "") {
  if (typeof str !== "string") {
    if (str == null) return "";
    if (typeof str === "object" && "#text" in str) str = str["#text"];
    else str = String(str);
  }
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

function extractImage(item) {
  const media = item["media:thumbnail"] || item["media:content"];
  if (media) {
    const m = Array.isArray(media) ? media[0] : media;
    if (m?.["@_url"]) return m["@_url"];
  }
  if (item.enclosure?.["@_url"] && /^image\//.test(item.enclosure?.["@_type"] || "")) {
    return item.enclosure["@_url"];
  }
  const html = item["content:encoded"] || item.description || "";
  const htmlStr = typeof html === "string" ? html : (html?.["#text"] || "");
  const match = htmlStr.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// RSS öğesinde görsel yoksa, haberin kendi sayfasına gidip <meta property="og:image">
// (ya da twitter:image) etiketini okuyarak görseli bulmaya çalışır.
// Bu yalnızca fallback'tir; başarısız olursa sessizce null döner, akışı durdurmaz.
async function fetchOgImage(link) {
  if (!link) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OG_IMAGE_TIMEOUT_MS);
    const res = await fetch(link, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DeutschTurkHaber-Agent/1.0)" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    // Sayfanın tamamını indirmeye gerek yok; <head> genelde ilk birkaç KB içinde olur.
    const reader = res.body.getReader();
    let html = "";
    const decoder = new TextDecoder();
    while (html.length < 60000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

    return ogMatch ? ogMatch[1] : null;
  } catch {
    return null;
  }
}

// archive.org'un "Availability API"si üzerinden bir linkin daha önceden
// arşivlenmiş bir kopyası olup olmadığına bakar. Varsa en yakın snapshot'ın
// URL'sini döner, yoksa null.
async function checkWaybackAvailability(link) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);
    const res = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(link)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.archived_snapshots?.closest?.url || null;
  } catch {
    return null;
  }
}

// Var olan bir kopya yoksa, Wayback Machine'in "Save Page Now" servisine
// arşivleme isteği gönderir ve oluşturulan snapshot'ın URL'sini döner.
// Bu istek yavaş olabilir (archive.org sayfayı gerçekten indirir), bu yüzden
// zaman aşımına uğrarsa veya hata verirse sessizce null döner — akış durmaz.
async function requestWaybackSave(link) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);
    const res = await fetch(`https://web.archive.org/save/${link}`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DeutschTurkHaber-Agent/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const contentLocation = res.headers.get("content-location");
    if (contentLocation) return `https://web.archive.org${contentLocation}`;
    if (res.url && res.url.includes("web.archive.org/web/")) return res.url;
    return null;
  } catch {
    return null;
  }
}

async function fetchWaybackUrl(link) {
  const existing = await checkWaybackAvailability(link);
  if (existing) return existing;
  return requestWaybackSave(link);
}

// Basit eşzamanlılık sınırlayıcı: bir dizi işi en fazla `limit` tanesi aynı anda çalışacak şekilde yürütür.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
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
    const list = (Array.isArray(items) ? items : [items]).slice(0, 40);

    const rows = list.filter(Boolean).map(item => {
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
        gorsel_url: extractImage(item),
        arsiv_url: null,
      };
    }).filter(n => n.baslik && n.link);

    // RSS'te görseli olmayan haberler için og:image fallback'ini dene.
    const eksikGorselli = rows.filter(r => !r.gorsel_url);
    if (eksikGorselli.length > 0) {
      await mapWithConcurrency(eksikGorselli, OG_IMAGE_CONCURRENCY, async (row) => {
        row.gorsel_url = await fetchOgImage(row.link);
      });
    }

    // archive.org üzerinde kalıcı bir kopya oluştur/kontrol et (isteğe bağlı).
    if (ENABLE_WAYBACK) {
      await mapWithConcurrency(rows, WAYBACK_CONCURRENCY, async (row) => {
        row.arsiv_url = await fetchWaybackUrl(row.link);
      });
    }

    return rows;
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
    const gorselli = rows.filter(r => r.gorsel_url).length;
    const arsivli = rows.filter(r => r.arsiv_url).length;
    console.log(
      `${feed.kaynak}: ${rows.length} haber bulundu, ${gorselli} tanesinde görsel var` +
      (ENABLE_WAYBACK ? `, ${arsivli} tanesi arşivlendi.` : ".")
    );
    await upsertNews(rows);
  }

  console.log("Tamamlandı.");
}

main();
