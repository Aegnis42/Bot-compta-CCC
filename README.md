# Bot Compta CCC

Bot Discord qui tient la comptabilité des charbonniers dans un Google Sheet :

- **Chaque charbonnier a son salon Discord** : il y écrit ce qu'il a déposé (`300 CP`, `120 C 40 BC`…). Le bot l'inscrit dans **son onglet** du Google Sheet et lui répond avec son total de la semaine.
- **Sheet → Discord** : si quelqu'un ajoute une ligne à la main dans l'onglet d'un charbonnier, le bot l'annonce dans le salon du charbonnier (vérification toutes les 30 s).
- **Salaires** : onglet `Salaires` avec ce qui est dû à chaque charbonnier pour la semaine (+ commande `/salaires`).
- **Avis de paie** : chaque **dimanche à 17h** (heure de Paris), le bot pingue chaque charbonnier dans son salon avec son salaire de la semaine et lui dit de venir le chercher aux locaux de la CCC.
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
| `Feuille 1` | **Récapitulatif** de la semaine (date en B3) : stock, chiffre d'affaires, coût matériaux, bénéfice, salaire gestion (40 %), salaire clan (10 %), citoyenneté (50 × charbonniers ayant fourni), contrat nourriture, bénéfice final, taxe (20 %), BAT. Pourcentages et montants modifiables en colonne I, trésorerie en B13 |
| `Prix` | Prix de rachat et de vente (modifiables) |
| `Charbonniers` | Nom, ID Discord, ID du salon, onglet, actif (OUI/NON) |
| `<Nom du charbonnier>` | Un onglet par charbonnier : Date, Semaine, CP, C, BC, CO, Montant, Source, Réf, Note |
| `Salaires` | Salaire dû par charbonnier pour la semaine contenant la date saisie en **B1** (vide = semaine en cours) |
| `Stock` | Déposé, ajustement manuel (colonne D), livré, stock actuel, reste à livrer, à produire |
| `Contrats` | ID, client, tarif, quantités commandées / livrées / restantes, montants, statut |
| `Livraisons` | Historique des livraisons de contrats |
| `Achats` | Charbon acheté ailleurs qu'à nos charbonniers : entre dans le stock ; rattaché à un contrat, son prix remplace le prix de rachat dans le coût matériaux du contrat |
| `Nourriture` | Contrats nourriture, déduits du bénéfice de la semaine |

Les colonnes calculées (Semaine, Montant, Livré, Reste, Statut…) sont des formules : **ne pas écrire dedans**.

**Ajouter un dépôt à la main** dans l'onglet d'un charbonnier : remplir la date (facultatif) et les quantités sur une nouvelle ligne, laisser `Réf` vide. Le bot complète la ligne et prévient le charbonnier sur Discord.

**Semaines** : du lundi au dimanche, notées `28/09/2026 au 04/10/2026`. Dans les commandes, l'option `semaine` accepte n'importe quel jour de la semaine (`29/09`) ou `derniere`.

## Commandes Discord

| Commande | Qui | Rôle |
|---|---|---|
| *message* `300 CP` dans son salon | charbonnier | Déclarer un dépôt |
| `/depot cp: c: bc: co: [note] [membre]` | charbonnier (staff pour `membre`) | Déclarer un dépôt |
| `/annuler-depot [ref] [membre]` | charbonnier / staff | Supprimer un dépôt (le dernier par défaut) |
| `/recap [semaine] [membre]` | charbonnier | Dépôts et salaire de la semaine |
| `/stock` | tous | Stock (avec niveau 🔒 🟢 🟠 🔴 pour CP et C), reste à livrer, à produire. Une fois le stock de CP / C à 4000 ou plus (🔒), leurs dépôts sont refusés |
| `/stock-salons [categorie] [role]` | staff | Catégorie privée avec un salon vocal par marchandise affichant le stock (`Charbon | 3200`), visible seulement par les rôles choisis. Les noms des salons vocaux suivent le stock dans la limite de Discord (2 renommages / 10 min par salon) ; le salon `📦-stock-en-direct` affiche un tableau mis à jour instantanément |
| `/avis-paie [semaine]` | staff | Envoie tout de suite les avis de paie (sinon automatique le dimanche à 17h) |
| `/salaires [semaine]` | staff | Salaires de tous les charbonniers |
| `/contrat creer client tarif cp c bc co [note]` | staff | Nouveau contrat (ID auto `CT-001`…) |
| `/contrat livrer id [cp c bc co]` | staff | Livre depuis le stock (sans quantité : le maximum possible) |
| `/contrat voir id` · `/contrat liste` · `/contrat annuler id` | staff | Suivi des contrats |
| `/achat fournisseur prix cp c bc co [contrat] [note]` | staff | Charbon acheté à l'extérieur (ajouté au stock, compté dans le coût matériaux) |
| `/nourriture montant [note]` | staff | Contrat nourriture de la semaine |
| `/charbonnier ajouter membre [nom] [salon]` | staff | Crée le salon privé + l'onglet |
| `/charbonnier retirer membre` · `/charbonnier liste` | staff | Gestion des charbonniers |
| `/setup [categorie]` | staff | Initialise le bot : onglets du Sheet, formules, et catégorie Discord où ranger les salons des charbonniers (créée si besoin, salons existants déplacés) |

« Staff » = permission *Gérer le serveur*, le rôle `STAFF_ROLE_ID`, ou un compte listé dans `ADMIN_IDS` (le compte `1222839727934279692` est autorisé par défaut). Les commandes staff sont visibles par tous mais le bot refuse les autres membres.

## Installation

### 1. Bot Discord
1. <https://discord.com/developers/applications> → **New Application** → onglet **Bot** → *Reset Token* : c'est le `DISCORD_TOKEN`.
2. Toujours dans **Bot**, activer **Message Content Intent**.
3. **OAuth2 → URL Generator** : scopes `bot` + `applications.commands`, permissions : *Gérer les salons*, *Gérer les rôles*, *Voir les salons*, *Envoyer des messages*, *Intégrer des liens*, *Ajouter des réactions*, *Lire l'historique*. Ouvrir l'URL et inviter le bot sur le serveur.

### 2. Relier le Google Sheet (Apps Script)
Le bot passe par un petit script installé directement dans votre Google Sheet : pas besoin de console Google Cloud.

1. Dans le Google Sheet : **Extensions → Apps Script**.
2. Effacer le contenu de `Code.gs` et coller celui de [apps-script/Code.gs](apps-script/Code.gs).
3. Remplacer `'A_REMPLACER'` (ligne `const SECRET`) par la valeur de `APPS_SCRIPT_SECRET` du `.env` (un mot de passe long et aléatoire, à garder secret).
4. Dans la colonne de gauche : **Services (+) → Google Sheets API → Ajouter**.
5. **Enregistrer** (icône disquette), puis **Déployer → Nouveau déploiement** → roue dentée → **Application Web** :
   - *Exécuter en tant que* : **Moi**
   - *Qui a accès* : **Tout le monde** (le secret empêche quiconque d'autre de s'en servir)
6. **Déployer** → **Autoriser l'accès** → choisir votre compte Google → *Paramètres avancés → Accéder au projet (non sécurisé)* → Autoriser. (Google affiche cet avertissement pour tout script personnel non vérifié.)
7. Copier l'**URL de l'application Web** (`https://script.google.com/macros/s/.../exec`) dans `APPS_SCRIPT_URL` du `.env`.

Si vous modifiez le script plus tard : **Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version** (l'URL reste la même).

### 3. Lancer
```bash
npm install
cp .env.example .env   # puis remplir DISCORD_TOKEN, APPS_SCRIPT_URL et APPS_SCRIPT_SECRET
npm start
```
Au démarrage, le bot crée les onglets et enregistre les commandes sur le serveur. Ensuite : `/setup categorie:Charbonniers` puis `/charbonnier ajouter @membre` pour chaque charbonnier.

Pour qu'il tourne en permanence, l'héberger sur un VPS / Raspberry Pi (avec `pm2`) ou un hébergeur Node (Railway, Fly.io…).

### Options (`.env`)
- `CHARBONNIER_CATEGORY_ID` : catégorie où créer les salons des charbonniers.
- `STAFF_ROLE_ID` : rôle qui voit tous les salons charbonniers et a les droits staff.
- `RECAP_CHANNEL_ID` : salon staff où poster le récapitulatif des salaires en même temps que les avis de paie (dimanche 17h).
- Jour, heure et lieu de la paie : `PAIE` dans `src/config.js`.
- `SYNC_INTERVAL_SECONDS` : fréquence de lecture du Sheet (30 s par défaut).

## Développement
```bash
npm test        # tests du lecteur de messages
```
Code : `src/index.js` (démarrage, messages), `src/commands.js` (commandes), `src/charbonniers.js` (dépôts, salaires), `src/contrats.js` (stock, contrats), `src/sync.js` (Sheet → Discord, récap), `src/setup.js` (structure du Sheet).
