import { CODES, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { getContract } from './contrats.js';
import { toSheetSerial } from './time.js';
import { UserError, lastDataRow, num } from './utils.js';

const A = gs.q(SHEETS.ACHATS);
const N = gs.q(SHEETS.NOURRITURE);

// Achats : A Date | B Fournisseur | C-F CP, C, BC, CO | G Prix payé | H Contrat | I Par | J Note

/**
 * Charbon acheté ailleurs qu'auprès de nos charbonniers : entre dans le stock, et son prix
 * compte dans le coût matériaux de la semaine (et du contrat s'il y est rattaché).
 */
export function recordPurchase({ fournisseur, qty, prix, contrat, par, note = '' }) {
  return gs.withLock(async () => {
    let ct = null;
    if (contrat) {
      ct = await getContract(contrat);
      if (!ct) throw new UserError(`Contrat **${contrat}** introuvable.`);
    }
    const rows = await gs.read(`${A}!A2:B`);
    const row = lastDataRow(rows, [0, 1]) + 3;
    await gs.ensureRows(SHEETS.ACHATS, row);
    await gs.write(`${A}!A${row}:J${row}`, [[
      toSheetSerial(), fournisseur, ...CODES.map((c) => qty[c] || ''), prix, ct?.id ?? '', par, note,
    ]]);
    return { row, contract: ct };
  });
}

// Nourriture : A Date | B Montant | C Note | D Par | E Hebdomadaire (OUI) | F ID (NR-001…)

export async function listFood() {
  const rows = await gs.read(`${N}!A2:F`, { unformatted: true });
  return rows
    .map((r, i) => ({
      row: i + 2,
      date: r[0],
      montant: num(r[1]),
      note: String(r[2] ?? ''),
      par: String(r[3] ?? ''),
      hebdo: /^oui$/i.test(String(r[4] ?? '').trim()),
      id: String(r[5] ?? '').trim(),
    }))
    .filter((f) => f.montant || f.id);
}

/** Dépense « contrat nourriture », déduite du bénéfice dans le récap de la semaine. */
export function recordFood({ montant, note = '', par, hebdo = false }) {
  return gs.withLock(async () => {
    const rows = await gs.read(`${N}!A2:F`);
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r[5] ?? '').match(/^NR-(\d+)$/i)?.[1] ?? 0)), 0);
    const id = `NR-${String(max + 1).padStart(3, '0')}`;
    const row = lastDataRow(rows, [0, 1]) + 3;
    await gs.ensureRows(SHEETS.NOURRITURE, row);
    await gs.write(`${N}!A${row}:F${row}`, [[toSheetSerial(), montant, note, par, hebdo ? 'OUI' : '', id]]);
    return { row, id };
  });
}

/** Change la colonne « Hebdomadaire » d'une ligne de nourriture (OUI, vide, ou texte de suivi). */
export function setFoodWeekly(food, value) {
  return gs.withLock(() => gs.write(`${N}!E${food.row}`, [[value]]));
}
