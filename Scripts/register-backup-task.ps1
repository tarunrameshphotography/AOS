<#
.SYNOPSIS
    Register the nightly AOS backup as a Windows Scheduled Task. Office server only.

.DESCRIPTION
    A backup that depends on somebody remembering to type `npm run backup` is not
    a backup strategy. This registers it with the Windows Task Scheduler so it
    runs unattended, and  -  because `Backend/backup.mjs` verifies every run before
    it prunes anything  -  an unattended run that produces an unreadable dump exits
    non-zero and leaves the previous backups untouched.

    RUN THIS ON THE OFFICE SERVER PC ONLY. It is the machine that has the
    database and the document store; a scheduled backup on any other PC would
    back up an empty install over the top of the retention window.

    The task is registered to run as the account you name, because it needs to
    read AOS_DB_PASSWORD from the repository's .env and write to AOS_BACKUP_ROOT
    (frequently a mapped drive, which SYSTEM cannot see). It is registered with
    -RunLevel Highest only if the backup destination requires it.

.PARAMETER Time
    Local time to run, HH:mm. Default 20:30  -  after the office closes, so the
    document tree is not being written to mid-copy.

.PARAMETER User
    The Windows account to run as. Defaults to the current user. You will be
    prompted for its password by Windows (this script never handles it).

.PARAMETER TaskName
    Default "AOS Nightly Backup".

.PARAMETER WhatIf
    Show exactly what would be registered and change nothing. Start here.

.EXAMPLE
    # See what it would do  -  always do this first.
    .\Scripts\register-backup-task.ps1 -WhatIf

.EXAMPLE
    # Register it for real, running at 20:30 as the office AOS account.
    .\Scripts\register-backup-task.ps1 -Time 20:30 -User "AMAZE-SERVER\aos"

.NOTES
    To inspect afterwards:   Get-ScheduledTask -TaskName "AOS Nightly Backup" | Get-ScheduledTaskInfo
    To run it by hand:       Start-ScheduledTask -TaskName "AOS Nightly Backup"
    To remove it:            Unregister-ScheduledTask -TaskName "AOS Nightly Backup" -Confirm:$false
    Logs:                    <AOS_BACKUP_ROOT>\backup-log.txt
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Time = "20:30",
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [string]$TaskName = "AOS Nightly Backup"
)

$ErrorActionPreference = "Stop"

# The repository root is this script's parent  -  no assumption about where the
# operator's shell happens to be sitting.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackupScript = Join-Path $RepoRoot "Backend\backup.mjs"

if (-not (Test-Path $BackupScript)) {
    throw "Could not find $BackupScript. Run this script from inside the AOS checkout."
}

$EnvFile = Join-Path $RepoRoot ".env"
if (-not (Test-Path $EnvFile)) {
    throw ".env does not exist at $EnvFile. Configure the server first (see Docs/Installation.md)  -  an unconfigured backup would silently back up the wrong database."
}

# Read AOS_BACKUP_ROOT out of .env so the log lands beside the backups rather
# than somewhere only this script knows about.
$BackupRoot = "C:\AOS\Backups"
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*AOS_BACKUP_ROOT\s*=\s*(.+?)\s*$') {
        $BackupRoot = $Matches[1].Trim('"').Trim("'")
    }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH for this account. The scheduled task would fail the same way." }

$LogFile = Join-Path $BackupRoot "backup-log.txt"

# cmd.exe wrapper rather than node directly: it is what gives us the append
# redirect, so a failed unattended run leaves evidence instead of vanishing.
$Action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"`"$node`" `"$BackupScript`" >> `"$LogFile`" 2>&1`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

# -StartWhenAvailable matters on an office PC: it is routinely switched off at
# 20:30 on a Saturday, and without this the run is simply skipped rather than
# caught up at the next boot.

Write-Host ""
Write-Host "  Task name     $TaskName"
Write-Host "  Runs          daily at $Time"
Write-Host "  As user       $User"
Write-Host "  Command       $node $BackupScript"
Write-Host "  Working dir   $RepoRoot"
Write-Host "  Log           $LogFile"
Write-Host "  Backups to    $BackupRoot"
Write-Host ""

if (-not (Test-Path $BackupRoot)) {
    if ($PSCmdlet.ShouldProcess($BackupRoot, "Create the backup destination folder")) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
        Write-Host "  Created $BackupRoot"
    }
}

$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest

# S4U rather than the Register-ScheduledTask -User/-RunLevel default
# (InteractiveToken): the same non-interactive logon fix as
# register-aos-services.ps1, applied here for consistency.

if ($PSCmdlet.ShouldProcess($TaskName, "Register the scheduled task")) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "  A task named '$TaskName' already exists; it will be replaced."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Principal $Principal `
        -Description "Nightly AOS backup: pg_dump of the operational database plus a copy of the document store, verified before retention prunes anything (Backend/backup.mjs)." | Out-Null

    Write-Host ""
    Write-Host "  Registered."
    Write-Host ""
    Write-Host "  VERIFY IT NOW, do not wait for tonight:"
    Write-Host "      Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host "      Get-Content '$LogFile' -Tail 30"
    Write-Host ""
    Write-Host "  Then confirm the run is genuinely restorable:"
    Write-Host "      npm run backup:verify"
    Write-Host ""
}
