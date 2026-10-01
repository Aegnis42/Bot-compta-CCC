import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, OverwriteType, MessageFlags,
} from 'discord.js';
import { env, PRODUCTS, CODES, TARIFS } from './config.js';
import { UserError, emptyQty, hasQty } from './utils.js';
import { normalizeWeek, weekLabel } from './time.js';
import { rachatValue, venteValue, loadPrices } from './prices.js';
import { ensureStructure } from './setup.js';
import {
  allCharbonniers, findByChannel, findByUser, addCharbonnier, deactivateCharbonnier, validateName,
  recordDeposit, deleteDeposit, weekSummary, salariesForWeek, loadRegistry, rebuildFormulas,
} from './charbonniers.js';
import {
  listContracts, getContract, getStock, createContract, deliverContract, cancelContract, isOpen,
} from './contrats.js';
import * as ui from './ui.js';

// ---------- Définitions ----------

const addQtyOptions = (b) => {
  for (const p of PRODUCTS) {
    b.addIntegerOption((o) => o.setName(p.code.toLowerCase()).setDescription(`Quantité de ${p.name} (${p.code})`).setMinValue(0));
  }
  return b;
};
const weekOption = (o) => o.setName('semaine').setDescription('Semaine, ex : 2026-S40 ou 40 (par défaut : semaine en cours)');
const memberOption = (o) => o.setName('membre').setDescription('(Staff) Le charbonnier concerné');
const contractIdOption = (o) => o.setName('id').setDescription('ID du contrat (ex : CT-001)').setRequired(true).setAutocomplete(true);

export const commandDefs = [
  addQtyOptions(new SlashCommandBuilder().setName('depot').setDescription('Déclarer un dépôt de charbon'))
    .addStringOption((o) => o.setName('note').setDescription('Remarque (optionnel)'))
    .addUserOption(memberOption),

  new SlashCommandBuilder().setName('annuler-depot').setDescription('Annuler un dépôt (par défaut : ton dernier dépôt fait via Discord)')
    .addStringOption((o) => o.setName('ref').setDescription('Référence du dépôt (affichée sous la confirmation)'))
    .addUserOption(memberOption),

  new SlashCommandBuilder().setName('recap').setDescription('Voir ses dépôts et son salaire de la semaine')
    .addStringOption(weekOption)
    .addUserOption(memberOption),

  new SlashCommandBuilder().setName('stock').setDescription('Voir le stock et ce qu\'il reste à produire pour les contrats'),

  new SlashCommandBuilder().setName('salaires').setDescription('Salaires de tous les charbonniers pour une semaine')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(weekOption),

  new SlashCommandBuilder().setName('contrat').setDescription('Gestion des contrats de vente')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => addQtyOptions(
      s.setName('creer').setDescription('Créer un contrat')
        .addStringOption((o) => o.setName('client').setDescription('Nom du client').setRequired(true))
        .addStringOption((o) => o.setName('tarif').setDescription('Grille de prix').setRequired(true)
          .addChoices({ name: TARIFS.normal, value: TARIFS.normal }, { name: TARIFS.chatelerie, value: TARIFS.chatelerie })),
    ).addStringOption((o) => o.setName('note').setDescription('Remarque (optionnel)')))
    .addSubcommand((s) => addQtyOptions(
      s.setName('livrer').setDescription('Livrer depuis le stock (sans quantité : livre le maximum possible)').addStringOption(contractIdOption),
    ))
    .addSubcommand((s) => s.setName('voir').setDescription('Détail d\'un contrat').addStringOption(contractIdOption))
    .addSubcommand((s) => s.setName('liste').setDescription('Contrats en cours'))
    .addSubcommand((s) => s.setName('annuler').setDescription('Annuler un contrat').addStringOption(contractIdOption)),

  new SlashCommandBuilder().setName('charbonnier').setDescription('Gestion des charbonniers')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('ajouter').setDescription('Ajouter un charbonnier (crée son salon et son onglet)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true))
      .addStringOption((o) => o.setName('nom').setDescription('Nom affiché / nom de l\'onglet (par défaut : pseudo serveur)'))
      .addChannelOption((o) => o.setName('salon').setDescription('Utiliser un salon existant au lieu d\'en créer un').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('retirer').setDescription('Désactiver un charbonnier (son onglet et son historique sont conservés)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Liste des charbonniers')),

  new SlashCommandBuilder().setName('setup').setDescription('(Ré)initialiser la structure du Google Sheet')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ---------- Helpers ----------

const EPHEMERAL = new Set(['salaires', 'setup', 'charbonnier']);

export const isStaff = (member) =>
  member?.permissions?.has(PermissionFlagsBits.ManageGuild) || (env.staffRoleId && member?.roles?.cache?.has(env.staffRoleId));

function readQty(i) {
  const qty = emptyQty();
  for (const code of CODES) qty[code] = i.options.getInteger(code.toLowerCase()) ?? 0;
  return qty;
}

function resolveCharbonnier(i) {
  const membre = i.options.getUser('membre');
  if (membre) {
    if (!isStaff(i.member)) throw new UserError('Seul le staff peut agir pour un autre charbonnier.');
    const c = findByUser(membre.id);
    if (!c) throw new UserError(`<@${membre.id}> n'est pas enregistré comme charbonnier.`);
    return c;
  }
  const c = findByChannel(i.channelId) ?? findByUser(i.user.id);
  if (!c) throw new UserError('Tu n\'es pas enregistré comme charbonnier. Demande au staff de t\'ajouter avec `/charbonnier ajouter`.');
  return c;
}

function weekFrom(i) {
  const week = normalizeWeek(i.options.getString('semaine'));
  if (!week) throw new UserError('Semaine invalide. Format attendu : `2026-S40` ou `40`.');
  return week;
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'charbonnier';

// ---------- Handlers ----------

/** Enregistre un dépôt et renvoie l'embed de confirmation (partagé avec les messages texte). */
export async function depositAndEmbed(c, qty, note) {
  const res = await recordDeposit(c, qty, { source: 'Discord', note });
  const weekSum = await weekSummary(c, res.week);
  return ui.depositEmbed({ c, qty, montant: rachatValue(qty), ref: res.ref, week: res.week, weekSum, title: '✅ Dépôt enregistré' });
}

const handlers = {
  async depot(i) {
    const c = resolveCharbonnier(i);
    const qty = readQty(i);
    if (!hasQty(qty)) throw new UserError('Indique au moins une quantité (`cp`, `c`, `bc` ou `co`).');
    const note = i.options.getString('note');
    const embed = await depositAndEmbed(c, qty, `${i.user.username}${note ? ` : ${note}` : ''}`);
    await i.editReply({ embeds: [embed] });
    if (c.channelId && c.channelId !== i.channelId) {
      const ch = await i.client.channels.fetch(c.channelId).catch(() => null);
      await ch?.send({ content: `Dépôt déclaré par <@${i.user.id}> :`, embeds: [embed] }).catch(() => {});
    }
  },

  async 'annuler-depot'(i) {
    const c = resolveCharbonnier(i);
    if (c.discordId !== i.user.id && !isStaff(i.member)) throw new UserError('Tu ne peux annuler que tes propres dépôts.');
    const d = await deleteDeposit(c, i.options.getString('ref'));
    await i.editReply({
      embeds: [ui.depositEmbed({
        c, qty: d.qty, montant: d.montant, ref: d.ref, week: d.week || '?',
        weekSum: await weekSummary(c, d.week || weekLabel()), title: '🗑️ Dépôt annulé', color: ui.COLORS.warn,
      })],
    });
  },

  async recap(i) {
    const c = resolveCharbonnier(i);
    const week = weekFrom(i);
    await i.editReply({ embeds: [ui.recapEmbed(c, week, await weekSummary(c, week))] });
  },

  async stock(i) {
    await i.editReply({ embeds: [ui.stockEmbed(await getStock())] });
  },

  async salaires(i) {
    const week = weekFrom(i);
    await i.editReply({ embeds: [ui.salairesEmbed(week, await salariesForWeek(week))] });
  },

  async contrat(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'creer') {
      const qty = readQty(i);
      if (!hasQty(qty)) throw new UserError('Indique au moins une quantité commandée.');
      const ct = await createContract({
        client: i.options.getString('client', true).slice(0, 100),
        tarif: i.options.getString('tarif', true),
        qty,
        note: i.options.getString('note') ?? '',
      });
      await i.editReply({ content: `Contrat **${ct.id}** créé.`, embeds: [ui.contractEmbed(ct, await getStock())] });
    } else if (sub === 'livrer') {
      const qty = readQty(i);
      const { contract, delivered, stock } = await deliverContract(i.options.getString('id', true), hasQty(qty) ? qty : null, i.user.username);
      if (!delivered) {
        await i.editReply({ content: '⚠️ Rien n\'a pu être livré : le stock est insuffisant pour ce contrat.', embeds: [ui.contractEmbed(contract, stock)] });
        return;
      }
      await i.editReply({
        content: `🚚 Livraison enregistrée pour **${contract.id}** : ${ui.qtyInline(delivered)} (${ui.money(venteValue(delivered, contract.tarif))})`,
        embeds: [ui.contractEmbed(contract, stock)],
      });
    } else if (sub === 'voir') {
      const ct = await getContract(i.options.getString('id', true));
      if (!ct) throw new UserError('Contrat introuvable.');
      await i.editReply({ embeds: [ui.contractEmbed(ct, await getStock())] });
    } else if (sub === 'liste') {
      const [contracts, stock] = await Promise.all([listContracts(), getStock()]);
      const open = contracts.filter(isOpen);
      if (!open.length) {
        await i.editReply({ content: 'Aucun contrat en cours.', embeds: [ui.stockEmbed(stock)] });
        return;
      }
      await i.editReply({ embeds: [...open.slice(0, 9).map((ct) => ui.contractEmbed(ct, stock)), ui.stockEmbed(stock)] });
    } else if (sub === 'annuler') {
      const ct = await cancelContract(i.options.getString('id', true));
      await i.editReply({ content: `Contrat **${ct.id}** annulé.`, embeds: [ui.contractEmbed(ct)] });
    }
  },

  async charbonnier(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'ajouter') {
      const user = i.options.getUser('membre', true);
      const member = await i.guild.members.fetch(user.id);
      const name = (i.options.getString('nom') ?? member.displayName).trim();
      try {
        validateName(name);
      } catch (e) {
        throw new UserError(`${e.message}\nPrécise un nom avec l'option \`nom\`.`);
      }
      let channel = i.options.getChannel('salon');
      if (!channel) {
        const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
        channel = await i.guild.channels.create({
          name: `charbon-${slug(name)}`,
          type: ChannelType.GuildText,
          parent: env.categoryId ?? undefined,
          topic: `Dépôts de charbon de ${name}`,
          permissionOverwrites: [
            { id: i.guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, type: OverwriteType.Member, allow },
            { id: i.client.user.id, type: OverwriteType.Member, allow: [...allow, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions] },
            ...(env.staffRoleId ? [{ id: env.staffRoleId, type: OverwriteType.Role, allow }] : []),
          ],
        }).catch((e) => {
          throw new UserError(`Impossible de créer le salon (le bot a-t-il les permissions « Gérer les salons » et « Gérer les rôles » ?) : ${e.message}`);
        });
      }
      const c = await addCharbonnier({ name, discordId: user.id, channelId: channel.id });
      await channel.send({ content: `<@${user.id}>`, embeds: [ui.welcomeEmbed(c)] }).catch(() => {});
      await i.editReply(`✅ **${c.name}** ajouté : salon <#${channel.id}>, onglet « ${c.tab} » dans le Google Sheet.`);
    } else if (sub === 'retirer') {
      const user = i.options.getUser('membre', true);
      const c = findByUser(user.id);
      if (!c) throw new UserError(`<@${user.id}> n'est pas un charbonnier actif.`);
      await deactivateCharbonnier(c);
      await i.editReply(`**${c.name}** est désactivé. Son onglet et son salon sont conservés (supprime le salon à la main si besoin).`);
    } else if (sub === 'liste') {
      const lines = allCharbonniers().map((c) =>
        `${c.actif ? '🟢' : '⚫'} **${c.name}** — ${c.discordId ? `<@${c.discordId}>` : '?'} · ${c.channelId ? `<#${c.channelId}>` : 'pas de salon'}`);
      await i.editReply(lines.join('\n') || 'Aucun charbonnier enregistré.');
    }
  },

  async setup(i) {
    const created = await ensureStructure();
    await loadRegistry();
    await loadPrices();
    await rebuildFormulas();
    await i.editReply(created.length ? `✅ Onglets créés : ${created.join(', ')}. Formules mises à jour.` : '✅ Structure déjà en place. Formules mises à jour.');
  },
};

// ---------- Autocomplete ----------

let contractCache = { at: 0, list: [] };
async function autocomplete(i) {
  if (Date.now() - contractCache.at > 15000) contractCache = { at: Date.now(), list: await listContracts() };
  const sub = i.options.getSubcommand(false);
  const typed = String(i.options.getFocused() ?? '').toLowerCase();
  const choices = contractCache.list
    .filter((ct) => sub === 'voir' || isOpen(ct))
    .filter((ct) => `${ct.id} ${ct.client}`.toLowerCase().includes(typed))
    .slice(-25)
    .reverse()
    .map((ct) => ({ name: `${ct.id} — ${ct.client} (${ct.statut || '?'})`.slice(0, 100), value: ct.id }));
  await i.respond(choices);
}

// ---------- Point d'entrée ----------

export async function handleInteraction(i) {
  if (i.isAutocomplete()) return autocomplete(i).catch(() => i.respond([]).catch(() => {}));
  if (!i.isChatInputCommand()) return;
  const handler = handlers[i.commandName];
  if (!handler) return;
  try {
    await i.deferReply(EPHEMERAL.has(i.commandName) ? { flags: MessageFlags.Ephemeral } : {});
    await handler(i);
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[/${i.commandName}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await (i.deferred || i.replied ? i.editReply({ content: '', embeds: [ui.errorEmbed(msg)] }) : i.reply({ embeds: [ui.errorEmbed(msg)], flags: MessageFlags.Ephemeral })).catch(() => {});
  }
}
