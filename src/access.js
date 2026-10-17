import { PermissionFlagsBits } from 'discord.js';
import { env } from './config.js';

/** Staff : admins du serveur (« Gérer le serveur »), rôle STAFF_ROLE_ID, rôles de adminRoleIds ou compte de adminIds. */
export const isStaff = (member) =>
  Boolean(
    env.adminIds.includes(member?.id ?? member?.user?.id)
      || env.adminRoleIds.some((r) => member?.roles?.cache?.has(r))
      || member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || (env.staffRoleId && member?.roles?.cache?.has(env.staffRoleId)),
  );
