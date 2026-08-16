# ============================================================
# DSH-Windows desktop: GitHub upload privacy guard
# ------------------------------------------------------------
# Invoked by .githooks/pre-commit and .githooks/pre-push.
# Manual runs:
#   powershell -NoProfile -File .githooks/guard.ps1 -Mode commit
#   feed pre-push argument lines via stdin:
#     "refs/heads/main <new-sha> refs/heads/main <old-sha>" |
#       powershell -NoProfile -File .githooks/guard.ps1 -Mode push
#
# BLOCK (exit 1, aborts commit / push):
#   - API keys / tokens (sk-..., GitHub PAT, AWS AKIA, ...)
#   - literal passwords
#   - privacy files entering the repo: credentials, sessions,
#     chat history, account state, logs
# WARN (does not block; -Strict upgrades it to a block):
#   - personal e-mail addresses, local absolute paths
#   - image metadata (Photoshop XMP / AIGC marks)
# Emergency bypass: git commit --no-verify / git push --no-verify
# ============================================================

param(
  [string]$Mode = 'commit',
  [switch]$Strict
)

$ErrorActionPreference = 'Continue'

function Invoke-Git {
  param([string[]]$ArgList)
  $out = @(& git @ArgList 2>$null)
  return $out
}

$root = ((Invoke-Git @('rev-parse', '--show-toplevel')) -join "`n").Trim()
if (-not $root) { Write-Host '[guard] not a git repository, skip.'; exit 0 }
Set-Location $root

# ---------------- detection rules ----------------
# NOTE: do not write a literal sample that satisfies the rules below,
# otherwise the guard reports itself.
$KEY_RE  = 'sk-[0-9a-zA-Z_-]{16,}|ghp_[0-9a-zA-Z]{20,}|github_pat_[0-9a-zA-Z_]{20,}|AKIA[0-9A-Z]{16}|DEEPSEEK_API_KEY[[:space:]]*:[[:space:]]*["'']?[0-9a-zA-Z_-]{8,}|Authorization[[:space:]]*:[[:space:]]*Bearer[[:space:]]+[0-9a-zA-Z._-]{16,}|_authToken[[:space:]]*[:=][[:space:]]*["'']?[0-9a-zA-Z]{8,}'
$PWD_RE  = 'password[[:space:]]*[:=][[:space:]]*["''][^"'']{6,}["'']'
$FILE_RE = '\.credentials(\.yaml)?$|\.env(\.[A-Za-z0-9_-]+)?$|account-state\.json$|pet-(chat-history|persona|backend|schedule)\.json$|(^|/)sessions/|(^|/)storages/|(^|/)settings\.yaml$|dsh-desktop\.log$|\.log$|\.npmrc$|id_rsa|id_ed25519|\.pem$|\.pfx$|(^|/)\.dsh(-accounts)?/'
$PNG_RE  = 'ContentProducer|AIGC|softwareAgent'
$EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
# Pass patterns via a file: PS 5.1 mangles argv that contains quote chars,
# which silently drops git grep's <rev>/<pathspec> arguments.
$patternFile = Join-Path $env:TEMP 'dsh-guard-key-pattern.txt'
$patternOk = $true
try { Set-Content -Path $patternFile -Value @($KEY_RE, $PWD_RE) -Encoding ASCII } catch { $patternOk = $false }
# Personal warning rules are per-machine and never committed:
# .githooks/private-rules.txt (one regex per line, # = comment).
$privateRulesFile = Join-Path $root '.githooks\private-rules.txt'
$privatePatternFile = Join-Path $env:TEMP 'dsh-guard-private-pattern.txt'
$privateRules = @()
if (Test-Path $privateRulesFile) {
  try {
    $privateRules = @(Get-Content -Path $privateRulesFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $_.Replace('\', '\\') })
  } catch { }
}
if ($privateRules.Count -gt 0) {
  try { Set-Content -Path $privatePatternFile -Value $privateRules -Encoding ASCII } catch { }
}

$blocked = New-Object System.Collections.Generic.List[string]
$warned  = New-Object System.Collections.Generic.List[string]

function Scan-Text {
  param([string[]]$GitArgs, [string]$Tag)
  foreach ($h in (Invoke-Git $GitArgs)) {
    if ($h) { $blocked.Add("[$Tag] $h") }
  }
}

function Scan-Files {
  param([string[]]$Names, [string]$Tag)
  foreach ($n in $Names) {
    if ($n -and ($n -match $FILE_RE)) { $blocked.Add("[$Tag] $n") }
  }
}

function Scan-Warn {
  param([string[]]$GitArgs, [string]$Tag)
  foreach ($h in (Invoke-Git $GitArgs)) {
    if ($h) { $warned.Add("[$Tag] $h") }
  }
}

# ---------------- commit mode: scan the staged index ----------------
$report = 'commit'
if ($Mode -eq 'commit') {
  $stagedNames = @(Invoke-Git @('diff', '--cached', '--name-only', '--') | Where-Object { $_ })
  if ($stagedNames.Count -eq 0) {
    Write-Host '[guard] commit: no staged changes.'
    exit 0
  }
  Scan-Text -GitArgs @('grep', '--cached', '-n', '-I', '-E', '-f', $patternFile, '--', '.') -Tag 'API key/password'
  Scan-Files -Names $stagedNames -Tag 'privacy file'
  if ($privateRules.Count -gt 0) {
    Scan-Warn -GitArgs (@('grep', '--cached', '-n', '-I', '-E', '-f', $privatePatternFile, '--') + $stagedNames) -Tag 'personal path/e-mail'
  }
  $stagedPngs = @($stagedNames | Where-Object { $_ -like '*.png' })
  if ($stagedPngs.Count -gt 0) {
    Scan-Warn -GitArgs (@('grep', '--cached', '-a', '-l', '-E', $PNG_RE, '--') + $stagedPngs) -Tag 'image metadata'
  }
}

# ---------------- push mode: scan the new commits to be pushed ----------------
if ($Mode -eq 'push') {
  $report = 'push'
  $lines = @($input)
  if ($lines.Count -eq 0) {
    try {
      $raw = [Console]::In.ReadToEnd()
      if ($raw) { $lines = @($raw -split "`n") }
    } catch { }
  }
  if ($lines.Count -eq 0) {
    Write-Host '[guard] push: no refs input.'
    exit 0
  }
  foreach ($line in $lines) {
    $p = @($line.Trim() -split '\s+')
    if ($p.Count -lt 4) { continue }
    $localSha  = $p[1]
    $remoteSha = $p[3]
    if ($remoteSha -match '^0+$') { $range = "$EMPTY_TREE..$localSha" } else { $range = "$remoteSha..$localSha" }
    $n = ((Invoke-Git @('rev-list', '--count', $range)) -join '').Trim()
    if (-not $n -or [int]$n -le 0) { continue }
    $report = "push ($localSha)"
    $names = @(Invoke-Git @('diff', '--name-only', $range, '--') | Where-Object { $_ })
    Scan-Files -Names $names -Tag 'privacy file'
    if ($names.Count -gt 0) {
      Scan-Text -GitArgs (@('grep', '-n', '-I', '-E', '-f', $patternFile, $localSha, '--') + $names) -Tag 'API key/password'
      if ($privateRules.Count -gt 0) {
        Scan-Warn -GitArgs (@('grep', '-n', '-I', '-E', '-f', $privatePatternFile, $localSha, '--') + $names) -Tag 'personal path/e-mail'
      }
      $pngs = @($names | Where-Object { $_ -like '*.png' })
      if ($pngs.Count -gt 0) {
        Scan-Warn -GitArgs (@('grep', '-a', '-l', '-E', $PNG_RE, $localSha, '--') + $pngs) -Tag 'image metadata'
      }
    }
  }
}

# ---------------- report and exit ----------------
if (-not $patternOk) {
  Write-Host '[guard] ERROR: could not write the pattern file; refusing to continue.'
  exit 1
}
if ($blocked.Count -gt 0) {
  Write-Host ''
  Write-Host '================ DSH privacy guard: BLOCKED ================'
  Write-Host "scope: $report"
  foreach ($b in $blocked) { Write-Host "  $b" }
  Write-Host '  Fix: remove/rewrite the sensitive content, then retry.'
  Write-Host '  Emergency bypass: add --no-verify (at your own risk).'
  Write-Host '============================================================'
  exit 1
}
if ($warned.Count -gt 0) {
  Write-Host ''
  Write-Host '================ DSH privacy guard: WARNINGS ==============='
  foreach ($w in $warned) { Write-Host "  $w" }
  if ($Strict) {
    Write-Host '  -Strict mode: warnings are treated as blocks.'
    Write-Host '============================================================'
    exit 1
  }
  Write-Host '  (warnings do not block; fix them if they are private)'
  Write-Host '============================================================'
}
Write-Host "[guard] passed: $report"
exit 0
