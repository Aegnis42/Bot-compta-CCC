import { env } from './config.js';
import * as gs from './sheets.js';
import { toSheetSerial, weekOfSerial, weekLabel, previousWeekLabel } from './time.js';
import { qtyFrom, hasQty, newRef } from './utils.js';
import { loadPrices, rachatValue } from './prices.js';
import {
  loadRegistry, activeCharbonniers, allCharbonniers, readTabs, weekSummary, salariesForWeek, ensureTab, rebuildFormulas, IDX,
} from './charbonniers.js';
import * as ui from './ui.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { updateStockChannels } from './stockChannels.js';

// ---------- Google Sheet → Discord ----------

/**
 * Repère les lignes ajoutées à la main dans les onglets charbonniers (quantités sans "Réf"),
 * leur attribue une réf (et une date si vide) puis les annonce dans le salon du charbonnier.
 */
async function syncSheetToDiscord(client) {
  const list = activeCharbonniers().filter((c) => c.channelId);
  if (!list.length) return;

  const pending = await gs.withLock(async () => {
    const found = [];
    const writes = [];
    for (const { c, rows } of await readTabs(list)) {
      rows.forEach((r, j) => {
        const qty = qtyFrom(r, IDX.qty);
        if (!hasQty(qty) || String(r[IDX.ref] ?? '').trim()) return;
        const row = j + 2;
        const t = gs.q(c.tab);
        let week;
        if (typeof r[IDX.date] === 'number') {
          week = weekOfSerial(r[IDX.date]);
        } else {
          if (r[IDX.date] === undefined || r[IDX.date] === '') writes.push({ range: `${t}!A${row}`, values: [[toSheetSerial()]] });
          week = weekLabel();
        }
        const ref = newRef('S');
        writes.push({ range: `${t}!H${row}:I${row}`, values: [[r[IDX.source] || 'Google Sheet', ref]] });
        found.push({ c, qty, ref, week });
      });
    }
    await gs.writeMany(writes);
    return found;
  });

  for (const p of pending) {
    const channel = await client.channels.fetch(p.c.channelId).catch(() => null);
    if (!channel) continue;
    const weekSum = await weekSummary(p.c, p.week);
    await channel.send({
      embeds: [ui.depositEmbed({
        c: p.c, qty: p.qty, montant: rachatValue(p.qty), ref: p.ref, week: p.week, weekSum,
        title: '📄 Dépôt ajouté depuis le Google Sheet', color: ui.COLORS.sheet,
      })],
    }).catch((e) => console.warn(`[sync] envoi impossible dans le salon de ${p.c.name} :`, e.message));
  }
}

// ---------- Charbonniers ajoutés à la main dans l'onglet "Charbonniers" ----------

let lastSignature = null;
async function syncRegistry() {
  await loadRegistry();
  const signature = allCharbonniers().map((c) => `${c.name}|${c.tab}|${c.actif}`).join(';');
  if (signature === lastSignature) return;
  await gs.withLock(async () => {
    for (const c of allCharbonniers()) await ensureTab(c.tab);
    await rebuildFormulas();
  });
  lastSignature = signature;
}

// ---------- Récap hebdomadaire ----------

/** Le lundi (changement de semaine), poste les salaires de la semaine écoulée dans RECAP_CHANNEL_ID. */
async function weeklyRecap(client) {
  if (!env.recapChannelId) return;
  // Mémorisé dans l'onglet Config du Sheet pour survivre aux redémarrages / redéploiements
  const last = getSetting('dernier_recap_salaires');
  const prev = previousWeekLabel();
  if (!last) {
    // Premier démarrage : on ne poste pas tout de suite, on attend la prochaine fin de semaine
    await setSetting('dernier_recap_salaires', prev);
    return;
  }
  if (last === prev) return;
  const channel = await client.channels.fetch(env.recapChannelId).catch(() => null);
  if (!channel) return;
  await channel.send({ content: `📅 Semaine du **${prev}** terminée — salaires à verser :`, embeds: [ui.salairesEmbed(prev, await salariesForWeek(prev))] });
  await setSetting('dernier_recap_salaires', prev);
}

// ---------- Boucle ----------

export function startSync(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncRegistry();
      await loadPrices();
      await syncSheetToDiscord(client);
      await loadSettings();
      await weeklyRecap(client);
      await updateStockChannels(client);
    } catch (e) {
      console.error('[sync]', e.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, env.syncInterval * 1000);
}
