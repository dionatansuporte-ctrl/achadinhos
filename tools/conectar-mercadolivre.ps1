# Abre um túnel HTTPS público temporário (Cloudflare, sem conta) até a API local,
# para o Mercado Livre aceitar a URL de retorno do OAuth. Só precisa ficar aberto
# enquanto você conecta a conta; depois pode fechar.
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$tools = $PSScriptRoot
$exe   = Join-Path $tools 'cloudflared.exe'
$log   = Join-Path $tools 'cloudflared.log'
$flag  = Join-Path $root 'apps\api\ml-redirect.txt'
$callbackPath = '/api/integrations/mercadolivre/callback'

Write-Host ''
Write-Host '  OfertasDaHora - Conectar Mercado Livre' -ForegroundColor Yellow
Write-Host '  ======================================' -ForegroundColor Yellow
Write-Host ''

# API precisa estar de pé
try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3333/api/nao-existe' -TimeoutSec 5 | Out-Null } catch { if (-not ($_.Exception.Response)) { Write-Host '  A API não está rodando. Abra o sistema (OfertasDaHora.bat, opção Iniciar) e tente de novo.' -ForegroundColor Red; Read-Host '  Enter para sair'; exit 1 } }

if (-not (Test-Path $exe)) {
  Write-Host '  Baixando o cloudflared (uma vez só, ~60 MB)...'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe
}

Remove-Item $log -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList 'tunnel','--url','http://localhost:3333','--no-autoupdate','--logfile',"`"$log`"",'--loglevel','info' -WindowStyle Hidden -PassThru

Write-Host '  Abrindo o túnel...'
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | ForEach-Object { $_.Matches } | Select-Object -First 1
    if ($m) { $url = $m.Value }
  }
}
if (-not $url) { Write-Host '  Não consegui abrir o túnel. Confira a internet e tente de novo.' -ForegroundColor Red; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Read-Host '  Enter para sair'; exit 1 }

$callback = "$url$callbackPath"
Set-Content -Path $flag -Value $callback -Encoding ASCII -NoNewline
try { Set-Clipboard -Value $callback } catch {}

Write-Host ''
Write-Host '  URL DE RETORNO (já copiada para a área de transferência):' -ForegroundColor Green
Write-Host "  $callback" -ForegroundColor Cyan
Write-Host ''
Write-Host '  1) No DevCenter do Mercado Livre, cole essa URL em "URI de redirect" e salve.'
Write-Host '  2) No OfertasDaHora > Configurações > Mercado Livre, clique em "Conectar" e autorize.'
Write-Host '  3) Quando o card ficar "Conectado", volte aqui e pressione Enter para fechar o túnel.'
Write-Host ''
Write-Host '  Deixe esta janela aberta até terminar. A API já está usando esta URL de retorno.' -ForegroundColor DarkGray
Read-Host '  Enter para fechar o túnel'

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Remove-Item $flag -ErrorAction SilentlyContinue
Write-Host '  Túnel fechado. A conexão com o Mercado Livre continua valendo (o token renova sozinho).' -ForegroundColor Green
Start-Sleep -Seconds 3
