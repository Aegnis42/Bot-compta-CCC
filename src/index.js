import { Client, Events, GatewayIntentBits } from 'discord.js';
import { env } from './config.js';
import { setupHint } from './sheets.js';
import { ensureStructure } from './setup.js';
import { loadRegistry, findByChannel } from './charbonniers.js';
import { loadPrices } from './prices.js';
import { loadSettings } from './settings.js';
import { parseQuantities } from './parse.js';
import { commandDefs, handleInteraction, depositAndEmbed } from './commands.js';
import { startSync } from './sync.js';
import * as ui from './ui.js';

if (!env.token) {
  console.error('❌ DISCORD_TOKEN manquant dans le fichier .env (voir .env.example)');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
  startSync(client);
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
  try {
    const embed = await depositAndEmbed(c, qty, `${msg.author.username} : ${msg.content}`);
    await msg.react('✅').catch(() => {});
    await msg.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch (e) {
    console.error('[message]', e);
    await msg.react('❌').catch(() => {});
    await msg.reply({ embeds: [ui.errorEmbed(`Dépôt non enregistré : ${e.message}`)] }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.Error, (e) => console.error('[discord]', e));

client.login(env.token);
