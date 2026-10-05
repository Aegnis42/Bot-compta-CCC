import { env, CODES, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { getStock } from './contrats.js';
import { allCharbonniers, readTabs } from './charbonniers.js';
import { toSheetSerial, weekOfSerial } from './time.js';
import { num, round2, lastDataRow } from './utils.js';
import * as ui from './ui.js';

// Historique : une ligne par semaine terminée (lundi → dimanche), avec les chiffres du récap de la Feuille 1
// figés au moment de la clôture (les pourcentages utilisés sont ceux du récap à ce moment-là).
const H = gs.q(SHEETS.HISTORIQUE);

/** Lundi (numéro de série Sheets, à 00h) de la semaine contenant `serial`. */
const mondayOf = (serial) => {
  const day = Math.floor(serial);
  const weekday = new Date((day - 25569) * 86400000).getUTCDay(); // 0 = dimanche
  return day - ((weekday + 6) % 7);
};

/** Paramètres du récap (Feuille 1, colonne I), avec les valeurs par défaut si le récap n'existe pas. */
async function recapParams() {
  const [[gestion] = [], [clan] = [], [citoyen] = [], , , [taxe] = []] =
    await gs.read(`${gs.q(SHEETS.RECAP)}!I12:I17`, { unformatted: true }).catch(() => []);
  const val = (v, d) => (v === undefined || v === '' ? d : num(v));
  return { gestion: val(gestion, 0.4), clan: val(clan, 0.1), citoyen: val(citoyen, 50), taxe: val(taxe, 0.2) };
}

/** Toutes les données datées nécessaires, lues en une fois. */
async function loadData() {
  const [livraisons, achats, nourriture] = await gs.readMany(
    [`${gs.q(SHEETS.LIVRAISONS)}!A2:G`, `${gs.q(SHEETS.ACHATS)}!A2:G`, `${gs.q(SHEETS.NOURRITURE)}!A2:B`],
    { unformatted: true },
  );
  const tabs = await readTabs(allCharbonniers());
  return { livraisons, achats, nourriture, tabs };
}

/** Chiffres d'une semaine (lundi = numéro de série), mêmes règles que le récap de la Feuille 1. */
export function weekFigures(monday, data, params) {
  const inWeek = (r) => typeof r[0] === 'number' && r[0] >= monday && r[0] < monday + 7;
  const sum = (rows, col) => rows.filter(inWeek).reduce((s, r) => s + num(r[col]), 0);

  const ca = sum(data.livraisons, 6);
  const rachat = data.tabs.reduce((s, t) => s + sum(t.rows, 6), 0);
  const achats = sum(data.achats, 6);
  const fournisseurs = data.tabs
    .filter((t) => t.c?.citoyennete !== false) // citoyenneté payée seulement si OUI dans l'onglet Charbonniers
    .filter((t) => t.rows.some((r) => inWeek(r) && num(r[6]) > 0)).length;
  const nourriture = sum(data.nourriture, 1);

  const cout = rachat + achats;
  const benefice = ca - cout;
  const gestion = round2(Math.max(0, benefice) * params.gestion);
  const clan = round2(Math.max(0, benefice) * params.clan);
  const citoyennete = fournisseurs * params.citoyen;
  const final = benefice - gestion - clan - citoyennete - nourriture;
  const taxe = round2(Math.max(0, final) * params.taxe);
  return {
    ca: round2(ca), rachat: round2(rachat), achats: round2(achats), cout: round2(cout), benefice: round2(benefice),
    gestion, clan, fournisseurs, citoyennete, nourriture: round2(nourriture), final: round2(final), taxe, bat: round2(final - taxe),
  };
}

/**
 * Ajoute à l'Historique toutes les semaines terminées qui n'y sont pas encore (depuis la première donnée).
 * Le stock de fin de semaine n'est noté que pour la semaine qui vient de se terminer (inconnu pour les plus anciennes).
 * Renvoie les semaines ajoutées.
 */
export function closeFinishedWeeks() {
  return gs.withLock(async () => {
    const current = mondayOf(toSheetSerial());
    const existingRows = await gs.read(`${H}!A2:A`);
    const existing = new Set(existingRows.map((r) => String(r[0] ?? '')));
    const data = await loadData();

    const dates = [data.livraisons, data.achats, data.nourriture, ...data.tabs.map((t) => t.rows)]
      .flat()
      .map((r) => r[0])
      .filter((v) => typeof v === 'number');
    if (!dates.length) return [];
    const weeks = [];
    for (let m = mondayOf(Math.min(...dates)); m < current; m += 7) {
      if (!existing.has(weekOfSerial(m))) weeks.push(m);
    }
    if (!weeks.length) return [];

    const params = await recapParams();
    const stock = await getStock();
    const lastFinished = current - 7;
    const rows = weeks.map((m) => {
      const f = weekFigures(m, data, params);
      return [
        weekOfSerial(m), m, f.ca, f.rachat, f.achats, f.cout, f.benefice, f.gestion, f.clan, f.fournisseurs,
        f.citoyennete, f.nourriture, f.final, f.taxe, f.bat,
        ...CODES.map((c) => (m === lastFinished ? round2(stock[c].stock) : '')),
        toSheetSerial(),
      ];
    });
    const firstRow = lastDataRow(existingRows, [0]) + 3;
    await gs.ensureRows(SHEETS.HISTORIQUE, firstRow + rows.length);
    await gs.write(`${H}!A${firstRow}:T${firstRow + rows.length - 1}`, rows);
    return rows.map((r) => ({ semaine: r[0], ca: r[2], benefice: r[6], final: r[12], bat: r[14] }));
  });
}

/** Dernières semaines de l'historique (les plus récentes d'abord). */
export async function lastWeeks(n = 6) {
  const rows = await gs.read(`${H}!A2:O`, { unformatted: true });
  return rows
    .filter((r) => r[0])
    .sort((a, b) => num(b[1]) - num(a[1]))
    .slice(0, n)
    .map((r) => ({ semaine: r[0], ca: num(r[2]), cout: num(r[5]), benefice: num(r[6]), final: num(r[12]), bat: num(r[14]) }));
}

let checkedFor = null;
/** Appelé régulièrement : clôture les semaines terminées au plus une fois par semaine (et au démarrage). */
export async function weeklyHistory(client) {
  const current = mondayOf(toSheetSerial());
  if (checkedFor === current) return;
  const added = await closeFinishedWeeks();
  checkedFor = current;
  if (!added.length) return;
  console.log(`[historique] ${added.length} semaine(s) ajoutée(s) : ${added.map((w) => w.semaine).join(', ')}`);
  if (env.recapChannelId) {
    const channel = await client.channels.fetch(env.recapChannelId).catch(() => null);
    const lines = added.map((w) => `📅 **${w.semaine}** — CA ${ui.money(w.ca)} · bénéfice ${ui.money(w.benefice)} · bénéfice final ${ui.money(w.final)} · BAT ${ui.money(w.bat)}`);
    await channel?.send(`🗂️ **Semaine clôturée** (onglet Historique) :\n${lines.join('\n')}`).catch(() => {});
  }
}
