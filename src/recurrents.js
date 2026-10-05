import { env } from './config.js';
import { listContracts, getContract, createContract, setContractWeekly } from './contrats.js';
import { listFood, recordFood, setFoodWeekly } from './achats.js';
import { getSetting, setSetting } from './settings.js';
import { weekLabel } from './time.js';
import { UserError } from './utils.js';
import * as ui from './ui.js';

// Contrats hebdomadaires (ventes de charbon et nourriture) : chaque lundi, une copie est créée pour la
// nouvelle semaine. La marque « OUI » passe sur la copie ; l'original garde « Renouvelé → <nouvel ID> ».

const RENEW_KEY = 'dernier_renouvellement_hebdo';

export async function listRecurring() {
  const [contracts, food] = await Promise.all([listContracts(), listFood()]);
  return {
    contracts: contracts.filter((ct) => ct.hebdo && ct.statut !== 'Annulé'),
    food: food.filter((f) => f.hebdo),
  };
}

/** Arrête la répétition d'un contrat (CT-…) ou d'une nourriture (NR-…). */
export async function stopRecurring(id) {
  const key = String(id).trim().toUpperCase();
  if (key.startsWith('NR-')) {
    const f = (await listFood()).find((x) => x.id.toUpperCase() === key);
    if (!f) throw new UserError(`Nourriture **${id}** introuvable.`);
    if (!f.hebdo) throw new UserError(`**${f.id}** n'est pas hebdomadaire.`);
    await setFoodWeekly(f, '');
    return `🍖 **${f.id}** (${ui.money(f.montant)}) ne sera plus renouvelé.`;
  }
  const ct = await getContract(key);
  if (!ct) throw new UserError(`Contrat **${id}** introuvable.`);
  if (!ct.hebdo) throw new UserError(`**${ct.id}** n'est pas hebdomadaire.`);
  await setContractWeekly(ct, '');
  return `📜 **${ct.id}** (${ct.client}) ne sera plus renouvelé. Le contrat de cette semaine reste valable.`;
}

/** Recrée pour la semaine en cours tous les contrats hebdomadaires. Renvoie les lignes de résumé. */
export async function renewAll() {
  const { contracts, food } = await listRecurring();
  const lines = [];
  for (const ct of contracts) {
    const copy = await createContract({
      client: ct.client,
      tarif: ct.tarif,
      qty: ct.cmd,
      prices: Object.fromEntries(Object.entries(ct.prixPerso).filter(([, v]) => v)),
      note: ct.note,
      hebdo: true,
    });
    await setContractWeekly(ct, `Renouvelé → ${copy.id}`);
    lines.push(`📜 **${copy.id}** — ${copy.client} : ${ui.qtyInline(copy.cmd)} (${ui.money(copy.montant)}) _(suite de ${ct.id})_`);
  }
  for (const f of food) {
    const { id } = await recordFood({ montant: f.montant, note: f.note, par: 'hebdomadaire', hebdo: true });
    await setFoodWeekly(f, `Renouvelé → ${id}`);
    lines.push(`🍖 **${id}** — nourriture : ${ui.money(f.montant)}${f.note ? ` (${f.note})` : ''} _(suite de ${f.id})_`);
  }
  return lines;
}

/**
 * Appelé régulièrement : au changement de semaine (lundi 00h), renouvelle les contrats hebdomadaires une
 * seule fois (semaine mémorisée dans Config). Au tout premier lancement, ne fait que mémoriser la semaine.
 */
export async function weeklyRenewal(client) {
  const week = weekLabel();
  const last = getSetting(RENEW_KEY);
  if (last === week) return;
  await setSetting(RENEW_KEY, week); // noté avant : jamais deux renouvellements pour la même semaine
  if (!last) return;
  const lines = await renewAll();
  if (!lines.length) return;
  console.log(`[hebdo] ${lines.length} contrat(s) renouvelé(s) pour la semaine du ${week}`);
  if (env.recapChannelId) {
    const channel = await client.channels.fetch(env.recapChannelId).catch(() => null);
    await channel?.send(`🔁 **Contrats hebdomadaires renouvelés** pour la semaine du ${week} :\n${lines.join('\n')}`).catch(() => {});
  }
}
