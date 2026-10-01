# Bot Compta CCC

Bot Discord qui tient la comptabilité des charbonniers dans un Google Sheet :

- **Chaque charbonnier a son salon Discord** : il y écrit ce qu'il a déposé (`300 CP`, `120 C 40 BC`…). Le bot l'inscrit dans **son onglet** du Google Sheet et lui répond avec son total de la semaine.
- **Sheet → Discord** : si quelqu'un ajoute une ligne à la main dans l'onglet d'un charbonnier, le bot l'annonce dans le salon du charbonnier (vérification toutes les 30 s).
- **Salaires** : onglet `Salaires` avec ce qui est dû à chaque charbonnier pour la semaine (+ commande `/salaires` et récap automatique le lundi).
- **Stock** : déposé − livré + ajustements manuels, avec ce qu'il reste à produire pour honorer les contrats.
- **Contrats** : commandes clients, livraisons partielles depuis le stock, reste à livrer et ce qu'il manque en stock.

## Marchandises et prix

| Produit | Code | Rachat | Vente normale | Vente Chatelerie |
|---|---|---|---|---|
| Charbon Pauvre | CP | 0,6 | 1 | 0,8 |
| Charbon | C | 1,2 | 2 | 1,5 |
| Briquette | BC | 1,8 | 3 | 2,5 |
| Coke | CO | 3,2 | 6 | 5 |

Montants en **septimes**. Les prix sont dans l'onglet `Prix` du Sheet : on peut les modifier là, tout se recalcule.
Exemple : 300 CP × 0,6 = **180 septimes**.

## Le Google Sheet

Le bot crée tout seul les onglets au premier démarrage (il ne touche pas aux onglets existants) :

| Onglet | Contenu |
|---|---|
| `Prix` | Prix de rachat et de vente (modifiables) |
| `Charbonniers` | Nom, ID Discord, ID du salon, onglet, actif (OUI/NON) |
| `<Nom du charbonnier>` | Un onglet par charbonnier : Date, Semaine, CP, C, BC, CO, Montant, Source, Réf, Note |
| `Salaires` | Salaire dû par charbonnier pour la semaine choisie en **B1** (vide = semaine en cours) |
| `Stock` | Déposé, ajustement manuel (colonne D), livré, stock actuel, reste à livrer, à produire |
| `Contrats` | ID, client, tarif, quantités commandées / livrées / restantes, montants, statut |
| `Livraisons` | Historique des livraisons de contrats |

Les colonnes calculées (Semaine, Montant, Livré, Reste, Statut…) sont des formules : **ne pas écrire dedans**.

**Ajouter un dépôt à la main** dans l'onglet d'un charbonnier : remplir la date (facultatif) et les quantités sur une nouvelle ligne, laisser `Réf` vide. Le bot complète la ligne et prévient le charbonnier sur Discord.

**Semaines** : du lundi au dimanche, notées `2026-S40`.

## Commandes Discord

| Commande | Qui | Rôle |
|---|---|---|
| *message* `300 CP` dans son salon | charbonnier | Déclarer un dépôt |
| `/depot cp: c: bc: co: [note] [membre]` | charbonnier (staff pour `membre`) | Déclarer un dépôt |
| `/annuler-depot [ref] [membre]` | charbonnier / staff | Supprimer un dépôt (le dernier par défaut) |
| `/recap [semaine] [membre]` | charbonnier | Dépôts et salaire de la semaine |
| `/stock` | tous | Stock, reste à livrer, à produire |
| `/salaires [semaine]` | staff | Salaires de tous les charbonniers |
| `/contrat creer client tarif cp c bc co [note]` | staff | Nouveau contrat (ID auto `CT-001`…) |
| `/contrat livrer id [cp c bc co]` | staff | Livre depuis le stock (sans quantité : le maximum possible) |
| `/contrat voir id` · `/contrat liste` · `/contrat annuler id` | staff | Suivi des contrats |
| `/charbonnier ajouter membre [nom] [salon]` | staff | Crée le salon privé + l'onglet |
| `/charbonnier retirer membre` · `/charbonnier liste` | staff | Gestion des charbonniers |
| `/setup` | staff | Recrée les onglets manquants et remet les formules à jour |

« Staff » = permission *Gérer le serveur* (modifiable dans Paramètres du serveur → Intégrations → le bot), ou le rôle `STAFF_ROLE_ID`.

## Installation

### 1. Bot Discord
1. <https://discord.com/developers/applications> → **New Application** → onglet **Bot** → *Reset Token* : c'est le `DISCORD_TOKEN`.
2. Toujours dans **Bot**, activer **Message Content Intent**.
3. **OAuth2 → URL Generator** : scopes `bot` + `applications.commands`, permissions : *Gérer les salons*, *Gérer les rôles*, *Voir les salons*, *Envoyer des messages*, *Intégrer des liens*, *Ajouter des réactions*, *Lire l'historique*. Ouvrir l'URL et inviter le bot sur le serveur.

### 2. Accès Google Sheets
1. <https://console.cloud.google.com/> → créer un projet → **API et services → Bibliothèque** → activer **Google Sheets API**.
2. **Identifiants → Créer → Compte de service** → onglet *Clés* → *Ajouter une clé* → JSON. Enregistrer le fichier sous `service-account.json` à la racine du projet (il est ignoré par git, **ne jamais le committer**).
3. Ouvrir le Google Sheet → **Partager** → ajouter l'adresse e-mail du compte de service (`...@...iam.gserviceaccount.com`) en **Éditeur**.

### 3. Lancer
```bash
npm install
cp .env.example .env   # puis remplir DISCORD_TOKEN (le reste est déjà prérempli)
npm start
```
Au démarrage, le bot crée les onglets et enregistre les commandes sur le serveur. Ensuite : `/charbonnier ajouter @membre` pour chaque charbonnier.

Pour qu'il tourne en permanence, l'héberger sur un VPS / Raspberry Pi (avec `pm2`) ou un hébergeur Node (Railway, Fly.io…). Sur un hébergeur, mettre le contenu du JSON dans `GOOGLE_SERVICE_ACCOUNT_JSON` au lieu du fichier.

### Options (`.env`)
- `CHARBONNIER_CATEGORY_ID` : catégorie où créer les salons des charbonniers.
- `STAFF_ROLE_ID` : rôle qui voit tous les salons charbonniers et a les droits staff.
- `RECAP_CHANNEL_ID` : salon où poster les salaires de la semaine écoulée chaque lundi à 00 h.
- `SYNC_INTERVAL_SECONDS` : fréquence de lecture du Sheet (30 s par défaut).

## Développement
```bash
npm test        # tests du lecteur de messages
```
Code : `src/index.js` (démarrage, messages), `src/commands.js` (commandes), `src/charbonniers.js` (dépôts, salaires), `src/contrats.js` (stock, contrats), `src/sync.js` (Sheet → Discord, récap), `src/setup.js` (structure du Sheet).
