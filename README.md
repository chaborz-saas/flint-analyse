# FLINT Analyse 🔬

App **séparée** de FLINT (l'app de base reste à Dino). Sert à **comparer 3 flux** de récupération et **calibrer l'algo** pour qu'il colle à Whoop — sans jamais toucher au capteur de Whoop comme référence de production.

## Le principe : 3 flux

| Flux | Capteur | Algo | Ce que c'est |
|------|---------|------|--------------|
| **F1** FLINT · Polar | Polar | FLINT | le **produit réel** |
| **F2** FLINT · Whoop | Whoop | FLINT | l'algo FLINT sur capteur Whoop |
| **F3** Whoop officiel | Whoop | Whoop | la **référence** |

- **F2 vs F3** (même capteur Whoop) = **fidélité de l'algo** → c'est ça qu'on calibre.
- **F1 vs F2** (même algo FLINT) = **écart capteur** Polar vs Whoop.
- **F1 vs F3** = bout-en-bout (produit vs étalon).

L'algo de récupération est **identique** à celui de l'app FLINT de base :
`Z = wHRV·z(HRV) − wRHR·z(FCrepos) + wSleep·z(sommeil) − wResp·z(resp)` → `score = sigmoïde(k·Z)`,
baseline = moyenne/écart-type sur 30 jours (≥ 3 nuits pour démarrer).

## Lancer l'app

C'est un fichier statique. Au choix :
```bash
cd ~/flint-analyse
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```
Onglet **Données → 🎲 Charger un jeu de démo** pour voir le comparateur fonctionner tout de suite.

## Récupérer les vraies données Whoop (API officielle)

1. **Crée une app développeur** sur https://developer.whoop.com (abonnement Whoop actif requis).
   - Redirect URI : `http://localhost:8787/callback`
   - Scopes : `read:recovery read:sleep read:cycles read:profile offline`
2. Configure :
   ```bash
   cp whoop-config.example.json whoop-config.json
   # remplis client_id / client_secret
   ```
3. Autorise puis tire les données (Node 18+) :
   ```bash
   node whoop-sync.mjs login      # ouvre l'URL, autorise → tokens stockés
   node whoop-sync.mjs pull 30    # écrit whoop-data.json
   ```
4. Dans l'app : **Données → Importer whoop-data.json**.

## Récupérer les données Polar (côté F1)

Dans l'app **FLINT de base** : Profil → « Exporter mes données » (copie le presse-papier).
Colle ce JSON dans l'onglet **Données → Importer Polar** de FLINT Analyse.

## Calibrer

Onglet **Calibration** : bouge les poids → la **fidélité algo (r)** et l'**erreur (MAE)** F2-vs-Whoop se mettent à jour en direct.
Quand c'est bon, transmets les poids à Dino pour l'app de base.

## ⚠️ Notes
- Outil **interne / R&D** : `whoop-config.json` et `whoop-tokens.json` contiennent des secrets → **ne pas committer** (voir `.gitignore`).
- Connecter une Whoop reste un usage **perso/test** ; le produit final tourne sur ton hardware (Polar / J-Style).
- Vérifie le **scaling HRV** : le script convertit `hrv_rmssd_milli` en ms (×1000 si la valeur est en secondes). Compare une nuit à ce qu'affiche l'app Whoop pour confirmer.
