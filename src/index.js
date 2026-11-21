import { Client, Events, GatewayIntentBits } from 'discord.js';
import { env } from './config.js';
import { setupHint } from './sheets.js';
import { ensureStructure } from './setup.js';
import { loadRegistry, findByChannel } from './charbonniers.js';
import { loadPrices } from './prices.js';
import { loadSettings } from './settings.js';
import { parseQuantities } from './parse.js';
import { commandDefs, handleInteraction } from './commands.js';
import { depositAndEmbed } from './actions.js';
import { ensureAllDepositMenus, bumpDepositMenu } from './depositMenu.js';
import { startSync } from './sync.js';
import { setStockClient } from './stockChannels.js';
import * as ui from './ui.js';
import { UserError } from './utils.js';

if (!env.token) {
  console.error('❌ DISCORD_TOKEN manquant dans le fichier .env (voir .env.example)');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // Renommer un salon est limité par Discord (2 fois / 10 min) : on préfère une erreur immédiate à une attente silencieuse
  rest: { rejectOnRateLimit: (d) => d.method === 'PATCH' && d.route.startsWith('/channels/') },
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Connecté en tant que ${c.user.tag}`);
  try {
    const created = await ensureStructure();
    if (created.length) console.log(`Onglets créés dans le Google Sheet : ${created.join(', ')}`);
    await loadRegistry();
    await loadPrices();
    await loadSettings();
  } catch (e) {
    console.error(`❌ Accès au Google Sheet impossible : ${e.message}`);
    console.error(`   → ${setupHint()}`);
    process.exit(1);
  }
  const guild = await c.guilds.fetch(env.guildId).catch(() => null);
  if (!guild) {
    console.error(`❌ Le bot n'est pas sur le serveur ${env.guildId}. Invite-le avec :`);
    console.error(`   https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot%20applications.commands&permissions=268520528`);
    process.exit(1);
  }
  await guild.commands.set(commandDefs);
  console.log(`${commandDefs.length} commandes enregistrées sur « ${guild.name} »`);
  // Sur les autres serveurs où le bot serait présent : retirer ses commandes (il n'y fonctionne pas)
  for (const other of (await c.guilds.fetch()).values()) {
    if (other.id === env.guildId) continue;
    const g = await other.fetch().catch(() => null);
    await g?.commands.set([]).then(() => console.log(`Commandes retirées du serveur « ${g.name} » (non autorisé)`)).catch(() => {});
  }
  setStockClient(client);
  startSync(client);
  ensureAllDepositMenus(client).catch((e) => console.warn('[menu]', e.message));
});

// Dépôt déclaré par simple message dans le salon d'un charbonnier
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || msg.guildId !== env.guildId) return;
  const c = findByChannel(msg.channelId);
  // Seuls les messages du charbonnier lui-même comptent (le staff peut discuter librement, et utilise /depot membre:)
  if (!c || msg.author.id !== c.discordId) return;

  const qty = parseQuantities(msg.content);
  if (!qty) {
    if (/^\s*\d+\s*$/.test(msg.content)) {
      await msg.reply('Précise le type : `CP` (charbon pauvre), `C` (charbon), `BC` (briquette) ou `CO` (coke). Ex : `300 CP`').catch(() => {});
    }
    return;
  }
  // ⏳ tout de suite : le charbonnier voit que son dépôt est pris en compte (l'écriture dans le Sheet peut prendre
  // quelques secondes) et ne le renvoie pas une seconde fois.
  await msg.react('⏳').catch(() => {});
  const doneWaiting = () => msg.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
  // Répond au message ; s'il a été supprimé entre-temps, la réponse est postée normalement dans le salon
  const answer = (payload) => msg.reply({ ...payload, allowedMentions: { repliedUser: false }, failIfNotExists: false })
    .catch((e) => console.warn(`[message] réponse impossible dans le salon de ${c.name} :`, e.message));

  let embed;
  try {
    embed = await depositAndEmbed(c, qty, `${msg.author.username} : ${msg.content}`);
  } catch (e) {
    if (!(e instanceof UserError)) console.error('[message]', e);
    await doneWaiting();
    await msg.react(e instanceof UserError ? '🔒' : '❌').catch(() => {});
    await answer({ embeds: [ui.errorEmbed(e instanceof UserError ? e.message : `Dépôt non enregistré : ${e.message}`)] });
    return;
  }
  // Dépôt enregistré : un problème d'affichage ne doit plus être présenté comme un échec du dépôt
  await doneWaiting();
  await msg.react('✅').catch(() => {});
  await answer({ embeds: [embed] });
  bumpDepositMenu(client, c);
});

client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.Error, (e) => console.error('[discord]', e));

client.login(env.token);
