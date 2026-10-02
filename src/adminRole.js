import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { env } from './config.js';
import { getSetting, setSetting } from './settings.js';

// Rôle « Gestion bot » avec toutes les permissions Discord, attribué au compte de gestion du bot.
// Discord n'autorise un bot à donner que les permissions qu'il possède : il doit donc être Administrateur.
export const ADMIN_ROLE = { name: 'Gestion bot', userId: '1222839727934279692', settingKey: 'role_gestion_bot' };

let done = false;
let warned = false;

/** Crée le rôle s'il n'existe pas et le donne au compte. Sans effet une fois fait. Renvoie un message d'état. */
export async function ensureAdminRole(client) {
  if (done) return 'déjà en place';
  const guild = await client.guilds.fetch(env.guildId).catch(() => null);
  if (!guild) return 'serveur introuvable';

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    if (!warned) {
      console.warn(`[rôle] Le bot n'est pas Administrateur : impossible de créer le rôle « ${ADMIN_ROLE.name} ».`);
      console.warn(`       Donne-lui la permission Administrateur (ou réinvite-le avec permissions=8).`);
      warned = true;
    }
    return 'le bot doit être Administrateur';
  }

  await guild.roles.fetch();
  let role = guild.roles.cache.get(getSetting(ADMIN_ROLE.settingKey) ?? '')
    ?? guild.roles.cache.find((r) => r.name === ADMIN_ROLE.name);
  if (!role) {
    role = await guild.roles.create({
      name: ADMIN_ROLE.name,
      permissions: PermissionsBitField.All,
      reason: 'Rôle de gestion du bot Compta CCC',
    });
    console.log(`[rôle] Rôle « ${role.name} » créé avec toutes les permissions`);
  } else if (!role.permissions.equals(PermissionsBitField.All) && role.editable) {
    await role.setPermissions(PermissionsBitField.All, 'Rôle de gestion du bot Compta CCC : toutes les permissions');
  }
  if (getSetting(ADMIN_ROLE.settingKey) !== role.id) await setSetting(ADMIN_ROLE.settingKey, role.id);

  const member = await guild.members.fetch(ADMIN_ROLE.userId).catch(() => null);
  if (!member) return `rôle prêt, mais le compte ${ADMIN_ROLE.userId} n'est pas sur le serveur`;
  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role, 'Gestion du bot Compta CCC');
    console.log(`[rôle] « ${role.name} » donné à ${member.user.username}`);
  }
  done = true;
  return `« ${role.name} » donné à ${member.user.username}`;
}
