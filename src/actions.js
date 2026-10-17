import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { env } from './config.js';
import { UserError } from './utils.js';
import { ensureStructure } from './setup.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { loadPrices } from './prices.js';
import { setupStockChannels } from './stockChannels.js';
import {
  allCharbonniers, findByUser, addCharbonnier, deactivateCharbonnier, validateName, loadRegistry, rebuildFormulas,
} from './charbonniers.js';
import * as ui from './ui.js';

// Actions partagées par les commandes slash et le panneau de gestion.

export const CATEGORY_KEY = 'categorie_charbonniers';

/** Catégorie des salons charbonniers (réglée par /setup ou le panneau), si elle existe toujours. */
export async function charbonnierCategory(guild) {
  const id = getSetting(CATEGORY_KEY) ?? env.categoryId;
  if (!id) return null;
  const cat = await guild.channels.fetch(id).catch(() => null);
  return cat?.type === ChannelType.GuildCategory ? cat : null;
}

const staffOverwrites = (guild, botId) => [
  { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
  { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ...(env.staffRoleId ? [{ id: env.staffRoleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] }] : []),
];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'charbonnier';

/**
 * Ajoute un charbonnier : crée son salon privé (sauf si `channel` est fourni), son onglet, et poste l'accueil.
 * Un charbonnier déjà enregistré dont le salon n'existe plus est relié à un nouveau salon (historique conservé).
 */
export async function addCharbonnierFlow({ guild, client, user, name: wanted, channel }) {
  const member = await guild.members.fetch(user.id);
  const old = findByUser(user.id);
  const oldChannel = old?.channelId ? await guild.channels.fetch(old.channelId).catch(() => null) : null;
  if (old && oldChannel) throw new UserError(`<@${user.id}> est déjà enregistré (**${old.name}**, salon <#${oldChannel.id}>).`);
  if (old) await deactivateCharbonnier(old);
  const name = (old?.name ?? wanted ?? member.displayName).trim();
  try {
    validateName(name);
  } catch (e) {
    throw new UserError(`${e.message}\nPrécise un autre nom.`);
  }
  if (!channel) {
    const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    channel = await guild.channels.create({
      name: `charbon-${slug(name)}`,
      type: ChannelType.GuildText,
      parent: (await charbonnierCategory(guild))?.id,
      topic: `Dépôts de charbon de ${name}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, type: OverwriteType.Member, allow },
        { id: client.user.id, type: OverwriteType.Member, allow: [...allow, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions] },
        ...(env.staffRoleId ? [{ id: env.staffRoleId, type: OverwriteType.Role, allow }] : []),
      ],
    }).catch((e) => {
      throw new UserError(`Impossible de créer le salon (le bot a-t-il les permissions « Gérer les salons » et « Gérer les rôles » ?) : ${e.message}`);
    });
  }
  const c = await addCharbonnier({ name, discordId: user.id, channelId: channel.id });
  await channel.send({ content: `<@${user.id}>`, embeds: [ui.welcomeEmbed(c)] }).catch(() => {});
  return `✅ **${c.name}** ajouté : salon <#${channel.id}>, onglet « ${c.tab} » dans le Google Sheet.`;
}

export async function removeCharbonnierFlow(user) {
  const c = findByUser(user.id);
  if (!c) throw new UserError(`<@${user.id}> n'est pas un charbonnier actif.`);
  await deactivateCharbonnier(c);
  return `**${c.name}** est désactivé. Son onglet et son salon sont conservés (supprime le salon à la main si besoin).`;
}

export function charbonniersList() {
  const lines = allCharbonniers().map((c) =>
    `${c.actif ? '🟢' : '⚫'} **${c.name}** — ${c.discordId ? `<@${c.discordId}>` : '?'} · ${c.channelId ? `<#${c.channelId}>` : 'pas de salon'}`
    + `${c.citoyennete ? '' : ' · 🚫 citoyenneté non payée'}${c.bonus ? ` · bonus +${ui.fmt(c.bonus)}` : ''}`);
  return lines.join('\n') || 'Aucun charbonnier enregistré.';
}

/** Met à jour le Sheet et, si `categoryName` est donné, crée/règle la catégorie des salons charbonniers. */
export async function setupFlow({ guild, client, categoryName }) {
  const created = await ensureStructure();
  await loadRegistry();
  await loadPrices();
  await rebuildFormulas();
  await loadSettings();
  const lines = [created.length ? `✅ Onglets créés dans le Google Sheet : ${created.join(', ')}.` : '✅ Google Sheet déjà en place, formules mises à jour.'];

  const catName = categoryName?.trim();
  if (catName) {
    let cat = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === catName.toLowerCase());
    if (cat) {
      lines.push(`📁 Catégorie existante utilisée : **${cat.name}**.`);
    } else {
      cat = await guild.channels.create({ name: catName, type: ChannelType.GuildCategory, permissionOverwrites: staffOverwrites(guild, client.user.id) })
        .catch((e) => { throw new UserError(`Impossible de créer la catégorie (permission « Gérer les salons » ?) : ${e.message}`); });
      lines.push(`📁 Catégorie **${cat.name}** créée (privée).`);
    }
    await setSetting(CATEGORY_KEY, cat.id);

    // On range les salons des charbonniers déjà enregistrés (leurs permissions individuelles sont conservées)
    let moved = 0;
    for (const c of allCharbonniers().filter((x) => x.actif && x.channelId)) {
      const ch = await guild.channels.fetch(c.channelId).catch(() => null);
      if (ch && ch.parentId !== cat.id) {
        await ch.setParent(cat.id, { lockPermissions: false }).then(() => moved++).catch(() => {});
      }
    }
    if (moved) lines.push(`↪️ ${moved} salon(s) de charbonnier déplacé(s) dans la catégorie.`);
  } else {
    const cat = await charbonnierCategory(guild);
    lines.push(cat ? `📁 Catégorie des charbonniers : **${cat.name}**.` : 'ℹ️ Aucune catégorie réglée pour les salons des charbonniers.');
  }
  return lines.join('\n');
}

/** Crée/complète la catégorie Stock (salons vocaux + tableau) et y donne accès à `role`. */
export async function stockSalonsFlow({ guild, client, name, role }) {
  const { cat, created } = await setupStockChannels(guild, client.user.id, name?.trim() || 'Stock', role).catch((e) => {
    throw e instanceof UserError ? e : new UserError(`Impossible de créer les salons (permission « Gérer les salons » / « Gérer les rôles » ?) : ${e.message}`);
  });
  const lines = [created.length ? `✅ Créé : ${created.join(', ')}.` : `✅ Catégorie **${cat.name}** déjà en place.`];
  if (role) lines.push(`👁️ Le rôle ${role} peut voir le stock.`);
  lines.push('Seuls les rôles autorisés (et les admins) voient la catégorie.');
  return lines.join('\n');
}
