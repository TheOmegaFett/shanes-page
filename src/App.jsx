import React, { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   Config & Utilities
   ========================= */
// 🟢 Enable or disable images globally
const SHOW_IMAGES = false;
const AU_PARAMS = "hl=en-AU&gl=AU&ceid=AU:en";
const IS_DEV =
  typeof location !== "undefined" && location.hostname === "localhost";

const PROXY = import.meta.env.VITE_PROXY_ORIGIN || "";
const g = (q) => {
  const path = `rss/search?q=${encodeURIComponent(q)}&${AU_PARAMS}`;
  // Always go through proxy in production; in dev you can still use Vite /gn proxy if you like
  if (IS_DEV && !PROXY) return `/gn/${path}`;
  return `${PROXY}/gn/${path}`;
};
// Topic colors
const COLORS = {
  ai: "#a461ff",
  msf: "#ff4655",
  gaming: "#41d39c",
  streaming: "#9146ff",
  webdev: "#65a7ff",
  tech: "#ffaa41",
};

// URL helpers
function resolveUrl(maybeUrl, pageUrl) {
  try {
    if (!maybeUrl) return null;
    if (maybeUrl.startsWith("//")) return new URL("https:" + maybeUrl).href;
    return new URL(maybeUrl, pageUrl).href;
  } catch {
    return null;
  }
}
function upgradeToHttps(u) {
  try {
    const url = new URL(u);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.href;
  } catch {
    return u;
  }
}
// Route images via a proxy to bypass hotlink/CORS blocks
function proxifyImage(u) {
  if (!u) return null;
  const httpsUrl = upgradeToHttps(u);
  return `https://wsrv.nl/?url=${encodeURIComponent(httpsUrl)}&q=85`; // you can add &w=960 if you want resizing
}
// Favicon fallback from article link
function faviconFor(link) {
  try {
    const origin = new URL(link).origin;
    return proxifyImage(`${origin}/favicon.ico`);
  } catch {
    return null;
  }
}

/* =========================
   RSS fetchers
   ========================= */
const rssFallbacks = [
  (u) => `https://api.allorigins.workers.dev/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => `https://r.jina.ai/http/${u.replace(/^https?:\/\//, "")}`,
];

async function fetchWithFallback(
  url,
  { timeoutMs = 12000, jitterMs = 250 } = {}
) {
  const attempt = async (finalUrl) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(finalUrl, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  };
  // Only use fallbacks if the URL doesn't already go through a proxy
  const shouldUseFallbacks = !url.includes('shanes-page') && !PROXY;
  const chain = shouldUseFallbacks ? [url, ...rssFallbacks.map((fn) => fn(url))] : [url];
  await new Promise((r) => setTimeout(r, Math.random() * jitterMs));
  let lastErr;
  for (const u of chain) {
    try {
      return await attempt(u);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All RSS proxies failed");
}

async function fetchFeed(gnUrl) {
  const xmlText = await fetchWithFallback(gnUrl);
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("XML parse error");
  return Array.from(xml.querySelectorAll("item")).map(parseItem);
}

/* =========================
   Page HTML fetch (for og:image)
   ========================= */
const pageProxies = [
  (u) => `https://api.allorigins.workers.dev/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  (u) => `https://r.jina.ai/http/${u.replace(/^https?:\/\//, "")}`,
];

async function fetchHTML(url, timeoutMs = 12000) {
  const proxied = `${PROXY}/page?url=${encodeURIComponent(url)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(proxied, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   Image extraction helpers
   ========================= */
function extractImgFromHTML(html, pageUrl) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const img = doc.querySelector("img");
  const src = img?.getAttribute("src");
  const abs = upgradeToHttps(resolveUrl(src, pageUrl));
  return abs ? proxifyImage(abs) : null;
}
function extractPreviewImage(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pick = (sel, attr = "content") =>
    doc.querySelector(sel)?.getAttribute(attr);

  let img =
    pick('meta[property="og:image:secure_url"]') ||
    pick('meta[property="og:image:url"]') ||
    pick('meta[property="og:image"]');
  if (img) return proxifyImage(upgradeToHttps(resolveUrl(img, pageUrl)));

  img =
    pick('meta[name="twitter:image:src"]') ||
    pick('meta[name="twitter:image"]');
  if (img) return proxifyImage(upgradeToHttps(resolveUrl(img, pageUrl)));

  img = pick('link[rel="image_src"]', "href");
  if (img) return proxifyImage(upgradeToHttps(resolveUrl(img, pageUrl)));

  // JSON-LD
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.parse(s.textContent || "{}");
      const v = json?.image;
      if (typeof v === "string")
        return proxifyImage(upgradeToHttps(resolveUrl(v, pageUrl)));
      if (Array.isArray(v) && v.length)
        return proxifyImage(upgradeToHttps(resolveUrl(v[0], pageUrl)));
      if (v && typeof v === "object" && v.url)
        return proxifyImage(upgradeToHttps(resolveUrl(v.url, pageUrl)));
    } catch {}
  }

  // Fallback: first reasonably-sized <img>
  const imgEl = Array.from(doc.images).find(
    (im) => im.src && (im.width || 0) >= 64 && (im.height || 0) >= 64
  );
  const abs = imgEl ? upgradeToHttps(resolveUrl(imgEl.src, pageUrl)) : null;
  return abs ? proxifyImage(abs) : null;
}
// AMP fallback
function findAmpUrl(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const href = doc.querySelector('link[rel="amphtml"]')?.getAttribute("href");
  return href ? resolveUrl(href, pageUrl) : null;
}

// Google News → publisher URL
function preferPublisherUrl(link, descriptionHTML) {
  try {
    const host = new URL(link).hostname;
    if (!/news\.google\.com$/.test(host)) return link;
    if (descriptionHTML) {
      const doc = new DOMParser().parseFromString(descriptionHTML, "text/html");
      const a = doc.querySelector("a[href]");
      if (a && /^https?:\/\//i.test(a.href)) return a.href;
    }
    const u = new URL(link);
    const real = u.searchParams.get("url");
    if (real && /^https?:\/\//i.test(real)) return real;
  } catch {}
  return link;
}

// Cache
const imgCache = new Map();
const LS_IMG_CACHE = "imgCache:v1";
try {
  const raw = localStorage.getItem(LS_IMG_CACHE);
  if (raw)
    for (const [k, v] of Object.entries(JSON.parse(raw))) imgCache.set(k, v);
} catch {}
function saveImgCacheSoon() {
  clearTimeout(saveImgCacheSoon._t);
  saveImgCacheSoon._t = setTimeout(() => {
    try {
      localStorage.setItem(
        LS_IMG_CACHE,
        JSON.stringify(Object.fromEntries(imgCache))
      );
    } catch {}
  }, 400);
}
async function getBestImageForUrl(url) {
  if (!url) return null;
  if (imgCache.has(url)) return imgCache.get(url);

  try {
    const html = await fetchHTML(url);
    let img = extractPreviewImage(html, url);
    if (!img) {
      const ampUrl = findAmpUrl(html, url);
      if (ampUrl) {
        const ampHtml = await fetchHTML(ampUrl);
        img = extractPreviewImage(ampHtml, ampUrl);
      }
    }
    const finalImg = img || faviconFor(url) || null;
    imgCache.set(url, finalImg);
    saveImgCacheSoon();
    return finalImg;
  } catch {
    const finalImg = faviconFor(url) || null;
    imgCache.set(url, finalImg);
    saveImgCacheSoon();
    return finalImg;
  }
}

/* =========================
   RSS parsing / merging
   ========================= */
function parseItem(item) {
  const pick = (sel) => item.querySelector(sel)?.textContent?.trim() || "";
  const rawLink = pick("link");
  const descriptionHTML = pick("description");
  const link = preferPublisherUrl(rawLink, descriptionHTML);

  const title = pick("title");
  const pubDate = pick("pubDate");
  const source = item.querySelector("source")?.textContent?.trim() || "";

  let image =
    item.querySelector("media\\:content")?.getAttribute("url") || null;
  if (!image) image = extractImgFromHTML(descriptionHTML, link) || null;

  const ts = Date.parse(pubDate) || Date.now();
  return { title, link, image, source, ts };
}

async function fetchTopic(feeds) {
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
  const items = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter(Boolean);

  // dedupe by link
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.link || it.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function formatTS(ts) {
  const d = new Date(ts);
  return isNaN(d)
    ? ""
    : d.toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      });
}

function getArticleHighlight(title, ts) {
  const lower = title.toLowerCase();
  const daysSince = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  
  // MSF breaking news (last 2 days)
  if (daysSince <= 2 && (lower.includes("marvel strike force") || lower.includes("scopely"))) {
    return { border: "#ff4655", glow: "0 0 12px rgba(255, 70, 85, 0.3)" };
  }
  
  // AI tools (ChatGPT, Sourcegraph Amp, GitHub Copilot)
  if (lower.includes("chatgpt") || lower.includes("gpt-4") || lower.includes("gpt-5") || 
      lower.includes("sourcegraph") || lower.includes("amp") && lower.includes("ai") ||
      lower.includes("github copilot") || lower.includes("copilot")) {
    return { border: "#a461ff", glow: "0 0 10px rgba(164, 97, 255, 0.3)" };
  }
  
  // Twitch
  if (lower.includes("twitch")) {
    return { border: "#9146ff", glow: "0 0 8px rgba(145, 70, 255, 0.2)" };
  }
  
  // Nintendo/Mario/Zelda
  if (lower.includes("nintendo") || lower.includes("mario") || lower.includes("zelda")) {
    return { border: "#e60012", glow: "0 0 8px rgba(230, 0, 18, 0.2)" };
  }
  
  // JavaScript/Python
  if (lower.includes("javascript") || lower.includes("python") || lower.includes("typescript") || lower.includes("node.js")) {
    return { border: "#65a7ff", glow: "0 0 8px rgba(101, 167, 255, 0.2)" };
  }
  
  return null;
}

/* =========================
   Topics
   ========================= */
const TOPICS = [
  {
    key: "ai",
    title: "AI, ML & Neural Networks",
    feeds: [
      g('"artificial intelligence" OR "AI news"'),
      g('"OpenAI" OR "ChatGPT" OR "Claude" OR "Gemini"'),
      g('"machine learning" OR "deep learning"'),
      g('"data science" OR "ML models"'),
      g('"neural networks" OR "transformers" OR "diffusion models"'),
      g('"computer vision" OR "reinforcement learning"'),
    ],
  },
  {
    key: "msf",
    title: "Marvel Strike Force",
    feeds: [
      "https://www.gameskinny.com/games/marvel-strike-force/?format=rss",
      "https://rss.feedspot.com/marvel_rss_feeds/",
      g('"Marvel Strike Force" "update" OR "patch" OR "character" OR "event"'),
      g('"Scopely" "Marvel" "mobile game"'),
      g('"MSF" "game" "Marvel"'),
      g('"Marvel Strike Force" "tier list" OR "guide" OR "tier"'),
    ],
  },
  {
    key: "gaming",
    title: "Gaming",
    feeds: [
      g('"Nintendo Switch" OR "Nintendo Direct" OR "Super Mario" OR "Zelda"'),
      g('"Steam Deck" OR "Steam game" OR "Steam release" OR "Valve"'),
      g('"PC gaming" OR "gaming PC" OR "RTX" OR "AMD gaming"'),
      g('"PlayStation 5" OR "PS5" OR "Xbox Series" OR "Game Pass"'),
      g('"esports tournament" OR "gaming championship" -gambling -casino -betting'),
    ],
  },
  {
    key: "streaming",
    title: "Streaming",
    feeds: [
      g('"Twitch streamer" OR "Twitch stream" OR "Twitch news"'),
      g('"OBS Studio" OR "Streamlabs" OR "streaming software"'),
      g('"YouTube Live" OR "YouTube streaming" OR "Kick streaming platform"'),
    ],
  },
  {
    key: "webdev",
    title: "Web Development",
    feeds: [
      g('"web development framework" OR "frontend framework" OR "backend framework"'),
      g('"React framework" OR "Next.js framework" OR "Vue.js" OR "Svelte"'),
      g('"TypeScript release" OR "Node.js update" OR "JavaScript ES2024"'),
      g('"REST API" OR "GraphQL" OR "web components" OR "responsive design"'),
      g('"webpack" OR "vite build" OR "package manager" -CSS -tailwind -npm'),
    ],
  },
  {
    key: "tech",
    title: "Technology & Hardware",
    feeds: [
      g('"tech industry" OR "consumer electronics"'),
      g('"hardware reviews" OR "innovation" OR "startups"'),
      g('"Apple" OR "MacBook" OR "iPhone" OR "iOS"'),
      g('"Tim Cook" OR "Apple keynote" OR "WWDC"'),
      g('"Elgato" OR "Stream Deck" OR "Facecam"'),
      g('"Corsair Elgato" OR "streaming gear"'),
      g('"Corsair" OR "Corsair PC" OR "iCUE"'),
      g('"Corsair peripherals" OR "gaming hardware"'),
    ],
  },
];

/* =========================
   UI
   ========================= */
function Controls({ q, setQ, src, setSrc }) {
  return (
    <div className="controls">
      <input
        className="search"
        placeholder="Search headline…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <input
        className="search"
        placeholder="Filter by source/domain…"
        value={src}
        onChange={(e) => setSrc(e.target.value)}
      />
    </div>
  );
}

function FeedColumn({ topic, pollMs = 60000, batchSize = 24 }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("idle");
  const [visible, setVisible] = useState(batchSize);
  const [q, setQ] = useState("");
  const [src, setSrc] = useState("");
  const scroller = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        setStatus("loading");
        const data = await fetchTopic(topic.feeds);
        setItems(data);

        // Enrich a handful with page-scraped images (4 at a time, up to 16)
        (async () => {
          const copy = data.slice();
          const targets = copy.filter((x) => !x.image && x.link).slice(0, 16);
          let i = 0;
          const workers = Array.from({ length: 4 }, async () => {
            while (i < targets.length) {
              const idx = i++;
              const it = targets[idx];
              const img = await getBestImageForUrl(it.link);
              if (img) it.image = img;
            }
          });
          await Promise.all(workers);
          if (alive) setItems(copy);
        })();

        if (!alive) return;
        setVisible(Math.min(batchSize, data.length));
        setStatus("ok");
      } catch (e) {
        console.error(e);
        if (!alive) return;
        setStatus("error");
      }
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [topic.feeds, pollMs, batchSize]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
      if (nearBottom) setVisible((v) => Math.min(items.length, v + batchSize));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [items.length, batchSize]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      // For MSF topic, filter to only show MSF-related content
      if (topic.key === "msf") {
        const lower = it.title.toLowerCase();
        const isMSF = 
          lower.includes("marvel strike force") ||
          lower.includes("strike force") && lower.includes("marvel") ||
          lower.includes("msf") && (lower.includes("game") || lower.includes("scopely"));
        if (!isMSF) return false;
      }
      
      const hitQ = !q || it.title.toLowerCase().includes(q.toLowerCase());
      const hitS =
        !src ||
        it.source?.toLowerCase().includes(src.toLowerCase()) ||
        (it.link && it.link.toLowerCase().includes(src.toLowerCase()));
      return hitQ && hitS;
    });
  }, [items, q, src, topic.key]);

  const shown = filtered.slice(0, visible);

  return (
    <section className="column">
      <header className="column__header">
        <span className="topic-dot" style={{ background: COLORS[topic.key] }} />
        <h2 className="column__title">{topic.title}</h2>
        <div className="chip">{filtered.length.toLocaleString()}</div>
        <button
          className="refresh"
          onClick={() => {
            (async () => {
              try {
                setStatus("loading");
                const data = await fetchTopic(topic.feeds);
                setItems(data);
                setVisible(Math.min(batchSize, data.length));
                setStatus("ok");
                scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
              } catch {
                setStatus("error");
              }
            })();
          }}
        >
          ↻
        </button>
      </header>

      <Controls q={q} setQ={setQ} src={src} setSrc={setSrc} />
      {status === "loading" && <p className="hint">Loading latest…</p>}
      {status === "error" && <p className="hint error">Couldn’t load feeds.</p>}

      <div className="cards scroll" ref={scroller}>
        {shown.map((it, i) => {
          const highlight = getArticleHighlight(it.title, it.ts);
          return (
            <a
              className="card"
              key={`${topic.key}-${i}-${it.link}`}
              href={it.link}
              target="_blank"
              rel="noopener noreferrer"
              style={
                highlight
                  ? {
                      borderColor: highlight.border,
                      boxShadow: highlight.glow,
                    }
                  : undefined
              }
            >
            {SHOW_IMAGES && it.image && (
              <div className="thumb">
                <img
                  src={it.image}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const thumb = e.currentTarget.closest(".thumb");
                    if (thumb) thumb.style.display = "none";
                  }}
                />
              </div>
            )}

            <div className="meta">
              <div className="meta__source">
                {it.source ||
                  (() => {
                    try {
                      return new URL(it.link).hostname.replace("www.", "");
                    } catch {
                      return "";
                    }
                  })()}
              </div>
              <div className="meta__date">{formatTS(it.ts)}</div>
            </div>
            <h3 className="card__title">{it.title}</h3>
            </a>
          );
        })}
        <div className="endcap">
          {visible < filtered.length
            ? "Scroll to load more…"
            : "End of results"}
        </div>
      </div>
    </section>
  );
}

/* =========================
   App
   ========================= */
export default function App() {
  const columns = useMemo(() => TOPICS, []);
  return (
    <div className="app">
      <nav className="topbar">
        <h1>
          Multi-RSS News — AI • ML • Neural Networks • Gaming • Web Dev • Tech •
          Apple • Elgato • Corsair • Twitch • Metaphysics
        </h1>
        <p className="topbar__note">
          100% static React. Multiple RSS feeds per topic. Search and filter by
          source/domain.
        </p>
      </nav>
      <main className="grid">
        {columns.map((t) => (
          <FeedColumn key={t.key} topic={t} />
        ))}
      </main>
      <footer className="foot">
        <small>
          Images and headlines belong to their publishers. Educational reader.
        </small>
      </footer>
    </div>
  );
}
