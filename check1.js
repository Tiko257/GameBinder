
(()=> {
  const overlay=document.getElementById('gb-credentials-overlay');
  const steamId=document.getElementById('gb-steam-id');
  const save=document.getElementById('gb-save-credentials');
  const error=document.getElementById('gb-credentials-error');
  const settings=document.getElementById('gb-credentials-settings');

  function normalizeSteamInput(value){
    const raw=String(value||'').trim();
    if(/^\d{17}$/.test(raw)) return raw;
    const m=raw.match(/steamcommunity\.com\/profiles\/(\d{17})(?:[\/?#]|$)/i);
    return m ? m[1] : '';
  }
  function showSetup(existingId=''){
    if(existingId) steamId.value=existingId;
    overlay.classList.add('gb-show');
    overlay.setAttribute('aria-hidden','false');
    setTimeout(()=>{steamId.focus();steamId.select();},50);
  }
  function hideSetup(){
    overlay.classList.remove('gb-show');
    overlay.setAttribute('aria-hidden','true');
    error.textContent='';
  }
  async function checkConfig(){
    try{
      const r=await fetch('/api/config',{cache:'no-store'});
      const d=await r.json();
      settings.style.display='block';
      // The ID dialog is intentionally shown on every startup so the user can
      // confirm/change the Steam account before importing the live library.
      showSetup(d.steamId || '');
    }catch(_){
      settings.style.display='block';
      showSetup();
      error.textContent='Could not connect to GameBinder.';
    }
  }
  save.addEventListener('click',async()=>{
    const id=normalizeSteamInput(steamId.value);
    error.textContent='';
    if(!id){error.textContent='Paste a valid Steam ID64 or a direct Steam profile link.';return;}
    steamId.value=id;
    save.disabled=true;
    try{
      const r=await fetch('/api/config',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({steamId:id})
      });
      const d=await r.json();
      if(!r.ok) throw new Error(d.error||'Could not save Steam ID.');
      hideSetup(); settings.style.display='block';
      // Continue directly into the live Steam import; no reload is needed.
      if(typeof syncSteam==='function') await syncSteam();
    }catch(x){error.textContent=x.message||'Could not save Steam ID.'}
    finally{save.disabled=false}
  });
  steamId.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save.click();}});
  settings.addEventListener('click',async()=>{
    const r=await fetch('/api/config',{cache:'no-store'}).catch(()=>null);
    const d=r && r.ok ? await r.json() : {};
    showSetup(d.steamId || '');
  });
  checkConfig();
})();
