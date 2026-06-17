#!/usr/bin/env node
/*
 * polar-sync.mjs — récupère les données Polar (API officielle AccessLink) → polar-data.json
 * À importer ensuite dans FLINT Analyse (onglet Données → Importer Polar).
 *
 * Récupère la HRV (que Health Connect n'exporte pas) via la Nightly Recharge + le sommeil.
 *
 * Prérequis : Node 18+, Polar Flow installé qui synchronise ta Loop au cloud,
 * et une app créée sur https://admin.polaraccesslink.com (gratuit, perso ≤ 20 users).
 *
 * Usage :
 *   1) cp polar-config.example.json polar-config.json   (remplis client_id/secret/redirect_uri)
 *   2) node polar-sync.mjs login        → autorise + enregistre l'utilisateur
 *   3) node polar-sync.mjs pull          → écrit polar-data.json
 */
import fs from 'fs';
import http from 'http';

const CFG_FILE = 'polar-config.json';
const TOK_FILE = 'polar-tokens.json';
const OUT_FILE = 'polar-data.json';

const AUTH_URL  = 'https://flow.polar.com/oauth2/authorization';
const TOKEN_URL = 'https://polarremote.com/v2/oauth2/token';
const API       = 'https://www.polaraccesslink.com/v3';

function readJSON(f, d){ try { return JSON.parse(fs.readFileSync(f)); } catch(e){ return d; } }
function cfg(){
  const c = readJSON(CFG_FILE, null);
  if(!c || !c.client_id){ console.error('❌ Manque '+CFG_FILE+' (copie polar-config.example.json). Voir README.'); process.exit(1); }
  c.redirect_uri = c.redirect_uri || 'http://localhost:8788/callback';
  c.member_id   = c.member_id   || 'flint-analyse-user';
  return c;
}
function basic(c){ return 'Basic '+Buffer.from(c.client_id+':'+c.client_secret).toString('base64'); }

/* ---------- OAuth + enregistrement user ---------- */
async function login(){
  const c = cfg();
  const port = Number(new URL(c.redirect_uri).port || 8788);
  const url = AUTH_URL+'?'+new URLSearchParams({ response_type:'code', client_id:c.client_id, redirect_uri:c.redirect_uri, scope:'accesslink.read_all' });
  console.log('\n1) Ouvre cette URL et autorise :\n\n'+url+'\n');
  await new Promise((resolve)=>{
    const server = http.createServer(async (req,res)=>{
      const u = new URL(req.url, c.redirect_uri);
      const code = u.searchParams.get('code');
      if(!code){ res.end('En attente du code…'); return; }
      res.end('✅ Autorisé. Reviens au terminal.');
      server.close();
      const r = await fetch(TOKEN_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':basic(c), 'Accept':'application/json' },
        body:new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:c.redirect_uri })
      });
      const txt = await r.text();
      if(!r.ok){ console.error('❌ Token '+r.status+': '+txt); process.exit(1); }
      const tok = JSON.parse(txt);
      fs.writeFileSync(TOK_FILE, JSON.stringify(tok,null,2));
      // enregistre l'utilisateur dans ton app AccessLink (one-time ; 409 = déjà fait)
      const reg = await fetch(API+'/users', {
        method:'POST',
        headers:{ Authorization:'Bearer '+tok.access_token, 'Content-Type':'application/json', Accept:'application/json' },
        body:JSON.stringify({ 'member-id': c.member_id })
      });
      if(reg.ok || reg.status===409) console.log('✅ Connecté. Lance : node polar-sync.mjs pull');
      else console.log('⚠️ Enregistrement user : '+reg.status+' '+(await reg.text())+'\n(essaie quand même : node polar-sync.mjs pull)');
      resolve();
    });
    server.listen(port, ()=>console.log('2) En écoute sur '+c.redirect_uri+' …'));
  });
}
function token(){
  const t = readJSON(TOK_FILE, null);
  if(!t || !t.access_token){ console.error('❌ Pas de token. Lance d\'abord : node polar-sync.mjs login'); process.exit(1); }
  return t.access_token;
}
async function apiGet(path, tok){
  const res = await fetch(API+path, { headers:{ Authorization:'Bearer '+tok, Accept:'application/json' } });
  if(res.status===401){ console.error('❌ Token expiré/invalide → relance : node polar-sync.mjs login'); process.exit(1); }
  if(res.status===204) return null;                       // pas de contenu
  if(!res.ok){ console.error('⚠️ '+path+' '+res.status+': '+(await res.text())); return null; }
  return res.json();
}

/* ---------- pull ---------- */
const min = sec => sec==null ? null : Math.round(sec/60);
function asList(j, ...keys){ if(Array.isArray(j)) return j; if(!j) return []; for(const k of keys){ if(Array.isArray(j[k])) return j[k]; } return []; }

async function pull(){
  const tok = token();
  const nr    = asList(await apiGet('/users/nightly-recharge', tok), 'recharges', 'nightly_recharges');
  const sleep = asList(await apiGet('/users/sleep', tok), 'nights');

  const byDate = {};
  nr.forEach(r=>{
    const d = r.date; if(!d) return;
    byDate[d] = {
      date: d,
      hrv:  r.heart_rate_variability_avg ?? null,   // ms (RMSSD) — ce que Health Connect ne donne pas
      rhr:  r.heart_rate_avg ?? null,
      resp: r.breathing_rate_avg ?? null,
      source: 'polar'
    };
  });
  sleep.forEach(s=>{
    const d = s.date; if(!d) return;
    const light=s.light_sleep, deep=s.deep_sleep, rem=s.rem_sleep;
    const tot = (light!=null||deep!=null||rem!=null) ? (light||0)+(deep||0)+(rem||0) : null;
    const o = byDate[d] || { date:d, hrv:null, rhr:null, resp:null, source:'polar' };
    o.sleepMin = min(tot);
    o.deep = min(deep); o.rem = min(rem); o.light = min(light);
    o.awake = min(s.total_interruption_duration);
    byDate[d] = o;
  });

  const arr = Object.values(byDate).sort((a,b)=>a.date<b.date?-1:1);
  fs.writeFileSync(OUT_FILE, JSON.stringify(arr,null,2));
  const withHrv = arr.filter(x=>x.hrv!=null).length;
  console.log('✅ '+arr.length+' nuits écrites dans '+OUT_FILE+' ('+withHrv+' avec HRV). Importe-le dans FLINT Analyse → Données → Importer Polar.');
  if(withHrv===0) console.log('⚠️ Aucune HRV : vérifie que ta Loop fait bien la « Nightly Recharge » et qu\'elle a synchronisé dans Polar Flow.');
}

/* ---------- CLI ---------- */
const cmd = process.argv[2];
if(cmd==='login') login();
else if(cmd==='pull') pull();
else console.log('Usage:\n  node polar-sync.mjs login\n  node polar-sync.mjs pull');
