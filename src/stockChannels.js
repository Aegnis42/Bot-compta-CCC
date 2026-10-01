import { ChannelType, OverwriteType, PermissionFlagsBits as P } from 'discord.js';
import { env, PRODUCTS } from './config.js';
import { getStock, listContracts, isOpen } from './contrats.js';
import { getSetting, setSetting } from './settings.js';
import * as ui from './ui.js';

// Catégorie privée affichant le stock :
// - un salon vocal par marchandise dont le nom affiche le stock ("Charbon | 3200").
//   Discord n'autorise que 2 renommages par 10 minutes et par salon : au-delà, on réessaie quand Discord le permet.
// - un salon texte avec un tableau mis à jour instantanément (les modifications de message ne sont pas limitées).
const CAT_KEY = 'stock_categorie';
const BOARD_KEY = 'stock_tableau_salon';
const BOARD_MSG_KEY = 'stock_tableau_message';
const chanKey = (code) => `stock_salon_${code}`;

const nextRenameAt = new Map(); // salon → date à partir de laquelle Discord accepte un nouveau renommage
let lastBoard = null;
let clientRef = null;

const channelName = (p, stock) => `${p.name} | ${Math.round(stock[p.code]?.stock ?? 0)}`;

async function fetchChannel(guild, id, type) {
  if (!id) return null;
  const ch = await guild.channels.fetch(id).catch(() => null);
  return ch?.type === type ? ch : null;
}

/** Salon tableau en lecture seule : mêmes accès que la catégorie, mais personne n'y écrit sauf le bot. */
async function makeReadOnly(ch, cat, botId) {
  await ch.lockPermissions();
  for (const ow of cat.permissionOverwrites.cache.values()) {
    if (ow.id !== botId) await ch.permissionOverwrites.edit(ow.id, { SendMessages: false, AddReactions: false, CreatePublicThreads: false });
  }
  await ch.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true, EmbedLinks: true });
}

/** Crée (ou complète) la catégorie Stock et ses salons, et y donne accès au rôle indiqué. */
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

  // Tableau en direct
  let board = await fetchChannel(guild, getSetting(BOARD_KEY), ChannelType.GuildText);
  if (!board) {
    board = await guild.channels.create({ name: '📦-stock-en-direct', type: ChannelType.GuildText, parent: cat.id, position: 0 });
    await setSetting(BOARD_KEY, board.id);
    created.push(`salon **${board.name}**`);
  } else if (board.parentId !== cat.id) {
    await board.setParent(cat.id);
  }
  await makeReadOnly(board, cat, botId);

  // Salons vocaux
  const stock = await getStock();
  for (const p of PRODUCTS) {
    let ch = await fetchChannel(guild, getSetting(chanKey(p.code)), ChannelType.GuildVoice);
    if (!ch) {
      ch = await guild.channels.create({ name: channelName(p, stock), type: ChannelType.GuildVoice, parent: cat.id });
      await setSetting(chanKey(p.code), ch.id);
      created.push(`salon **${ch.name}**`);
    } else {
      if (ch.parentId !== cat.id) await ch.setParent(cat.id);
      await ch.lockPermissions(); // mêmes accès que la catégorie
    }
  }
  lastBoard = null;
  await updateStockChannels(guild.client);
  return { cat, created };
}

async function updateBoard(guild, stock) {
  const board = await fetchChannel(guild, getSetting(BOARD_KEY), ChannelType.GuildText);
  if (!board) return;
  const open = (await listContracts()).filter(isOpen);
  const embeds = [ui.stockEmbed(stock).setTitle('📦 Stock en direct')];
  if (open.length) {
    embeds.push(ui.contractsSummaryEmbed(open));
  }
  const key = JSON.stringify(embeds.map((e) => ({ ...e.toJSON(), timestamp: undefined })));
  if (key === lastBoard) return;

  const payload = { content: '', embeds };
  const msg = await board.messages.fetch(getSetting(BOARD_MSG_KEY) ?? '0').catch(() => null);
  if (msg) {
    await msg.edit(payload);
  } else {
    const sent = await board.send(payload);
    await setSetting(BOARD_MSG_KEY, sent.id);
  }
  lastBoard = key;
}

async function renameVoiceChannels(guild, stock) {
  for (const p of PRODUCTS) {
    const ch = await fetchChannel(guild, getSetting(chanKey(p.code)), ChannelType.GuildVoice);
    const name = channelName(p, stock);
    if (!ch || ch.name === name || Date.now() < (nextRenameAt.get(ch.id) ?? 0)) continue;
    try {
      await ch.setName(name);
    } catch (e) {
      if (e.name === 'RateLimitError' || e.retryAfter !== undefined) {
        // Limite Discord atteinte : on réessaiera quand elle sera levée
        const wait = Math.max(e.retryAfter ?? 0, e.sublimitTimeout ?? 0) || 5 * 60 * 1000;
        nextRenameAt.set(ch.id, Date.now() + wait);
        console.log(`[stock] ${p.name} : limite Discord, nouveau nom dans ${Math.ceil(wait / 60000)} min`);
      } else {
        console.warn(`[stock] renommage de ${ch.name} impossible :`, e.message);
      }
    }
  }
}

let running = null;
/** Met à jour le tableau et les noms des salons vocaux selon le stock. */
export async function updateStockChannels(client) {
  if (!getSetting(CAT_KEY)) return;
  if (running) return running;
  running = (async () => {
    const guild = await client.guilds.fetch(env.guildId).catch(() => null);
    if (!guild) return;
    const stock = await getStock();
    await updateBoard(guild, stock).catch((e) => console.warn('[stock] tableau :', e.message));
    await renameVoiceChannels(guild, stock);
  })().finally(() => {
    running = null;
  });
  return running;
}

export const setStockClient = (client) => {
  clientRef = client;
};

/** À appeler après un dépôt / une livraison : mise à jour quasi immédiate. */
let timer = null;
export function scheduleStockRefresh() {
  if (!clientRef) return;
  clearTimeout(timer);
  timer = setTimeout(() => updateStockChannels(clientRef).catch((e) => console.warn('[stock]', e.message)), 1500);
}
