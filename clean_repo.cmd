@echo off
echo ========================================
echo CLEANING GIT REPOSITORY (FULL RESET)
echo ========================================

REM ========================================
REM STEP 1 - VERIFY IN PROJECT ROOT
REM ========================================
echo Current Directory:
cd

REM ========================================
REM STEP 2 - DELETE .GIT folder (THIS IS THE BIG FIX)
REM ========================================
echo.
echo Deleting .git folder (removes all history)...

IF EXIST .git (
    rmdir /s /q .git
    echo ✅ .git folder removed
) ELSE (
    echo ⚠️ No .git folder found
)

REM ========================================
REM STEP 3 - RECREATE REPO
REM ========================================
echo.
echo Reinitializing Git repo...
git init

REM ========================================
REM STEP 4 - ADD FILES (RESPECTS .gitignore)
REM ========================================
echo.
echo Staging clean files...
git add .

REM ========================================
REM STEP 5 - COMMIT
REM ========================================
echo.
echo Committing clean repo...
git commit -m "🔥 Clean repo (removed large history, fresh start)"

REM ========================================
REM STEP 6 - SET MAIN BRANCH
REM ========================================
git branch -M main

REM ========================================
REM STEP 7 - ADD REMOTE (YOU MUST EDIT THIS)
REM ========================================

REM ⚠️ >>> CHANGE THIS LINE TO YOUR ACTUAL REPO URL <<< ⚠️
set REPO_URL=https://github.com/cjdawgs/SherryJo_Cal_App.git

echo.
echo Adding remote origin...
git remote remove origin 2>nul
git remote add origin %REPO_URL%

REM ========================================
REM STEP 8 - FORCE PUSH CLEAN VERSION
REM ========================================
echo.
echo FORCE PUSHING CLEAN REPO...
git push -f origin main

echo.
echo ========================================
echo ✅ CLEAN REPO COMPLETE
echo ========================================
pause