import { SHEETS } from './config.js';
import * as gs from './sheets.js';

// Réglages du bot stockés dans l'onglet "Config" (Clé | Valeur), pour survivre à un changement de machine.
const R = () => `${gs.q(SHEETS.CONFIG)}!A2:B`;
let settings = new Map();

export async function loadSettings() {
  const rows = await gs.read(R());
  settings = new Map(rows.filter((r) => r[0]).map((r, i) => [String(r[0]).trim(), { value: String(r[1] ?? '').trim(), row: i + 2 }]));
  return settings;
}

export const getSetting = (key) => settings.get(key)?.value || null;

export function setSetting(key, value) {
  return gs.withLock(async () => {
    await loadSettings();
    const row = settings.get(key)?.row ?? Math.max(1, ...[...settings.values()].map((s) => s.row)) + 1;
    await gs.write(`${gs.q(SHEETS.CONFIG)}!A${row}:B${row}`, [[key, String(value)]]);
    await loadSettings();
  });
}
