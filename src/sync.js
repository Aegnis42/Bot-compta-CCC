import { env, PAIE } from './config.js';
import * as gs from './sheets.js';
import { toSheetSerial, weekOfSerial, weekLabel, localClock } from './time.js';
import { qtyFrom, hasQty, newRef } from './utils.js';
import { loadPrices, rachatValue } from './prices.js';
import {
  loadRegistry, activeCharbonniers, allCharbonniers, readTabs, weekSummary, salariesForWeek, ensureTab, rebuildFormulas, IDX,
} from './charbonniers.js';
import * as ui from './ui.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { updateStockChannels } from './stockChannels.js';
import { ensureAdminRole } from './adminRole.js';

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

// ---------- Avis de paie (dimanche 17h) ----------

const PAIE_KEY = 'dernier_avis_paie';

/** Vrai le jour de paie à partir de l'heure prévue (rattrape un redémarrage du bot pendant la soirée). */
export const isPayTime = ({ weekday, hour }) => weekday === PAIE.weekday && hour >= PAIE.hour;

/**
 * Pingue chaque charbonnier dans son salon avec son salaire de la semaine,
 * et poste le récapitulatif dans RECAP_CHANNEL_ID s'il est défini. Renvoie le nombre d'avis envoyés.
 */
export async function sendPayNotices(client, week) {
  const salaries = await salariesForWeek(week);
  let sent = 0;
  for (const s of salaries) {
    if (!s.c.actif || !s.c.channelId || !s.c.discordId || s.montant <= 0) continue;
    const channel = await client.channels.fetch(s.c.channelId).catch(() => null);
    if (!channel) continue;
    await channel.send({
      content: `<@${s.c.discordId}> 💰 Ta paie de la semaine est prête : **${ui.money(s.montant)}**.\nViens la chercher ${PAIE.lieu} !`,
      embeds: [ui.recapEmbed(s.c, week, s)],
      allowedMentions: { users: [s.c.discordId] },
    }).then(() => sent++).catch((e) => console.warn(`[paie] avis impossible pour ${s.c.name} :`, e.message));
  }
  if (env.recapChannelId) {
    const channel = await client.channels.fetch(env.recapChannelId).catch(() => null);
    await channel?.send({ content: `📅 Paie de la semaine du **${week}** — à verser ${PAIE.lieu} :`, embeds: [ui.salairesEmbed(week, salaries)] }).catch(() => {});
  }
  return sent;
}

async function payday(client) {
  if (!isPayTime(localClock())) return;
  const week = weekLabel();
  // Mémorisé dans l'onglet Config du Sheet : un seul envoi par semaine, même après un redéploiement
  if (getSetting(PAIE_KEY) === week) return;
  await setSetting(PAIE_KEY, week);
  const sent = await sendPayNotices(client, week);
  console.log(`[paie] ${sent} avis envoyés pour la semaine du ${week}`);
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
      await payday(client);
      await updateStockChannels(client);
      await ensureAdminRole(client).catch((e) => console.warn('[rôle]', e.message));
    } catch (e) {
      console.error('[sync]', e.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, env.syncInterval * 1000);
}
