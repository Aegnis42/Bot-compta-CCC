import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, MessageFlags, ModalBuilder,
  SeparatorSpacingSize, StringSelectMenuBuilder, TextInputStyle,
} from 'discord.js';
import { env, PRODUCTS, SHEETS, TARIFS, stockLevel } from './config.js';
import * as gs from './sheets.js';
import { isStaff } from './access.js';
import { UserError, hasQty, num } from './utils.js';
import { parseQuantities, parsePrices } from './parse.js';
import { getSetting, setSetting } from './settings.js';
import { previousWeekLabel, weekLabel } from './time.js';
import { contractValue, rachatValue } from './prices.js';
import { scheduleStockRefresh } from './stockChannels.js';
import {
  listContracts, getStock, createContract, deliverContract, cancelContract, setContractPrices, isOpen,
} from './contrats.js';
import {
  activeCharbonniers, findByUser, setCitizenship, salariesForWeek, recordDeposit, weekSummary,
} from './charbonniers.js';
import { recordPurchase, recordFood } from './achats.js';
import { listRecurring, stopRecurring } from './recurrents.js';
import { lastWeeks } from './historique.js';
import { sendPayNotices } from './sync.js';
import {
  addCharbonnierFlow, removeCharbonnierFlow, charbonniersList, setupFlow, stockSalonsFlow,
} from './actions.js';
import * as ui from './ui.js';

// Panneau de gestion : un message en Components V2 dans le salon PANEL_CHANNEL_ID, avec un résumé en direct
// et des boutons qui ouvrent des formulaires. Toutes les actions sont réservées au staff.

const MSG_KEY = 'panneau_message';
const EPH = { flags: MessageFlags.Ephemeral };

// Contrats en cours gardés en mémoire : un formulaire doit s'ouvrir en moins de 3 s, sans attendre le Sheet
let openContracts = [];

// ---------- Affichage ----------

const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(`pn:${id}`).setLabel(label).setEmoji(emoji).setStyle(style);

const SECTIONS = [
  ['### 📜 Contrats', [
    btn('ct-new', 'Nouveau', '➕', ButtonStyle.Success),
    btn('ct-livrer', 'Livrer', '🚚', ButtonStyle.Primary),
    btn('ct-prix', 'Prix perso', '✏️'),
    btn('ct-liste', 'En cours', '📋'),
    btn('ct-annuler', 'Annuler', '⛔', ButtonStyle.Danger),
  ]],
  ['### 🛒 Achats & dépenses', [
    btn('ach', 'Achat extérieur', '🛒', ButtonStyle.Primary),
    btn('nour', 'Contrat nourriture', '🍖', ButtonStyle.Primary),
    btn('rec', 'Hebdomadaires', '🔁'),
  ]],
  ['### 👥 Charbonniers', [
    btn('ch-add', 'Ajouter', '➕', ButtonStyle.Success),
    btn('ch-depot', 'Dépôt pour…', '⛏️', ButtonStyle.Primary),
    btn('ch-cit', 'Citoyenneté', '🏛️'),
    btn('ch-liste', 'Liste', '📋'),
    btn('ch-del', 'Retirer', '➖', ButtonStyle.Danger),
  ]],
  ['### 💰 Paie & finances', [
    btn('sal', 'Salaires', '💰', ButtonStyle.Primary),
    btn('hist', 'Historique', '🗂️'),
    btn('avis', 'Envoyer les avis de paie', '📨'),
  ]],
  ['### ⚙️ Réglages', [
    btn('set-cat', 'Catégorie charbonniers', '📁'),
    btn('set-stock', 'Salons de stock', '📦'),
    btn('set-sheet', 'Mettre à jour le Sheet', '🔄'),
    btn('refresh', 'Actualiser', '♻️'),
  ]],
];

/** Données du résumé : stock, contrats en cours, chiffres de la semaine (Feuille 1). */
async function loadSummary() {
  const [stock, contracts, [recap]] = await Promise.all([
    getStock(),
    listContracts(),
    gs.readMany([`${gs.q(SHEETS.RECAP)}!H7:H16`], { unformatted: true }).catch(() => [[]]),
  ]);
  openContracts = contracts.filter(isOpen).reverse(); // les plus récents d'abord
  const v = (k) => num(recap?.[k]?.[0]);
  return {
    stock,
    open: openContracts,
    week: { ca: v(0), cout: v(3), benefice: v(4), final: v(9) },
    actifs: activeCharbonniers().length,
  };
}

function buildPanel(s) {
  const stockLines = PRODUCTS.map((p) => {
    const qty = s.stock[p.code]?.stock ?? 0;
    return `${stockLevel(p.code, qty)?.icon ?? '▫️'} ${p.name} — **${ui.fmt(qty)}**`;
  });
  const attendu = s.open.reduce((sum, ct) => sum + ct.benefice, 0);
  const summary = [
    '### 📦 Stock',
    ...stockLines,
    `### 📊 Semaine du ${weekLabel()}`,
    `💰 Chiffre d'affaires **${ui.money(s.week.ca)}** · ⛏️ Coût **${ui.money(s.week.cout)}**`,
    `📈 Bénéfice **${ui.money(s.week.benefice)}** · 🏁 Bénéfice final **${ui.money(s.week.final)}**`,
    `📜 **${s.open.length}** contrat(s) en cours (bénéfice attendu **${ui.money(attendu)}**) · 👥 **${s.actifs}** charbonniers actifs`,
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents((t) => t.setContent('# ⛏️ Compagnie du Charbon Crevassais\n-# Panneau de gestion du bot · réservé à l\'intendance'))
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large))
    .addTextDisplayComponents((t) => t.setContent(summary))
    .addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
  for (const [title, buttons] of SECTIONS) {
    container
      .addTextDisplayComponents((t) => t.setContent(title))
      .addActionRowComponents((row) => row.setComponents(buttons));
  }
  return container;
}

let lastKey = null;
let refreshing = null;

/** Crée ou met à jour le message du panneau (seulement si son contenu a changé, sauf `force`). */
export async function refreshPanel(client, { force = false } = {}) {
  if (!env.panelChannelId) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const channel = await client.channels.fetch(env.panelChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const container = buildPanel(await loadSummary());
    const key = JSON.stringify(container.toJSON());
    if (!force && key === lastKey) return;
    const stamp = { type: 10, content: `-# Mis à jour <t:${Math.floor(Date.now() / 1000)}:R>` };
    const payload = { components: [{ ...container.toJSON(), components: [...container.toJSON().components, stamp] }], flags: MessageFlags.IsComponentsV2 };
    const msg = await channel.messages.fetch(getSetting(MSG_KEY) ?? '0').catch(() => null);
    if (msg) {
      await msg.edit(payload);
    } else {
      const sent = await channel.send(payload);
      await setSetting(MSG_KEY, sent.id);
    }
    lastKey = key;
  })().catch((e) => console.warn('[panneau]', e.message)).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

let timer = null;
let clientRef = null;
/** Mise à jour du panneau quelques secondes après une action. */
export function schedulePanelRefresh() {
  if (!clientRef) return;
  clearTimeout(timer);
  timer = setTimeout(() => refreshPanel(clientRef), 3000);
}

let lastPeriodic = 0;
/** Appelé par la boucle de synchro : rafraîchit le résumé au plus toutes les 2 minutes. */
export async function periodicPanelRefresh(client) {
  clientRef = client;
  if (Date.now() - lastPeriodic < 2 * 60 * 1000) return;
  lastPeriodic = Date.now();
  await refreshPanel(client);
}

// ---------- Formulaires ----------

const text = (id, label, { placeholder, required = true, long = false, value, max } = {}) => (l) => l
  .setLabel(label)
  .setTextInputComponent((t) => {
    t.setCustomId(id).setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(required);
    if (placeholder) t.setPlaceholder(placeholder);
    if (value) t.setValue(value);
    if (max) t.setMaxLength(max);
    return t;
  });

/** Les options de liste attendent l'emoji sous forme d'objet ({ name: '🔁' }). */
const opt = (o) => (typeof o.emoji === 'string' ? { ...o, emoji: { name: o.emoji } } : o);

const choice = (id, label, options, { required = true, placeholder } = {}) => (l) => l
  .setLabel(label)
  .setStringSelectMenuComponent((s) => {
    s.setCustomId(id).setRequired(required).addOptions(options.slice(0, 25).map(opt));
    if (placeholder) s.setPlaceholder(placeholder);
    return s;
  });

const contractOptions = () => openContracts.slice(0, 25).map((ct) => ({
  label: `${ct.id} — ${ct.client}`.slice(0, 100),
  description: `${ui.qtyInline(Object.fromEntries(PRODUCTS.map((p) => [p.code, Math.max(0, ct.reste[p.code])])))} à livrer · ${ct.statut}`.slice(0, 100),
  value: ct.id,
}));

const modal = (id, title, ...labels) => new ModalBuilder().setCustomId(`pnm:${id}`).setTitle(title).addLabelComponents(...labels);

const QTY_HINT = 'ex : 500 CP 200 C 10 CO';

function needContracts() {
  if (!openContracts.length) throw new UserError('Aucun contrat en cours. (Si tu viens d\'en créer un, clique sur ♻️ Actualiser.)');
}

/** Boutons du panneau qui ouvrent directement un formulaire. */
const MODALS = {
  'ct-new': () => modal('ct-new', 'Nouveau contrat',
    text('client', 'Client', { placeholder: 'ex : Markarth', max: 100 }),
    choice('tarif', 'Tarif', [{ label: TARIFS.normal, value: TARIFS.normal, emoji: '🏷️' }, { label: TARIFS.chatelerie, value: TARIFS.chatelerie, emoji: '🏰' }]),
    text('qty', 'Quantités commandées', { placeholder: QTY_HINT }),
    text('prix', 'Prix perso par unité (optionnel)', { placeholder: 'ex : CP 0,9 C 1,8 (vide = tarif)', required: false }),
    choice('hebdo', 'Se répète chaque semaine ?', [{ label: 'Non', value: 'non', default: true }, { label: 'Oui, recréé chaque lundi', value: 'oui', emoji: '🔁' }]),
  ),
  'ct-livrer': () => {
    needContracts();
    return modal('ct-livrer', 'Livrer un contrat',
      choice('id', 'Contrat', contractOptions()),
      text('qty', 'Quantités (vide = le maximum possible)', { placeholder: QTY_HINT, required: false }),
    );
  },
  'ct-prix': () => {
    needContracts();
    return modal('ct-prix', 'Prix perso d\'un contrat',
      choice('id', 'Contrat', contractOptions()),
      text('prix', 'Prix par unité', { placeholder: 'ex : CP 0,9 C 1,8 · CP 0 = revenir au tarif' }),
    );
  },
  'ct-annuler': () => {
    needContracts();
    return modal('ct-annuler', 'Annuler un contrat',
      choice('id', 'Contrat à annuler', contractOptions()),
      choice('confirm', 'Confirmation', [{ label: 'Oui, annuler ce contrat', value: 'oui', emoji: '⛔' }]),
    );
  },
  ach: () => modal('ach', 'Achat extérieur',
    text('fournisseur', 'Fournisseur', { placeholder: 'Chez qui le charbon a été acheté', max: 100 }),
    text('qty', 'Quantités achetées', { placeholder: QTY_HINT }),
    text('prix', `Prix total payé (${env.currency})`, { placeholder: 'ex : 1200' }),
    ...(openContracts.length ? [choice('contrat', 'Pour un contrat ? (optionnel)', contractOptions(), { required: false, placeholder: 'Aucun' })] : []),
    text('note', 'Note (optionnel)', { required: false, max: 200 }),
  ),
  nour: () => modal('nour', 'Contrat nourriture',
    text('montant', `Montant payé (${env.currency})`, { placeholder: 'ex : 350' }),
    text('note', 'Note (optionnel)', { required: false, max: 200 }),
    choice('hebdo', 'Se répète chaque semaine ?', [{ label: 'Non', value: 'non', default: true }, { label: 'Oui, recréé chaque lundi', value: 'oui', emoji: '🔁' }]),
  ),
  'ch-add': () => modal('ch-add', 'Ajouter un charbonnier',
    (l) => l.setLabel('Membre').setUserSelectMenuComponent((s) => s.setCustomId('membre').setRequired(true)),
    text('nom', 'Nom / onglet (optionnel)', { placeholder: 'vide = pseudo du serveur', required: false, max: 30 }),
  ),
  'ch-depot': () => modal('ch-depot', 'Déclarer un dépôt',
    (l) => l.setLabel('Charbonnier').setUserSelectMenuComponent((s) => s.setCustomId('membre').setRequired(true)),
    text('qty', 'Quantités déposées', { placeholder: QTY_HINT }),
    text('note', 'Note (optionnel)', { required: false, max: 200 }),
  ),
  'ch-cit': () => modal('ch-cit', 'Citoyenneté',
    (l) => l.setLabel('Charbonnier').setUserSelectMenuComponent((s) => s.setCustomId('membre').setRequired(true)),
    choice('payer', 'Payer la citoyenneté ?', [{ label: 'Oui, quand il fournit du charbon', value: 'oui', emoji: '🏛️' }, { label: 'Non', value: 'non', emoji: '🚫' }]),
  ),
  'ch-del': () => modal('ch-del', 'Retirer un charbonnier',
    (l) => l.setLabel('Charbonnier à désactiver').setUserSelectMenuComponent((s) => s.setCustomId('membre').setRequired(true)),
    choice('confirm', 'Confirmation', [{ label: 'Oui, le désactiver (historique conservé)', value: 'oui', emoji: '➖' }]),
  ),
  'set-cat': () => modal('set-cat', 'Catégorie des salons charbonniers',
    text('nom', 'Nom de la catégorie', { placeholder: 'ex : ⛏️ Charbonniers', max: 100 }),
  ),
  'set-stock': () => modal('set-stock', 'Salons de stock',
    text('nom', 'Nom de la catégorie', { value: 'Stock', max: 100 }),
    (l) => l.setLabel('Rôle qui peut voir le stock (optionnel)').setRoleSelectMenuComponent((s) => s.setCustomId('role').setRequired(false)),
  ),
};

// ---------- Traitement ----------

const qtyFrom = (raw, { required = true } = {}) => {
  if (!raw?.trim()) {
    if (required) throw new UserError(`Indique au moins une quantité (${QTY_HINT}).`);
    return null;
  }
  const qty = parseQuantities(raw);
  if (!qty || !hasQty(qty)) throw new UserError(`Quantités non reconnues : « ${raw} ». Écris par exemple ${QTY_HINT}.`);
  return qty;
};

const amountFrom = (raw, label) => {
  const n = num(raw);
  if (!(n > 0)) throw new UserError(`${label} invalide : « ${raw} ».`);
  return n;
};

const firstUser = (i, id) => i.fields.getSelectedUsers(id, true).first();
/** Valeur choisie dans une liste du formulaire (undefined si rien n'est choisi pour une liste facultative). */
const selected = (i, id) => {
  try {
    return i.fields.getStringSelectValues(id)?.[0];
  } catch {
    return undefined;
  }
};

/** Formulaires envoyés : la réponse est privée (éphémère). */
const SUBMITS = {
  async 'ct-new'(i) {
    const qty = qtyFrom(i.fields.getTextInputValue('qty'));
    const rawPrix = i.fields.getTextInputValue('prix');
    const prices = rawPrix.trim() ? parsePrices(rawPrix) : {};
    if (prices === null) throw new UserError(`Prix non reconnus : « ${rawPrix} ». Écris par exemple CP 0,9 C 1,8.`);
    const ct = await createContract({
      client: i.fields.getTextInputValue('client').trim(),
      tarif: selected(i, 'tarif'),
      qty,
      prices,
      hebdo: selected(i, 'hebdo') === 'oui',
    });
    return { content: `✅ Contrat **${ct.id}** créé.`, embeds: [ui.contractEmbed(ct, await getStock())] };
  },

  async 'ct-livrer'(i) {
    const qty = qtyFrom(i.fields.getTextInputValue('qty'), { required: false });
    const { contract, delivered, stock } = await deliverContract(selected(i, 'id'), qty, i.user.username);
    scheduleStockRefresh();
    if (!delivered) return { content: '⚠️ Rien n\'a pu être livré : le stock est insuffisant pour ce contrat.', embeds: [ui.contractEmbed(contract, stock)] };
    return {
      content: `🚚 Livraison enregistrée pour **${contract.id}** : ${ui.qtyInline(delivered)} (${ui.money(contractValue(delivered, contract))})`,
      embeds: [ui.contractEmbed(contract, stock)],
    };
  },

  async 'ct-prix'(i) {
    const raw = i.fields.getTextInputValue('prix');
    const prices = parsePrices(raw);
    if (!prices) throw new UserError(`Prix non reconnus : « ${raw} ». Écris par exemple CP 0,9 C 1,8.`);
    const ct = await setContractPrices(selected(i, 'id'), prices);
    return { content: `✏️ Prix du contrat **${ct.id}** mis à jour.`, embeds: [ui.contractEmbed(ct, await getStock())] };
  },

  async 'ct-annuler'(i) {
    const ct = await cancelContract(selected(i, 'id'));
    scheduleStockRefresh();
    return { content: `⛔ Contrat **${ct.id}** annulé.`, embeds: [ui.contractEmbed(ct)] };
  },

  async ach(i) {
    const qty = qtyFrom(i.fields.getTextInputValue('qty'));
    const prix = amountFrom(i.fields.getTextInputValue('prix'), 'Prix');
    const fournisseur = i.fields.getTextInputValue('fournisseur').trim();
    const contrat = openContracts.length ? selected(i, 'contrat') : undefined;
    const { contract } = await recordPurchase({
      fournisseur, qty, prix, contrat, par: i.user.username, note: i.fields.getTextInputValue('note').trim(),
    });
    scheduleStockRefresh();
    const embeds = contract ? [ui.contractEmbed(contract, await getStock())] : [];
    return {
      content: `🛒 Achat enregistré : ${ui.qtyInline(qty)} pour **${ui.money(prix)}** chez **${fournisseur}**. Ajouté au stock.`
        + (contract ? `\nRattaché au contrat **${contract.id}**.` : ''),
      embeds,
    };
  },

  async nour(i) {
    const montant = amountFrom(i.fields.getTextInputValue('montant'), 'Montant');
    const hebdo = selected(i, 'hebdo') === 'oui';
    const { id } = await recordFood({ montant, note: i.fields.getTextInputValue('note').trim(), par: i.user.username, hebdo });
    return { content: `🍖 Contrat nourriture **${id}** enregistré : **${ui.money(montant)}**${hebdo ? ' · 🔁 recréé chaque lundi' : ''}.` };
  },

  async 'ch-add'(i) {
    const user = firstUser(i, 'membre');
    const name = i.fields.getTextInputValue('nom').trim() || undefined;
    return { content: await addCharbonnierFlow({ guild: i.guild, client: i.client, user, name }) };
  },

  async 'ch-depot'(i) {
    const user = firstUser(i, 'membre');
    const c = findByUser(user.id);
    if (!c) throw new UserError(`<@${user.id}> n'est pas un charbonnier actif.`);
    const qty = qtyFrom(i.fields.getTextInputValue('qty'));
    const note = i.fields.getTextInputValue('note').trim();
    const res = await recordDeposit(c, qty, { source: 'Discord', note: `${i.user.username} (panneau)${note ? ` : ${note}` : ''}` });
    scheduleStockRefresh();
    const embed = ui.depositEmbed({
      c, qty, montant: rachatValue(qty, c.bonus), ref: res.ref, week: res.week, weekSum: await weekSummary(c, res.week), title: '✅ Dépôt enregistré',
    });
    const ch = c.channelId ? await i.client.channels.fetch(c.channelId).catch(() => null) : null;
    await ch?.send({ content: `Dépôt déclaré par <@${i.user.id}> :`, embeds: [embed] }).catch(() => {});
    return { embeds: [embed] };
  },

  async 'ch-cit'(i) {
    const user = firstUser(i, 'membre');
    const c = findByUser(user.id);
    if (!c) throw new UserError(`<@${user.id}> n'est pas un charbonnier actif.`);
    const payer = selected(i, 'payer') === 'oui';
    await setCitizenship(c, payer);
    return { content: payer ? `🏛️ **${c.name}** : citoyenneté payée quand il fournit du charbon.` : `🚫 **${c.name}** : citoyenneté non payée.` };
  },

  async 'ch-del'(i) {
    return { content: await removeCharbonnierFlow(firstUser(i, 'membre')) };
  },

  async 'set-cat'(i) {
    return { content: await setupFlow({ guild: i.guild, client: i.client, categoryName: i.fields.getTextInputValue('nom') }) };
  },

  async 'set-stock'(i) {
    let role = null;
    try {
      role = i.fields.getSelectedRoles('role')?.first() ?? null;
    } catch { /* aucun rôle choisi */ }
    return { content: await stockSalonsFlow({ guild: i.guild, client: i.client, name: i.fields.getTextInputValue('nom'), role }) };
  },
};

/** Boutons qui affichent une réponse privée (après un éventuel temps de chargement). */
const VIEWS = {
  async 'ct-liste'() {
    const [contracts, stock] = await Promise.all([listContracts(), getStock()]);
    const open = contracts.filter(isOpen);
    if (!open.length) return { content: 'Aucun contrat en cours.', embeds: [ui.stockEmbed(stock)] };
    return { embeds: [...open.slice(-8).map((ct) => ui.contractEmbed(ct, stock)), ui.contractsSummaryEmbed(open)] };
  },

  async rec() {
    const { contracts, food } = await listRecurring();
    const items = [
      ...contracts.map((ct) => ({ label: `${ct.id} — ${ct.client}`, description: `${ui.qtyInline(ct.cmd)} · ${ui.money(ct.montant)}`, value: ct.id, emoji: '📜' })),
      ...food.map((f) => ({ label: `${f.id} — nourriture ${ui.money(f.montant)}`, description: f.note || 'Contrat nourriture', value: f.id, emoji: '🍖' })),
    ].map((o) => ({ ...o, label: o.label.slice(0, 100), description: o.description.slice(0, 100) }));
    if (!items.length) return { content: '🔁 Aucun contrat hebdomadaire. Choisis « Oui, recréé chaque lundi » en créant un contrat ou une nourriture.' };
    return {
      content: `🔁 **Contrats hebdomadaires** (recréés chaque lundi à 00h) :\n${items.map((o) => `${o.emoji} **${o.label}** · ${o.description}`).join('\n')}`,
      components: [new ActionRowBuilder().setComponents(
        new StringSelectMenuBuilder().setCustomId('pn:rec-stop').setPlaceholder('Arrêter la répétition de…').addOptions(items.slice(0, 25).map(opt)),
      )],
    };
  },

  async 'ch-liste'() {
    return { embeds: [new EmbedBuilder().setColor(ui.COLORS.coal).setTitle(`👥 Charbonniers (${activeCharbonniers().length} actifs)`).setDescription(charbonniersList().slice(0, 4096))] };
  },

  async sal() {
    const week = weekLabel();
    return {
      embeds: [ui.salairesEmbed(week, await salariesForWeek(week))],
      components: [new ActionRowBuilder().setComponents(btn('sal-prev', 'Semaine dernière', '⏮️'))],
    };
  },

  async 'sal-prev'() {
    const week = previousWeekLabel();
    return { embeds: [ui.salairesEmbed(week, await salariesForWeek(week))] };
  },

  async hist() {
    return { embeds: [ui.historiqueEmbed(await lastWeeks(6))] };
  },

  async avis() {
    return {
      content: `📨 Envoyer maintenant à chaque charbonnier son avis de paie de la semaine du **${weekLabel()}** ?\n-# (C'est fait automatiquement le dimanche à 17h.)`,
      components: [new ActionRowBuilder().setComponents(btn('avis-ok', 'Oui, envoyer les avis', '📨', ButtonStyle.Danger))],
    };
  },

  async 'avis-ok'(i) {
    const week = weekLabel();
    const sent = await sendPayNotices(i.client, week);
    return { content: sent ? `✅ ${sent} avis de paie envoyé(s) pour la semaine du ${week}.` : `Aucun charbonnier n'a de salaire pour la semaine du ${week}.` };
  },

  async 'set-sheet'(i) {
    return { content: await setupFlow({ guild: i.guild, client: i.client }) };
  },
};

async function reply(i, payload) {
  const body = { content: '', embeds: [], components: [], ...payload };
  if (i.deferred || i.replied) return i.editReply(body);
  return i.reply({ ...body, ...EPH });
}

/** Point d'entrée : renvoie true si l'interaction venait du panneau. */
export async function handlePanelInteraction(i) {
  const id = i.customId ?? '';
  if (!id.startsWith('pn:') && !id.startsWith('pnm:')) return false;
  clientRef = i.client;
  try {
    if (!isStaff(i.member)) throw new UserError('Le panneau est réservé au staff.');

    if (i.isModalSubmit()) {
      const handler = SUBMITS[id.slice(4)];
      if (!handler) return true;
      await i.deferReply(EPH);
      await reply(i, await handler(i));
      schedulePanelRefresh();
      return true;
    }

    const action = id.slice(3);
    if (i.isStringSelectMenu() && action === 'rec-stop') {
      await i.deferReply(EPH);
      await reply(i, { content: await stopRecurring(i.values[0]) });
      schedulePanelRefresh();
      return true;
    }
    if (!i.isButton()) return true;

    if (action === 'refresh') {
      await i.deferUpdate();
      await refreshPanel(i.client, { force: true });
      return true;
    }
    if (MODALS[action]) {
      await i.showModal(MODALS[action]());
      return true;
    }
    if (VIEWS[action]) {
      await i.deferReply(EPH);
      await reply(i, await VIEWS[action](i));
      if (['avis-ok', 'set-sheet'].includes(action)) schedulePanelRefresh();
    }
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[panneau ${id}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await reply(i, { embeds: [ui.errorEmbed(msg)] }).catch(() => {});
  }
  return true;
}

// Pour les tests (validation hors ligne des formulaires et du panneau)
export const __test = { buildPanel, MODALS, setOpenContracts: (list) => { openContracts = list; } };
