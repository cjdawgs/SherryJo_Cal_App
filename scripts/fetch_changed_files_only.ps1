# =====================================================
# APPLY CODESPACES UNCOMMITTED PATCH TO LOCAL DESKTOP
# =====================================================
#
# Use this when you already have the uncommitted work from GitHub Codespaces
# and want your local desktop repo to mirror that exact working tree.
#
# In Codespaces, create the patch first with:
#   git add -A
#   git diff --cached --binary > ~/codespace-changes.patch
#   git reset
#
# Then run this script on your desktop:
#   .\scripts\fetch_changed_files_only.ps1 -RepoPath "C:\path\to\SherryJo_Cal_App" -PatchFile "C:\path\to\codespace-changes.patch"
#   or, if you have a URL for the patch file:
#   .\scripts\fetch_changed_files_only.ps1 -RepoPath "C:\path\to\SherryJo_Cal_App" -PatchUrl "https://example.com/codespace-changes.patch"
#   or, if you want the script to create and download the patch from your Codespace automatically:
#   .\scripts\fetch_changed_files_only.ps1 -RepoPath "C:\path\to\SherryJo_Cal_App"
#   or, if you can SSH to your Codespace and want the script to create the patch remotely for you:
#   .\scripts\fetch_changed_files_only.ps1 -RepoPath "C:\path\to\SherryJo_Cal_App" -RemoteHost "YOUR_CODESPACE_HOST" -RemoteUser "codespace" -RemoteRepoPath "/workspaces/SherryJo_Cal_App"
#
# This script does NOT commit, push, or fetch anything.
# =====================================================

function Invoke-CodespacePatchDownload {
    param(
        [string]$RepoPath,
        [string]$PatchFile,
        [string]$RemoteRepoPath,
        [string]$RemotePatchPath
    )

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        return $false
    }

    $authCheck = & gh auth status 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    $repoSlug = ""
    try {
        $repoInfo = & gh repo view --json nameWithOwner 2>$null
        if ($LASTEXITCODE -eq 0 -and $repoInfo) {
            $repoSlug = ($repoInfo | ConvertFrom-Json).nameWithOwner
        }
    }
    catch {
        $repoSlug = ""
    }

    if (-not $repoSlug) {
        $remoteUrl = & git -C $RepoPath config --get remote.origin.url 2>$null
        if ($LASTEXITCODE -eq 0 -and $remoteUrl) {
            if ($remoteUrl -match 'github\.com[:/](.+?/.+?)(?:\.git)?$') {
                $repoSlug = $Matches[1]
            }
        }
    }

    $codespaceList = @()
    if ($repoSlug) {
        $codespaceList = & gh codespace list --repo $repoSlug --json name,repository 2>$null
    }
    else {
        $codespaceList = & gh codespace list --json name,repository 2>$null
    }

    if ($LASTEXITCODE -ne 0 -or -not $codespaceList) {
        return $false
    }

    try {
        $codespaces = $codespaceList | ConvertFrom-Json
    }
    catch {
        return $false
    }

    $codespaceName = $null
    if ($codespaces -is [array]) {
        foreach ($item in $codespaces) {
            if ($repoSlug -and $item.repository -eq $repoSlug) {
                $codespaceName = $item.name
                break
            }
        }
        if (-not $codespaceName -and $codespaces.Count -gt 0) {
            $codespaceName = $codespaces[0].name
        }
    }
    elseif ($codespaces) {
        $codespaceName = $codespaces.name
    }

    if (-not $codespaceName) {
        return $false
    }

    $parentDir = Split-Path -Parent $PatchFile
    if ($parentDir) {
        New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
    }

    $remoteCommand = "cd '$RemoteRepoPath' && git add -A && git diff --cached --binary > '$RemotePatchPath' && git reset"
    Write-Host "Creating patch inside your Codespace..." -ForegroundColor Cyan
    & gh codespace ssh -c $codespaceName -- "bash -lc `"$remoteCommand`"" 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    Write-Host "Downloading patch from your Codespace..." -ForegroundColor Cyan
    & gh codespace cp -c $codespaceName "remote:$RemotePatchPath" $PatchFile 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    return $true
}

param(
    [string]$RepoPath = "C:\Users\e201503110\OneDrive - Gwinnett County Public Schools\Desktop\Python\Chips Home Stuff\SherryJo Calendar App\Python Code\SherryJo_Cal_App",
    [string]$PatchFile = (Join-Path $PSScriptRoot "codespace-changes.patch"),
    [string]$PatchUrl,
    [string]$RemoteHost,
    [string]$RemoteUser = "codespace",
    [string]$RemoteRepoPath = "/workspaces/SherryJo_Cal_App",
    [string]$RemotePatchPath = "/home/codespace/codespace-changes.patch",
    [string]$SshKeyPath,
    [switch]$PromptForRemote
)

if (-not (Test-Path $RepoPath)) {
    Write-Host "RepoPath not found: $RepoPath" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $PatchFile)) {
    if ($PatchUrl) {
        Write-Host "Downloading patch from $PatchUrl ..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $PatchUrl -OutFile $PatchFile -UseBasicParsing
        }
        catch {
            Write-Host "Patch download failed: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    }
    elseif ($RemoteHost -or $PromptForRemote) {
        if (-not $RemoteHost) {
            $RemoteHost = Read-Host "Enter your Codespace host (for example: ssh.dev.azure.com or your SSH endpoint)"
        }
        if (-not $RemoteHost) {
            Write-Host "No remote host provided. Aborting." -ForegroundColor Red
            exit 1
        }

        Write-Host "Creating patch remotely on $RemoteHost ..." -ForegroundColor Cyan

        $sshTarget = if ($RemoteUser) { "$RemoteUser@$RemoteHost" } else { $RemoteHost }
        $sshArgs = @()
        if ($SshKeyPath) {
            $sshArgs += @("-i", $SshKeyPath)
        }

        $remoteCommand = "cd '$RemoteRepoPath' && git add -A && git diff --cached --binary > '$RemotePatchPath' && git reset"
        & ssh @sshArgs $sshTarget "bash -lc '$remoteCommand'"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Remote patch creation failed." -ForegroundColor Red
            exit 1
        }

        & scp @sshArgs "$sshTarget:$RemotePatchPath" $PatchFile
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Remote patch download failed." -ForegroundColor Red
            exit 1
        }
    }
    else {
        Write-Host "Trying to create and download the patch directly from your Codespace..." -ForegroundColor Cyan
        $codespaceSyncSuccess = Invoke-CodespacePatchDownload -RepoPath $RepoPath -PatchFile $PatchFile -RemoteRepoPath $RemoteRepoPath -RemotePatchPath $RemotePatchPath
        if (-not $codespaceSyncSuccess) {
            Write-Host "Patch file not found: $PatchFile" -ForegroundColor Red
            Write-Host "Create it in Codespaces with: git add -A; git diff --cached --binary > ~/codespace-changes.patch; git reset" -ForegroundColor Yellow
            exit 1
        }
    }
}

Set-Location $RepoPath

# Verify this is a git repo before doing anything.
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not a git repository: $RepoPath" -ForegroundColor Red
    exit 1
}

$workingTreeStatus = git status --porcelain
if ($workingTreeStatus) {
    Write-Host "Local working tree is not clean." -ForegroundColor Yellow
    Write-Host "Please commit, stash, or discard your local changes first so the patch can be applied safely." -ForegroundColor Yellow
    Write-Host ""
    git status --short
    exit 1
}

$backupDir = Join-Path $RepoPath "_backup_before_codespace_patch"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$timeTag = Get-Date -Format "yyyyMMdd_HHmmss"
$patchBackupPath = Join-Path $backupDir ("patch_" + $timeTag + ".patch")
Copy-Item $PatchFile $patchBackupPath -Force

Write-Host ""
Write-Host "Validating patch..." -ForegroundColor Cyan
git apply --check --verbose $PatchFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "Patch validation failed. There may be conflicts or a mismatched repo state." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Applying patch to local working tree..." -ForegroundColor Cyan
git apply --verbose $PatchFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "Patch apply failed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Patch applied successfully." -ForegroundColor Green
Write-Host "Backup of patch saved to: $patchBackupPath" -ForegroundColor Green
Write-Host ""
Write-Host "==== FINAL STATUS ====" -ForegroundColor Cyan
git status --short
Write-Host ""
Write-Host "No commit or push was performed." -ForegroundColor DarkCyan
