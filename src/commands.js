import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, OverwriteType, MessageFlags,
} from 'discord.js';
import { env, PRODUCTS, CODES, TARIFS } from './config.js';
import { UserError, emptyQty, hasQty } from './utils.js';
import { normalizeWeek, weekLabel } from './time.js';
import { rachatValue, venteValue, loadPrices } from './prices.js';
import { ensureStructure } from './setup.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { setupStockChannels, scheduleStockRefresh } from './stockChannels.js';
import { sendPayNotices } from './sync.js';
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
const weekOption = (o) => o.setName('semaine').setDescription('Un jour de la semaine voulue, ex : 29/09 ou "derniere" (par défaut : semaine en cours)');
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

  new SlashCommandBuilder().setName('stock-salons').setDescription('Crée une catégorie privée affichant le stock en salons vocaux (ex : Charbon | 3200)')
    .addStringOption((o) => o.setName('categorie').setDescription('Nom de la catégorie (par défaut : Stock)').setMaxLength(100))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle qui pourra voir le stock (relancer la commande pour en ajouter d\'autres)')),

  new SlashCommandBuilder().setName('avis-paie').setDescription('Envoyer maintenant à chaque charbonnier son avis de paie (auto : dimanche 17h)')
    .addStringOption(weekOption),

  new SlashCommandBuilder().setName('salaires').setDescription('Salaires de tous les charbonniers pour une semaine')
    .addStringOption(weekOption),

  new SlashCommandBuilder().setName('contrat').setDescription('Gestion des contrats de vente')
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
    .addSubcommand((s) => s.setName('ajouter').setDescription('Ajouter un charbonnier (crée son salon et son onglet)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true))
      .addStringOption((o) => o.setName('nom').setDescription('Nom affiché / nom de l\'onglet (par défaut : pseudo serveur)'))
      .addChannelOption((o) => o.setName('salon').setDescription('Utiliser un salon existant au lieu d\'en créer un').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('retirer').setDescription('Désactiver un charbonnier (son onglet et son historique sont conservés)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Liste des charbonniers')),

  new SlashCommandBuilder().setName('setup').setDescription('Initialiser le bot : Google Sheet + catégorie des salons charbonniers')
    .addStringOption((o) => o.setName('categorie').setDescription('Nom de la catégorie où mettre les salons des charbonniers (créée si besoin)').setMaxLength(100)),
].map((c) => c.toJSON());

// ---------- Helpers ----------

const EPHEMERAL = new Set(['avis-paie', 'salaires', 'setup', 'charbonnier', 'stock-salons']);

/** Staff : admins du serveur (« Gérer le serveur »), rôle STAFF_ROLE_ID, ou compte listé dans adminIds. */
export const isStaff = (member) =>
  Boolean(
    env.adminIds.includes(member?.id ?? member?.user?.id)
      || member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || (env.staffRoleId && member?.roles?.cache?.has(env.staffRoleId)),
  );

// Commandes réservées au staff (vérifiées par le bot avant exécution)
const STAFF_COMMANDS = new Set(['stock-salons', 'avis-paie', 'salaires', 'contrat', 'charbonnier', 'setup']);

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
  if (!week) throw new UserError('Semaine invalide. Donne un jour de la semaine, ex : `29/09` ou `29/09/2026`, ou `derniere`.');
  return week;
}

/** Catégorie des salons charbonniers (réglée par /setup), si elle existe toujours. */
async function charbonnierCategory(guild) {
  const id = getSetting(CATEGORY_KEY) ?? env.categoryId;
  if (!id) return null;
  const cat = await guild.channels.fetch(id).catch(() => null);
  return cat?.type === ChannelType.GuildCategory ? cat : null;
}
const CATEGORY_KEY = 'categorie_charbonniers';

const staffOverwrites = (guild, botId) => [
  { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ...(env.staffRoleId ? [{ id: env.staffRoleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] }] : []),
];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'charbonnier';

// ---------- Handlers ----------

/** Enregistre un dépôt et renvoie l'embed de confirmation (partagé avec les messages texte). */
export async function depositAndEmbed(c, qty, note) {
  const res = await recordDeposit(c, qty, { source: 'Discord', note });
  scheduleStockRefresh();
  const weekSum = await weekSummary(c, res.week);
  return ui.depositEmbed({ c, qty, montant: rachatValue(qty, c.bonus), ref: res.ref, week: res.week, weekSum, title: '✅ Dépôt enregistré' });
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
    scheduleStockRefresh();
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

  async 'stock-salons'(i) {
    const role = i.options.getRole('role');
    const name = i.options.getString('categorie')?.trim() || 'Stock';
    const { cat, created } = await setupStockChannels(i.guild, i.client.user.id, name, role).catch((e) => {
      throw e instanceof UserError ? e : new UserError(`Impossible de créer les salons (permission « Gérer les salons » / « Gérer les rôles » ?) : ${e.message}`);
    });
    const lines = [created.length ? `✅ Créé : ${created.join(', ')}.` : `✅ Catégorie **${cat.name}** déjà en place.`];
    if (role) lines.push(`👁️ Le rôle ${role} peut voir le stock.`);
    lines.push('Seuls les rôles autorisés (et les admins) voient la catégorie. Pour ajouter un rôle : relance la commande avec `role`, ou modifie les permissions de la catégorie dans Discord.');
    lines.push('ℹ️ Discord limite les renommages : les chiffres se mettent à jour au plus toutes les 5 minutes.');
    await i.editReply(lines.join('\n'));
  },

  async 'avis-paie'(i) {
    const week = weekFrom(i);
    const sent = await sendPayNotices(i.client, week);
    await i.editReply(sent ? `✅ ${sent} avis de paie envoyé(s) pour la semaine du ${week}.` : `Aucun charbonnier n'a de salaire pour la semaine du ${week}.`);
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
      // Charbonnier déjà enregistré mais dont le salon n'existe plus ici (supprimé, ou créé sur un autre serveur) :
      // on le relie à un nouveau salon en gardant son nom, son onglet et son historique.
      const old = findByUser(user.id);
      const oldChannel = old?.channelId ? await i.guild.channels.fetch(old.channelId).catch(() => null) : null;
      if (old && oldChannel) throw new UserError(`<@${user.id}> est déjà enregistré (**${old.name}**, salon <#${oldChannel.id}>).`);
      if (old) await deactivateCharbonnier(old);
      const name = (old?.name ?? i.options.getString('nom') ?? member.displayName).trim();
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
          parent: (await charbonnierCategory(i.guild))?.id,
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
    await loadSettings();
    const lines = [created.length ? `✅ Onglets créés dans le Google Sheet : ${created.join(', ')}.` : '✅ Google Sheet déjà en place, formules mises à jour.'];

    const catName = i.options.getString('categorie')?.trim();
    if (catName) {
      let cat = i.guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === catName.toLowerCase());
      if (cat) {
        lines.push(`📁 Catégorie existante utilisée : **${cat.name}**.`);
      } else {
        cat = await i.guild.channels.create({ name: catName, type: ChannelType.GuildCategory, permissionOverwrites: staffOverwrites(i.guild, i.client.user.id) })
          .catch((e) => { throw new UserError(`Impossible de créer la catégorie (permission « Gérer les salons » ?) : ${e.message}`); });
        lines.push(`📁 Catégorie **${cat.name}** créée (privée).`);
      }
      await setSetting(CATEGORY_KEY, cat.id);

      // On range les salons des charbonniers déjà enregistrés (leurs permissions individuelles sont conservées)
      let moved = 0;
      for (const c of allCharbonniers().filter((x) => x.actif && x.channelId)) {
        const ch = await i.guild.channels.fetch(c.channelId).catch(() => null);
        if (ch && ch.parentId !== cat.id) {
          await ch.setParent(cat.id, { lockPermissions: false }).then(() => moved++).catch(() => {});
        }
      }
      if (moved) lines.push(`↪️ ${moved} salon(s) de charbonnier déplacé(s) dans la catégorie.`);
    } else {
      const cat = await charbonnierCategory(i.guild);
      lines.push(cat ? `📁 Catégorie des charbonniers : **${cat.name}**.` : 'ℹ️ Aucune catégorie réglée : ajoute l\'option `categorie` pour en créer une.');
    }
    lines.push('Ajoute ensuite tes charbonniers avec `/charbonnier ajouter`.');
    await i.editReply(lines.join('\n'));
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
  // Le bot ne fonctionne que sur le serveur de la CCC (ni en message privé, ni ailleurs)
  if (i.guildId !== env.guildId) {
    if (i.isRepliable()) await i.reply({ content: 'Ce bot ne fonctionne que sur le serveur de la CCC.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (i.isAutocomplete()) return autocomplete(i).catch(() => i.respond([]).catch(() => {}));
  if (!i.isChatInputCommand()) return;
  const handler = handlers[i.commandName];
  if (!handler) return;
  try {
    if (STAFF_COMMANDS.has(i.commandName) && !isStaff(i.member)) {
      await i.reply({ embeds: [ui.errorEmbed('Cette commande est réservée au staff.')], flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply(EPHEMERAL.has(i.commandName) ? { flags: MessageFlags.Ephemeral } : {});
    await handler(i);
    if (i.commandName === 'contrat') scheduleStockRefresh();
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[/${i.commandName}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await (i.deferred || i.replied ? i.editReply({ content: '', embeds: [ui.errorEmbed(msg)] }) : i.reply({ embeds: [ui.errorEmbed(msg)], flags: MessageFlags.Ephemeral })).catch(() => {});
  }
}
