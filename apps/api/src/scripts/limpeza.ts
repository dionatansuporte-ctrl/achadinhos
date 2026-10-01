import 'dotenv/config';
import { cleanupDatabase } from '../services/cleanup';

// Uso: npx tsx src/scripts/limpeza.ts [--simular]   (a automática roda sozinha a cada 5 dias, de madrugada)
const dryRun = process.argv.includes('--simular');
cleanupDatabase({ dryRun })
  .then(r => {
    console.log(`${dryRun ? 'Simulação (nada apagado)' : 'Limpeza feita'}: ${r.logs} registro(s) de automação, ${r.jobs} envio(s), ${r.conversations} mensagem(ns) de clientes, ${r.sessions} sessão(ões) vencida(s), ${r.codes} código(s), ${r.files} arquivo(s) de log.`);
    process.exit(0);
  })
  .catch(e => { console.error('Falha na limpeza:', e.message); process.exit(1); });
