// Robô das Ofertas - roda API, worker e painel numa janela só (pedido do usuário em 2026-09-26:
// "1 prompt em vez de 4 telas"). Cada linha sai com o prefixo do processo e também vai para
// logs\api.log, logs\worker.log e logs\web.log. Fechar a janela ou apertar Ctrl+C para os três.
// Uso: node tools\rodar.js [semweb]   (semweb = não sobe o painel)
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'logs');
fs.mkdirSync(logs, { recursive: true });
const semWeb = process.argv.slice(2).some(a => a.toLowerCase() === 'semweb');

const cor = { API: '\x1b[36m', Worker: '\x1b[33m', Painel: '\x1b[35m' };
const fim = '\x1b[0m';
const servicos = [
  { nome: 'API', cwd: 'apps/api', script: 'dev', log: 'api.log' },
  { nome: 'Worker', cwd: 'apps/api', script: 'worker', log: 'worker.log' },
  ...(semWeb ? [] : [{ nome: 'Painel', cwd: 'apps/web', script: 'dev', log: 'web.log' }])
];

const hora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const filhos = [];

function escreve(s, texto, arquivo) {
  // Junta pedaços até a quebra de linha, para o prefixo sair uma vez por linha.
  s.resto += texto;
  const linhas = s.resto.split(/\r?\n/);
  s.resto = linhas.pop();
  for (const l of linhas) {
    if (!l.trim()) continue;
    process.stdout.write(`${cor[s.nome]}[${s.nome}]${fim} ${l}\n`);
    arquivo.write(`${hora()} ${l}\n`);
  }
}

for (const s of servicos) {
  s.resto = '';
  const arquivo = fs.createWriteStream(path.join(logs, s.log), { flags: 'a' });
  arquivo.write(`\n===== ${new Date().toLocaleString('pt-BR')} iniciado por tools\\rodar.js =====\n`);
  // npm é .cmd no Windows: precisa de shell. FORCE_COLOR mantém as cores do tsx/vite.
  const p = spawn('npm', ['run', s.script], { cwd: path.join(root, s.cwd), shell: true, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  filhos.push(p);
  p.stdout.on('data', d => escreve(s, d.toString('utf8'), arquivo));
  p.stderr.on('data', d => escreve(s, d.toString('utf8'), arquivo));
  p.on('exit', code => {
    process.stdout.write(`${cor[s.nome]}[${s.nome}]${fim} terminou (código ${code}). Feche esta janela e use OfertasDaHora.bat > Iniciar para subir de novo.\n`);
    arquivo.write(`${hora()} terminou (código ${code})\n`);
  });
}

process.stdout.write([
  '',
  '  Robô das Ofertas rodando nesta janela: ' + servicos.map(s => s.nome).join(' + '),
  '  Painel: http://127.0.0.1:8080   API: http://localhost:3333',
  '  Para parar tudo: feche esta janela, aperte Ctrl+C ou use OfertasDaHora.bat > Parar.',
  ''
].join('\n'));

// Ctrl+C / fechar a janela: derruba a árvore de cada filho (npm -> tsx -> node) antes de sair.
function encerra() {
  for (const p of filhos) {
    if (p.exitCode !== null) continue;
    try { execSync(`taskkill /T /F /PID ${p.pid}`, { stdio: 'ignore' }); } catch { /* já morreu */ }
  }
  process.exit(0);
}
process.on('SIGINT', encerra);
process.on('SIGHUP', encerra);
process.on('SIGTERM', encerra);
