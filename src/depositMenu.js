import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, ModalBuilder, SeparatorSpacingSize, TextInputStyle,
} from 'discord.js';
import { PRODUCTS } from './config.js';
import { isStaff } from './access.js';
import { UserError, emptyQty, hasQty } from './utils.js';
import { getPrices } from './prices.js';
import { weekLabel } from './time.js';
import { activeCharbonniers, findByChannel, deleteDeposit, weekSummary } from './charbonniers.js';
import { depositAndEmbed } from './actions.js';
import { scheduleStockRefresh } from './stockChannels.js';
import * as ui from './ui.js';

// Menu de dépôt dans le salon de chaque charbonnier : un message (Components V2) avec un bouton qui ouvre un
// formulaire « combien de chaque charbon ? ». Le menu est redescendu en bas du salon après chaque dépôt.

const EPH = { flags: MessageFlags.Ephemeral };
const IS_MENU = (m) => m.author?.id === m.client.user.id && JSON.stringify(m.components ?? []).includes('"dm:depot"');

const button = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function buildMenu(c) {
  const prices = getPrices();
  const tarifs = PRODUCTS.map((p) => `${p.code} **${ui.fmt(prices[p.code].rachat + (c.bonus || 0))}**`).join(' · ');
  return new ContainerBuilder()
    .setAccentColor(0x2c2f33)
    .addTextDisplayComponents((t) => t.setContent([
      `## ⛏️ Dépôts de ${c.name}`,
      'Tu viens de déposer du charbon ? Clique sur **Déclarer un dépôt** et indique les quantités.',
      `-# Prix de rachat par unité : ${tarifs}${c.bonus ? ` (bonus +${ui.fmt(c.bonus)} compris)` : ''}`,
    ].join('\n')))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents((row) => row.setComponents(
      button('dm:depot', 'Déclarer un dépôt', '⛏️', ButtonStyle.Success),
      button('dm:semaine', 'Ma semaine', '📊'),
      button('dm:annuler', 'Annuler mon dernier dépôt', '↩️'),
    ))
    .addTextDisplayComponents((t) => t.setContent('-# Tu peux aussi écrire directement ton dépôt dans ce salon, par exemple `300 CP 50 C`.'));
}

/**
 * Place le menu dans le salon du charbonnier. `bump` : le supprime et le reposte tout en bas
 * (après un dépôt) ; sinon ne fait rien s'il est déjà parmi les derniers messages.
 */
export async function ensureDepositMenu(client, c, { bump = false } = {}) {
  if (!c?.channelId) return;
  const channel = await client.channels.fetch(c.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const menus = recent ? [...recent.values()].filter(IS_MENU) : [];
  if (!bump && menus.length && recent.first()?.id === menus[0].id) return; // déjà tout en bas
  for (const m of menus) await m.delete().catch(() => {});
  await channel.send({ components: [buildMenu(c)], flags: MessageFlags.IsComponentsV2 }).catch((e) => {
    console.warn(`[menu] impossible de poster le menu de ${c.name} :`, e.message);
  });
}

let bumpTimers = new Map();
/** Redescend le menu quelques secondes après une activité dans le salon (regroupe les dépôts rapprochés). */
export function bumpDepositMenu(client, c) {
  if (!c?.channelId) return;
  clearTimeout(bumpTimers.get(c.channelId));
  bumpTimers.set(c.channelId, setTimeout(() => ensureDepositMenu(client, c, { bump: true }), 4000));
}

/** Au démarrage : un menu dans chaque salon de charbonnier actif (sans spammer ceux qui l'ont déjà en bas). */
export async function ensureAllDepositMenus(client) {
  for (const c of activeCharbonniers()) await ensureDepositMenu(client, c);
}

function depositModal(c) {
  const modal = new ModalBuilder().setCustomId('dmm:depot').setTitle(`Dépôt de ${c.name}`.slice(0, 45));
  for (const p of PRODUCTS) {
    modal.addLabelComponents((l) => l
      .setLabel(`${p.name} (${p.code})`)
      .setDescription('Nombre déposé (laisse vide si aucun)')
      .setTextInputComponent((t) => t.setCustomId(p.code).setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('0').setMaxLength(7)));
  }
  modal.addLabelComponents((l) => l
    .setLabel('Note (optionnel)')
    .setTextInputComponent((t) => t.setCustomId('note').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200)));
  return modal;
}

/** Lit les quantités du formulaire : entiers ≥ 0, au moins un produit. */
export function readModalQty(get) {
  const qty = emptyQty();
  for (const p of PRODUCTS) {
    const raw = String(get(p.code) ?? '').trim().replace(/\s/g, '');
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw new UserError(`${p.name} : « ${raw} » n'est pas un nombre entier.`);
    qty[p.code] = parseInt(raw, 10);
  }
  if (!hasQty(qty)) throw new UserError('Indique au moins une quantité.');
  return qty;
}

/** Point d'entrée : renvoie true si l'interaction vient d'un menu de dépôt. */
export async function handleDepositMenu(i) {
  const id = i.customId ?? '';
  if (!id.startsWith('dm:') && !id.startsWith('dmm:')) return false;
  const reply = (payload) => (i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, ...EPH }));
  try {
    const c = findByChannel(i.channelId);
    if (!c) throw new UserError('Ce salon n\'est relié à aucun charbonnier actif.');
    if (i.user.id !== c.discordId && !isStaff(i.member)) throw new UserError(`Ce menu est réservé à **${c.name}**.`);

    if (i.isButton() && id === 'dm:depot') {
      await i.showModal(depositModal(c));
    } else if (i.isModalSubmit() && id === 'dmm:depot') {
      const qty = readModalQty((code) => i.fields.getTextInputValue(code));
      const note = i.fields.getTextInputValue('note').trim();
      await i.deferReply(); // réponse visible dans le salon, comme un dépôt écrit
      const by = i.user.id === c.discordId ? i.user.username : `${i.user.username} (pour ${c.name})`;
      const embed = await depositAndEmbed(c, qty, `${by} (menu)${note ? ` : ${note}` : ''}`);
      await i.editReply({ embeds: [embed] });
      bumpDepositMenu(i.client, c);
    } else if (i.isButton() && id === 'dm:semaine') {
      await i.deferReply(EPH);
      const week = weekLabel();
      await i.editReply({ embeds: [ui.recapEmbed(c, week, await weekSummary(c, week))] });
    } else if (i.isButton() && id === 'dm:annuler') {
      await i.reply({
        content: 'Annuler ton **dernier dépôt** fait sur Discord ?',
        components: [new ActionRowBuilder().setComponents(button('dm:annuler-ok', 'Oui, annuler', '↩️', ButtonStyle.Danger))],
        ...EPH,
      });
    } else if (i.isButton() && id === 'dm:annuler-ok') {
      await i.deferUpdate();
      const d = await deleteDeposit(c, null);
      scheduleStockRefresh();
      await i.editReply({ content: '✅ Dépôt annulé.', components: [] });
      await i.channel.send({
        embeds: [ui.depositEmbed({
          c, qty: d.qty, montant: d.montant, ref: d.ref, week: d.week || '?',
          weekSum: await weekSummary(c, d.week || weekLabel()), title: '🗑️ Dépôt annulé', color: ui.COLORS.warn,
        })],
      });
      bumpDepositMenu(i.client, c);
    }
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[menu ${id}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await reply({ content: '', embeds: [ui.errorEmbed(msg)], components: [] }).catch(() => {});
  }
  return true;
}

// Pour les tests (validation hors ligne)
export const __test = { buildMenu, depositModal };
