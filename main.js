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
    webPreferences: { nodeIntegration:false, contextIsolation:true, sandbox:true }
  });

  const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  steamAuthWindow.webContents.setUserAgent(ua);
  steamAuthWindow.webContents.on('did-start-loading', () => console.log('[GameBinder] Steam child: did-start-loading'));
  steamAuthWindow.webContents.on('did-stop-loading', () => console.log('[GameBinder] Steam child: did-stop-loading', steamAuthWindow?.webContents.getURL()));
  steamAuthWindow.webContents.on('did-navigate', (_e,url) => console.log('[GameBinder] Steam navigation:', url));
  steamAuthWindow.webContents.on('did-fail-load', (_e,code,desc,url) => console.error('[GameBinder] Steam load failed:', code,desc,url));

  steamAuthWindow.once('ready-to-show', () => {
    try { steamAuthWindow.show(); steamAuthWindow.focus(); steamAuthWindow.moveTop(); } catch (_) {}
  });
  try { steamAuthWindow.show(); steamAuthWindow.focus(); steamAuthWindow.moveTop(); } catch (_) {}

  const base=`https://steamcommunity.com/profiles/${steamId}/games/?tab=all&sort=name`;
  console.log('[GameBinder] Opening Steam Community:',base);
  try { await steamAuthWindow.loadURL(base,{userAgent:ua}); }
  catch(e) { console.error('[GameBinder] initial Steam load error:',e); }

  try { mainWindow?.webContents.send('gamebinder:steam-progress', {stage:'authenticated-page', message:'Steam page loaded. Loading the complete game list…'}); } catch (_) {}

  try {
    // Steam's Games page is dynamically populated as the user scrolls. Recent
    // community reports confirm that the complete list is exposed only after
    // scrolling to the bottom. We deliberately do this inside the authenticated
    // Steam window so the same session that displays the 356 games is used.
    const result = await steamAuthWindow.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const getCount = () => {
        const selectors = [
          'a[href*="/app/"]',
          '[data-appid]',
          '[data-app-id]',
          '[class*="gameListRow"]',
          '[class*="gameslistitems_GameName"]'
        ];
        const set = new Set();
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            const href = el.getAttribute?.('href') || '';
            const id = (href.match(/\\/app\\/(\\d+)/i) || [])[1]
              || el.getAttribute?.('data-appid')
              || el.getAttribute?.('data-app-id');
            if (id) set.add(String(id));
          }
        }
        return set.size;
      };
      const getHeight = () => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      const metrics = () => ({height:getHeight(), count:getCount()});

      // Steam's Games page is lazy-loaded. Instead of sleeping a fixed 450ms
      // after every scroll, wait only until the DOM actually grows. This keeps
      // the old safety behavior but removes most of the unnecessary idle time.
      const waitForGrowth = async (before, timeout=900) => {
        const started=Date.now();
        while(Date.now()-started < timeout){
          await sleep(60);
          const now=metrics();
          if(now.count>before.count || now.height>before.height+40) return now;
        }
        return metrics();
      };

      let current=metrics();
      let stableRounds=0;
      const maxRounds=60;
      for(let round=0; round<maxRounds; round++){
        const before=current;
        window.scrollTo(0, document.documentElement.scrollHeight);
        current=await waitForGrowth(before, 900);

        if(current.count>before.count || current.height>before.height+40){
          stableRounds=0;
          continue;
        }

        // If Steam did not react to the exact bottom position, give its lazy
        // loader a second trigger point near the bottom, but only when needed.
        window.scrollTo(0, Math.max(0, current.height-Math.max(window.innerHeight*1.35,900)));
        await sleep(70);
        window.scrollTo(0, document.documentElement.scrollHeight);
        const nudged=await waitForGrowth(current, 420);
        if(nudged.count>current.count || nudged.height>current.height+40){
          current=nudged;
          stableRounds=0;
          continue;
        }

        stableRounds++;
        current=nudged;
        // Four consecutive no-growth checks are enough to declare the lazy
        // list settled, while still allowing late Steam batches to appear.
        if(stableRounds>=4) break;
      }

      // Final settle pass, shorter than the previous fixed 1.2s delay.
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(180);

      const found = new Map();
      const add = (id, title='') => {
        const n = Number(id);
        if (!Number.isFinite(n) || n <= 0) return;
        const t = String(title || '').replace(/\\s+/g, ' ').trim();
        if (!found.has(n)) found.set(n, { appid:n, name:t || ('App ' + n) });
      };

      for (const row of Array.from(document.querySelectorAll('[data-appid], [data-app-id], [class*="gameListRow"], [class*="gameslistitems_GameName"]'))) {
        const id = row.getAttribute('data-appid') || row.getAttribute('data-app-id') || row.dataset?.appid || row.dataset?.appId;
        const link = row.matches?.('a[href*="/app/"]') ? row : row.querySelector?.('a[href*="/app/"]');
        const href = link?.getAttribute?.('href') || '';
        const hrefId = (href.match(/\\/app\\/(\\d+)/i) || [])[1];
        const name = row.textContent?.trim() || link?.textContent?.trim() || '';
        add(id || hrefId, name);
      }
      for (const link of Array.from(document.querySelectorAll('a[href*="/app/"]'))) {
        const href = link.getAttribute('href') || '';
        const id = (href.match(/\\/app\\/(\\d+)/i) || [])[1];
        if (!id) continue;
        const row = link.closest?.('[class*="gameListRow"], [class*="gameslistitems"], [data-appid], [data-app-id]');
        add(id, row?.textContent?.trim() || link.textContent?.trim() || '');
      }

      return {
        games: [...found.values()],
        url: location.href,
        title: document.title,
        scrollHeight: getHeight(),
        renderedCount: found.size
      };
    })()`, true);

    console.log('[GameBinder] Dynamic Steam extraction:', result);
    try { mainWindow?.webContents.send('gamebinder:steam-progress', {stage:'parse', page:1, games:result.renderedCount, message:`Steam loaded ${result.renderedCount} games from the authenticated page…`}); } catch (_) {}

    const normalized=[...(result?.games || [])].map(normalizeSteamCommunityGame).filter(Boolean);
    if (!normalized.length) throw new Error(`Steam session is active, but no game App IDs were found after loading the complete authenticated Games page (${result?.url || base}).`);

    return {
      games: normalized,
      source: 'steam_authenticated_dynamic_games_page',
      pages: 1,
      rendered_count: normalized.length,
      source_url: result.url || base
    };
  } finally {
    if (steamAuthWindow && !steamAuthWindow.isDestroyed()) steamAuthWindow.close();
    steamAuthWindow=null;
  }
}



async function createWindow() {
  process.env.GAMEBINDER_DATA_DIR = app.getPath("userData");
  process.env.PORT = process.env.PORT || "3000";

  gamebinderServer = await import(pathToFileURL(path.join(__dirname, "server.js")).href);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "GameBinder",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(`http://localhost:${process.env.PORT}`);
}


ipcMain.handle("gamebinder:steam-connect", async (_event, steamId) => {
  return await connectSteamLibrary(String(steamId || ""));
});

async function readWindowsPrintJobs() {
  if (process.platform !== "win32") return [];
  const script = `
    $jobs = @(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction SilentlyContinue |
      Select-Object JobId,Name,Document,PrinterName,TotalPages,PagesPrinted,Status,JobStatus,TimeSubmitted)
    if ($jobs.Count -eq 0) { '[]' } else { $jobs | ConvertTo-Json -Compress }
  `;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024 });
    const raw = String(stdout || "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

function printJobKey(job) {
  return `${job?.PrinterName || ""}|${job?.JobId ?? job?.Name ?? ""}`;
}

function sendPrintProgress(data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("gamebinder:print-progress", data);
  } catch (_) {}
}

function startWindowsPrintMonitor(expectedPages) {
  if (process.platform !== "win32") {
    return { callbackReturned: () => {}, stop: () => {}, promise: Promise.resolve({ detected: false, completed: false }) };
  }

  let stopped = false;
  let timer = null;
  let callbackHasReturned = false;
  let resolveDone;
  let baselinePromise = readWindowsPrintJobs();
  let activeKey = null;
  let lastPrinted = 0;
  let idleSince = 0;
  const startedAt = Date.now();

  const promise = new Promise(resolve => { resolveDone = resolve; });
  const finish = result => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    resolveDone(result);
  };

  const poll = async () => {
    if (stopped) return;
    const baselineJobs = await baselinePromise;
    const baseline = new Set(baselineJobs.map(printJobKey));
    const jobs = await readWindowsPrintJobs();
    const now = Date.now();

    if (!activeKey) {
      const candidates = jobs.filter(job => {
        const key = printJobKey(job);
        const submitted = job?.TimeSubmitted ? Date.parse(String(job.TimeSubmitted)) : 0;
        return !baseline.has(key) && (!submitted || submitted >= startedAt - 15000);
      });
      if (candidates.length) {
        const ranked = candidates.slice().sort((a,b) => {
          const aGameBinder = /gamebinder/i.test(String(a.Document || a.Name || "")) ? 0 : 1;
          const bGameBinder = /gamebinder/i.test(String(b.Document || b.Name || "")) ? 0 : 1;
          return aGameBinder - bGameBinder || Number(a.JobId || 0) - Number(b.JobId || 0);
        });
        const job = ranked[0];
        activeKey = printJobKey(job);
        idleSince = 0;
        const total = Number(job.TotalPages) || expectedPages;
        sendPrintProgress({ stage: "spooling", detected: true, printer: job.PrinterName || "", jobId: job.JobId ?? null, printed: 0, total, message: `Windows print job detected · 0 / ${total} pages` });
      }
    }

    if (activeKey) {
      const current = jobs.find(job => printJobKey(job) === activeKey);
      if (current) {
        const total = Number(current.TotalPages) || expectedPages;
        const printed = Math.max(lastPrinted, Number(current.PagesPrinted) || 0);
        lastPrinted = printed;
        idleSince = 0;
        sendPrintProgress({ stage: "spooling", detected: true, printer: current.PrinterName || "", jobId: current.JobId ?? null, printed, total, status: current.JobStatus || current.Status || "", message: printed > 0 ? `Printing · ${printed} / ${total} pages` : `Sending to printer… 0 / ${total} pages` });
        if (total > 0 && printed >= total) {
          finish({ detected: true, completed: true, printed, total });
          return;
        }
        const status = String(current.JobStatus || current.Status || "").toLowerCase();
        if (/error|failed|blocked|offline|paper jam|user intervention/.test(status)) {
          finish({ detected: true, completed: false, failed: true, printed, total, status });
          return;
        }
      } else if (lastPrinted > 0) {
        // Some port monitors remove a job immediately after the last page is
        // accepted. If page progress was observed, disappearance is completion.
        finish({ detected: true, completed: true, printed: lastPrinted, total: expectedPages });
        return;
      }
    }

    if (callbackHasReturned && !activeKey) {
      if (!idleSince) idleSince = now;
      // If the selected driver never exposes a spooler job, do not hold the UI
      // forever. We still report that Windows accepted the print call.
      if (now - idleSince >= 12000) finish({ detected: false, completed: false });
    }
  };

  timer = setInterval(() => { poll().catch(() => {}); }, 1000);
  poll().catch(() => {});

  return {
    callbackReturned() {
      callbackHasReturned = true;
      poll().catch(() => {});
    },
    stop() {
      if (!stopped) finish({ detected: Boolean(activeKey), completed: false, printed: lastPrinted, total: expectedPages });
    },
    promise
  };
}

ipcMain.handle("gamebinder:print", async (_event, expectedPages = 0) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("GameBinder window is not available.");
  }

  const totalPages = Number(expectedPages) || 0;
  const monitor = startWindowsPrintMonitor(totalPages);
  sendPrintProgress({ stage: "dialog", printed: 0, total: totalPages, message: "Opening Windows Print Dialog…" });

  try {
    await new Promise((resolve, reject) => {
      mainWindow.webContents.print({
        silent: false,
        printBackground: true,
        color: true,
        landscape: false,
        margins: { marginType: "default" }
      }, (success, failureReason) => {
        monitor.callbackReturned();
        if (!success) {
          reject(new Error(failureReason || "Print dialog could not be opened."));
          return;
        }
        resolve();
      });
    });

    const result = await Promise.race([
      monitor.promise,
      new Promise(resolve => setTimeout(() => resolve({ detected: false, completed: false, timeout: true }), 120000))
    ]);

    if (result?.failed) {
      throw new Error(`Windows print job failed${result.status ? `: ${result.status}` : "."}`);
    }

    if (result?.detected) {
      sendPrintProgress({ stage: "complete", detected: true, printed: result.printed, total: result.total, message: `Print job complete · ${result.printed} / ${result.total} pages` });
    } else {
      sendPrintProgress({ stage: "submitted", detected: false, printed: 0, total: totalPages, message: "Print job submitted to Windows. Page-level progress is not exposed by this printer driver." });
    }
    return { ok: true, printProgress: result };
  } catch (error) {
    sendPrintProgress({ stage: "error", message: error?.message || "Print failed." });
    throw error;
  } finally {
    monitor.stop();
  }
});

app.whenReady().then(createWindow).catch(err => {
  console.error("Failed to start GameBinder:", err);
});

app.on("before-quit", () => {
  try {
    const srv = gamebinderServer?.default;
    if (srv && typeof srv.close === "function") srv.close();
  } catch (_) {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
