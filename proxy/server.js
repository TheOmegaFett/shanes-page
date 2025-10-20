import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

/** Allow your static site to call this service */
app.use(cors({ origin: "*" })); // tighten later if you want

// Helper: forward a URL and return text, with caching hints
async function forward(url, res) {
  try {
    const r = await fetch(url, {
      // Impersonate a browser a bit
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsReader/1.0)" },
      redirect: "follow",
    });
    if (!r.ok) {
      res.status(r.status).send(await r.text());
      return;
    }
    // Set permissive CORS + cache headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=120"); // 2 minutes
    res.type("text/xml; charset=utf-8");
    res.send(await r.text());
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
}

// Handle preflight requests
app.options("*", cors());

/** RSS: /gn/rss/search?q=...&hl=...&gl=...&ceid=... */
app.get("/gn/*", async (req, res) => {
  // Only allow Google News host
  const path = req.params[0] || "";
  const qs = req.url.split("?")[1] || "";
  const target = `https://news.google.com/${path}${qs ? "?" + qs : ""}`;
  await forward(target, res);
});

/** Generic fetch for article HTML: /page?url=https://example.com/article */
app.get("/page", async (req, res) => {
  const { url } = req.query;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Bad protocol");
  } catch {
    return res.status(400).send("Invalid url");
  }
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsReader/1.0)" },
      redirect: "follow",
    });
    if (!r.ok) {
      res.status(r.status).send(await r.text());
      return;
    }
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=300");
    res.type("text/html; charset=utf-8");
    res.send(await r.text());
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`RSS proxy listening on :${PORT}`));
