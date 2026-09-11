
let games=[];
const grid=document.querySelector("#grid"),search=document.querySelector("#search"),sort=document.querySelector("#sort");
const statusEl=document.querySelector("#status"),count=document.querySelector("#count"),pages=document.querySelector("#pages");
const statusCounts=document.querySelector("#statusCounts"),statusMessage=document.querySelector("#statusMessage"),progressBar=document.querySelector("#progressBar");
const empty=document.querySelector("#empty"),sync=document.querySelector("#sync"),print=document.querySelector("#print"),printPages=document.querySelector("#printPages");
const printSettings=document.querySelector("#print-settings"),printPaperSize=document.querySelector("#print-paper-size"),printCancel=document.querySelector("#print-cancel"),printContinue=document.querySelector("#print-continue");
let selectedPrintPaper="A4";
printSettings.classList.remove("open"); printSettings.style.display="none"; printSettings.setAttribute("aria-hidden","true");
let detailPromises=[];
const detailsByAppId=new Map();
const artworkPromises = new Map();
const gameByAppId = new Map();
const dataMatrixCache = new Map();
const flippedCards = new Set();
let artworkQueue = [];
let artworkWorkersRunning = 0;
const ARTWORK_CONCURRENCY = 6;
let featureFitQueue = new Set();
let featureFitRaf = 0;
let syncStatusRaf = 0;
let scrollResetRaf = 0;

function rebuildGameIndex(){
  gameByAppId.clear();
  for(const g of games) gameByAppId.set(String(g.app_id), g);
}
function getGame(appid){ return gameByAppId.get(String(appid)); }


function dataMatrixSvg(appid){
  const key=String(appid);
  if(dataMatrixCache.has(key)) return dataMatrixCache.get(key);
  try{
    if(typeof DATAMatrix!=="function") return "";
    const node=DATAMatrix({msg:`https://s.team/a/${appid}`,dim:256,pad:2,pal:["#000000","#ffffff"],vrb:0});
    const svg=node?.outerHTML || "";
    dataMatrixCache.set(key,svg);
    return svg;
  }catch(_){ return ""; }
}

function updateSyncStatus(message){
  const total=games.length;
  const synced=games.filter(g=>g.sync_state === "synced").length;
  const pending=Math.max(0,total-synced);
  const failed=games.filter(g=>g.sync_state === "failed").length;
  const pct=total ? Math.min(100,Math.round((synced/total)*100)) : 0;
  statusCounts.textContent=`${total} found · ${synced} synced · ${pending} pending${failed ? ` · ${failed} unavailable` : ""}`;
  progressBar.style.width=`${pct}%`;
  statusMessage.textContent=message || (pending ? "Sync needed" : "Everything is synchronized");
}
function refreshGameSyncState(g){
  const artworkReady=Boolean(g.artwork_resolved || g.artwork_cached);
  const detailsReady=detailsByAppId.has(String(g.app_id)) || Boolean(g.details_cached);
  if(g.artwork_failed) g.sync_state="failed";
  else if(artworkReady && detailsReady) g.sync_state="synced";
  else g.sync_state="pending";
}
function refreshAllSyncStates(){ games.forEach(refreshGameSyncState); updateSyncStatus(); }
function scheduleSyncStatus(){
  if(syncStatusRaf) return;
  syncStatusRaf=requestAnimationFrame(()=>{ syncStatusRaf=0; updateSyncStatus(); });
}
async function cacheArtwork(g){
  if(!g.artwork_url || g.artwork_cached || g.artwork_url.startsWith("/api/artwork-cache/")) return;
  try{
    const r=await fetch("/api/cache-artwork",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({appid:g.app_id,url:g.artwork_url,width:g.artwork_width||0,height:g.artwork_height||0,horizontal:Boolean(g.artwork_horizontal)})});
    if(r.ok){
      const data=await r.json();
      if(data.cached){
        g.artwork_url=data.url || `/api/artwork-cache/${g.app_id}`;
        g.artwork_cached=true;
      }
    }
  }catch(_){ /* Remote artwork remains usable if disk caching is temporarily unavailable. */ }
}
async function hydrateCachedDetails(){
  const pending=games.filter(g=>g.details_cached && !detailsByAppId.has(String(g.app_id)));
  if(!pending.length) return;
  for(let i=0;i<pending.length;i+=100){
    const chunk=pending.slice(i,i+100);
    try{
      const ids=chunk.map(g=>g.app_id).join(",");
      const r=await fetch(`/api/cache-status?appids=${encodeURIComponent(ids)}`);
      if(!r.ok) continue;
      const data=await r.json();
      Object.entries(data.details||{}).forEach(([id,d])=>{
        detailsByAppId.set(id,d);
        const game=getGame(id);
        if(game && hasDetailValue(d?.title)) game.title=d.title;
      });
      chunk.forEach(g=>refreshGameSyncState(g));
    }catch(_){}
  }
  refreshAllSyncStates();
}
async function loadCachedLibrary(){
  try{
    const r=await fetch("/api/cache/library");
    if(!r.ok) return false;
    const data=await r.json();
    if(!Array.isArray(data.games) || !data.games.length) return false;
    games=data.games.map(g=>({...g, artwork_failed:Boolean(g.artwork_failed), artwork_resolved:Boolean(g.artwork_resolved || g.artwork_cached), sync_state:"pending"}));
    rebuildGameIndex();
    games.forEach(refreshGameSyncState);
    search.disabled=false; sort.disabled=false;
    render();
    refreshAllSyncStates();
    await hydrateCachedDetails();
    await waitForArtworkResolution();
    refreshAllSyncStates();
    print.disabled=getPrintableGames().length===0;
    statusMessage.textContent="Loaded from local cache · click Sync Steam to check for changes";
    return true;
  }catch(_){ return false; }
}

function titleClass(title){
  const n=String(title||"").length;
  if(n>34) return "title-long";
  if(n>24) return "title-medium";
  return "";
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function uniqueArtworkCandidates(g){
  const list=[];
  // Steam currently serves these two Battlefield 6 library capsules through
  // content-hashed asset paths. Keep them as explicit known-good candidates
  // while the universal resolver handles the rest of the library.
  const knownSteamArtwork={
    "2807960":"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2807960/289b1c193f9730a0d4ea4dbf912219e46cd1a8a3/library_capsule_2x.jpg",
    "3081410":"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3081410/52f9c64d00833656891243f0475d51c9a27f1013/library_capsule_2x.jpg"
  };
  const add=v=>{ if(typeof v!=="string" || !v.trim()) return; if(!list.includes(v)) list.push(v); };
  add(knownSteamArtwork[String(g.app_id)]);
  if(Array.isArray(g.artwork_candidates)) g.artwork_candidates.forEach(add);
  add(g.artwork_url);
  add(g.artwork_fallback_url);
  return list;
}

function artworkIsGoodPortrait(img){
  const w=img.naturalWidth||0, h=img.naturalHeight||0;
  return w>=500 && h>=750 && (w/h)<=1.15;
}

function artworkIsHorizontal(img){
  const w=img.naturalWidth||0, h=img.naturalHeight||0;
  return w>=400 && h>=180 && (w/h)>=1.25;
}

function artworkIsUsableFallback(img){
  const w=img.naturalWidth||0, h=img.naturalHeight||0;
  return w>=400 && h>=180;
}

function artworkPlaceholder(g){
  return `<div class="art-placeholder"><span>${escapeHtml(g.title)}</span></div>`;
}

function setResolvedArtwork(g,img,result){
  g.artwork_url=img.currentSrc || img.src;
  g.artwork_resolved=true;
  g.artwork_width=result?.w || img.naturalWidth || 0;
  g.artwork_height=result?.h || img.naturalHeight || 0;
  g.artwork_horizontal=(g.artwork_width > 0 && g.artwork_height > 0 && (g.artwork_width / g.artwork_height) > 1.25);
}

function applyArtworkOrientation(g,img){
  if(!img || !g.artwork_resolved) return;
  const w=g.artwork_width || img.naturalWidth || 0;
  const h=g.artwork_height || img.naturalHeight || 0;
  const horizontal=w>0 && h>0 && (w/h)>1.25;
  g.artwork_horizontal=horizontal;
  img.classList.toggle("art-horizontal",horizontal);
  if(horizontal){
    const frame=img.closest(".front,.print-front");
    if(frame){
      const fw=frame.clientWidth || 1;
      const fh=frame.clientHeight || 1;
      img.style.setProperty("--horizontal-art-scale", String(fh/fw));
    }
  }else{
    img.style.removeProperty("--horizontal-art-scale");
  }
}

function loadImageCandidate(img,url){
  return new Promise(resolve=>{
    if(!img) return resolve({ok:false,portrait:false,horizontal:false,usable:false,w:0,h:0,url});
    const done=ok=>resolve(ok
      ? {ok:true,portrait:artworkIsGoodPortrait(img),horizontal:artworkIsHorizontal(img),usable:artworkIsUsableFallback(img),w:img.naturalWidth||0,h:img.naturalHeight||0,url}
      : {ok:false,portrait:false,horizontal:false,usable:false,w:0,h:0,url});
    img.onload=()=>done(true);
    img.onerror=()=>done(false);
    img.src=url;
  });
}

async function resolveArtworkForGame(g, img){
  if(g.artwork_resolved) return true;
  const tried=new Set();
  let portraitBest=null;
  let horizontalBest=null;
  let fallback=null;

  const considerResult=result=>{
    if(!result || !result.ok) return;
    if(result.portrait && !portraitBest) portraitBest=result;
    if(result.horizontal && !horizontalBest) horizontalBest=result;
    if(result.usable && !fallback) fallback=result;
  };

  const commit=result=>{
    if(!result) return false;
    if(img.src !== result.url) img.src=result.url;
    setResolvedArtwork(g,img,result);
    applyArtworkOrientation(g,img);
    return true;
  };

  // Fast resolver: stop as soon as we have the type of artwork we are looking
  // for. Do NOT scan every Steam candidate sequentially; doing that for a
  // 356-game library makes every card appear dead while dozens of URLs time out.
  const findFirst=async (candidates, wanted)=>{
    for(const url of candidates){
      if(tried.has(url)) continue;
      tried.add(url);
      const result=await loadImageCandidate(img,url);
      if(!result.ok) continue;
      considerResult(result);
      if(wanted==='horizontal' && result.horizontal) return result;
      if(wanted==='portrait' && result.portrait) return result;
    }
    return null;
  };

  let backendCandidates=[];
  let backendPrefersHorizontal=false;

  // Get Steam's current asset metadata first. This lets the backend tell us
  // when a generated portrait.png is really a wrapper around horizontal art.
  try{
    const r=await fetch(`/api/artwork/${g.app_id}`);
    if(r.ok){
      const data=await r.json();
      backendPrefersHorizontal=Boolean(data.prefer_horizontal);
      backendCandidates=Array.isArray(data.candidates)?data.candidates:[];
    }
  }catch(_){}

  const localCandidates=uniqueArtworkCandidates(g);

  if(backendPrefersHorizontal){
    // When Steam identifies a generated portrait wrapper, prefer the first
    // genuinely horizontal image available. That image is the one that will
    // be rotated inside the fixed 4.8 card.
    let chosen=await findFirst(backendCandidates,'horizontal');
    if(!chosen) chosen=await findFirst(localCandidates,'horizontal');
    if(chosen) return commit(chosen);

    // Safe fallback if the horizontal asset is unavailable.
    let portrait=await findFirst(backendCandidates,'portrait');
    if(!portrait) portrait=await findFirst(localCandidates,'portrait');
    if(portrait) return commit(portrait);
  }else{
    // Normal games keep the proven 4.8 behavior: prefer a true vertical
    // library capsule. Only if no portrait exists do we accept horizontal art.
    let portrait=await findFirst(localCandidates,'portrait');
    if(!portrait) portrait=await findFirst(backendCandidates,'portrait');
    if(portrait) return commit(portrait);

    let horizontal=await findFirst(localCandidates,'horizontal');
    if(!horizontal) horizontal=await findFirst(backendCandidates,'horizontal');
    if(horizontal) return commit(horizontal);
  }

  // Last resort: a sufficiently large non-icon image. It remains fully
  // constrained by the existing 4.8 card geometry.
  if(fallback) return commit(fallback);
  return false;
}
function getVisibleGames(){
  const q=search.value.toLowerCase();
  return games.filter(g=>!g.artwork_failed && g.title.toLowerCase().includes(q));
}
function getPrintableGames(){
  const q=search.value.toLowerCase();
  return games.filter(g=>
    !g.artwork_failed &&
    g.sync_state==="synced" &&
    Boolean(g.artwork_resolved || g.artwork_cached) &&
    Boolean(g.artwork_url) &&
    g.title.toLowerCase().includes(q)
  );
}
function enqueueArtworkTask(task){
  return new Promise((resolve,reject)=>{
    artworkQueue.push({task,resolve,reject});
    pumpArtworkQueue();
  });
}

function pumpArtworkQueue(){
  while(artworkWorkersRunning < ARTWORK_CONCURRENCY && artworkQueue.length){
    const job=artworkQueue.shift();
    artworkWorkersRunning++;
    Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{
      artworkWorkersRunning--;
      pumpArtworkQueue();
    });
  }
}

function startArtworkResolution(g, img, frame){
  const key=String(g.app_id);
  if(artworkPromises.has(key)) return artworkPromises.get(key);
  const promise=enqueueArtworkTask(async()=>{
    const ok=await resolveArtworkForGame(g,img);
    if(!ok){
      g.artwork_failed=true;
      g.artwork_status="failed";
      g.sync_state="failed";
      const wrap=img && img.closest(".wrap");
      if(wrap) wrap.remove();
      const visible=getVisibleGames();
      count.textContent=visible.length;
      pages.textContent=Math.max(1,Math.ceil(visible.length/9));
      empty.style.display=visible.length?"none":"block";
      scheduleSyncStatus();
      return false;
    }
    g.artwork_status="resolved";
    img.style.display="block";
    await cacheArtwork(g);
    refreshGameSyncState(g);
    scheduleSyncStatus();
    return true;
  });
  artworkPromises.set(key,promise);
  promise.finally(()=>artworkPromises.delete(key));
  return promise;
}
async function waitForArtworkResolution(){
  while(artworkPromises.size){
    await Promise.all([...artworkPromises.values()]);
  }
}
async function loadDetails(appid){
  if(detailsByAppId.has(String(appid))) return detailsByAppId.get(String(appid));
  try{
    const r=await fetch(`/api/details/${appid}`);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    detailsByAppId.set(String(appid),d);
    const game=getGame(appid); if(game){game.details_cached=true; refreshGameSyncState(game);}
    applyDetails(appid,d);
    return d;
  }catch(_){
    const d={app_id:Number(appid),year:"",release_date:"",developer:"",publisher:"",description:""};
    detailsByAppId.set(String(appid),d);
    const game=getGame(appid); if(game){game.details_cached=true; refreshGameSyncState(game);}
    applyDetails(appid,d);
    return d;
  }
}

function hasDetailValue(value){
  const v=String(value??"").trim();
  if(!v || v==="—" || v==="-" ) return false;
  if(/^no\s+(short\s+)?description\s+available\.?$/i.test(v)) return false;
  if(/^loading(?:\s+short\s+description)?…?$/i.test(v)) return false;
  return true;
}
function applyDetails(appid,d){
  if(hasDetailValue(d?.title)){
    const game=getGame(appid);
    if(game) game.title=d.title;
    const titleNodes=document.querySelectorAll(`.wrap[data-id="${appid}"] .back-header h2, .print-back[data-appid="${appid}"] .back-header h2`);
    titleNodes.forEach(node=>{ node.textContent=d.title; node.className=titleClass(d.title); });
  }
  const y=document.querySelector(`#year-${appid}`);
  const dev=document.querySelector(`#dev-${appid}`);
  const pub=document.querySelector(`#pub-${appid}`);
  const desc=document.querySelector(`#desc-${appid}`);
  const yearBlock=y?.closest(".detail-block");
  const devBlock=dev?.closest(".detail-block");
  const pubBlock=pub?.closest(".detail-block");
  const descBlock=desc?.closest(".detail-block");
  const release=hasDetailValue(d.release_date);
  const developer=hasDetailValue(d.developer);
  const publisher=hasDetailValue(d.publisher);
  const description=hasDetailValue(d.description);
  if(y){ y.textContent=release ? `Release date · ${d.release_date}` : ""; if(yearBlock) yearBlock.style.display=release?"":"none"; }
  if(dev){ dev.textContent=developer ? d.developer : ""; if(devBlock) devBlock.style.display=developer?"":"none"; }
  if(pub){ pub.textContent=publisher ? d.publisher : ""; if(pubBlock) pubBlock.style.display=publisher?"":"none"; }
  if(desc){ desc.textContent=description ? d.description : ""; if(descBlock) descBlock.style.display=description?"":"none"; }
  const features=document.querySelector(`#features-${appid}`);
  const featuresBlock=document.querySelector(`#features-block-${appid}`);
  const featureList=Array.isArray(d?.features)?d.features.filter(hasDetailValue):[];
  if(features){ features.textContent=featureList.join(" · "); if(featuresBlock) featuresBlock.style.display=featureList.length?"":"none"; }
  if(printPages.childElementCount) updatePrintDetails(appid,d);
  queueFitFeatures(appid);
}

function queueFitFeatures(appid){
  featureFitQueue.add(String(appid));
  if(featureFitRaf) return;
  featureFitRaf=requestAnimationFrame(()=>{
    featureFitRaf=0;
    const ids=[...featureFitQueue];
    featureFitQueue.clear();
    ids.forEach(fitFeatures);
  });
}

function measureNaturalContent(el, width, printMode=false){
  if(!el) return 0;
  const clone=el.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  Object.assign(clone.style,{
    position:'absolute', left:'-100000px', top:'0', visibility:'hidden',
    display:'flex', flexDirection:'column', justifyContent:'flex-start',
    flex:'0 0 auto', width:width+'px', height:'auto', minHeight:'0',
    maxHeight:'none', overflow:'visible', boxSizing:'border-box'
  });
  if(printMode){
    const about=clone.querySelector('.about-block');
    const desc=clone.querySelector('.desc');
    const opt=clone.querySelector('.optional-grid');
    if(about) Object.assign(about.style,{flex:'0 0 auto',minHeight:'0',maxHeight:'none',height:'auto',overflow:'visible'});
    if(desc) Object.assign(desc.style,{flex:'0 0 auto',minHeight:'0',maxHeight:'none',height:'auto',overflow:'visible',display:'block'});
    if(opt) Object.assign(opt.style,{flex:'0 0 auto',height:'auto',overflow:'visible'});
  }
  document.body.appendChild(clone);
  const h=clone.getBoundingClientRect().height;
  clone.remove();
  return h;
}

function fitFeatures(appid){
  const desc=document.querySelector(`#desc-${appid}`);
  const features=document.querySelector(`#features-block-${appid}`);
  const group=features?.closest('.content-group');
  if(!desc || !features || !group) return;
  if(!document.querySelector(`#features-${appid}`)?.textContent.trim()) { features.style.display='none'; return; }

  features.style.display='';
  // V67 rule: ABOUT has priority. If the complete natural ABOUT + FEATURES
  // block does not fit in the available content area, remove FEATURES as a
  // whole. Never clip or shorten ABOUT to preserve FEATURES.
  const available=group.clientHeight;
  const natural=measureNaturalContent(group, group.clientWidth, false);
  if(natural > available + 1){
    features.style.display='none';
  }
  syncPrintFeatureVisibility(appid);
}

function syncPrintFeatureVisibility(appid){
  const screenFeatures=document.querySelector(`#features-block-${appid}`);
  const printFeatures=document.querySelector(`#print-features-block-${appid}`);
  if(!screenFeatures || !printFeatures) return;
  const hidden=getComputedStyle(screenFeatures).display==='none' || screenFeatures.style.display==='none';
  printFeatures.style.display=hidden?'none':'';
}

function fitPrintFeatures(appid){
  // Retained for compatibility with older call paths. V68 intentionally
  // delegates the decision to the screen card, where the content is fully
  // measurable before print preparation begins.
  syncPrintFeatureVisibility(appid);
}

async function loadDetailsInBatches(list){
  detailPromises=[];
  if(!list.length){ refreshAllSyncStates(); return; }
  const chunks=[];
  for(let i=0;i<list.length;i+=100) chunks.push(list.slice(i,i+100));
  const jobs=chunks.map(async chunk=>{
    try{
      const ids=chunk.map(g=>g.app_id).join(",");
      const r=await fetch(`/api/details-batch?appids=${encodeURIComponent(ids)}`);
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const data=await r.json();
      const details=data.details || {};
      chunk.forEach(g=>{
        const d=details[String(g.app_id)];
        if(d){
          if(hasDetailValue(d.title)) g.title=d.title;
          detailsByAppId.set(String(g.app_id),d);
          g.details_cached=true; refreshGameSyncState(g);
          applyDetails(g.app_id,d);
        }else{
          const fallback={app_id:Number(g.app_id),title:g.title,release_date:"",developer:"",publisher:"",description:""};
          detailsByAppId.set(String(g.app_id),fallback);
          g.details_cached=true; refreshGameSyncState(g);
          applyDetails(g.app_id,fallback);
        }
      });
    }catch(_){
      chunk.forEach(g=>{
        if(!detailsByAppId.has(String(g.app_id))){
          const fallback={app_id:Number(g.app_id),title:g.title,release_date:"",developer:"",publisher:"",description:""};
          detailsByAppId.set(String(g.app_id),fallback);
          g.details_cached=true; refreshGameSyncState(g);
          applyDetails(g.app_id,fallback);
        }
      });
    }
  });
  detailPromises=jobs;
  await Promise.all(jobs);
  refreshAllSyncStates();
}


function buildPrintPages(list){
  // Normal/background builder. Keep this synchronous because artwork resolution
  // can call it many times while the library is syncing.
  const chunks=[];
  for(let i=0;i<list.length;i+=9) chunks.push(list.slice(i,i+9));
  printPages.innerHTML=chunks.map((chunk,pageIndex)=>{
    const front=chunk.map(g=>{
      const horizontalClass=g.artwork_horizontal ? "art-horizontal" : "";
      const scale=g.artwork_horizontal ? (88/63).toFixed(6) : "";
      return `<div class="print-card print-front" data-appid="${g.app_id}"><img src="${g.artwork_url||''}" class="${horizontalClass}" ${scale?`style="--horizontal-art-scale:${scale}"`:''}></div>`;
    }).join('');
    // Duplex alignment: with portrait flip-on-long-edge, the physical back
    // is mirrored horizontally. Do NOT rely on DOM order alone for partial
    // rows: when a filtered print contains 1 or 2 cards, the browser can
    // otherwise place them in the same columns. Assign the exact mirrored
    // grid position explicitly for every card.
    const back=chunk.map((g,i)=>{
      const col=3-(i%3); // Mirror every row horizontally for duplex printing.
      const row=Math.floor(i/3)+1;
      return `<div class="print-card print-back" data-appid="${g.app_id}" style="grid-column:${col};grid-row:${row};"><div class="back-header"><h2 class="${titleClass(g.title)}">${escapeHtml(g.title)}</h2><div class="print-year detail-block" id="print-year-${g.app_id}"></div><div class="print-app-id">APP ID · ${g.app_id}</div></div><div class="back-body"><div class="meta-grid"><div class="detail-cell detail-block"><div class="meta">DEVELOPER</div><div class="value print-value" id="print-dev-${g.app_id}"></div></div><div class="detail-cell detail-block"><div class="meta">PUBLISHER</div><div class="value print-value" id="print-pub-${g.app_id}"></div></div></div><div class="content-group"><div class="detail-block about-block"><div class="meta">ABOUT</div><div id="print-desc-${g.app_id}" class="desc print-desc"></div></div><div class="optional-grid"><div class="optional-cell detail-block" id="print-features-block-${g.app_id}" style="display:none"><div class="meta">FEATURES</div><div id="print-features-${g.app_id}" class="optional-value"></div></div></div></div></div><div class="back-footer"><div class="print-bottom"><div class="datamatrix-mark" aria-hidden="true">${dataMatrixSvg(g.app_id)}</div></div></div></div>`;
    }).join('');
    return `<section class="print-sheet print-front-sheet">${front}</section><section class="print-sheet print-back-sheet">${back}</section>`;
  }).join('');
  list.forEach(g=>{ const d=detailsByAppId.get(String(g.app_id)); if(d) updatePrintDetails(g.app_id,d); });
}

function printDetailsMarkup(g, d){
  const appid=String(g.app_id);
  const release=hasDetailValue(d?.release_date);
  const developer=hasDetailValue(d?.developer);
  const publisher=hasDetailValue(d?.publisher);
  const description=hasDetailValue(d?.description);
  const featureList=Array.isArray(d?.features) ? d.features.filter(hasDetailValue) : [];
  const screenFeatures=document.querySelector(`#features-block-${appid}`);
  const featuresVisible=featureList.length>0 && (!screenFeatures || getComputedStyle(screenFeatures).display!=='none');
  const year=release ? `Release date · ${escapeHtml(d.release_date)}` : '';
  const dev=developer ? escapeHtml(d.developer) : '';
  const pub=publisher ? escapeHtml(d.publisher) : '';
  const desc=description ? escapeHtml(d.description) : '';
  const features=featureList.length ? escapeHtml(featureList.join(' · ')) : '';
  const horizontalClass=g.artwork_horizontal ? 'art-horizontal' : '';
  const scale=g.artwork_horizontal ? (88/63).toFixed(6) : '';
  const col=3-(g.__printIndex%3);
  const row=Math.floor(g.__printIndex/3)+1;
  return {
    front:`<div class="print-card print-front" data-appid="${appid}"><img src="${g.artwork_url||''}" class="${horizontalClass}" ${scale?`style="--horizontal-art-scale:${scale}"`:''}></div>`,
    back:`<div class="print-card print-back" data-appid="${appid}" style="grid-column:${col};grid-row:${row};"><div class="back-header"><h2 class="${titleClass(g.title)}">${escapeHtml(g.title)}</h2><div class="print-year detail-block"${release?'':' style="display:none"'}>${year}</div><div class="print-app-id">APP ID · ${appid}</div></div><div class="back-body"><div class="meta-grid"><div class="detail-cell detail-block"${developer?'':' style="display:none"'}><div class="meta">DEVELOPER</div><div class="value print-value">${dev}</div></div><div class="detail-cell detail-block"${publisher?'':' style="display:none"'}><div class="meta">PUBLISHER</div><div class="value print-value">${pub}</div></div></div><div class="content-group"><div class="detail-block about-block"${description?'':' style="display:none"'}><div class="meta">ABOUT</div><div class="desc print-desc">${desc}</div></div><div class="optional-grid"><div class="optional-cell detail-block"${featuresVisible?'':' style="display:none"'}><div class="meta">FEATURES</div><div class="optional-value">${features}</div></div></div></div></div><div class="back-footer"><div class="print-bottom"><div class="datamatrix-mark" aria-hidden="true">${dataMatrixSvg(g.app_id)}</div></div></div></div>`
  };
}

async function buildPrintPagesWithProgress(list, onPageProgress){
  const chunks=[];
  for(let i=0;i<list.length;i+=9) chunks.push(list.slice(i,i+9));
  printPages.innerHTML="";
  const totalPages=chunks.length*2;
  let preparedPages=0;

  // Precompute the exact print markup once. This avoids hundreds of DOM queries
  // and style recalculations that the old updatePrintDetails path performed
  // while the print DOM was being assembled.
  list.forEach((g,i)=>{ g.__printIndex=i; });
  try {
    for(let pageIndex=0;pageIndex<chunks.length;pageIndex++){
      const chunk=chunks[pageIndex];
      const front=[];
      const back=[];
      for(const g of chunk){
        const d=detailsByAppId.get(String(g.app_id)) || {title:g.title};
        const markup=printDetailsMarkup(g,d);
        front.push(markup.front);
        back.push(markup.back);
      }
      printPages.insertAdjacentHTML("beforeend", `<section class="print-sheet print-front-sheet">${front.join('')}</section><section class="print-sheet print-back-sheet">${back.join('')}</section>`);
      preparedPages=Math.min(totalPages,preparedPages+2);
      if(onPageProgress) onPageProgress(preparedPages,totalPages);
      // Yield once per physical front/back pair so the UI stays responsive and
      // the page counter is genuinely live instead of jumping at the end.
      await nextPaint();
    }
  } finally {
    list.forEach(g=>{ delete g.__printIndex; });
  }
}

function updatePrintDetails(appid,d){
  const y=document.querySelector(`#print-year-${appid}`);
  const dev=document.querySelector(`#print-dev-${appid}`);
  const pub=document.querySelector(`#print-pub-${appid}`);
  const desc=document.querySelector(`#print-desc-${appid}`);
  const features=document.querySelector(`#print-features-${appid}`);
  const featuresBlock=document.querySelector(`#print-features-block-${appid}`);
  const yearBlock=y?.closest(".detail-block");
  const devBlock=dev?.closest(".detail-block");
  const pubBlock=pub?.closest(".detail-block");
  const descBlock=desc?.closest(".detail-block");
  const release=hasDetailValue(d.release_date);
  const developer=hasDetailValue(d.developer);
  const publisher=hasDetailValue(d.publisher);
  const description=hasDetailValue(d.description);
  if(y){ y.textContent=release ? `Release date · ${d.release_date}` : ""; if(yearBlock) yearBlock.style.display=release?"":"none"; }
  if(dev){ dev.textContent=developer ? d.developer : ""; if(devBlock) devBlock.style.display=developer?"":"none"; }
  if(pub){ pub.textContent=publisher ? d.publisher : ""; if(pubBlock) pubBlock.style.display=publisher?"":"none"; }
  if(desc){
    desc.textContent=description ? d.description : "";
    desc.dataset.fitted="";
    if(descBlock) descBlock.style.display=description ? "flex" : "none";
  }
  const featureList=Array.isArray(d?.features)?d.features.filter(hasDetailValue):[];
  if(features){
    features.textContent=featureList.join(" · ");
    if(featuresBlock) featuresBlock.style.display=featureList.length?"":"none";
  }
  // V68: print must use the same feature-visibility decision as the
  // fully-built screen card. The old print-side measurement ran while
  // #printPages was display:none, so every print card looked too small and
  // FEATURES was incorrectly hidden.
  syncPrintFeatureVisibility(appid);
}


function render(){
  const q=search.value.toLowerCase();
  let list=games.filter(g=>!g.artwork_failed && g.title.toLowerCase().includes(q));
  if(sort.value==="title") list.sort((a,b)=>a.title.localeCompare(b.title));
  if(sort.value==="playtime") list.sort((a,b)=>b.playtime_minutes-a.playtime_minutes);
  grid.innerHTML=list.map(g=>{
    const artwork=`<img src="${g.artwork_url || ""}" alt="" data-appid="${g.app_id}" style="display:none">`;
    return `<div class="wrap" data-id="${g.app_id}">
      <div class="card">
        <div class="face front" data-appid="${g.app_id}">${artwork}</div>
        <div class="face back">
          <div class="back-header"><h2 class="${titleClass(g.title)}">${escapeHtml(g.title)}</h2><div class="year detail-block" id="year-${g.app_id}">Release date unavailable</div><div class="app-id-header">APP ID · ${g.app_id}</div></div>
          <div class="back-body">
          <div class="meta-grid">
            <div class="detail-cell detail-block"><div class="meta">DEVELOPER</div><div class="value" id="dev-${g.app_id}">Loading…</div></div>
            <div class="detail-cell detail-block"><div class="meta">PUBLISHER</div><div class="value" id="pub-${g.app_id}">Loading…</div></div>
          </div>
          <div class="content-group">
          <div class="detail-block about-block" style="display:none"><div class="meta">ABOUT</div><div class="desc" id="desc-${g.app_id}"></div></div>
          <div class="optional-grid"><div class="optional-cell detail-block" id="features-block-${g.app_id}" style="display:none"><div class="meta">FEATURES</div><div class="optional-value" id="features-${g.app_id}"></div></div></div>
          </div>
          </div>
          <div class="back-footer"><div class="print-bottom"><div class="datamatrix-mark" aria-hidden="true">${dataMatrixSvg(g.app_id)}</div></div></div>
        </div>
      </div>
    </div>`;
  }).join("");
  // Print pages are built only when printing starts; keeping a second full DOM
  // tree synchronized during normal browsing was a major source of work.
  // Re-apply already cached details after every render (including search/sort).
  // Rendering replaces the card DOM, so the previous text nodes disappear;
  // never show Loading… when the details are already in the in-memory cache.
  list.forEach(g=>{
    const d=detailsByAppId.get(String(g.app_id));
    if(d) applyDetails(g.app_id,d);
  });
  flippedCards.clear();
  list.forEach(g=>{
    const img=document.querySelector(`.front[data-appid="${g.app_id}"] img`);
    if(img){
      if(g.artwork_resolved) applyArtworkOrientation(g,img);
      startArtworkResolution(g,img,img.closest(".front"));
    }
  });
  count.textContent=list.length;
  pages.textContent=Math.max(1,Math.ceil(list.length/9));
  empty.style.display=list.length?"none":"block";
  refreshAllSyncStates();
}
async function syncSteam(){
  games=[];
  detailsByAppId.clear();
  render();
  sync.disabled=true;
  statusMessage.textContent="Opening Steam connection window…";
  console.log("[GameBinder] Connect button clicked");
  try{
    if(!window.gamebinder?.connectSteam) throw new Error("Steam connection bridge is unavailable. Restart GameBinder.");
    const cfg=await (await fetch("/api/config",{cache:"no-store"})).json();
    const data=await window.gamebinder.connectSteam(cfg.steamId || "");
    if(!data?.games?.length) throw new Error("Steam returned no games from the authenticated Community page.");
    games=data.games.map(g=>({...g,artwork_status:"pending",artwork_failed:false,artwork_resolved:false,sync_state:"pending"}));
    rebuildGameIndex();
    search.disabled=false; sort.disabled=false;
    refreshAllSyncStates();
    statusMessage.textContent=`LIVE Steam session · ${data.games.length} applications found · ${data.pages||1} page(s) scanned (not from local library cache)`;
    render();
    await hydrateCachedDetails();
    await loadDetailsInBatches(games.filter(g=>!g.details_cached));
    await waitForArtworkResolution();
    refreshAllSyncStates();
    print.disabled=getPrintableGames().length===0;
    statusMessage.textContent=games.some(g=>g.sync_state==="pending")
      ? `${getPrintableGames().length} cards ready to print · ${games.filter(g=>g.sync_state==="pending").length} pending excluded`
      : `Synchronization complete · ${getPrintableGames().length} cards ready to print`;
  }catch(e){
    statusMessage.textContent="Steam connection error: "+(e?.message||e);
  }finally{sync.disabled=false;}
}

grid.addEventListener("click",e=>{
  const wrap=e.target.closest?.(".wrap");
  if(!wrap || !grid.contains(wrap)) return;
  const card=wrap.querySelector(".card");
  if(!card) return;
  card.classList.remove("click-feedback");
  void card.offsetWidth;
  card.classList.add("click-feedback");
  setTimeout(()=>card.classList.remove("click-feedback"),320);
  card.classList.toggle("flip");
  const id=String(wrap.dataset.id);
  if(card.classList.contains("flip")) flippedCards.add(wrap);
  else flippedCards.delete(wrap);
});

grid.addEventListener("dblclick",e=>{
  const wrap=e.target.closest?.(".wrap");
  if(!wrap || !grid.contains(wrap)) return;
  window.open("https://store.steampowered.com/app/"+wrap.dataset.id+"/","_blank");
});

function resetFlippedCardsAtViewportEdge(){
  scrollResetRaf=0;
  if(!flippedCards.size) return;
  const viewportHeight=window.innerHeight;
  for(const wrap of [...flippedCards]){
    if(!wrap.isConnected){ flippedCards.delete(wrap); continue; }
    const card=wrap.querySelector(".card");
    if(!card || !card.classList.contains("flip")){ flippedCards.delete(wrap); continue; }
    const rect=wrap.getBoundingClientRect();
    if(rect.top <= 0 || rect.bottom >= viewportHeight){
      card.classList.remove("flip");
      flippedCards.delete(wrap);
    }
  }
}
window.addEventListener("scroll",()=>{
  if(scrollResetRaf) return;
  scrollResetRaf=requestAnimationFrame(resetFlippedCardsAtViewportEdge);
},{passive:true});
window.addEventListener("resize",()=>{
  resetFlippedCardsAtViewportEdge();
  document.querySelectorAll(".wrap[data-id]").forEach(w=>{
    const id=w.dataset.id;
    if(document.querySelector(`#features-${id}`)?.textContent.trim()) queueFitFeatures(id);
  });
},{passive:true});

// EXPERIMENT: do NOT auto-load the local library cache. Every Sync Steam run must come from an authenticated Steam Community session.
statusMessage.textContent="No cached library loaded · click Connect Steam & Sync to import the live authenticated Games page";
if(window.gamebinder?.onSteamProgress){
  window.gamebinder.onSteamProgress((p)=>{
    if(!p) return;
    if(p.stage==="parse"){
      statusMessage.textContent=p.message||`Reading Steam Games page… ${p.games||0} games detected`;
      const n=Number(p.games||0);
      progressBar.style.width=Math.min(95,Math.max(5,Math.round((n/356)*95)))+"%";
    }else if(p.message){
      statusMessage.textContent=p.message;
    }
  });
}
if(window.gamebinder?.onPrintProgress){
  window.gamebinder.onPrintProgress((p)=>{
    if(!p) return;
    const total=Number(p.total||0);
    const printed=Math.max(0,Number(p.printed||0));
    if(p.stage==="spooling" && total>0){
      const pct=Math.round((printed/total)*100);
      showPrintProgress("Printing…",pct,`${printed} / ${total} pages printed`);
    }else if(p.stage==="dialog"){
      showPrintProgress("Windows Print Dialog…",97,total?`0 / ${total} pages printed · waiting for Windows`:`Waiting for Windows print dialog`);
    }else if(p.stage==="complete"){
      showPrintProgress("Print complete",100,`${printed} / ${total} pages printed`);
    }else if(p.stage==="submitted"){
      showPrintProgress("Print job submitted",99,total?`Windows accepted the job · ${total} pages`:`Windows accepted the print job`);
    }else if(p.stage==="error"){
      showPrintProgress("Print failed",99,p.message||"Windows could not complete the print job.");
    }
  });
}
count.textContent="0";
pages.textContent="0";
sync.addEventListener("click",syncSteam); search.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); render(); } }); sort.addEventListener("change",render);

function showPrintProgress(label, percent, countText){
  const overlay=document.getElementById("gb-print-progress");
  const bar=document.getElementById("gb-print-progress-bar");
  const text=document.getElementById("gb-print-progress-label");
  const countEl=document.getElementById("gb-print-progress-count");
  if(!overlay) return;
  overlay.classList.add("gb-show");
  overlay.setAttribute("aria-hidden","false");
  text.textContent=label||"Preparing cards…";
  bar.style.width=Math.max(0,Math.min(100,percent||0))+"%";
  countEl.textContent=countText||"";
}
function hidePrintProgress(){
  const overlay=document.getElementById("gb-print-progress");
  if(!overlay) return;
  overlay.classList.remove("gb-show");
  overlay.setAttribute("aria-hidden","true");
}
function nextPaint(){
  return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}
function applyPrintPaperSize(size){
  selectedPrintPaper=size;
  let style=document.getElementById("dynamic-print-paper-size");
  if(!style){ style=document.createElement("style"); style.id="dynamic-print-paper-size"; document.head.appendChild(style); }
  const letter=size==="LETTER";
  style.textContent=`@media print{@page{size:${letter?"letter":"A4"} portrait;margin:0}.print-sheet{width:${letter?"216":"210"}mm!important;height:${letter?"279":"297"}mm!important;padding-top:${letter?"7":"8"}mm!important}}`;
}

async function preparePrintSnapshot(){
  const printable=getPrintableGames();
  const total=printable.length;
  if(!total) throw new Error("There are no print-ready cards.");

  showPrintProgress("Preparing Steam details…",3,`${total} cards ready for printing`);
  await Promise.all(detailPromises);
  await nextPaint();

  // Work through the actual printable cards incrementally. This is intentionally
  // done in small batches with paints between them, so progress is visible even
  // when the images are already cached.
  let ready=0;
  const batchSize=12;
  for(let i=0;i<total;i+=batchSize){
    const batch=printable.slice(i,i+batchSize);
    await Promise.all(batch.map(async g=>{
      const key=String(g.app_id);
      if(artworkPromises.has(key)){
        await artworkPromises.get(key);
      }
      return g;
    }));
    ready=Math.min(total,i+batch.length);
    const pct=5+Math.round((ready/total)*15);
    showPrintProgress("Preparing artwork…",pct,`${ready} / ${total} cards checked`);
    await nextPaint();
  }

  const totalPrintPages=Math.ceil(total/9)*2;
  showPrintProgress("Preparing print pages…",20,`0 / ${totalPrintPages} pages prepared`);
  // Build one front/back sheet pair at a time so the progress dialog reflects
  // actual page preparation rather than jumping straight to 100%.
  await buildPrintPagesWithProgress(printable,(preparedPages,totalPages)=>{
    const pct=20+Math.round((preparedPages/totalPages)*50);
    showPrintProgress("Preparing print pages…",pct,`${preparedPages} / ${totalPages} pages prepared`);
  });
  await nextPaint();

  const imgs=[...document.querySelectorAll(".print-front img")];
  let loaded=0;
  const imgTotal=imgs.length||1;
  const imageBatchSize=24;
  for(let i=0;i<imgs.length;i+=imageBatchSize){
    const batch=imgs.slice(i,i+imageBatchSize);
    await Promise.all(batch.map(async img=>{
      if(img.complete && img.naturalWidth>0){
        try{ if(img.decode) await img.decode(); }catch(_){}
        return;
      }
      await new Promise(resolve=>{
        const done=()=>{img.removeEventListener("load",done);img.removeEventListener("error",done);resolve();};
        img.addEventListener("load",done,{once:true});
        img.addEventListener("error",done,{once:true});
      });
      try{ if(img.decode) await img.decode(); }catch(_){}
    }));
    loaded=Math.min(imgTotal,i+batch.length);
    const pct=70+Math.round((loaded/imgTotal)*25);
    showPrintProgress("Checking print artwork…",pct,`${loaded} / ${imgTotal} images ready`);
    await nextPaint();
  }

  if(document.fonts && document.fonts.ready) await document.fonts.ready;
  showPrintProgress("Ready · opening Windows Print Dialog…",97,`${total} cards · ${totalPrintPages} print pages prepared`);
  await nextPaint();
  return { printable, totalPrintPages };
}
print.addEventListener("click",()=>{
  if(!getPrintableGames().length) return;
  printPaperSize.value=selectedPrintPaper;
  printSettings.classList.add("open");
  printSettings.style.display="flex";
  printSettings.setAttribute("aria-hidden","false");
});
printCancel.addEventListener("click",()=>{
  printSettings.classList.remove("open");
  printSettings.style.display="none";
  printSettings.setAttribute("aria-hidden","true");
});
printSettings.addEventListener("click",e=>{if(e.target===printSettings) printCancel.click();});
printContinue.addEventListener("click",async()=>{
  const original=print.textContent;
  printSettings.classList.remove("open");
  printSettings.style.display="none";
  printSettings.setAttribute("aria-hidden","true");
  applyPrintPaperSize(printPaperSize.value);
  print.disabled=true;
  print.textContent="Preparing print…";
  try{
    const prepared=await preparePrintSnapshot();
    const totalPrintPages=Number(prepared?.totalPrintPages)||Math.ceil(getPrintableGames().length/9)*2;
    if(window.gamebinder && typeof window.gamebinder.print==="function"){
      await window.gamebinder.print(totalPrintPages);
    }else{
      window.print();
    }
  }catch(e){
    statusMessage.textContent="Could not prepare print: "+(e.message||e);
  }finally{
    hidePrintProgress();
    print.disabled=getPrintableGames().length===0;
    print.textContent=original;
  }
});
