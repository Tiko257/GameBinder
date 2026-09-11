import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_ROOT = process.env.GAMEBINDER_DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_ROOT, "gamebinder-config.json");

function readGameBinderConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { steamId: "" };
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { steamId: String(cfg.steamId || "") };
  } catch (_) {
    return { steamId: "" };
  }
}

function normalizeSteamIdInput(value) {
  const raw = String(value || "").trim();
  if (/^\d{17}$/.test(raw)) return raw;
  const match = raw.match(/steamcommunity\.com\/profiles\/(\d{17})(?:[\/?#]|$)/i);
  return match ? match[1] : "";
}

function writeGameBinderConfig(steamId) {
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ steamId: normalizeSteamIdInput(steamId) }, null, 2),
    "utf8"
  );
}

function getSteamId() {
  return readGameBinderConfig().steamId || process.env.STEAM_ID || "";
}

// Migrate older local configs: the experimental Steam-ID-only build never reads
// or stores the old Steam Web API key.
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const oldCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (oldCfg && Object.prototype.hasOwnProperty.call(oldCfg, "apiKey")) {
      writeGameBinderConfig(String(oldCfg.steamId || ""));
    }
  }
} catch (_) {}

const detailsCache = new Map();
const cacheBaseRoot = path.join(DATA_ROOT, "cache");
let cacheRoot = cacheBaseRoot;
let artworkCacheDir = path.join(cacheRoot, "artwork");
let detailsCacheFile = path.join(cacheRoot, "details.json");
let libraryCacheFile = path.join(cacheRoot, "library.json");
let artworkMetaFile = path.join(cacheRoot, "artwork.json");
let artworkMeta = {};
const artworkResolverCache = new Map();

function steamCacheRoot(steamId) {
  return path.join(cacheBaseRoot, String(steamId));
}

function clearActiveCaches() {
  detailsCache.clear();
  artworkMeta = {};
  artworkResolverCache.clear();
}

function loadActiveCaches() {
  clearActiveCaches();
  fs.mkdirSync(artworkCacheDir, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(detailsCacheFile, "utf8"));
    for (const [id, details] of Object.entries(saved || {})) detailsCache.set(id, details);
  } catch (_) {}
  try { artworkMeta = JSON.parse(fs.readFileSync(artworkMetaFile, "utf8")); } catch (_) {}
}

function migrateLegacyCacheToSteamId(steamId) {
  if (!/^\d{17}$/.test(String(steamId))) return;
  const legacyFiles = ["library.json", "details.json", "artwork.json"];
  const legacyArtwork = path.join(cacheBaseRoot, "artwork");
  const targetRoot = steamCacheRoot(steamId);
  if (fs.existsSync(targetRoot)) return;
  const hasLegacy = legacyFiles.some(name => fs.existsSync(path.join(cacheBaseRoot, name))) || fs.existsSync(legacyArtwork);
  if (!hasLegacy) return;
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const name of legacyFiles) {
    const src = path.join(cacheBaseRoot, name);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(targetRoot, name));
  }
  if (fs.existsSync(legacyArtwork)) fs.renameSync(legacyArtwork, path.join(targetRoot, "artwork"));
}

function activateCacheForSteamId(steamId) {
  const id = normalizeSteamIdInput(steamId);
  if (!/^\d{17}$/.test(id)) {
    cacheRoot = cacheBaseRoot;
  } else {
    migrateLegacyCacheToSteamId(id);
    cacheRoot = steamCacheRoot(id);
  }
  artworkCacheDir = path.join(cacheRoot, "artwork");
  detailsCacheFile = path.join(cacheRoot, "details.json");
  libraryCacheFile = path.join(cacheRoot, "library.json");
  artworkMetaFile = path.join(cacheRoot, "artwork.json");
  loadActiveCaches();
}

activateCacheForSteamId(getSteamId());
const pendingCacheWrites = new Map();
function saveJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); } catch (e) { console.error("Cache write error:", e.message); }
}
function scheduleJsonSave(file, value, delay=200) {
  const pending=pendingCacheWrites.get(file);
  if(pending) clearTimeout(pending.timer);
  const snapshot=JSON.stringify(value, null, 2);
  const timer=setTimeout(()=>{
    pendingCacheWrites.delete(file);
    try { fs.writeFileSync(file, snapshot, "utf8"); } catch(e) { console.error("Cache write error:", e.message); }
  },delay);
  pendingCacheWrites.set(file,{timer});
}
function artworkPath(appid) {
  const ext = artworkMeta[String(appid)]?.ext || ".img";
  return path.join(artworkCacheDir, `${appid}${ext}`);
}
function hasArtworkCache(appid) {
  const meta = artworkMeta[String(appid)];
  return Boolean(meta && fs.existsSync(artworkPath(appid)));
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    steamKeyConfigured: false,
    steamId: getSteamId(),
    librarySource: "Steam Community Big Picture JSON (experimental)"
  });
});

app.get("/api/cache/library", (_req, res) => {
  try {
    const saved = JSON.parse(fs.readFileSync(libraryCacheFile, "utf8"));
    if (!saved || !Array.isArray(saved.games)) return res.status(404).json({ error: "No local library cache yet." });
    const games = saved.games.map(g => {
      const id = String(g.app_id);
      const out = { ...g };
      const meta = artworkMeta[id];
      if (hasArtworkCache(id)) {
        out.artwork_url = `/api/artwork-cache/${id}`;
        out.artwork_cached = true;
        out.artwork_resolved = true;
        out.artwork_width = meta?.width || 0;
        out.artwork_height = meta?.height || 0;
        out.artwork_horizontal = Boolean(meta?.horizontal);
      }
      out.details_cached = detailsCache.has(id);
      return out;
    });
    res.json({ steamid: saved.steamid, game_count: saved.game_count ?? games.length, games, cached_at: saved.cached_at || null });
  } catch (_) {
    res.status(404).json({ error: "No local library cache yet." });
  }
});

app.get("/api/cache-status", (req, res) => {
  const rawIds = String(req.query.appids || "");
  const ids = [...new Set(rawIds.split(",").map(v => v.trim()).filter(v => /^\d+$/.test(v)))];
  const artwork = {};
  const details = {};
  ids.forEach(id => {
    if (hasArtworkCache(id)) artwork[id] = artworkMeta[id];
    if (detailsCache.has(id)) details[id] = detailsCache.get(id);
  });
  let library = null;
  try { library = JSON.parse(fs.readFileSync(libraryCacheFile, "utf8")); } catch (_) {}
  res.json({ artwork, details, library });
});

app.get("/api/artwork-cache/:appid", (req, res) => {
  const appid = String(req.params.appid);
  if (!/^\d+$/.test(appid) || !hasArtworkCache(appid)) return res.status(404).end();
  const meta = artworkMeta[appid];
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  if (meta?.contentType) res.setHeader("Content-Type", meta.contentType);
  res.sendFile(artworkPath(appid));
});

app.post("/api/cache-artwork", express.json({ limit: "1mb" }), async (req, res) => {
  const appid = String(req.body?.appid || "");
  const url = String(req.body?.url || "");
  const width = Number(req.body?.width || 0);
  const height = Number(req.body?.height || 0);
  const horizontal = Boolean(req.body?.horizontal);
  if (!/^\d+$/.test(appid) || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Invalid artwork cache request." });
  if (hasArtworkCache(appid)) return res.json({ cached: true, url: `/api/artwork-cache/${appid}` });
  try {
    const r = await fetch(url, { headers: { "User-Agent": "GameBinder/0.4.17" } });
    if (!r.ok) return res.status(502).json({ error: `Artwork source returned HTTP ${r.status}.` });
    const contentType = r.headers.get("content-type") || "application/octet-stream";
    if (!contentType.startsWith("image/")) return res.status(415).json({ error: "Artwork source is not an image." });
    const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : contentType.includes("avif") ? ".avif" : ".jpg";
    const target = path.join(artworkCacheDir, `${appid}${ext}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length) return res.status(502).json({ error: "Empty artwork response." });
    fs.writeFileSync(target, bytes);
    artworkMeta[appid] = { width, height, horizontal, contentType, ext, source: url, cached_at: new Date().toISOString() };
    scheduleJsonSave(artworkMetaFile, artworkMeta);
    res.json({ cached: true, url: `/api/artwork-cache/${appid}`, width, height, horizontal });
  } catch (e) {
    console.error("Artwork cache error:", e.message);
    res.status(500).json({ error: "Could not cache artwork." });
  }
});

app.get("/api/config", (_req, res) => {
  const cfg = readGameBinderConfig();
  res.json({ configured: Boolean(/^\d{17}$/.test(cfg.steamId)), steamId: cfg.steamId });
});

app.post("/api/config", express.json(), (req, res) => {
  const steamId = normalizeSteamIdInput(req.body?.steamId);

  if (!/^\d{17}$/.test(steamId)) {
    return res.status(400).json({ error: "Paste a valid Steam ID64 or a direct Steam profile link." });
  }

  try {
    writeGameBinderConfig(steamId);
    activateCacheForSteamId(steamId);
    res.json({ ok: true, steamId, cacheProfile: steamId });
  } catch (e) {
    res.status(500).json({ error: "Could not save Steam ID locally." });
  }
});

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(re);
  return match ? decodeXmlText(match[1]) : "";
}

function parseSteamCommunityXml(xml) {
  const text = String(xml || "");
  if (/<error\b/i.test(text)) {
    const message = xmlTag(text, "error");
    throw new Error(message || "Steam Community did not expose this profile.");
  }
  const blocks = text.match(/<game\b[\s\S]*?<\/game>/gi) || [];
  const games = [];
  for (const block of blocks) {
    const appId = xmlTag(block, "appID");
    if (!/^\d+$/.test(appId)) continue;
    const title = xmlTag(block, "name") || `App ${appId}`;
    const hours = Number(xmlTag(block, "hoursOnRecord") || 0);
    const lastTwoWeeks = Number(xmlTag(block, "hoursLast2Weeks") || 0);
    games.push({
      app_id: Number(appId),
      title,
      playtime_minutes: Number.isFinite(hours) ? Math.round(hours * 60) : 0,
      playtime_last_2_weeks_minutes: Number.isFinite(lastTwoWeeks) ? Math.round(lastTwoWeeks * 60) : 0,
      icon_hash: null,
      artwork_url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
      artwork_candidates: [
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/library_600x900_2x.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_capsule.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_748x896.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`
      ],
      icon_url: null
    });
  }
  if (!games.length) {
    throw new Error("Steam returned no games. Your Steam game details may be private, or Steam may not expose the Community XML for this profile.");
  }
  return games;
}

function extractAssignedJson(text, variableName) {
  const re = new RegExp(`(?:var\\s+|let\\s+|const\\s+)?${variableName}\\s*=\\s*`, "i");
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  const open = text[i];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(i, j + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function normalizeCommunityGameData(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const entries = Array.isArray(source)
    ? source.map((g, i) => [String(g?.appid ?? g?.appID ?? g?.id ?? i), g])
    : Object.entries(source);
  const games = [];
  for (const [key, value] of entries) {
    const g = value && typeof value === "object" ? value : {};
    const appId = String(g.appid ?? g.appID ?? g.id ?? key ?? "");
    if (!/^\d+$/.test(appId)) continue;
    const title = String(g.name ?? g.title ?? g.game_name ?? `App ${appId}`);
    const hoursRaw = g.hours_forever ?? g.hoursOnRecord ?? g.hours_played ?? g.playtime_forever_hours ?? 0;
    const lastRaw = g.hours_last_two_weeks ?? g.hoursLast2Weeks ?? g.playtime_2weeks_hours ?? 0;
    const hours = Number(hoursRaw) || 0;
    const lastHours = Number(lastRaw) || 0;
    games.push({
      app_id: Number(appId),
      title,
      playtime_minutes: Math.round(hours * 60),
      playtime_last_2_weeks_minutes: Math.round(lastHours * 60),
      icon_hash: g.icon_hash ?? g.iconhash ?? g.icon ?? null,
      artwork_url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
      artwork_candidates: [
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_capsule.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_748x896.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`
      ],
      icon_url: null
    });
  }
  const seen = new Set();
  return games.filter(g => { if (seen.has(g.app_id)) return false; seen.add(g.app_id); return true; });
}

async function fetchSteamCommunityBigPictureLibrary(steamid) {
  const url = `https://steamcommunity.com/profiles/${steamid}/games/?tab=all`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "GameBinder/1.2 SteamCommunityBigPictureTest",
      "X-ValveUserAgent": "panorama",
      "Accept": "text/html,application/xhtml+xml,*/*"
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Steam Community returned HTTP ${response.status}.`);

  // Steam's Big Picture/"panorama" response has historically exposed the
  // user's games as g_rgGameData JSON. This is unofficial and can change.
  let data = extractAssignedJson(body, "g_rgGameData");
  let sourceName = "g_rgGameData";
  if (!data) {
    // Some Community page variants expose rgGames instead.
    data = extractAssignedJson(body, "rgGames");
    sourceName = "rgGames";
  }
  if (!data) {
    if (/private|game details.*private|games.*private/i.test(body)) {
      throw new Error("Steam did not expose the game list. Your Steam Game Details may be private.");
    }
    throw new Error("Steam Community did not expose g_rgGameData/rgGames for this profile.");
  }
  const games = normalizeCommunityGameData(data);
  if (!games.length) throw new Error("Steam Community exposed no games in its Big Picture/JSON data.");
  return { games, url, sourceName };
}

app.get("/api/library", async (req, res) => {
  const steamid = String(req.query.steamid || getSteamId());
  const requestStartedAt = new Date().toISOString();

  if (!/^\d{17}$/.test(steamid)) {
    return res.status(400).json({ error: "Invalid SteamID64." });
  }

  try {
    const { games: parsedGames, url, sourceName } = await fetchSteamCommunityBigPictureLibrary(steamid);
    const games = parsedGames.map(g => ({ ...g }));

    games.sort((a, b) => a.title.localeCompare(b.title));
    games.forEach(g => {
      const id = String(g.app_id);
      const meta = artworkMeta[id];
      if (hasArtworkCache(id)) {
        g.artwork_url = `/api/artwork-cache/${id}`;
        g.artwork_cached = true;
        g.artwork_resolved = true;
        g.artwork_width = meta?.width || 0;
        g.artwork_height = meta?.height || 0;
        g.artwork_horizontal = Boolean(meta?.horizontal);
      }
      if (detailsCache.has(id)) g.details_cached = true;
    });

    saveJson(libraryCacheFile, {
      steamid,
      game_count: games.length,
      games,
      source: "steam_community_big_picture_json",
      source_url: url,
      cached_at: new Date().toISOString()
    });

    res.json({
      steamid,
      game_count: games.length,
      games,
      source: "steam_community_big_picture_json",
      warning: `Experimental Steam ID-only source using Steam Community ${sourceName}. This is unofficial and may change without notice.`,
      live_fetched_at: requestStartedAt,
      cache_used_for_library: false
    });
  } catch (error) {
    console.error("Steam Community library error:", error.message);
    res.status(502).json({
      error: error.message || "Could not reach Steam Community.",
      hint: "Make sure your Steam profile's Game Details are Public. This experimental mode does not use a Steam Web API key and uses the Steam Community Big Picture JSON route."
    });
  }
});

app.get("/api/artwork/:appid", async (req, res) => {
  const appid = String(req.params.appid);
  if (!/^\d+$/.test(appid)) return res.status(400).json({ error: "Invalid App ID." });
  if (artworkResolverCache.has(appid)) return res.json(artworkResolverCache.get(appid));
  try {
    // Newer Steam games use content-hashed asset paths, so an App ID alone
    // is not enough to build the correct library artwork URL. GetItems returns
    // the current asset filename/path for the App ID.
    let candidates = [];
    let preferHorizontal = false;
    // Known-good current Steam library assets for Battlefield 6 entries.
    // These are content-hashed paths, so they cannot be derived from App ID alone.
    const knownSteamArtwork = {
      "2807960": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2807960/289b1c193f9730a0d4ea4dbf912219e46cd1a8a3/library_capsule_2x.jpg",
      "3081410": "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3081410/52f9c64d00833656891243f0475d51c9a27f1013/library_capsule_2x.jpg"
    };
    if (knownSteamArtwork[appid]) candidates.push(knownSteamArtwork[appid]);
    try {
      const input = {
        ids: [{ appid: Number(appid) }],
        context: { language: "english", country_code: "US", steam_realm: 1 },
        data_request: {
          include_assets: true,
          include_assets_without_overrides: true
        }
      };
      const browseUrl = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
      const browseResponse = await fetch(browseUrl, { headers: { "User-Agent": "GameBinder/0.4.14" } });
      if (browseResponse.ok) {
        const browseRaw = await browseResponse.json();
        const item = browseRaw?.response?.store_items?.[0];
        const assets = item?.assets || {};
        const format = String(assets.asset_url_format || "").trim();
        // SteamDB shows some older titles (including the F.E.A.R. games) using
        // a generated library_capsule named portrait.png. That portrait is a
        // vertical wrapper around horizontal store art. When Steam reports
        // that generated asset, prefer the real horizontal capsule/header so
        // the client can rotate that final image inside the 4.8 card.
        for (const key of ["library_capsule_2x", "library_capsule", "library_600x900_2x", "library_600x900"]) {
          const value = String(assets[key] || "").toLowerCase();
          if (value.endsWith("/portrait.png") || value === "portrait.png") {
            preferHorizontal = true;
            break;
          }
        }
        // GetItems returns these as flat fields. The important part is the
        // library capsule: Steam may put a content hash in FILENAME.
        const assetKeys = [
          "library_capsule_2x", "library_capsule",
          "library_600x900_2x", "library_600x900",
          "hero_capsule_2x", "hero_capsule",
          "main_capsule_2x", "main_capsule",
          "header_2x", "header"
        ];
        if (format) {
          for (const key of assetKeys) {
            const filename = assets[key];
            if (!filename) continue;
            const resolved = format.replace("${FILENAME}", filename);
            if (/^https?:\/\//i.test(resolved)) {
              candidates.push(resolved);
            } else {
              candidates.push(`https://shared.steamstatic.com/store_item_assets/${resolved}`);
              candidates.push(`https://shared.fastly.steamstatic.com/store_item_assets/${resolved}`);
              candidates.push(`https://shared.akamai.steamstatic.com/store_item_assets/${resolved}`);
            }
          }
        }
      }
    } catch (_) {}

    // Keep appdetails and legacy App-ID URLs as fallbacks for older titles.
    try {
      const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=en&cc=us`;
      const response = await fetch(url, { headers: { "User-Agent": "GameBinder/0.4.14" } });
      if (response.ok) {
        const raw = await response.json();
        const d = raw?.[appid]?.success ? raw[appid].data : null;
        if (d) candidates.push(d.library_capsule, d.header_image, d.capsule_image);
      }
    } catch (_) {}

    candidates.push(
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900_2x.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_capsule_2x.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_capsule.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_616x353_2x.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_616x353.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header_2x.jpg`,
      `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`
    );

    const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
    if (!uniqueCandidates.length) return res.status(404).json({ error: "No Steam Store artwork found." });
    const payload={ app_id: Number(appid), candidates: uniqueCandidates, prefer_horizontal: preferHorizontal };
    artworkResolverCache.set(appid,payload);
    res.json(payload);
  } catch (error) {
    console.error("Steam artwork error:", error.message);
    res.status(500).json({ error: "Could not reach Steam Store artwork." });
  }
});


app.get("/api/details-batch", async (req, res) => {
  const rawIds = String(req.query.appids || "");
  const ids = [...new Set(rawIds.split(",").map(v => v.trim()).filter(v => /^\d+$/.test(v)))].slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: "No valid App IDs." });

  // V38: FEATURES comes from the same GetItems payload that already powers
  // ABOUT/developer/publisher. Re-fetch old cache entries that predate the
  // feature field instead of treating them as complete.
  const missing = ids.filter(id => !detailsCache.has(id) || !detailsCache.get(id)?.features_v1);
  const result = {};
  for (const id of ids) {
    if (detailsCache.has(id)) result[id] = detailsCache.get(id);
  }
  if (!missing.length) return res.json({ details: result });

  try {
    const input = {
      ids: missing.map(appid => ({ appid: Number(appid) })),
      context: { language: "english", country_code: "US", steam_realm: 1 },
      data_request: {
        include_release: true,
        include_basic_info: true
      }
    };
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(url, { headers: { "User-Agent": "GameBinder/0.4.13" } });
    if (!response.ok) throw new Error(`GetItems HTTP ${response.status}`);
    const raw = await response.json();
    const items = Array.isArray(raw?.response?.store_items) ? raw.response.store_items : [];

    const cleanText = value => String(value || "").replace(/<[^>]*>/g, "").trim();
    const toDate = value => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return "";
      return new Date(n * 1000).toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric", timeZone:"UTC" });
    };
    const firstName = value => Array.isArray(value) ? (value[0]?.name || value[0] || "") : (value?.name || value || "");

    // Steam's GetItems exposes category IDs directly in the same StoreItem
    // payload. These are the human-facing player/feature categories we want
    // on the card; no second Store request is needed for FEATURES.
    const featureNames = new Map([
      [1, "Multi-player"], [2, "Single-player"], [9, "Co-op"], [38, "Online Co-op"],
      [48, "LAN Co-op"], [39, "Shared/Split Screen Co-op"], [27, "Cross-Platform Multiplayer"],
      [36, "Online PvP"], [37, "Shared/Split Screen PvP"], [47, "LAN PvP"], [49, "PvP"],
      [22, "Steam Achievements"], [23, "Steam Cloud"], [29, "Steam Trading Cards"],
      [30, "Steam Workshop"], [28, "Full Controller Support"], [18, "Partial Controller Support"],
      [52, "Tracked Controller Support"], [59, "Steam Input API Support"], [60, "Controller Preferred"],
      [44, "Remote Play Together"], [41, "Remote Play on Phone"], [42, "Remote Play on Tablet"],
      [43, "Remote Play on TV"], [62, "Family Sharing"], [50, "Additional High-Quality Audio"],
      [13, "Captions available"], [40, "SteamVR Collectibles"], [53, "VR Supported"], [54, "VR Only"]
    ]);
    const extractFeaturesFromItem = item => {
      const cats=item?.categories || {};
      const ids=[...(Array.isArray(cats?.supported_player_categoryids)?cats.supported_player_categoryids:[]), ...(Array.isArray(cats?.feature_categoryids)?cats.feature_categoryids:[]), ...(Array.isArray(cats?.controller_categoryids)?cats.controller_categoryids:[])];
      return [...new Set(ids.map(Number).map(id=>featureNames.get(id)).filter(Boolean))].slice(0,8);
    };

    for (const item of items) {
      const id = String(item?.appid || "");
      if (!id || !missing.includes(id)) continue;
      const basic = item?.basic_info || {};
      const release = item?.release || {};
      const details = {
        app_id: Number(id),
        title: item?.name || `App ${id}`,
        year: release?.steam_release_date ? new Date(Number(release.steam_release_date) * 1000).getUTCFullYear().toString() : "",
        release_date: toDate(release?.steam_release_date),
        developer: firstName(basic?.developers || item?.developers),
        publisher: firstName(basic?.publishers || item?.publishers),
        description: cleanText(basic?.short_description || item?.short_description),
        features: extractFeaturesFromItem(item),
        features_v1: true,
        steam_url: `https://store.steampowered.com/app/${id}/`
      };
      detailsCache.set(id, details);
      result[id] = details;
    }

    // Some legacy/unlisted apps may not be returned by GetItems. Give them a
    // lightweight singular fallback, but only for the missing IDs and with a
    // small concurrency cap so one odd app cannot stall the whole library.
    const stillMissing = missing.filter(id => !result[id]);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, stillMissing.length) }, async () => {
      while (cursor < stillMissing.length) {
        const id = stillMissing[cursor++];
        try {
          const u = `https://store.steampowered.com/api/appdetails?appids=${id}&l=en&cc=us`;
          const r = await fetch(u, { headers: { "User-Agent": "GameBinder/0.4.13" } });
          if (!r.ok) continue;
          const rawOne = await r.json();
          const d = rawOne?.[id]?.success ? rawOne[id].data : null;
          if (!d) continue;
          const details = {
            app_id: Number(id),
            title: d.name || `App ${id}`,
            year: d.release_date?.date ? (d.release_date.date.match(/\d{4}/)?.[0] || "") : "",
            release_date: String(d.release_date?.date || "").trim(),
            developer: Array.isArray(d.developers) ? d.developers[0] : "",
            publisher: Array.isArray(d.publishers) ? d.publishers[0] : "",
            description: cleanText(d.short_description),
            features: [],
            features_v1: false,
            steam_url: `https://store.steampowered.com/app/${id}/`
          };
          detailsCache.set(id, details);
          result[id] = details;
        } catch (_) {}
      }
    });
    await Promise.all(workers);
    scheduleJsonSave(detailsCacheFile, Object.fromEntries(detailsCache), 50);

    res.json({ details: result });
  } catch (error) {
    console.error("Steam batch details error:", error.message);
    // Do not leave the UI waiting forever. Return any cached details we have.
    res.json({ details: result, warning: "Steam detail service temporarily unavailable." });
  }
});

app.get("/api/details/:appid", async (req, res) => {
  const appid = String(req.params.appid);
  if (!/^\d+$/.test(appid)) return res.status(400).json({ error: "Invalid App ID." });
  if (detailsCache.has(appid)) return res.json(detailsCache.get(appid));
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=en&cc=us`;
    const response = await fetch(url, { headers: { "User-Agent": "GameBinder/0.4.5" } });
    if (!response.ok) return res.status(502).json({ error: `Steam Store returned HTTP ${response.status}.` });
    const raw = await response.json();
    const d = raw?.[appid]?.success ? raw[appid].data : null;
    if (!d) return res.status(404).json({ error: "No Steam Store details found." });
    const details = {
      app_id: Number(appid),
      title: d.name || `App ${appid}`,
      year: d.release_date?.date ? (d.release_date.date.match(/\d{4}/)?.[0] || "") : "",
      release_date: String(d.release_date?.date || "").trim(),
      developer: Array.isArray(d.developers) ? d.developers[0] : "",
      publisher: Array.isArray(d.publishers) ? d.publishers[0] : "",
      description: String(d.short_description || "").replace(/<[^>]*>/g, "").trim(),
      steam_url: `https://store.steampowered.com/app/${appid}/`
    };
    detailsCache.set(appid, details);
    scheduleJsonSave(detailsCacheFile, Object.fromEntries(detailsCache));
    res.json(details);
  } catch (error) {
    console.error("Steam Store details error:", error.message);
    res.status(500).json({ error: "Could not reach Steam Store details." });
  }
});

app.listen(PORT, () => {
  console.log(`GameBinder v4.8.17 running at http://localhost:${PORT}`);
});
