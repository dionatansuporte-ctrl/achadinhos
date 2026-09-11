import 'dotenv/config';
import { createBackup, BACKUP_DIR } from '../services/backup';

// Uso: npx tsx src/scripts/backup.ts   (ou OfertasDaHora.bat > Backup) — funciona mesmo com a API parada.
createBackup('manual')
  .then(b => { console.log(`Backup criado: ${BACKUP_DIR}\\${b.file} (${(b.size / 1024 / 1024).toFixed(1)} MB)`); process.exit(0); })
  .catch(e => { console.error('Falha no backup:', e.message); process.exit(1); });
