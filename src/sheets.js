import { env } from './config.js';

/**
 * Tout passe par le script Apps Script installé dans le Google Sheet (apps-script/Code.gs),
 * qui relaie les appels vers l'API Google Sheets.
 */
async function call(op, args) {
  if (!env.appsScriptUrl || !env.appsScriptSecret) {
    throw new Error('APPS_SCRIPT_URL ou APPS_SCRIPT_SECRET manquant dans le .env (voir README)');
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(env.appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: env.appsScriptSecret, op, args }),
        redirect: 'follow',
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Réponse inattendue du script Apps Script (HTTP ${res.status}). Le déploiement est-il bien en accès "Tout le monde" ?`);
      }
      if (!json.ok) throw Object.assign(new Error(json.error), { fatal: true });
      return json.data ?? {};
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export const setupHint = () =>
  'Vérifie APPS_SCRIPT_URL / APPS_SCRIPT_SECRET dans le .env et que le script Apps Script est déployé (voir README).';

/** Nom d'onglet utilisable dans une plage A1 : 'Mon onglet' */
export const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

let metaCache = null;
export async function getMeta(force = false) {
  if (metaCache && !force) return metaCache;
  const data = await call('meta', { fields: 'properties(title,timeZone,locale),sheets(properties(sheetId,title,gridProperties))' });
  metaCache = {
    properties: data.properties,
    sheets: new Map(data.sheets.map((s) => [s.properties.title, s.properties])),
  };
  return metaCache;
}

export async function sheetProps(title) {
  let meta = await getMeta();
  if (!meta.sheets.has(title)) meta = await getMeta(true);
  return meta.sheets.get(title);
}

const readOpts = (unformatted) => ({
  valueRenderOption: unformatted ? 'UNFORMATTED_VALUE' : 'FORMATTED_VALUE',
  dateTimeRenderOption: 'SERIAL_NUMBER',
});

export async function read(range, { unformatted = false } = {}) {
  const data = await call('get', { range, options: readOpts(unformatted) });
  return data.values ?? [];
}

export async function readMany(ranges, { unformatted = false } = {}) {
  if (!ranges.length) return [];
  const data = await call('batchGet', { ranges, options: readOpts(unformatted) });
  return data.valueRanges.map((vr) => vr.values ?? []);
}

/**
 * Les formules sont interprétées selon la langue du Sheet : avec une virgule décimale (fr_FR…),
 * les arguments sont séparés par ";" au lieu de ",". Le code écrit tout en syntaxe anglaise et convertit ici.
 */
export function localizeFormula(formula, semicolon) {
  if (!semicolon || typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  let out = '';
  let inString = false;
  for (const ch of formula) {
    if (ch === '"') inString = !inString;
    out += ch === ',' && !inString ? ';' : ch;
  }
  return out;
}

async function usesSemicolon() {
  const locale = (await getMeta()).properties.locale || 'en_US';
  try {
    return new Intl.NumberFormat(locale.replace('_', '-')).format(1.5).includes(',');
  } catch {
    return false;
  }
}

async function localizeValues(values) {
  const semi = await usesSemicolon();
  return values.map((row) => row.map((v) => localizeFormula(v, semi)));
}

/** raw=true : les valeurs sont écrites telles quelles (pas de formule, pas d'interprétation). */
export async function write(range, values, raw = true) {
  if (!raw) values = await localizeValues(values);
  await call('update', { range, values, valueInputOption: raw ? 'RAW' : 'USER_ENTERED' });
}

export async function writeMany(data, raw = true) {
  if (!data.length) return;
  if (!raw) data = await Promise.all(data.map(async (d) => ({ ...d, values: await localizeValues(d.values) })));
  await call('batchUpdateValues', { data, valueInputOption: raw ? 'RAW' : 'USER_ENTERED' });
}

export async function clear(range) {
  await call('clear', { range });
}

export async function batchUpdate(requests) {
  if (!requests.length) return null;
  return call('batchUpdate', { requests });
}

/** S'assure que l'onglet a au moins `row` lignes. */
export async function ensureRows(title, row) {
  const p = await sheetProps(title);
  if (p.gridProperties.rowCount >= row) return;
  await batchUpdate([{ appendDimension: { sheetId: p.sheetId, dimension: 'ROWS', length: row - p.gridProperties.rowCount + 500 } }]);
  await getMeta(true);
}

// --- Mise en forme ---
export const headerFormat = (sheetId, row = 0) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: row, endRowIndex: row + 1 },
    cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
    fields: 'userEnteredFormat(textFormat,backgroundColor)',
  },
});

export const columnFormat = (sheetId, col, numberFormat, startRow = 1) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: startRow, startColumnIndex: col, endColumnIndex: col + 1 },
    cell: { userEnteredFormat: { numberFormat } },
    fields: 'userEnteredFormat.numberFormat',
  },
});

export const DATE_TIME = { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' };
export const TEXT = { type: 'TEXT' };

// --- Verrou : sérialise les écritures du bot pour éviter que deux dépôts visent la même ligne ---
let chain = Promise.resolve();
export function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}
