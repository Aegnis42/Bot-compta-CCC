import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, MessageFlags, ModalBuilder,
  SeparatorSpacingSize, TextInputStyle,
} from 'discord.js';
import { env, PRODUCTS, TARIFS } from './config.js';
import { UserError, emptyQty, hasQty, addQty } from './utils.js';
import { parseQuantities } from './parse.js';
import { getPrices, contractValue, contractUnitPrice } from './prices.js';
import { getSetting, setSetting } from './settings.js';
import { createContract, getStock } from './contrats.js';
import { scheduleStockRefresh } from './stockChannels.js';
import * as ui from './ui.js';

// Prise de commande : panneau public dans ORDER_CHANNEL_ID. Le client remplit un formulaire (nom, lieu de
// livraison, quantités), voit le total au tarif de son rôle, confirme, et la commande devient un contrat.

const EPH = { flags: MessageFlags.Ephemeral };
const MSG_KEY = 'commande_message';
const TARIF_LABEL = { [TARIFS.chatelerie]: 'Client Crevasse', [TARIFS.normal]: 'Client Extérieur' };

/** Tarif du client selon ses rôles (Crevasse prioritaire), ou null s'il n'a aucun rôle client. */
export function tarifForMember(member) {
  const has = (ids) => ids.some((r) => member?.roles?.cache?.has(r));
  if (has(env.chatelerieRoleIds)) return TARIFS.chatelerie;
  if (has(env.normalRoleIds)) return TARIFS.normal;
  return null;
}

const button = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function buildOrderPanel() {
  const prices = getPrices();
  const lines = PRODUCTS.map((p) =>
    `**${p.name}** (${p.code}) · Client Extérieur **${ui.fmt(prices[p.code].normal)}** · Client Crevasse **${ui.fmt(prices[p.code].chatelerie)}**`);
  return new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents((t) => t.setContent('# 🛒 Commander du charbon\n-# Compagnie du Charbon Crevassais'))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Large))
    .addTextDisplayComponents((t) => t.setContent([`### 💰 Nos prix (en ${env.currency}, par unité)`, ...lines].join('\n')))
    .addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((t) => t.setContent([
      '### 📝 Comment commander',
      '**1.** Clique sur **Passer commande**',
      '**2.** Indique ton nom, le lieu de livraison et les quantités',
      '**3.** Vérifie le total et confirme : la Compagnie s\'occupe du reste !',
      '-# Le prix dépend de ton rôle : Client Crevasse ou Client Extérieur.',
    ].join('\n')))
    .addActionRowComponents((row) => row.setComponents(button('cmd:new', 'Passer commande', '🛒', ButtonStyle.Success)));
}

let lastKey = null;
/** Crée ou met à jour le panneau de commande (seulement si les prix ont changé). */
export async function refreshOrderPanel(client, { force = false } = {}) {
  if (!env.orderChannelId) return;
  const channel = await client.channels.fetch(env.orderChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const container = buildOrderPanel();
  const key = JSON.stringify(container.toJSON());
  if (!force && key === lastKey) return;
  const payload = { components: [container], flags: MessageFlags.IsComponentsV2 };
  const msg = await channel.messages.fetch(getSetting(MSG_KEY) ?? '0').catch(() => null);
  if (msg) {
    await msg.edit(payload);
  } else {
    const sent = await channel.send(payload);
    await setSetting(MSG_KEY, sent.id);
  }
  lastKey = key;
}

let lastPeriodic = 0;
export async function periodicOrderPanel(client) {
  if (Date.now() - lastPeriodic < 5 * 60 * 1000) return;
  lastPeriodic = Date.now();
  await refreshOrderPanel(client).catch((e) => console.warn('[commande]', e.message));
}

function orderModal(member, tarif) {
  const qtyInput = (id, label, placeholder) => (l) => l
    .setLabel(label)
    .setTextInputComponent((t) => t.setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(placeholder).setMaxLength(40));
  return new ModalBuilder()
    .setCustomId('cmdm:new')
    .setTitle(`Commande · ${TARIF_LABEL[tarif]}`)
    .addLabelComponents(
      (l) => l.setLabel('Nom de l\'acheteur').setTextInputComponent((t) => t
        .setCustomId('nom').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(member.displayName.slice(0, 100))),
      (l) => l.setLabel('Lieu de livraison').setTextInputComponent((t) => t
        .setCustomId('lieu').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(150).setPlaceholder('ex : Markarth, entrepôt du port')),
      qtyInput('CP', 'Charbon Pauvre (quantité)', 'ex : 500'),
      qtyInput('C', 'Charbon (quantité)', 'ex : 200'),
      qtyInput('autres', 'Briquette / Coke (optionnel)', 'ex : 20 BC 5 CO'),
    );
}

/** Quantités du formulaire de commande. */
export function readOrderQty(get) {
  const qty = emptyQty();
  for (const code of ['CP', 'C']) {
    const raw = String(get(code) ?? '').trim().replace(/\s/g, '');
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) throw new UserError(`« ${raw} » n'est pas un nombre entier.`);
    qty[code] = parseInt(raw, 10);
  }
  const autres = String(get('autres') ?? '').trim();
  if (autres) {
    const extra = parseQuantities(autres);
    if (!extra) throw new UserError(`Briquette / Coke : « ${autres} » non reconnu. Écris par exemple 20 BC 5 CO.`);
    addQty(qty, extra);
  }
  if (!hasQty(qty)) throw new UserError('Indique au moins une quantité à commander.');
  return qty;
}

// Commandes en attente de confirmation (le récapitulatif reste valable 30 minutes)
const pending = new Map();
const newToken = () => Math.random().toString(36).slice(2, 10);

function recapEmbed(o, stock) {
  const ct = { tarif: o.tarif, prixPerso: {} };
  const lines = PRODUCTS.filter((p) => o.qty[p.code]).map((p) => {
    const unit = contractUnitPrice(ct, p.code);
    let line = `• **${ui.fmt(o.qty[p.code])}** ${p.name} × ${ui.fmt(unit)} = **${ui.money(o.qty[p.code] * unit)}**`;
    if (stock && o.qty[p.code] > Math.max(0, stock[p.code].stock)) line += '\n  -# ⏳ stock actuel insuffisant : livraison possible en plusieurs fois';
    return line;
  });
  return new EmbedBuilder()
    .setColor(ui.COLORS.info)
    .setTitle('🧾 Récapitulatif de ta commande')
    .setDescription([
      `👤 **${o.nom}**`,
      `📍 Livraison : **${o.lieu}**`,
      `🏷️ Tarif : ${TARIF_LABEL[o.tarif]}`,
      '',
      ...lines,
      '',
      `💰 **Total : ${ui.money(o.total)}**`,
    ].join('\n'))
    .setFooter({ text: 'Vérifie puis confirme ta commande.' });
}

/** Point d'entrée : renvoie true si l'interaction vient du panneau de commande. */
export async function handleOrderInteraction(i) {
  const id = i.customId ?? '';
  if (!id.startsWith('cmd:') && !id.startsWith('cmdm:')) return false;
  const reply = (payload) => (i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, ...EPH }));
  try {
    if (i.isButton() && id === 'cmd:new') {
      const tarif = tarifForMember(i.member);
      if (!tarif) throw new UserError('Pour commander, il te faut le rôle **Client Crevasse** ou **Client Extérieur**. Demande-le à la Compagnie.');
      await i.showModal(orderModal(i.member, tarif));
      return true;
    }

    if (i.isModalSubmit() && id === 'cmdm:new') {
      const tarif = tarifForMember(i.member);
      if (!tarif) throw new UserError('Tu n\'as plus de rôle client.');
      const qty = readOrderQty((k) => i.fields.getTextInputValue(k));
      await i.deferReply(EPH);
      const order = {
        userId: i.user.id,
        username: i.user.username,
        nom: i.fields.getTextInputValue('nom').trim(),
        lieu: i.fields.getTextInputValue('lieu').trim(),
        qty,
        tarif,
        total: contractValue(qty, { tarif, prixPerso: {} }),
        at: Date.now(),
      };
      const token = newToken();
      pending.set(token, order);
      setTimeout(() => pending.delete(token), 30 * 60 * 1000);
      const stock = await getStock().catch(() => null);
      await i.editReply({
        embeds: [recapEmbed(order, stock)],
        components: [new ActionRowBuilder().setComponents(
          button(`cmd:ok:${token}`, 'Confirmer la commande', '✅', ButtonStyle.Success),
          button(`cmd:no:${token}`, 'Annuler', '✖️', ButtonStyle.Secondary),
        )],
      });
      return true;
    }

    const [, action, token] = id.split(':');
    if (i.isButton() && (action === 'ok' || action === 'no')) {
      const order = pending.get(token);
      if (!order) throw new UserError('Ce récapitulatif a expiré. Clique à nouveau sur **Passer commande**.');
      if (order.userId !== i.user.id) throw new UserError('Ce récapitulatif ne t\'appartient pas.');
      pending.delete(token);
      if (action === 'no') {
        await i.update({ content: '✖️ Commande annulée.', embeds: [], components: [] });
        return true;
      }
      await i.update({ content: '⏳ Enregistrement de ta commande…', components: [] });
      const ct = await createContract({
        client: order.nom,
        tarif: order.tarif,
        qty: order.qty,
        note: `Commande Discord de ${order.username}`,
        lieu: order.lieu,
        clientId: order.userId,
      });
      scheduleStockRefresh();
      await i.editReply({
        content: `✅ **Commande ${ct.id} enregistrée !** La Compagnie du Charbon Crevassais va la préparer et la livrer à **${order.lieu}**.\n💰 Total : **${ui.money(ct.montant)}**`,
        embeds: [],
        components: [],
      });
      // Prévenir le staff dans le salon de gestion
      const staff = env.panelChannelId ? await i.client.channels.fetch(env.panelChannelId).catch(() => null) : null;
      await staff?.send({
        content: `🛒 **Nouvelle commande** de <@${order.userId}> (${TARIF_LABEL[order.tarif]})`,
        embeds: [ui.contractEmbed(ct, await getStock().catch(() => null))],
        allowedMentions: { parse: [] },
      }).catch((e) => console.warn('[commande] notification staff impossible :', e.message));
      return true;
    }
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[commande ${id}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await reply({ content: '', embeds: [ui.errorEmbed(msg)], components: [] }).catch(() => {});
  }
  return true;
}

// Pour les tests (validation hors ligne)
export const __test = { buildOrderPanel, orderModal, recapEmbed };
