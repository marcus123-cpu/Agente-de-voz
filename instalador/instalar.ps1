#requires -Version 5.1
<#
  Instalador do Agente de Voz (painel + servidor cVortex/ElevenLabs).
  Dê dois cliques em Instalar.cmd. Rodar de novo atualiza a instalação.

  Parâmetros opcionais (para uso avançado/testes):
    -Destino          pasta da instalação (padrão: Documentos\Agente-de-Voz)
    -Repo             URL (ou caminho) do repositório Git
    -SegredosArquivo  arquivo .env com as chaves (padrão: segredos.env ao lado deste script)
    -Verificar        só confere o PC, sem instalar nada
    -SemAbrir         não pergunta se quer iniciar no final
    -PastaAtalhos     onde criar os atalhos (padrão: Área de Trabalho)
#>
param(
  [string]$Destino = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Agente-de-Voz'),
  [string]$Repo = 'https://github.com/marcus123-cpu/Agente-de-voz.git',
  [string]$SegredosArquivo = '',
  [switch]$Verificar,
  [switch]$SemAbrir,
  [string]$PastaAtalhos = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$script:Problemas = New-Object System.Collections.ArrayList
$script:Avisos = New-Object System.Collections.ArrayList

function Titulo($t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  [OK]    $t" -ForegroundColor Green }
function Info($t)   { Write-Host "  [..]    $t" -ForegroundColor Gray }
function Aviso($t)  { Write-Host "  [AVISO] $t" -ForegroundColor Yellow; [void]$script:Avisos.Add($t) }
function Falha($t)  { Write-Host "  [FALHA] $t" -ForegroundColor Red; [void]$script:Problemas.Add($t) }

function Atualizar-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}
function Tem-Comando($nome) { return [bool](Get-Command $nome -ErrorAction SilentlyContinue) }

function Executar($exe, $argumentos, $pasta) {
  # Roda um comando mostrando a saída; devolve o código de saída.
  $anterior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # PowerShell 5.1 trata stderr de programas (git/npm) como erro
  Push-Location $pasta
  try {
    & $exe @argumentos 2>&1 | ForEach-Object { Write-Host "          $_" -ForegroundColor DarkGray }
    return $LASTEXITCODE
  } finally { Pop-Location; $ErrorActionPreference = $anterior }
}

function Instalar-Winget($id, $nome) {
  if (-not (Tem-Comando 'winget')) { Falha "O Windows não tem o 'winget' para instalar $nome sozinho. Instale $nome manualmente e rode este instalador de novo."; return $false }
  Info "Instalando $nome (pode pedir permissão do Windows)..."
  $code = Executar 'winget' @('install', '--id', $id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements') $env:TEMP
  Atualizar-Path
  return ($code -eq 0 -or $code -eq -1978335189)  # -1978335189 = já instalado
}

function Texto-Secreto($pergunta) {
  $s = Read-Host -Prompt $pergunta -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Ler-Env($caminho) {
  $h = @{}
  foreach ($l in (Get-Content -LiteralPath $caminho -Encoding UTF8)) {
    if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $h[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
  return $h
}
function Gravar-SemBom($caminho, $texto) { [IO.File]::WriteAllText($caminho, $texto, (New-Object Text.UTF8Encoding($false))) }

# --------------------------------------------------------------------------
Write-Host ''
Write-Host '  ===============================================' -ForegroundColor Magenta
Write-Host '   Instalador - Central de Atendimento (Giovana)' -ForegroundColor Magenta
Write-Host '  ===============================================' -ForegroundColor Magenta

try {
  # ---------------- 1. Verificação do PC ----------------
  Titulo '1/6  Verificando o computador'
  $so = [Environment]::OSVersion.Version
  if ($so.Major -ge 10) { Ok "Windows $($so.Major).$($so.Minor) (build $($so.Build))" } else { Falha 'É preciso Windows 10 ou 11.' }

  try {
    $livre = [math]::Round((Get-PSDrive -Name ((Split-Path -Qualifier $Destino).TrimEnd(':')) ).Free / 1GB, 1)
    if ($livre -ge 2) { Ok "Espaço livre no disco: $livre GB" } else { Falha "Pouco espaço livre ($livre GB). São necessários cerca de 2 GB." }
  } catch { Aviso 'Não consegui medir o espaço em disco.' }

  try { [void](Invoke-WebRequest -Uri 'https://github.com' -UseBasicParsing -TimeoutSec 15); Ok 'Internet funcionando (GitHub acessível)' }
  catch { Falha 'Sem acesso ao GitHub. Confira a internet e tente de novo.' }

  Atualizar-Path
  if (Tem-Comando 'git') { Ok ("Git: " + (git --version)) } else { Info 'Git não encontrado (será instalado).' }
  $nodeOk = $false
  if (Tem-Comando 'node') {
    $v = (node --version).TrimStart('v'); $maj = [int]($v.Split('.')[0])
    if ($maj -ge 20) { Ok "Node.js $v"; $nodeOk = $true } else { Info "Node.js $v é antigo (será atualizado)." }
  } else { Info 'Node.js não encontrado (será instalado).' }
  if (Tem-Comando 'winget') { Ok 'winget disponível (instala programas sozinho)' } else { Aviso 'winget não encontrado: Git/Node precisarão estar instalados.' }

  foreach ($porta in 3001, 5173) {
    $em_uso = $false
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $porta); $c.Close(); $em_uso = $true } catch { }
    if ($em_uso) { Aviso "A porta $porta já está em uso (talvez o painel já esteja aberto)." } else { Ok "Porta $porta livre" }
  }

  if ($Verificar) {
    Titulo 'Resultado (modo verificação)'
    if ($script:Problemas.Count) { $script:Problemas | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red } } else { Ok 'O computador está pronto para instalar.' }
    return
  }
  if ($script:Problemas.Count) { throw 'Corrija os itens em vermelho acima e rode o instalador de novo.' }

  # ---------------- 2. Programas necessários ----------------
  Titulo '2/6  Programas necessários'
  if (-not (Tem-Comando 'git')) { [void](Instalar-Winget 'Git.Git' 'Git'); if (-not (Tem-Comando 'git')) { throw 'Não consegui instalar o Git. Instale em https://git-scm.com e rode de novo.' } }
  Ok 'Git pronto'
  if (-not $nodeOk) { [void](Instalar-Winget 'OpenJS.NodeJS.LTS' 'Node.js'); if (-not (Tem-Comando 'node')) { throw 'Não consegui instalar o Node.js. Instale em https://nodejs.org e rode de novo.' } }
  Ok ("Node.js " + (node --version) + " / npm " + (npm --version))

  # ---------------- 3. Baixar / atualizar o painel ----------------
  Titulo '3/6  Baixando o painel do GitHub'
  if (Test-Path (Join-Path $Destino '.git')) {
    Info "Instalação existente em ${Destino}: atualizando..."
    $sujo = (git -C $Destino status --porcelain 2>$null | Where-Object { $_ -notmatch '^\?\?' })
    if ($sujo) { Aviso 'Há alterações locais nos arquivos; não vou sobrescrever. Pulando a atualização do código.' }
    else {
      $c = Executar 'git' @('pull', '--ff-only') $Destino
      if ($c -ne 0) { Aviso 'Não consegui atualizar o código (git pull falhou). Sigo com a versão atual.' } else { Ok 'Código atualizado' }
    }
  } else {
    if ((Test-Path $Destino) -and (Get-ChildItem -LiteralPath $Destino -Force | Select-Object -First 1)) { throw "A pasta $Destino já existe e não está vazia. Apague-a ou escolha outra com -Destino." }
    New-Item -ItemType Directory -Force -Path (Split-Path $Destino) | Out-Null
    Info "Baixando para $Destino (se o repositório for privado, o GitHub pedirá seu login)..."
    $c = Executar 'git' @('clone', $Repo, $Destino) (Split-Path $Destino)
    if ($c -ne 0 -or -not (Test-Path (Join-Path $Destino 'package.json'))) { throw 'Não consegui baixar o projeto do GitHub.' }
    Ok 'Projeto baixado'
  }

  # ---------------- 4. Dependências ----------------
  Titulo '4/6  Instalando dependências (pode levar alguns minutos)'
  $c = Executar 'npm' @('install', '--no-audit', '--no-fund') $Destino
  if ($c -ne 0) { throw 'Falha no npm install.' }
  Ok 'Pacotes do painel e do servidor instalados'
  Info 'Baixando o navegador usado para controlar o cVortex...'
  $c = Executar 'npx' @('--no-install', 'playwright', 'install', 'chromium') $Destino
  if ($c -ne 0) { throw 'Falha ao baixar o navegador (playwright install chromium).' }
  Ok 'Navegador pronto'

  # ---------------- 5. Configuração (chaves) ----------------
  Titulo '5/6  Configuração'
  $envServidor = Join-Path $Destino 'server\.env'
  $envWeb = Join-Path $Destino 'web\.env'
  if (Test-Path $envServidor) {
    Ok 'server\.env já existe: mantido como está'
  } else {
    if (-not $SegredosArquivo) {
      foreach ($cand in @((Join-Path $PSScriptRoot 'segredos.env'), (Join-Path (Split-Path $Destino) 'segredos.env'))) { if (Test-Path $cand) { $SegredosArquivo = $cand; break } }
    }
    if ($SegredosArquivo -and (Test-Path $SegredosArquivo)) {
      Info "Usando as chaves de $SegredosArquivo"
      Copy-Item -LiteralPath $SegredosArquivo -Destination $envServidor
    } else {
      Write-Host '  Não achei o arquivo segredos.env. Vou pedir as chaves (nada é mostrado enquanto você digita).' -ForegroundColor Yellow
      $modelo = Get-Content -LiteralPath (Join-Path $Destino '.env.example') -Encoding UTF8
      $linhas = @(); foreach ($l in $modelo) { if ($l -match '^# Copie para web/.env') { break }; $linhas += $l }
      do {
        $senha = Texto-Secreto '  Crie a SENHA do operador (mínimo 10 caracteres)'
        $conf = Texto-Secreto '  Repita a senha'
        if ($senha.Length -lt 10) { Write-Host '  Senha curta demais.' -ForegroundColor Red }
        elseif ($senha -ne $conf) { Write-Host '  As senhas não conferem.' -ForegroundColor Red }
      } until ($senha.Length -ge 10 -and $senha -eq $conf)
      $bytes = New-Object byte[] 48; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
      $valores = @{
        OPERATOR_PASSWORD = $senha
        SESSION_SECRET = ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        ELEVENLABS_API_KEY = (Texto-Secreto '  Chave da ElevenLabs (ELEVENLABS_API_KEY)')
        SUPABASE_SECRET_KEY = (Texto-Secreto '  Chave secreta do Supabase (SUPABASE_SECRET_KEY)')
        ELEVENLABS_AGENT_ID = (Read-Host '  ID do agente da Giovana na ElevenLabs (começa com agent_)')
        ENABLE_BROWSER_TAKEOVER = 'true'
        ENABLE_LIVE_TRANSCRIPTION = 'true'
      }
      $saida = foreach ($l in $linhas) {
        if ($l -match '^([A-Z0-9_]+)=') { $k = $Matches[1]; if ($valores.ContainsKey($k)) { "$k=$($valores[$k])" } else { $l } } else { $l }
      }
      Gravar-SemBom $envServidor (($saida -join "`r`n") + "`r`n")
    }
    Ok 'server\.env criado'
  }
  if (-not (Test-Path $envWeb)) {
    Gravar-SemBom $envWeb ("VITE_API_BASE_URL=http://localhost:3001`r`nVITE_DEMO_MODE=false`r`n")
    Ok 'web\.env criado'
  } else { Ok 'web\.env já existe' }

  # ---------------- 6. Atalhos e conferência final ----------------
  Titulo '6/6  Atalhos e conferência final'
  $iniciar = Join-Path $Destino 'Iniciar-Agente-de-Voz.cmd'
  $atualizar = Join-Path $Destino 'Atualizar-Agente-de-Voz.cmd'
  $conteudoIniciar = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agente de Voz
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',5173);$c.Close();exit 0}catch{exit 1}"
if %errorlevel%==0 (
  echo O painel ja esta rodando. Abrindo no navegador...
  start "" http://localhost:5173
  exit /b
)
echo Iniciando o painel e o servidor. NAO FECHE a janela que vai abrir.
start "Agente de Voz - servidor (nao feche)" cmd /k "npm run dev"
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',5173);$c.Close();break}catch{Start-Sleep 1}}"
start "" http://localhost:5173
echo.
echo Painel aberto em http://localhost:5173
echo Para abrir o navegador do cVortex (login), use o botao "Abrir perfil cVortex" na aba Conexoes do painel.
timeout /t 6 >nul
'@
  $conteudoAtualizar = @'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Atualizando o Agente de Voz...
git pull --ff-only
call npm install --no-audit --no-fund
echo.
echo Pronto. Feche e abra o painel de novo para usar a versao nova.
pause
'@
  Gravar-SemBom $iniciar ($conteudoIniciar -replace "`r?`n", "`r`n")
  Gravar-SemBom $atualizar ($conteudoAtualizar -replace "`r?`n", "`r`n")
  try {
    New-Item -ItemType Directory -Force -Path $PastaAtalhos | Out-Null
    $sh = New-Object -ComObject WScript.Shell
    foreach ($par in @(@('Agente de Voz', $iniciar), @('Atualizar Agente de Voz', $atualizar))) {
      $lnk = $sh.CreateShortcut((Join-Path $PastaAtalhos ($par[0] + '.lnk')))
      $lnk.TargetPath = $par[1]; $lnk.WorkingDirectory = $Destino; $lnk.Save()
    }
    Ok "Atalhos criados em $PastaAtalhos"
  } catch { Aviso "Não consegui criar os atalhos ($($_.Exception.Message)). Use os arquivos .cmd da pasta $Destino." }

  # conferência das chaves
  $cfg = Ler-Env $envServidor
  foreach ($k in 'OPERATOR_PASSWORD', 'SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID') {
    if ([string]::IsNullOrWhiteSpace($cfg[$k])) { Falha "Falta preencher $k em server\.env" }
  }
  if ($cfg['OPERATOR_PASSWORD'] -and $cfg['OPERATOR_PASSWORD'].Length -lt 10) { Aviso 'A senha do operador tem menos de 10 caracteres. Troque por uma mais forte antes de expor o painel na internet.' }
  if ($cfg['SESSION_SECRET'] -and $cfg['SESSION_SECRET'].Length -lt 32) { Aviso 'SESSION_SECRET curto; use 32+ caracteres aleatórios.' }

  if ($cfg['ELEVENLABS_API_KEY'] -and $cfg['ELEVENLABS_AGENT_ID']) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -UserAgent 'AgenteDeVoz-Instalador/1.0' -Uri ('https://api.elevenlabs.io/v1/convai/agents/' + $cfg['ELEVENLABS_AGENT_ID']) -Headers @{ 'xi-api-key' = $cfg['ELEVENLABS_API_KEY'] }
      Ok 'ElevenLabs: chave válida e agente da Giovana encontrado'
    } catch { Falha "ElevenLabs recusou a chave/agente (HTTP $($_.Exception.Response.StatusCode.value__)). Confira ELEVENLABS_API_KEY e ELEVENLABS_AGENT_ID." }
  }
  if ($cfg['SUPABASE_URL'] -and $cfg['SUPABASE_SECRET_KEY']) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -UserAgent 'AgenteDeVoz-Instalador/1.0' -Uri ($cfg['SUPABASE_URL'] + '/rest/v1/brains?select=id&limit=1') -Headers @{ apikey = $cfg['SUPABASE_SECRET_KEY'] }
      Ok 'Supabase: banco de dados acessível'
    } catch { Falha "Supabase recusou a chave (HTTP $($_.Exception.Response.StatusCode.value__)). Confira SUPABASE_URL e SUPABASE_SECRET_KEY." }
  }

  Info 'Rodando os testes do servidor...'
  Push-Location $Destino
  try { $saidaTeste = (& npm test -w server 2>&1 | Out-String) } finally { Pop-Location }
  if ($saidaTeste -match 'fail 0' -and $saidaTeste -match 'pass (\d+)') { Ok "Testes do servidor: $($Matches[1]) aprovados" } else { Aviso 'Os testes do servidor não passaram por completo (o painel pode funcionar mesmo assim).' }

  # ---------------- Fim ----------------
  Titulo 'Resultado'
  if ($script:Problemas.Count) {
    Write-Host '  Instalação concluída, mas com problemas:' -ForegroundColor Red
    $script:Problemas | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
  } else {
    Write-Host '  TUDO PRONTO!' -ForegroundColor Green
  }
  $script:Avisos | ForEach-Object { Write-Host "   * $_" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host "  Pasta: $Destino"
  Write-Host '  Para usar: dê dois cliques no atalho "Agente de Voz" da área de trabalho.'
  Write-Host '  1o uso neste PC: no painel, aba Conexões > "Abrir perfil cVortex" e faça o login no cVortex.'
  Write-Host '  Atenção: use um PC por vez com o mesmo login do cVortex.'
  if (-not $SemAbrir -and -not $script:Problemas.Count) {
    $resp = Read-Host '  Iniciar o painel agora? (S/N)'
    if ($resp -match '^[sSyY]') { Start-Process -FilePath $iniciar }
  }
}
catch {
  Write-Host ''
  Write-Host "  ERRO: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  A instalação parou. Corrija o item acima e rode o instalador de novo (ele continua de onde parou).' -ForegroundColor Yellow
  exit 1
}
