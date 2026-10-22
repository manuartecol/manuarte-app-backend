<#
  Corre migraciones de Sequelize contra un entorno elegido a propósito.

  Por qué existe: config/config.js usa las mismas variables DB_* para
  development, test y production, así que `--env production` no cambia el
  destino. El destino lo decide únicamente DB_HOST/DB_PORT/DB_NAME. Con las
  credenciales de Railway dentro de .env, qué base recibía una migración
  dependía de cuál bloque estuviera descomentado: un estado invisible.

  La contraseña se teclea en un prompt oculto, así que no pasa por la línea de
  comandos ni queda en ConsoleHost_history.txt.

  dotenv NO sobrescribe variables que ya existen en el entorno (comprobado con
  la 16.4.5 del proyecto), así que lo que se inyecta aquí gana sobre .env sin
  tocar una línea de código.

  Uso:
    npm run migrate:env                      menú
    npm run migrate:env -- staging
    npm run migrate:env -- production
    npm run migrate:env -- staging status    solo ver qué hay pendiente
    npm run migrate:env -- staging migrate:undo
#>
[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[ValidateSet('local', 'staging', 'production')]
	[string]$Environment,

	[Parameter(Position = 1)]
	[ValidateSet('migrate', 'migrate:undo', 'seed:all', 'status')]
	[string]$Command = 'migrate'
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$targets = [ordered]@{
	local = @{
		Label  = 'LOCAL · manuartedb_dev en Docker'
		Remote = $false
	}
	staging = @{
		Label      = 'STAGING · zephyr'
		Remote     = $true
		DbHost     = 'zephyr.proxy.rlwy.net'
		DbPort     = '17087'
		DbName     = 'postgres'
		DbUser     = 'postgres'
		# Palabra que hay que escribir para confirmar. Se usa el nombre del
		# servidor y no un "sí": obliga a leer contra qué se está ejecutando.
		Keyword    = 'zephyr'
	}
	production = @{
		Label   = 'PRODUCTION · kodama'
		Remote  = $true
		DbHost  = 'kodama.proxy.rlwy.net'
		DbPort  = '44732'
		DbName  = 'postgres'
		DbUser  = 'postgres'
		Keyword = 'kodama'
	}
}

# ── Menú, si no se pasó entorno ──────────────────────────────────────────────
if (-not $Environment) {
	Write-Host ''
	Write-Host '  Which database?' -ForegroundColor Cyan
	Write-Host ''
	$index = 0
	$options = @()
	foreach ($key in $targets.Keys) {
		$index++
		$options += $key
		$color = if ($key -eq 'production') { 'Red' } else { 'Gray' }
		Write-Host ("    {0}) {1}" -f $index, $targets[$key].Label) -ForegroundColor $color
	}
	Write-Host ''
	$choice = Read-Host "  1-$index"
	$parsed = 0
	if (-not [int]::TryParse($choice, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt $index) {
		Write-Host '  Invalid option.' -ForegroundColor Red
		exit 1
	}
	$Environment = $options[$parsed - 1]
}

$target = $targets[$Environment]
$exitCode = 1

# Deshacer una migración o sembrar datos en producción no es rutina: 43 de las
# 62 migraciones hacen removeColumn o dropTable en su `down`, así que un undo
# borra datos del cliente. Y la palabra de confirmación es la misma que la de
# un migrate normal, o sea que se teclea por costumbre. Se bloquea aquí: si
# alguna vez hace falta de verdad, se prepara a mano, con un dump reciente
# hecho y verificado antes.
if ($Environment -eq 'production' -and $Command -in @('migrate:undo', 'seed:all')) {
	Write-Host ''
	Write-Host "  '$Command' is blocked against production." -ForegroundColor Red
	Write-Host '  43 of 62 migrations drop columns or tables on their down step.' -ForegroundColor Red
	Write-Host '  Do it by hand, with a fresh dump verified first.' -ForegroundColor Red
	Write-Host ''
	exit 1
}

Write-Host ''
Write-Host "  target  : $($target.Label)" -ForegroundColor Cyan
Write-Host "  command : $(if ($Command -eq 'status') { 'status only' } else { "npm run $Command" })" -ForegroundColor Cyan

# ── local: no se inyecta nada, dotenv lee .env tal cual ──────────────────────
if (-not $target.Remote) {
	Write-Host ''
	Write-Host '=== target check ===' -ForegroundColor Cyan
	node scripts/db-target.js
	if ($LASTEXITCODE -ne 0) { exit 1 }
	Write-Host ''
	if ($Command -eq 'status') { npx sequelize-cli db:migrate:status } else { npm run $Command }
	exit $LASTEXITCODE
}

Write-Host "  server  : $($target.DbUser)@$($target.DbHost):$($target.DbPort)/$($target.DbName)" -ForegroundColor Cyan
Write-Host ''

$securePassword = Read-Host '  password' -AsSecureString
if ($securePassword.Length -eq 0) {
	Write-Host '  No password given, aborted.' -ForegroundColor Red
	exit 1
}
$password = ConvertFrom-SecureString $securePassword -AsPlainText
$securePassword.Dispose()

# Se guardan los valores previos para restaurarlos haya pasado lo que haya pasado.
$previous = @{}
foreach ($name in 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD') {
	$previous[$name] = [Environment]::GetEnvironmentVariable($name)
}

try {
	$env:DB_HOST     = $target.DbHost
	$env:DB_PORT     = $target.DbPort
	$env:DB_NAME     = $target.DbName
	$env:DB_USER     = $target.DbUser
	$env:DB_PASSWORD = $password

	# Primero, contra qué servidor se está hablando de verdad. sequelize-cli
	# imprime "Using environment development" siempre, porque config/config.js
	# define las tres claves igual: esa línea no distingue local de Railway.
	Write-Host ''
	Write-Host '=== target check ===' -ForegroundColor Cyan
	node scripts/db-target.js
	$exitCode = $LASTEXITCODE

	# Después, qué migraciones se van a aplicar. Nada se ejecuta a ciegas.
	if ($exitCode -eq 0) {
		Write-Host ''
		Write-Host '=== pending migrations ===' -ForegroundColor Cyan
		npx sequelize-cli db:migrate:status
		$exitCode = $LASTEXITCODE
	}

	if ($exitCode -eq 0 -and $Command -ne 'status') {
		Write-Host ''
		$answer = Read-Host "Type '$($target.Keyword)' to run 'npm run $Command' against $($target.Label)"
		if ($answer -eq $target.Keyword) {
			Write-Host ''
			npm run $Command
			$exitCode = $LASTEXITCODE
		}
		else {
			Write-Host 'Cancelled. Nothing was run.' -ForegroundColor Yellow
			$exitCode = 1
		}
	}
	elseif ($exitCode -ne 0) {
		Write-Host 'Could not reach the target. Nothing was run.' -ForegroundColor Red
	}
}
finally {
	foreach ($name in $previous.Keys) {
		[Environment]::SetEnvironmentVariable($name, $previous[$name])
	}
	$password = $null
}

exit $exitCode
