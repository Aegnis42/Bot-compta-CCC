import fs from 'node:fs';
import { google } from 'googleapis';
import { env } from './config.js';

function credentials() {
  if (env.googleKeyJson) return JSON.parse(env.googleKeyJson);
  if (!fs.existsSync(env.googleKeyFile)) {
    throw new Error(`Fichier du compte de service Google introuvable : ${env.googleKeyFile} (voir README)`);
  }
  return JSON.parse(fs.readFileSync(env.googleKeyFile, 'utf8'));
}

let api;
let creds;
function sheets() {
  if (!api) {
    creds = credentials();
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    api = google.sheets({ version: 'v4', auth });
  }
  return api;
}

export const serviceAccountEmail = () => {
  try {
    return (creds ?? credentials()).client_email;
  } catch {
    return '(compte de service)';
  }
};

const ID = env.spreadsheetId;

/** Nom d'onglet utilisable dans une plage A1 : 'Mon onglet' */
export const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

let metaCache = null;
export async function getMeta(force = false) {
  if (metaCache && !force) return metaCache;
  const res = await sheets().spreadsheets.get({
    spreadsheetId: ID,
    fields: 'properties(title,timeZone),sheets(properties(sheetId,title,gridProperties))',
  });
  metaCache = {
    properties: res.data.properties,
    sheets: new Map(res.data.sheets.map((s) => [s.properties.title, s.properties])),
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
  const res = await sheets().spreadsheets.values.get({ spreadsheetId: ID, range, ...readOpts(unformatted) });
  return res.data.values ?? [];
}

export async function readMany(ranges, { unformatted = false } = {}) {
  if (!ranges.length) return [];
  const res = await sheets().spreadsheets.values.batchGet({ spreadsheetId: ID, ranges, ...readOpts(unformatted) });
  return res.data.valueRanges.map((vr) => vr.values ?? []);
}

/** raw=true : les valeurs sont écrites telles quelles (pas de formule, pas d'interprétation). */
export async function write(range, values, raw = true) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: ID, range, valueInputOption: raw ? 'RAW' : 'USER_ENTERED', requestBody: { values },
  });
}

export async function writeMany(data, raw = true) {
  if (!data.length) return;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: ID, requestBody: { valueInputOption: raw ? 'RAW' : 'USER_ENTERED', data },
  });
}

export async function clear(range) {
  await sheets().spreadsheets.values.clear({ spreadsheetId: ID, range });
}

export async function batchUpdate(requests) {
  if (!requests.length) return null;
  const res = await sheets().spreadsheets.batchUpdate({ spreadsheetId: ID, requestBody: { requests } });
  return res.data;
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
