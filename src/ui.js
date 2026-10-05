import { EmbedBuilder } from 'discord.js';
import { env, PRODUCTS, stockLevel, STOCK_LEVELS } from './config.js';
import { isOpen } from './contrats.js';
import { contractUnitPrice } from './prices.js';

export const COLORS = { ok: 0x2ecc71, info: 0x3498db, warn: 0xe67e22, err: 0xe74c3c, sheet: 0x0f9d58, coal: 0x2c2f33 };

export const fmt = (n) => (Math.round((n + Number.EPSILON) * 100) / 100).toLocaleString('fr-FR');
export const money = (n) => `${fmt(n)} ${env.currency}`;

export const qtyInline = (qty) => PRODUCTS.filter((p) => qty[p.code]).map((p) => `${fmt(qty[p.code])} ${p.code}`).join(' · ') || '—';
export const qtyLines = (qty) =>
  PRODUCTS.filter((p) => qty[p.code]).map((p) => `• **${fmt(qty[p.code])}** ${p.name} (${p.code})`).join('\n') || '—';

export const errorEmbed = (msg) =>
  new EmbedBuilder().setColor(COLORS.err).setDescription(/^\p{Extended_Pictographic}/u.test(msg) ? msg : `❌ ${msg}`);

export function depositEmbed({ c, qty, montant, ref, week, weekSum, title, color = COLORS.ok }) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(qtyLines(qty))
    .addFields(
      { name: 'Valeur de rachat', value: money(montant), inline: true },
      { name: 'Semaine', value: `du ${week}`, inline: true },
      { name: 'Total de la semaine', value: `${qtyInline(weekSum.qty)}\n💰 **${money(weekSum.montant)}** à percevoir` },
    )
    .setFooter({ text: `${c.name}${c.bonus ? ` · bonus rachat +${fmt(c.bonus)}/unité` : ''} · Réf ${ref}` })
    .setTimestamp();
}

export function recapEmbed(c, week, sum) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📊 ${c.name} — semaine du ${week}`)
    .setDescription(sum.count ? qtyLines(sum.qty) : '_Aucun dépôt cette semaine._')
    .addFields(
      { name: 'Dépôts', value: String(sum.count), inline: true },
      { name: 'Salaire dû', value: `**${money(sum.montant)}**`, inline: true },
    );
}

export function salairesEmbed(week, list) {
  const total = list.reduce((s, x) => s + x.montant, 0);
  const lines = list
    .sort((a, b) => b.montant - a.montant)
    .map((s) => `**${s.c.name}**${s.c.discordId ? ` (<@${s.c.discordId}>)` : ''} — ${qtyInline(s.qty)} → **${money(s.montant)}**`);
  return new EmbedBuilder()
    .setColor(COLORS.coal)
    .setTitle(`💰 Salaires — semaine du ${week}`)
    .setDescription(lines.join('\n') || '_Aucun charbonnier._')
    .addFields({ name: 'Total à verser', value: `**${money(total)}**` });
}

export function stockEmbed(stock) {
  const lines = PRODUCTS.map((p) => {
    const s = stock[p.code];
    const level = stockLevel(p.code, s.stock);
    let line = `${level ? `${level.icon} ` : ''}**${p.name} (${p.code})** : **${fmt(s.stock)}** en stock${level ? ` (${level.label})` : ''}`;
    if (s.reste > 0) line += ` · ${fmt(s.reste)} à livrer`;
    if (s.aProduire > 0) line += ` · ⚠️ **${fmt(s.aProduire)} à produire**`;
    return line;
  });
  const legend = STOCK_LEVELS.levels
    .map((l, i) => `${l.icon} ${i === STOCK_LEVELS.levels.length - 1 ? `< ${fmt(STOCK_LEVELS.levels[i - 1].min)}` : `≥ ${fmt(l.min)}`}`)
    .join(' · ');
  return new EmbedBuilder().setColor(COLORS.info).setTitle('📦 Stock').setDescription(lines.join('\n'))
    .setFooter({ text: `Niveaux (${STOCK_LEVELS.codes.join(', ')}) : ${legend}` }).setTimestamp();
}

export function contractsSummaryEmbed(open) {
  const lines = open.slice(0, 20).map((ct) => {
    const reste = Object.fromEntries(PRODUCTS.map((p) => [p.code, Math.max(0, ct.reste[p.code])]));
    return `${STATUS_ICON[ct.statut] ?? ''} **${ct.id}** — ${ct.client} · reste : ${qtyInline(reste)} · 💰 ${money(ct.montant)} · 📈 ${money(ct.benefice)}`;
  });
  const total = open.reduce((s, ct) => s + ct.benefice, 0);
  return new EmbedBuilder().setColor(COLORS.warn).setTitle('📜 Contrats en cours').setDescription(lines.join('\n'))
    .setFooter({ text: `Bénéfice attendu sur les contrats en cours : ${money(total)}` });
}

const STATUS_ICON = { 'En attente': '🕓', Partiel: '🟠', Livré: '✅', Annulé: '⛔' };

export function contractEmbed(ct, stock) {
  const ordered = PRODUCTS.filter((p) => ct.cmd[p.code]);
  // Prix unitaire appliqué ; ✏️ = prix personnalisé du contrat
  const demande = ordered.map((p) =>
    `**${fmt(ct.cmd[p.code])}** ${p.name} à ${fmt(contractUnitPrice(ct, p.code))}${ct.prixPerso?.[p.code] ? ' ✏️' : ''}`);
  const resume = [
    `👤 **${ct.client}** demande ${demande.length ? demande.join(' · ') : '—'}`,
    '',
    `💰 **${ct.client}** doit payer **${money(ct.montant)}** _(tarif ${ct.tarif || '?'})_`,
    `⛏️ Ça coûte **${money(ct.cout)}** de matériaux`,
    `📈 Le contrat rapporte **${money(ct.benefice)}** de bénéfice`,
  ];

  // Suivi de livraison : ce qui reste à livrer et ce que le stock ne couvre pas encore
  const suivi = PRODUCTS.filter((p) => ct.cmd[p.code] || ct.livre[p.code]).map((p) => {
    const reste = Math.max(0, ct.reste[p.code]);
    let line = `${p.code} : livré ${fmt(ct.livre[p.code])} / ${fmt(ct.cmd[p.code])}`;
    if (reste > 0 && isOpen(ct) && stock) {
      const manque = Math.max(0, reste - Math.max(0, stock[p.code].stock));
      line += manque > 0 ? ` · ⚠️ il manque **${fmt(manque)}** en stock` : ' · ✅ livrable';
    }
    return line;
  });

  const embed = new EmbedBuilder()
    .setColor(ct.statut === 'Livré' ? COLORS.ok : ct.statut === 'Annulé' ? COLORS.err : COLORS.warn)
    .setTitle(`📜 Contrat ${ct.id}`)
    .setDescription(resume.join('\n'))
    .addFields(
      { name: 'Statut', value: `${STATUS_ICON[ct.statut] ?? ''} ${ct.statut || '?'}${ct.hebdo ? '\n🔁 Hebdomadaire' : ''}`, inline: true },
      { name: 'Valeur déjà livrée', value: `${money(ct.montantLivre)} / ${money(ct.montant)}`, inline: true },
      { name: 'Livraison', value: suivi.join('\n') || '—' },
    );
  if (ct.note) embed.addFields({ name: 'Note', value: ct.note.slice(0, 1000) });
  return embed;
}

export function historiqueEmbed(weeks) {
  const lines = weeks.map((w) => [
    `📅 **${w.semaine}**`,
    `CA ${money(w.ca)} · coût ${money(w.cout)} · bénéfice **${money(w.benefice)}**`,
    `bénéfice final ${money(w.final)} · BAT **${money(w.bat)}**`,
  ].join('\n'));
  return new EmbedBuilder()
    .setColor(COLORS.coal)
    .setTitle('🗂️ Historique des semaines')
    .setDescription(lines.join('\n\n') || '_Aucune semaine terminée pour l\'instant._');
}

export function welcomeEmbed(c) {
  return new EmbedBuilder()
    .setColor(COLORS.coal)
    .setTitle(`⛏️ Bienvenue ${c.name} !`)
    .setDescription(
      [
        'Ce salon sert à déclarer tes dépôts de charbon. Écris simplement ce que tu as déposé, par exemple :',
        '> `300 CP`',
        '> `120 C 40 BC`',
        '> `50 briquettes et 10 coke`',
        '',
        'Codes : **CP** Charbon Pauvre · **C** Charbon · **BC** Briquette · **CO** Coke',
        '',
        'Je l\'inscris dans le Google Sheet et je te réponds avec ton total de la semaine.',
        'Commandes utiles : `/depot`, `/recap`, `/annuler-depot`.',
      ].join('\n'),
    );
}
