import { app, BrowserWindow, shell, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;
let gamebinderServer;
let steamAuthWindow;

function normalizeSteamCommunityGame(g) {
  const appId = Number(g?.appid ?? g?.appID ?? g?.app_id ?? 0);
  if (!Number.isFinite(appId) || appId <= 0) return null;
  const title = String(g?.name ?? g?.title ?? `App ${appId}`).trim() || `App ${appId}`;
  const hours = Number(g?.hours_forever ?? g?.hoursOnRecord ?? g?.hours ?? 0);
  const last2 = Number(g?.hours_last_two_weeks ?? g?.hoursLast2Weeks ?? 0);
  return {
    app_id: appId, title,
    playtime_minutes: Number.isFinite(hours) ? Math.round(hours * 60) : 0,
    playtime_last_2_weeks_minutes: Number.isFinite(last2) ? Math.round(last2 * 60) : 0,
    icon_hash: g?.icon || g?.icon_hash || null,
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
    icon_url: g?.icon ? `https://media.steampowered.com/steamcommunity/public/images/apps/${appId}/${g.icon}.jpg` : null
  };
}

async function extractSteamGamesFromPage(win) {
  return await win.webContents.executeJavaScript(`(() => {
    const candidates = [];
    const add = (appid, name='') => {
      const id = Number(appid);
      if (!Number.isFinite(id) || id <= 0) return;
      const title = String(name || '').replace(/\\s+/g,' ').trim();
      candidates.push({appid:id,name:title || \`App \${id}\`});
    };

    // 1) Read Steam's rendered game rows. This is intentionally broad because
    // Steam has changed the row class names over time.
    const rows = Array.from(document.querySelectorAll(
      '[data-appid], [data-app-id], .gameListRow, .gameListRowItem, [class*="gameListRow"]'
    ));
    for (const row of rows) {
      const id = row.getAttribute('data-appid') || row.getAttribute('data-app-id') || row.dataset?.appid || row.dataset?.appId;
      const link = row.querySelector('a[href*="/app/"]');
      const href = link?.getAttribute('href') || '';
      const hrefId = (href.match(/\\/app\\/(\\d+)/i) || [])[1];
      const nameEl = row.querySelector('.gameListRowItemName, .gameListRowItemName a, .gameListRowItemName div, [class*="gameListRowItemName"]');
      const name = nameEl?.textContent?.trim() || link?.textContent?.trim() || '';
      add(id || hrefId, name);
    }

    // 2) Steam sometimes renders only links, with no useful data-* attributes.
    // Restrict this to anchors living inside a game-list-like ancestor so that
    // store/recommendation links elsewhere on the profile are not imported.
    for (const link of Array.from(document.querySelectorAll('a[href*="/app/"]'))) {
      const href = link.getAttribute('href') || '';
      const id = (href.match(/\\/app\\/(\\d+)/i) || [])[1];
      if (!id) continue;
      const parent = link.closest('[class*="gameList"], [class*="GameList"], [data-appid], [data-app-id]');
      if (parent) add(id, link.textContent?.trim() || '');
    }

    // 3) Parse the page's own game data if Steam exposes it. We support both
    // strict JSON and a JSON-looking assignment with HTML-escaped characters.
    const html = document.documentElement?.innerHTML || '';
    for (const name of ['rgGames','g_rgGameData']) {
      const re = new RegExp('(?:var\\s+|let\\s+|const\\s+)?'+name+'\\s*=\\s*([\\[\\{])');
      const m = re.exec(html);
      if (!m) continue;
      const start = m.index + m[0].length - 1;
      const open = html[start]; const close = open === '[' ? ']' : '}';
      let depth=0, quote=null, esc=false;
      for (let i=start;i<html.length;i++) {
        const c=html[i];
        if (quote) { if (esc) esc=false; else if(c==='\\\\') esc=true; else if(c===quote) quote=null; continue; }
        if(c==='"' || c==="'") { quote=c; continue; }
        if(c===open) depth++; else if(c===close) { depth--; if(depth===0) {
          let raw=html.slice(start,i+1).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
          try {
            const data=JSON.parse(raw);
            const arr=Array.isArray(data)?data:(data && typeof data==='object'?Object.values(data):[]);
            for(const g of arr) add(g?.appid ?? g?.appID ?? g?.app_id, g?.name ?? g?.title ?? '');
          } catch(_) {}
          break;
        }}
      }
    }

    const out=[]; const seen=new Set();
    for(const g of candidates){
      if(seen.has(g.appid)) continue;
      seen.add(g.appid); out.push(g);
    }
    return {games:out, url:location.href, title:document.title, links:document.querySelectorAll('a[href*="/app/"]').length};
  })()`);
}


async function fetchAuthenticatedSteamPage(win, url, ua) {
  const cookies = await win.webContents.session.cookies.get({ url: 'https://steamcommunity.com' });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const response = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
    },
    redirect: 'follow'
  });
  const body = await response.text();
  return { response, body, cookieCount: cookies.length };
}

function extractAssignedJson(text, variableName) {
  const source = String(text || '');
  const re = new RegExp(`(?:var\\s+|let\\s+|const\\s+)?${variableName}\\s*=\\s*`, 'i');
  const m = re.exec(source);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < source.length && /\\s/.test(source[i])) i++;
  const open = source[i];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const raw = source.slice(i, j + 1)
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        try { return JSON.parse(raw); } catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractAppIdsFromSteamHtml(html) {
  const text = String(html || '');
  const found = new Map();
  const add = (id, title='') => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    const t = String(title || '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\s+/g, ' ').trim();
    if (!found.has(n)) found.set(n, { appid:n, name:t || `App ${n}` });
  };

  // Steam's authenticated Games page contains game rows/links in the HTML.
  for (const m of text.matchAll(/(?:data-appid|data-app-id)=["'](\d+)["'][\s\S]{0,1200}?<\/[^>]+>/gi)) {
    add(m[1]);
  }
  for (const m of text.matchAll(/href=["'][^"']*\/app\/(\d+)(?:\/|["'?])/gi)) {
    const around = text.slice(Math.max(0, m.index - 500), Math.min(text.length, m.index + 1200));
    const name = (around.match(/(?:gameListRowItemName|data-tooltip-text|aria-label)=["']([^"']+)/i) || [])[1] || '';
    add(m[1], name);
  }

  // Also accept JSON game structures if Steam includes them in the authenticated response.
  for (const variableName of ['rgGames','g_rgGameData']) {
    const data = extractAssignedJson(text, variableName);
    if (!data) continue;
    const arr = Array.isArray(data) ? data : Object.values(data);
    for (const g of arr) add(g?.appid ?? g?.appID ?? g?.app_id ?? g?.id, g?.name ?? g?.title ?? '');
  }

  return [...found.values()];
}

async function connectSteamLibrary(steamId) {
  if (!/^\d{17}$/.test(String(steamId || ''))) throw new Error('Invalid Steam ID64.');
  if (steamAuthWindow && !steamAuthWindow.isDestroyed()) steamAuthWindow.close();

  steamAuthWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 900, minHeight: 650,
    title: 'Connect to Steam — GameBinder',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101216',
