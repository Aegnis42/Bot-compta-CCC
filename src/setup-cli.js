// Initialise le Google Sheet sans lancer le bot : npm run setup-sheet
import { ensureStructure } from './setup.js';
import { loadRegistry, rebuildFormulas } from './charbonniers.js';
import { serviceAccountEmail } from './sheets.js';

try {
  const created = await ensureStructure();
  await loadRegistry();
  await rebuildFormulas();
  console.log(created.length ? `✅ Onglets créés : ${created.join(', ')}` : '✅ Structure déjà en place, formules mises à jour.');
} catch (e) {
  console.error(`❌ ${e.message}`);
  console.error(`   → Vérifie que le Sheet est partagé en "Éditeur" avec ${serviceAccountEmail()}`);
  process.exit(1);
}
