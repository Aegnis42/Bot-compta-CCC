import { ChannelType, OverwriteType, PermissionFlagsBits as P } from 'discord.js';
import { env, PRODUCTS } from './config.js';
import { getStock } from './contrats.js';
import { getSetting, setSetting } from './settings.js';

// Catégorie privée avec un salon vocal par marchandise, dont le nom affiche le stock : "Charbon | 3200".
// Discord limite les renommages à 2 par 10 minutes et par salon : on renomme au plus toutes les 5 minutes.
const CAT_KEY = 'stock_categorie';
const chanKey = (code) => `stock_salon_${code}`;
const RENAME_DELAY = 5 * 60 * 1000;
const lastRename = new Map();

const channelName = (p, stock) => `${p.name} | ${Math.round(stock[p.code]?.stock ?? 0)}`;

async function fetchChannel(guild, id, type) {
  if (!id) return null;
  const ch = await guild.channels.fetch(id).catch(() => null);
  return ch?.type === type ? ch : null;
}

/** Crée (ou complète) la catégorie Stock et ses salons vocaux, et y donne accès au rôle indiqué. */
export async function setupStockChannels(guild, botId, name, role) {
  let cat = await fetchChannel(guild, getSetting(CAT_KEY), ChannelType.GuildCategory)
    ?? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase());
  const created = [];

  if (!cat) {
    cat = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel, P.Connect] },
        { id: botId, type: OverwriteType.Member, allow: [P.ViewChannel, P.ManageChannels, P.Connect] },
        ...(env.staffRoleId ? [{ id: env.staffRoleId, type: OverwriteType.Role, allow: [P.ViewChannel], deny: [P.Connect] }] : []),
      ],
    });
    created.push(`catégorie **${cat.name}**`);
  } else if (cat.name !== name) {
    await cat.setName(name);
  }
  await setSetting(CAT_KEY, cat.id);
  if (role) await cat.permissionOverwrites.edit(role.id, { ViewChannel: true, Connect: false });

  const stock = await getStock();
  for (const p of PRODUCTS) {
    let ch = await fetchChannel(guild, getSetting(chanKey(p.code)), ChannelType.GuildVoice);
    if (!ch) {
      ch = await guild.channels.create({ name: channelName(p, stock), type: ChannelType.GuildVoice, parent: cat.id });
      lastRename.set(ch.id, Date.now());
      await setSetting(chanKey(p.code), ch.id);
      created.push(`salon **${ch.name}**`);
    } else {
      if (ch.parentId !== cat.id) await ch.setParent(cat.id);
      await ch.lockPermissions(); // mêmes accès que la catégorie
    }
  }
  return { cat, created };
}

/** Met à jour le nom des salons vocaux selon le stock (appelé régulièrement). */
export async function updateStockChannels(client) {
  if (!getSetting(CAT_KEY)) return;
  const guild = await client.guilds.fetch(env.guildId).catch(() => null);
  if (!guild) return;
  const stock = await getStock();
  for (const p of PRODUCTS) {
    const ch = await fetchChannel(guild, getSetting(chanKey(p.code)), ChannelType.GuildVoice);
    const name = channelName(p, stock);
    if (!ch || ch.name === name) continue;
    if (Date.now() - (lastRename.get(ch.id) ?? 0) < RENAME_DELAY) continue;
    lastRename.set(ch.id, Date.now());
    await ch.setName(name).catch((e) => console.warn(`[stock] renommage de ${ch.name} impossible :`, e.message));
  }
}
