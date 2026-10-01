# Robo das Ofertas - senha do PostgreSQL guardada com criptografia do Windows (DPAPI).
#
# O arquivo apps\api\.db-secret guarda a senha criptografada para o USUARIO do Windows atual neste PC:
# copiado para outro PC ou aberto por outro usuario, nao serve para nada. Fica fora do git e do backup
# (ao restaurar, vale a senha do banco da maquina de destino).
#
# Uso:
#   db-senha.ps1 get       -> escreve a senha (para os .bat e para a API); sem arquivo, a padrao antiga "postgres"
#   db-senha.ps1 nova      -> gera uma senha forte e grava criptografada (usado ao criar o banco do zero)
#   db-senha.ps1 trocar    -> gera uma senha forte, troca no PostgreSQL ligado e grava criptografada
param([Parameter(Position = 0)][string]$Acao = 'get')
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root 'apps\api\.db-secret'

function Read-Senha {
  if (-not (Test-Path $file)) { return 'postgres' }
  $sec = ConvertTo-SecureString ((Get-Content $file -Raw).Trim())
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Write-Senha([string]$senha, [string]$destino) {
  $sec = ConvertTo-SecureString $senha -AsPlainText -Force
  Set-Content -Path $destino -Value (ConvertFrom-SecureString $sec) -NoNewline -Encoding ascii
}

# So letras e numeros: entra sem escape na URL do banco e nos .bat.
function New-Senha {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Find-Psql {
  $dirs = @($env:PGSQL_DIR, (Join-Path $root '..\pgsql'), (Join-Path $root 'pgsql')) | Where-Object { $_ }
  foreach ($d in $dirs) { $p = Join-Path $d 'bin\psql.exe'; if (Test-Path $p) { return (Resolve-Path $p).Path } }
  throw 'Nao achei pgsql\bin\psql.exe.'
}

switch ($Acao.ToLower()) {
  'get' { [Console]::Out.Write((Read-Senha)) }
  'nova' {
    $senha = New-Senha
    Write-Senha $senha $file
    [Console]::Out.Write($senha)
  }
  'trocar' {
    $atual = Read-Senha
    $nova = New-Senha
    $psql = Find-Psql
    # Grava num arquivo temporario primeiro: se a troca no banco falhar, a senha atual continua valendo.
    $tmp = "$file.novo"
    Write-Senha $nova $tmp
    $env:PGPASSWORD = $atual
    & $psql -h localhost -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD '$nova'" | Out-Null
    if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; throw 'O PostgreSQL recusou a troca de senha (ele esta ligado?).' }
    Move-Item $tmp $file -Force
    Write-Host 'Senha do banco trocada e guardada criptografada em apps\api\.db-secret.'
  }
  default { throw "Acao desconhecida: $Acao (use get, nova ou trocar)" }
}
