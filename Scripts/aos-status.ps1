<#
.SYNOPSIS
    Is AOS working, and if not, which part is broken?

.DESCRIPTION
    The first thing to run when somebody says "AOS is down". It answers, in
    order, the questions an operator actually has: is PostgreSQL up, are the
    four AOS processes up, can employees reach this machine, is the mail
    provider configured, and when did the last backup succeed.

    Safe to run at any time - it reads and reports, and changes nothing.

    Written because the alternative was a person guessing. AOS is five moving
    parts (PostgreSQL plus four Node processes) and every one of them fails in a
    way that looks identical from a browser: a page that will not load.

    NOTE ON ENCODING: this file is deliberately plain ASCII. Windows PowerShell
    5.1 reads a BOM-less file as ANSI, so a stray en-dash or arrow becomes
    mojibake and then a parse error - which is exactly how the first version of
    this script failed. Keep it ASCII.

.EXAMPLE
    .\Scripts\aos-status.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RepoRoot ".env"

$settings = @{
    AOS_WEB_PORT      = "4300"
    AOS_API_PORT      = "4321"
    AOS_STORAGE_PORT  = "4319"
    AOS_MAIL_PORT     = "4320"
    AOS_DB_PORT       = "5432"
    AOS_DB_NAME       = "aos"
    AOS_WEB_HOST      = "127.0.0.1"
    AOS_STORAGE_ROOT  = "C:\AOS\Data"
    AOS_BACKUP_ROOT   = "C:\AOS\Backups"
    AOS_MAIL_PROVIDER = "unconfigured"
}
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') {
            $settings[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
        }
    }
} else {
    Write-Warning "No .env at $EnvFile - showing defaults. This machine is not configured."
}

function Test-Endpoint($url) {
    try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 4 -UseBasicParsing
        return @{ ok = $true; body = $response.Content }
    } catch {
        return @{ ok = $false; body = $_.Exception.Message }
    }
}

function Show-Line($label, $ok, $detail) {
    if ($ok) { $mark = "  UP  "; $colour = "Green" } else { $mark = " DOWN "; $colour = "Red" }
    Write-Host "[" -NoNewline
    Write-Host $mark -ForegroundColor $colour -NoNewline
    Write-Host "] $($label.PadRight(22)) $detail"
}

Write-Host ""
Write-Host "AOS status - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') on $env:COMPUTERNAME"
Write-Host ("-" * 72)

# --- PostgreSQL -----------------------------------------------------------
$pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgService) {
    Show-Line "PostgreSQL service" ($pgService.Status -eq "Running") "$($pgService.Name) - $($pgService.Status)"
} else {
    Show-Line "PostgreSQL service" $false "no postgresql* service found on this machine"
}

$pgPort = Test-NetConnection -ComputerName "127.0.0.1" -Port $settings.AOS_DB_PORT -InformationLevel Quiet -WarningAction SilentlyContinue
Show-Line "PostgreSQL port" $pgPort "127.0.0.1:$($settings.AOS_DB_PORT), database '$($settings.AOS_DB_NAME)'"

# --- The four AOS processes -----------------------------------------------
$web = Test-Endpoint "http://127.0.0.1:$($settings.AOS_WEB_PORT)/health"
Show-Line "AOS web server" $web.ok "port $($settings.AOS_WEB_PORT)"

$api = Test-Endpoint "http://127.0.0.1:$($settings.AOS_API_PORT)/api/health"
Show-Line "AOS API" $api.ok "port $($settings.AOS_API_PORT)"

$storage = Test-Endpoint "http://127.0.0.1:$($settings.AOS_STORAGE_PORT)/health"
Show-Line "Document storage" $storage.ok "port $($settings.AOS_STORAGE_PORT) (loopback only, by design)"

$mail = Test-Endpoint "http://127.0.0.1:$($settings.AOS_MAIL_PORT)/health"
if ($mail.ok) {
    $mailBody = $mail.body | ConvertFrom-Json
    $configured = $mailBody.configured -eq $true
    if ($configured) {
        $note = "provider '$($mailBody.provider)' - able to send"
    } else {
        $note = "provider '$($mailBody.provider)' - RUNNING BUT CANNOT SEND"
    }
    Show-Line "Mail backend" $true "port $($settings.AOS_MAIL_PORT), $note"
    if (-not $configured) {
        Write-Host "        Submissions will be refused with a clear message until Gmail is configured (.env.example)." -ForegroundColor Yellow
    }
    if ($mailBody.provider -eq "capture") {
        Write-Host "        *** CAPTURE MODE: nothing is actually sent. This must never be an office install. ***" -ForegroundColor Red
    }
} else {
    Show-Line "Mail backend" $false "port $($settings.AOS_MAIL_PORT)"
}

# --- Reachability from other PCs ------------------------------------------
Write-Host ("-" * 72)
$loopbackOnly = $settings.AOS_WEB_HOST -in @("127.0.0.1", "localhost")
if ($loopbackOnly) {
    Show-Line "Employee access" $false "AOS_WEB_HOST=$($settings.AOS_WEB_HOST) - no other PC can reach this machine"
    Write-Host "        Correct for a development checkout. On the office server set AOS_WEB_HOST=0.0.0.0." -ForegroundColor Yellow
} else {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
           Select-Object -First 1).IPAddress
    Show-Line "Employee access" $true "http://$ip`:$($settings.AOS_WEB_PORT)"

    $rule = Get-NetFirewallRule -DisplayName "AOS*" -ErrorAction SilentlyContinue
    if ($rule) {
        Show-Line "Firewall rule" ($rule.Enabled -contains "True") "$($rule.DisplayName -join ', ')"
    } else {
        Show-Line "Firewall rule" $false "no rule named 'AOS*' - inbound TCP $($settings.AOS_WEB_PORT) may be blocked"
    }
}

# --- Scheduled tasks ------------------------------------------------------
Write-Host ("-" * 72)
foreach ($name in @("AOS Server", "AOS Nightly Backup")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        $info = $task | Get-ScheduledTaskInfo
        $healthy = $task.State -ne "Disabled"
        Show-Line $name $healthy "$($task.State); last run $($info.LastRunTime), result $($info.LastTaskResult)"
    } else {
        Show-Line $name $false "not registered (see Scripts/register-*.ps1)"
    }
}

# --- Storage and backups --------------------------------------------------
Write-Host ("-" * 72)
$docs = Join-Path $settings.AOS_STORAGE_ROOT "Documents"
if (Test-Path $docs) {
    $files = Get-ChildItem $docs -Recurse -File -ErrorAction SilentlyContinue
    $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
    Show-Line "Document store" $true "$($settings.AOS_STORAGE_ROOT) - $($files.Count) file(s), $mb MB"
} else {
    Show-Line "Document store" $false "$docs does not exist"
}

if (Test-Path $settings.AOS_BACKUP_ROOT) {
    $runs = Get-ChildItem $settings.AOS_BACKUP_ROOT -Directory -ErrorAction SilentlyContinue | Sort-Object Name
    if ($runs.Count -gt 0) {
        $newest = $runs[-1]
        $age = (New-TimeSpan -Start $newest.CreationTime -End (Get-Date)).TotalHours
        $fresh = $age -lt 36
        Show-Line "Last backup" $fresh "$($newest.Name) - $([math]::Round($age,1))h ago, $($runs.Count) run(s) retained"
        if (-not $fresh) {
            Write-Host "        The most recent backup is over 36 hours old. Check the nightly task." -ForegroundColor Yellow
        }
        Write-Host "        Prove it is restorable:  npm run backup:verify" -ForegroundColor DarkGray
    } else {
        Show-Line "Last backup" $false "$($settings.AOS_BACKUP_ROOT) exists but holds no backup runs"
    }
} else {
    Show-Line "Last backup" $false "$($settings.AOS_BACKUP_ROOT) does not exist - NO BACKUP HAS EVER RUN"
}

Write-Host ("-" * 72)
Write-Host ""
