import { CODES, SHEETS } from './config.js';
import * as gs from './sheets.js';
import { getContract } from './contrats.js';
import { toSheetSerial } from './time.js';
import { UserError, lastDataRow } from './utils.js';

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

/** Dépense « contrat nourriture », déduite du bénéfice dans le récap de la semaine. */
export function recordFood({ montant, note = '', par }) {
  return gs.withLock(async () => {
    const rows = await gs.read(`${N}!A2:B`);
    const row = lastDataRow(rows, [0, 1]) + 3;
    await gs.ensureRows(SHEETS.NOURRITURE, row);
    await gs.write(`${N}!A${row}:D${row}`, [[toSheetSerial(), montant, note, par]]);
    return { row };
  });
}
