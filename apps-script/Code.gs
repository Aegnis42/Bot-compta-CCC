/**
 * Pont entre le bot Discord et ce Google Sheet.
 *
 * Installation (une seule fois) :
 *  1. Dans le Google Sheet : Extensions → Apps Script. Remplacer tout le contenu par ce fichier.
 *  2. Remplacer SECRET ci-dessous par la valeur de APPS_SCRIPT_SECRET du fichier .env du bot.
 *  3. À gauche, "Services" (+) → "Google Sheets API" → Ajouter.
 *  4. Déployer → Nouveau déploiement → type "Application Web"
 *       - Exécuter en tant que : Moi
 *       - Qui a accès : Tout le monde
 *     → Autoriser l'accès → copier l'URL de l'application Web dans APPS_SCRIPT_URL du .env.
 *
 * Après une modification de ce script : Déployer → Gérer les déploiements → Modifier → Nouvelle version.
 */
const SECRET = 'A_REMPLACER';

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET === 'A_REMPLACER' || req.secret !== SECRET) throw new Error('Secret invalide');
    out = { ok: true, data: run_(req.op, req.args || {}) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Bot Compta CCC : OK');
}

function run_(op, a) {
  const id = SpreadsheetApp.getActiveSpreadsheet().getId();
  const V = Sheets.Spreadsheets.Values;
  switch (op) {
    case 'meta':
      return Sheets.Spreadsheets.get(id, { fields: a.fields });
    case 'get':
      return V.get(id, a.range, a.options);
    case 'batchGet':
      return V.batchGet(id, Object.assign({ ranges: a.ranges }, a.options));
    case 'update':
      return V.update({ values: a.values }, id, a.range, { valueInputOption: a.valueInputOption });
    case 'batchUpdateValues':
      return V.batchUpdate({ valueInputOption: a.valueInputOption, data: a.data }, id);
    case 'clear':
      return V.clear({}, id, a.range);
    case 'batchUpdate':
      return Sheets.Spreadsheets.batchUpdate({ requests: a.requests }, id);
    default:
      throw new Error('Opération inconnue : ' + op);
  }
}
