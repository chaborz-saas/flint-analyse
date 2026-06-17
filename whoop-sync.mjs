#!/usr/bin/env node
/*
 * whoop-sync.mjs — récupère les données Whoop (API officielle v2) → whoop-data.json
 * À importer ensuite dans FLINT Analyse (onglet Données).
 *
 * Prérequis : Node 18+ (fetch intégré), un abonnement Whoop actif,
 * et une app développeur créée sur https://developer.whoop.com
 *
 * Usage :
 *   1) cp whoop-config.example.json whoop-config.json   (puis remplis client_id/secret/redirect_uri)
 *   2) node whoop-sync.mjs login        → ouvre l'URL d'autorisation, capte le code, stocke les tokens
 *   3) node whoop-sync.mjs pull 30      → tire 30 jours et écrit whoop-data.json
 */
import fs from 'fs';
import http from 'http';

const CFG_FILE = 'whoop-config.json';
const TOK_FILE = 'whoop-tokens.json';
const OUT_FILE = 'whoop-data.json';

const AUTH_URL  = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API       = 'https://api.prod.whoop.com/developer';
const SCOPES    = 'read:recovery read:sleep read:cycles read:profile offline';

function readJSON(f, d){ try { return JSON.parse(fs.readFileSync(f)); } catch(e){ return d; } }
function cfg(){
  const c = readJSON(CFG_FILE, null);
  if(!c || !c.client_id){ console.error('❌ Manque '+CFG_FILE+' (copie whoop-config.example.json). Voir README.'); process.exit(1); }
  c.redirect_uri = c.redirect_uri || 'http://localhost:8787/callback';
  return c;
}
function saveTokens(t){ t.expires_at = Date.now() + (t.expires_in||3600)*1000; fs.writeFileSync(TOK_FILE, JSON.stringify(t,null,2)); }

/* ---------- OAuth ---------- */
async function exchange(params){
  const res = await fetch(TOKEN_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(params)
  });
  const txt = await res.text();
  if(!res.ok){ console.error('❌ Token endpoint '+res.status+': '+txt); process.exit(1); }
  return JSON.parse(txt);
}
async function login(){
  const c = cfg();
  const port = Number(new URL(c.redirect_uri).port || 8787);
  const state = Math.random().toString(36).slice(2);
  const url = AUTH_URL+'?'+new URLSearchParams({
    response_type:'code', client_id:c.client_id, redirect_uri:c.redirect_uri, scope:SCOPES, state
  });
  console.log('\n1) Ouvre cette URL dans ton navigateur et autorise :\n\n'+url+'\n');
  await new Promise((resolve)=>{
    const server = http.createServer(async (req,res)=>{
      const u = new URL(req.url, c.redirect_uri);
      const code = u.searchParams.get('code');
      if(!code){ res.end('En attente du code…'); return; }
      res.end('✅ Autorisé. Tu peux fermer cet onglet et revenir au terminal.');
      server.close();
      const tok = await exchange({ grant_type:'authorization_code', code, client_id:c.client_id, client_secret:c.client_secret, redirect_uri:c.redirect_uri });
      saveTokens(tok);
      console.log('✅ Tokens enregistrés dans '+TOK_FILE+'. Lance maintenant : node whoop-sync.mjs pull 30');
      resolve();
    });
    server.listen(port, ()=>console.log('2) En écoute sur '+c.redirect_uri+' …'));
  });
}
async function accessToken(){
  const c = cfg();
  let t = readJSON(TOK_FILE, null);
  if(!t){ console.error('❌ Pas de tokens. Lance d\'abord : node whoop-sync.mjs login'); process.exit(1); }
  if(Date.now() < (t.expires_at||0) - 60000) return t.access_token;
  const fresh = await exchange({ grant_type:'refresh_token', refresh_token:t.refresh_token, client_id:c.client_id, client_secret:c.client_secret, scope:SCOPES });
  if(!fresh.refresh_token) fresh.refresh_token = t.refresh_token;
  saveTokens(fresh);
  return fresh.access_token;
}

/* ---------- API ---------- */
async function getAll(path, params, token){
  const out=[]; let next=null;
  do{
    const q=new URLSearchParams(params); if(next) q.set('nextToken', next);
    const res=await fetch(API+path+'?'+q, { headers:{ Authorization:'Bearer '+token } });
    if(!res.ok){ console.error('⚠️  '+path+' '+res.status+': '+(await res.text())); break; }
    const j=await res.json();
    (j.records||[]).forEach(r=>out.push(r));
    next=j.next_token||null;
  } while(next);
  return out;
}
const ms = v => v==null ? null : +(v<2 ? v*1000 : v).toFixed(1);     // hrv_rmssd_milli (parfois en s) → ms
const dkey = iso => { const d=new Date(iso); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const min = milli => milli==null ? null : Math.round(milli/60000);

async function pull(days){
  const token = await accessToken();
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate()-days);
  const range = { start:start.toISOString(), end:end.toISOString(), limit:25 };

  const recs   = await getAll('/v2/recovery', range, token);
  const sleeps = await getAll('/v2/activity/sleep', range, token);
  const cycles = await getAll('/v2/cycle', range, token);

  const sleepById = {}; sleeps.forEach(s=>{ sleepById[s.id]=s; });
  const strainByDate = {}; cycles.forEach(c=>{ if(c.score && c.score.strain!=null) strainByDate[dkey(c.end||c.start)] = +c.score.strain.toFixed(1); });

  const byDate = {};
  recs.forEach(r=>{
    const sc=r.score; if(!sc) return;
    const sl=sleepById[r.sleep_id]; const ss=sl&&sl.score?sl.score:{}; const st=ss.stage_summary||{};
    const date = sl ? dkey(sl.end) : dkey(r.created_at);
    const sleepMin = (st.total_light_sleep_time_milli!=null)
      ? min((st.total_light_sleep_time_milli||0)+(st.total_slow_wave_sleep_time_milli||0)+(st.total_rem_sleep_time_milli||0))
      : null;
    byDate[date] = {
      date,
      hrv: ms(sc.hrv_rmssd_milli),
      rhr: sc.resting_heart_rate ?? null,
      resp: ss.respiratory_rate ?? null,
      sleepMin,
      deep: min(st.total_slow_wave_sleep_time_milli),
      rem:  min(st.total_rem_sleep_time_milli),
      light:min(st.total_light_sleep_time_milli),
      awake:min(st.total_awake_time_milli),
      spo2: sc.spo2_percentage ?? null,
      skinTemp: sc.skin_temp_celsius ?? null,
      offRecovery: sc.recovery_score ?? null,
      offStrain: null
    };
  });
  Object.keys(strainByDate).forEach(d=>{ if(byDate[d]) byDate[d].offStrain = strainByDate[d]; });

  const arr = Object.values(byDate).sort((a,b)=>a.date<b.date?-1:1);
  fs.writeFileSync(OUT_FILE, JSON.stringify(arr,null,2));
  console.log('✅ '+arr.length+' nuits écrites dans '+OUT_FILE+'. Importe-le dans FLINT Analyse → Données.');
}

/* ---------- CLI ---------- */
const cmd = process.argv[2];
if(cmd==='login') login();
else if(cmd==='pull') pull(Number(process.argv[3])||30);
else { console.log('Usage:\n  node whoop-sync.mjs login\n  node whoop-sync.mjs pull [jours]'); }
