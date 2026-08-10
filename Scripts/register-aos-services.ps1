<#
.SYNOPSIS
    Make AOS start automatically when the office server PC boots. Office server only.

.DESCRIPTION
    Registers `Backend/supervisor.mjs` as a Scheduled Task with an at-startup
    trigger, so AOS comes back on its own after a power cut, a Windows Update
    reboot, or somebody switching the PC off at night.

    WHY A SCHEDULED TASK AND NOT A WINDOWS SERVICE: a real service needs a
    service wrapper (NSSM, WinSW)  -  another binary to install, keep updated and
    explain. Task Scheduler is already on the machine, survives reboots, can run
    as a named account, restarts a failed task, and is inspectable from a GUI
    that whoever inherits this system already knows how to open. For one office
    PC that is the right trade.

    WHAT IT DOES NOT DO: start PostgreSQL. That is its own Windows service,
    installed by the PostgreSQL installer, and it already starts automatically.
    The supervisor waits up to two minutes for it before starting the API, which
    is what stops a slow boot from looking like a broken AOS.

    RUN THIS ON THE DESIGNATED AOS SERVER PC ONLY. Running it on an employee's
    PC starts a second, competing copy of the whole backend against a second,
    empty document store  -  the failure Docs/Deployment Topology.md exists to
    prevent.

.PARAMETER User
    Windows account to run as. Defaults to the current user. Needs to be able to
    read the repo, read/write AOS_STORAGE_ROOT, and reach PostgreSQL.

.PARAMETER TaskName
    Default "AOS Server".

.PARAMETER WhatIf
    Show what would be registered and change nothing. Start here.

.EXAMPLE
    .\Scripts\register-aos-services.ps1 -WhatIf

.EXAMPLE
    .\Scripts\register-aos-services.ps1 -User "AMAZE-SERVER\aos"

.NOTES
    Status:   .\Scripts\aos-status.ps1
    Start:    Start-ScheduledTask -TaskName "AOS Server"
    Stop:     Stop-ScheduledTask  -TaskName "AOS Server"
    Remove:   Unregister-ScheduledTask -TaskName "AOS Server" -Confirm:$false
    Log:      <repo>\Backend\supervisor.log
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [string]$TaskName = "AOS Server"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Supervisor = Join-Path $RepoRoot "Backend\supervisor.mjs"
$LogFile = Join-Path $RepoRoot "Backend\supervisor.log"

if (-not (Test-Path $Supervisor)) {
    throw "Could not find $Supervisor. Run this from inside the AOS checkout."
}

$EnvFile = Join-Path $RepoRoot ".env"
if (-not (Test-Path $EnvFile)) {
    throw ".env does not exist at $EnvFile. Configure the server first  -  see Docs/Installation.md."
}

$Dist = Join-Path $RepoRoot "Frontend\dist\index.html"
if (-not (Test-Path $Dist)) {
    throw "There is no built frontend at $Dist. Run ``npm run build`` before registering the service."
}

# Read back the two settings that decide whether employees can actually reach
# this machine, and say so plainly. A server registered with the loopback
# defaults starts perfectly and is invisible to the whole office  -  the single
# most likely way this install goes quietly wrong.
$apiHost = "127.0.0.1"
$webHost = "127.0.0.1"
$webPort = "4300"
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*AOS_API_HOST\s*=\s*(.+?)\s*$') { $apiHost = $Matches[1].Trim('"').Trim("'") }
    if ($line -match '^\s*AOS_WEB_HOST\s*=\s*(.+?)\s*$') { $webHost = $Matches[1].Trim('"').Trim("'") }
    if ($line -match '^\s*AOS_WEB_PORT\s*=\s*(.+?)\s*$') { $webPort = $Matches[1].Trim('"').Trim("'") }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH for this account. The scheduled task would fail the same way." }

Write-Host ""
Write-Host "  Task name     $TaskName"
Write-Host "  Trigger       at system startup (plus immediately on registration)"
Write-Host "  As user       $User"
Write-Host "  Command       $node $Supervisor"
Write-Host "  Working dir   $RepoRoot"
Write-Host "  Log           $LogFile"
Write-Host ""
Write-Host "  AOS_WEB_HOST  $webHost"
Write-Host "  AOS_API_HOST  $apiHost"
Write-Host ""

if ($webHost -eq "127.0.0.1" -or $webHost -eq "localhost") {
    Write-Warning "AOS_WEB_HOST is $webHost  -  AOS will run but NO OTHER PC WILL BE ABLE TO REACH IT."
    Write-Warning "On the office server set AOS_WEB_HOST=0.0.0.0 in .env, then re-run this script."
    Write-Host ""
} else {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
           Select-Object -First 1).IPAddress
    Write-Host "  Employees will reach AOS at:  http://$ip`:$webPort"
    Write-Host "  Make sure that address is static or DHCP-reserved, and record it in"
    Write-Host "  Docs/Deployment Topology.md. A server whose IP changes on reboot breaks"
    Write-Host "  every bookmark in the office silently."
    Write-Host ""
    Write-Host "  Firewall: allow inbound TCP $webPort. Nothing else needs opening  - "
    Write-Host "  storage (4319) and mail (4320) are loopback-only by design, and the"
    Write-Host "  API is reached through the web server."
    Write-Host ""
}

$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"`"$node`" `"$Supervisor`" >> `"$LogFile`" 2>&1`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtStartup

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

# -ExecutionTimeLimit Zero means "no limit": this task is a server that is
# supposed to run forever, and the default three-day limit would silently kill
# AOS mid-week. -MultipleInstances IgnoreNew is the second line of defence
# behind the supervisor's own PID lock  -  two supervisors kill each other's
# services and present as an application that flickers.

if ($PSCmdlet.ShouldProcess($TaskName, "Register the scheduled task")) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "  A task named '$TaskName' already exists; stopping and replacing it."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -User $User `
        -RunLevel Highest `
        -Description "Runs the AOS backend (web, API, document storage, mail) via Backend/supervisor.mjs. Starts at boot; waits for PostgreSQL before starting the API." | Out-Null

    Write-Host "  Registered."
    Write-Host ""
    Write-Host "  Start it now and check it:"
    Write-Host "      Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host "      .\Scripts\aos-status.ps1"
    Write-Host ""
    Write-Host "  Then REBOOT and run aos-status.ps1 again. An auto-start that has never"
    Write-Host "  survived a real reboot is not known to work."
    Write-Host ""
}
