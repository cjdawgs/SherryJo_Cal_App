# =====================================================
# CONFIG
# =====================================================

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoPath = (Resolve-Path (Join-Path $ScriptRoot "..")).Path
$LogFile = Join-Path $RepoPath "commit_log.txt"

Set-Location $RepoPath

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest


# =====================================================
# LOGGING FUNCTIONS
# =====================================================

function Write-Line($msg) {
    Write-Host $msg
    Add-Content -Path $LogFile -Value $msg -Encoding utf8
}

function Write-Section($title) {
    $line = "==== $title ===="
    Write-Host "`n$line" -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value "`n$line" -Encoding utf8
}

function Write-Header {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $header = @"
========================================================
RUN START: $timestamp
========================================================
"@
    Write-Host $header -ForegroundColor Green
    Add-Content -Path $LogFile -Value $header -Encoding utf8
}

function Write-Footer {
    $footer = @"
========================================================
RUN COMPLETE
========================================================
"@
    Write-Host $footer -ForegroundColor Green
    Add-Content -Path $LogFile -Value $footer -Encoding utf8
}


# =====================================================
# START SCRIPT
# =====================================================

Write-Header


# =====================================================
# USER INPUT
# =====================================================

Write-Host "`nEnter commit summary (press Enter for default):" -ForegroundColor Yellow
$UserSummary = Read-Host "Summary"

if ([string]::IsNullOrWhiteSpace($UserSummary)) {
    $UserSummary = "General update / sync"
}

Write-Line "Summary: $UserSummary"


# =====================================================
# VERIFY REPO
# =====================================================

if (!(Test-Path ".git")) {
    Write-Line "ERROR: Not a git repository"
    exit 1
}

# Block commits while unresolved merge/rebase state exists.
$gitStatusPorcelain = git status --porcelain
$hasUnmerged = $gitStatusPorcelain | Where-Object { $_ -match '^(UU|AA|DD|AU|UA|DU|UD)\s' }
if ($hasUnmerged) {
    Write-Line "ERROR: Unmerged files detected. Resolve conflicts and finish merge/rebase before running this script."
    git status | ForEach-Object { Write-Line $_ }
    exit 1
}

$isRebasing = (Test-Path ".git\rebase-merge") -or (Test-Path ".git\rebase-apply")
if ($isRebasing) {
    Write-Line "ERROR: Rebase appears to still be in progress. Run git rebase --continue (or --abort) first."
    git status | ForEach-Object { Write-Line $_ }
    exit 1
}


# =====================================================
# STATUS BEFORE
# =====================================================

Write-Section "STATUS (BEFORE)"
git status | ForEach-Object { Write-Line $_ }


# =====================================================
# REPOSITORY SIZE (GIT ACTUAL SIZE)
# =====================================================

Write-Section "REPOSITORY SIZE (GIT)"
$gitSizeOutput = git count-objects -vH
$gitSizeOutput | ForEach-Object { Write-Line $_ }

$packSizeLine = $gitSizeOutput | Where-Object { $_ -like "size-pack*" }
if ($packSizeLine) {
    Write-Line "Actual Repo Size: $packSizeLine"
} else {
    Write-Line "Could not determine Git repo size"
}


# =====================================================
# REQUIREMENTS
# =====================================================

Write-Section "UPDATING REQUIREMENTS"

$requirementsFile = "FileRequirements.txt"
$oldHash = $null

if (Test-Path $requirementsFile) {
    $oldHash = (Get-FileHash $requirementsFile).Hash
}

python -m pip freeze | Out-File -Encoding UTF8 $requirementsFile
if ($LASTEXITCODE -ne 0) {
    Write-Line "ERROR: Failed to generate requirements from pip freeze"
    exit 1
}

$newHash = (Get-FileHash $requirementsFile).Hash
if ($oldHash -ne $newHash) {
    Write-Line "Requirements updated"
} else {
    Write-Line "No changes in requirements"
}


# =====================================================
# STAGE
# =====================================================

Write-Section "STAGING FILES"
Write-Host "Choose staging mode:" -ForegroundColor Yellow
Write-Host "  A = All changes (git add -A)" -ForegroundColor Yellow
Write-Host "  T = Tracked files only (git add -u)" -ForegroundColor Yellow
Write-Host "  M = Manual file list" -ForegroundColor Yellow
$stageMode = (Read-Host "Stage mode [A/T/M] (default T)").Trim().ToUpper()
if ([string]::IsNullOrWhiteSpace($stageMode)) {
    $stageMode = "T"
}

switch ($stageMode) {
    "A" {
        git add -A
        if ($LASTEXITCODE -ne 0) {
            Write-Line "ERROR: git add -A failed"
            exit 1
        }
        Write-Line "Staged all changes"
    }
    "M" {
        Write-Line "Enter one or more repo-relative file paths separated by commas"
        git status --short | ForEach-Object { Write-Line $_ }
        $manualList = Read-Host "Files"
        $paths = @($manualList -split "," | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($paths.Count -eq 0) {
            Write-Line "ERROR: No files provided for manual staging"
            exit 1
        }
        git add -- @paths
        if ($LASTEXITCODE -ne 0) {
            Write-Line "ERROR: git add (manual mode) failed"
            exit 1
        }
        Write-Line "Staged manual file list"
    }
    default {
        git add -u
        if ($LASTEXITCODE -ne 0) {
            Write-Line "ERROR: git add -u failed"
            exit 1
        }
        Write-Line "Staged tracked changes only"
    }
}


# =====================================================
# STATUS AFTER
# =====================================================

Write-Section "STATUS (AFTER ADD)"
git status | ForEach-Object { Write-Line $_ }

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Line "No staged changes to commit. Exiting."
    Write-Footer
    exit 0
}


# =====================================================
# COMMIT
# =====================================================

Write-Section "COMMIT"

$TimeStamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$DetailBlock = @"
Date: $TimeStamp
Repo: SherryJo_Cal_App
"@

Write-Line $DetailBlock
git commit -m "$UserSummary" -m "$DetailBlock"
if ($LASTEXITCODE -ne 0) {
    Write-Line "ERROR: git commit failed"
    exit 1
}


# =====================================================
# PUSH
# =====================================================

Write-Section "PUSH"

$currentBranch = git branch --show-current
$hasUpstream = git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null

if (-not $hasUpstream) {
    git push -u origin $currentBranch
} else {
    git push
}

if ($LASTEXITCODE -eq 0) {
    Write-Line "Push successful"
} else {
    Write-Line "Push failed"
    exit 1
}


# =====================================================
# LOG PREVIEW
# =====================================================

Write-Section "RECENT LOG (LAST 10 LINES)"
Get-Content $LogFile | Select-Object -Last 10 | ForEach-Object {
    Write-Host $_
}


# =====================================================
# END
# =====================================================

Write-Footer
