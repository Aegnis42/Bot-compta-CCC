import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags,
} from 'discord.js';
import { env, PRODUCTS, CODES, TARIFS } from './config.js';
import { UserError, emptyQty, hasQty } from './utils.js';
import { normalizeWeek, weekLabel } from './time.js';
import { rachatValue, contractValue } from './prices.js';
import { scheduleStockRefresh } from './stockChannels.js';
import { sendPayNotices } from './sync.js';
import { recordPurchase, recordFood } from './achats.js';
import { listRecurring, stopRecurring } from './recurrents.js';
import { lastWeeks } from './historique.js';
import {
  addCharbonnierFlow, removeCharbonnierFlow, charbonniersList, setupFlow, stockSalonsFlow, depositAndEmbed,
} from './actions.js';
import { handlePanelInteraction, schedulePanelRefresh } from './panel.js';
import { isStaff } from './access.js';
import { handleDepositMenu } from './depositMenu.js';
import {
  findByChannel, findByUser, setCitizenship, recordDeposit, deleteDeposit, weekSummary, salariesForWeek,
} from './charbonniers.js';
import {
  listContracts, getContract, getStock, createContract, deliverContract, cancelContract, setContractPrices, isOpen,
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
const addPriceOptions = (b) => {
  for (const p of PRODUCTS) {
    b.addNumberOption((o) => o.setName(`prix_${p.code.toLowerCase()}`).setDescription(`Prix perso du ${p.name} par unité (vide = tarif, 0 = retirer)`).setMinValue(0));
  }
  return b;
};
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
    .addSubcommand((s) => addPriceOptions(addQtyOptions(
      s.setName('creer').setDescription('Créer un contrat')
        .addStringOption((o) => o.setName('client').setDescription('Nom du client').setRequired(true))
        .addStringOption((o) => o.setName('tarif').setDescription('Grille de prix').setRequired(true)
          .addChoices({ name: TARIFS.normal, value: TARIFS.normal }, { name: TARIFS.chatelerie, value: TARIFS.chatelerie })),
    )).addStringOption((o) => o.setName('note').setDescription('Remarque (optionnel)'))
      .addBooleanOption((o) => o.setName('hebdomadaire').setDescription('Se répète chaque semaine (recréé automatiquement le lundi)')))
    .addSubcommand((s) => addQtyOptions(
      s.setName('livrer').setDescription('Livrer depuis le stock (sans quantité : livre le maximum possible)').addStringOption(contractIdOption),
    ))
    .addSubcommand((s) => addPriceOptions(
      s.setName('prix').setDescription('Fixer un prix perso par type de charbon (0 = revenir au tarif)').addStringOption(contractIdOption),
    ))
    .addSubcommand((s) => s.setName('voir').setDescription('Détail d\'un contrat').addStringOption(contractIdOption))
    .addSubcommand((s) => s.setName('liste').setDescription('Contrats en cours'))
    .addSubcommand((s) => s.setName('annuler').setDescription('Annuler un contrat').addStringOption(contractIdOption)),

  addQtyOptions(new SlashCommandBuilder().setName('achat').setDescription('Enregistrer du charbon acheté ailleurs qu\'à nos charbonniers (entre dans le stock)')
    .addStringOption((o) => o.setName('fournisseur').setDescription('Chez qui le charbon a été acheté').setRequired(true))
    .addNumberOption((o) => o.setName('prix').setDescription(`Prix total payé (${env.currency})`).setRequired(true).setMinValue(0)))
    .addStringOption((o) => o.setName('contrat').setDescription('Contrat pour lequel ce charbon a été acheté (optionnel)').setAutocomplete(true))
    .addStringOption((o) => o.setName('note').setDescription('Remarque (optionnel)')),

  new SlashCommandBuilder().setName('nourriture').setDescription('Enregistrer un contrat nourriture (déduit du bénéfice de la semaine)')
    .addNumberOption((o) => o.setName('montant').setDescription(`Montant payé (${env.currency})`).setRequired(true).setMinValue(0))
    .addStringOption((o) => o.setName('note').setDescription('Remarque (optionnel)'))
    .addBooleanOption((o) => o.setName('hebdomadaire').setDescription('Se répète chaque semaine (recréé automatiquement le lundi)')),

  new SlashCommandBuilder().setName('historique').setDescription('Chiffres des dernières semaines terminées (onglet Historique)')
    .addIntegerOption((o) => o.setName('semaines').setDescription('Nombre de semaines à afficher (6 par défaut)').setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder().setName('recurrents').setDescription('Contrats hebdomadaires (ventes et nourriture)')
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les contrats qui se répètent chaque semaine'))
    .addSubcommand((s) => s.setName('arreter').setDescription('Arrêter la répétition d\'un contrat')
      .addStringOption((o) => o.setName('id').setDescription('CT-… ou NR-…').setRequired(true).setAutocomplete(true))),

  new SlashCommandBuilder().setName('charbonnier').setDescription('Gestion des charbonniers')
    .addSubcommand((s) => s.setName('ajouter').setDescription('Ajouter un charbonnier (crée son salon et son onglet)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true))
      .addStringOption((o) => o.setName('nom').setDescription('Nom affiché / nom de l\'onglet (par défaut : pseudo serveur)'))
      .addChannelOption((o) => o.setName('salon').setDescription('Utiliser un salon existant au lieu d\'en créer un').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('retirer').setDescription('Désactiver un charbonnier (son onglet et son historique sont conservés)')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true)))
    .addSubcommand((s) => s.setName('citoyennete').setDescription('Payer ou non la citoyenneté à un charbonnier quand il fournit du charbon')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre Discord').setRequired(true))
      .addBooleanOption((o) => o.setName('payer').setDescription('True = on lui paie la citoyenneté, False = non').setRequired(true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Liste des charbonniers')),

  new SlashCommandBuilder().setName('setup').setDescription('Initialiser le bot : Google Sheet + catégorie des salons charbonniers')
    .addStringOption((o) => o.setName('categorie').setDescription('Nom de la catégorie où mettre les salons des charbonniers (créée si besoin)').setMaxLength(100)),
].map((c) => c.toJSON());

// ---------- Helpers ----------

const EPHEMERAL = new Set(['avis-paie', 'salaires', 'setup', 'charbonnier', 'stock-salons']);

export { isStaff };

// Commandes réservées au staff (vérifiées par le bot avant exécution)
const STAFF_COMMANDS = new Set(['achat', 'nourriture', 'recurrents', 'historique', 'stock-salons', 'avis-paie', 'salaires', 'contrat', 'charbonnier', 'setup']);

/** Prix perso saisis dans la commande : { CP: 0.9, ... } (seulement les options renseignées). */
function readPrices(i) {
  const prices = {};
  for (const code of CODES) {
    const v = i.options.getNumber(`prix_${code.toLowerCase()}`);
    if (v !== null) prices[code] = v;
  }
  return prices;
}

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

// ---------- Handlers ----------

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
    await i.editReply(await stockSalonsFlow({
      guild: i.guild, client: i.client, name: i.options.getString('categorie'), role: i.options.getRole('role'),
    }));
  },

  async 'avis-paie'(i) {
    const week = weekFrom(i);
    const sent = await sendPayNotices(i.client, week);
    await i.editReply(sent ? `✅ ${sent} avis de paie envoyé(s) pour la semaine du ${week}.` : `Aucun charbonnier n'a de salaire pour la semaine du ${week}.`);
  },

  async achat(i) {
    const qty = readQty(i);
    if (!hasQty(qty)) throw new UserError('Indique au moins une quantité achetée (`cp`, `c`, `bc` ou `co`).');
    const prix = i.options.getNumber('prix', true);
    const { contract } = await recordPurchase({
      fournisseur: i.options.getString('fournisseur', true).slice(0, 100),
      qty,
      prix,
      contrat: i.options.getString('contrat'),
      par: i.user.username,
      note: i.options.getString('note') ?? '',
    });
    scheduleStockRefresh();
    const lines = [`🛒 Achat enregistré : ${ui.qtyInline(qty)} pour **${ui.money(prix)}** chez **${i.options.getString('fournisseur', true)}**. Ajouté au stock.`];
    const embeds = [];
    if (contract) {
      lines.push(`Rattaché au contrat **${contract.id}** : son coût matériaux tient compte de ce prix.`);
      embeds.push(ui.contractEmbed(contract, await getStock()));
    }
    await i.editReply({ content: lines.join('\n'), embeds });
  },

  async nourriture(i) {
    const montant = i.options.getNumber('montant', true);
    const hebdo = i.options.getBoolean('hebdomadaire') ?? false;
    const { id } = await recordFood({ montant, note: i.options.getString('note') ?? '', par: i.user.username, hebdo });
    await i.editReply(`🍖 Contrat nourriture **${id}** enregistré : **${ui.money(montant)}**, déduit du bénéfice de la semaine (récap Feuille 1).`
      + (hebdo ? '\n🔁 Hebdomadaire : il sera recréé chaque lundi (`/recurrents arreter` pour l\'arrêter).' : ''));
  },

  async historique(i) {
    const weeks = await lastWeeks(i.options.getInteger('semaines') ?? 6);
    await i.editReply({ embeds: [ui.historiqueEmbed(weeks)] });
  },

  async recurrents(i) {
    if (i.options.getSubcommand() === 'arreter') {
      await i.editReply(await stopRecurring(i.options.getString('id', true)));
      return;
    }
    const { contracts, food } = await listRecurring();
    const lines = [
      ...contracts.map((ct) => `📜 **${ct.id}** — ${ct.client} : ${ui.qtyInline(ct.cmd)} · ${ui.money(ct.montant)} · 📈 ${ui.money(ct.benefice)}`),
      ...food.map((f) => `🍖 **${f.id}** — nourriture : ${ui.money(f.montant)}${f.note ? ` (${f.note})` : ''}`),
    ];
    await i.editReply(lines.length
      ? `🔁 **Contrats hebdomadaires** (recréés chaque lundi) :\n${lines.join('\n')}`
      : 'Aucun contrat hebdomadaire. Utilise l\'option `hebdomadaire` de `/contrat creer` ou `/nourriture`.');
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
        prices: readPrices(i),
        note: i.options.getString('note') ?? '',
        hebdo: i.options.getBoolean('hebdomadaire') ?? false,
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
        content: `🚚 Livraison enregistrée pour **${contract.id}** : ${ui.qtyInline(delivered)} (${ui.money(contractValue(delivered, contract))})`,
        embeds: [ui.contractEmbed(contract, stock)],
      });
    } else if (sub === 'prix') {
      const prices = readPrices(i);
      if (!Object.keys(prices).length) throw new UserError('Indique au moins un prix (`prix_cp`, `prix_c`, `prix_bc` ou `prix_co`).');
      const ct = await setContractPrices(i.options.getString('id', true), prices);
      await i.editReply({ content: `Prix du contrat **${ct.id}** mis à jour.`, embeds: [ui.contractEmbed(ct, await getStock())] });
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
      await i.editReply(await addCharbonnierFlow({
        guild: i.guild, client: i.client, user: i.options.getUser('membre', true),
        name: i.options.getString('nom'), channel: i.options.getChannel('salon'),
      }));
    } else if (sub === 'retirer') {
      await i.editReply(await removeCharbonnierFlow(i.options.getUser('membre', true)));
    } else if (sub === 'citoyennete') {
      const user = i.options.getUser('membre', true);
      const payer = i.options.getBoolean('payer', true);
      const c = findByUser(user.id);
      if (!c) throw new UserError(`<@${user.id}> n'est pas un charbonnier actif.`);
      await setCitizenship(c, payer);
      await i.editReply(payer
        ? `🏛️ **${c.name}** : la citoyenneté lui est payée les semaines où il fournit du charbon.`
        : `🚫 **${c.name}** : la citoyenneté ne lui est plus payée (il ne compte plus dans le récap).`);
    } else if (sub === 'liste') {
      await i.editReply(charbonniersList());
    }
  },

  async setup(i) {
    await i.editReply(await setupFlow({ guild: i.guild, client: i.client, categoryName: i.options.getString('categorie') }));
  },
};

// ---------- Autocomplete ----------

let contractCache = { at: 0, list: [] };
async function autocomplete(i) {
  if (i.commandName === 'recurrents') {
    const typed = String(i.options.getFocused() ?? '').toLowerCase();
    const { contracts, food } = await listRecurring();
    const items = [
      ...contracts.map((ct) => ({ name: `${ct.id} — ${ct.client}`, value: ct.id })),
      ...food.map((f) => ({ name: `${f.id} — nourriture ${ui.money(f.montant)}${f.note ? ` (${f.note})` : ''}`, value: f.id })),
    ];
    await i.respond(items.filter((x) => x.name.toLowerCase().includes(typed)).slice(0, 25).map((x) => ({ ...x, name: x.name.slice(0, 100) })));
    return;
  }
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
  if (i.isAutocomplete()) {
    if (STAFF_COMMANDS.has(i.commandName) && !isStaff(i.member)) return i.respond([]).catch(() => {});
    return autocomplete(i).catch(() => i.respond([]).catch(() => {}));
  }
  if (await handlePanelInteraction(i)) return;
  if (await handleDepositMenu(i)) return;
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
    if (STAFF_COMMANDS.has(i.commandName)) schedulePanelRefresh();
  } catch (e) {
    if (!(e instanceof UserError)) console.error(`[/${i.commandName}]`, e);
    const msg = e instanceof UserError ? e.message : `Erreur inattendue : ${e.message}`;
    await (i.deferred || i.replied ? i.editReply({ content: '', embeds: [ui.errorEmbed(msg)] }) : i.reply({ embeds: [ui.errorEmbed(msg)], flags: MessageFlags.Ephemeral })).catch(() => {});
  }
}
