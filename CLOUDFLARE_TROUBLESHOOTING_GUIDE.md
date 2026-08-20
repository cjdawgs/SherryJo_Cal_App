# SherryJo Calendar App - Cloudflare Troubleshooting & Deployment Guide

**Production URL:** https://sherryjo-cal-app.realty-cal.workers.dev/login

---

## Table of Contents

1. [Quick Reference: Common Issues & Solutions](#quick-reference)
2. [Issue Overview: Redirect Loop Fix](#issue-overview)
3. [Architecture Overview](#architecture-overview)
4. [Deployment Instructions](#deployment-instructions)
5. [Verification & Testing Steps](#verification--testing-steps)
6. [Troubleshooting Guide](#troubleshooting-guide)
7. [Git Workflow: Commit & Push](#git-workflow-commit--push)
8. [Redeploy Instructions](#redeploy-instructions)

---

## Quick Reference: Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| **Infinite redirect loop (HTTP 307)** | `html_handling = "none"` in wrangler.toml breaks asset serving | Remove the line from `[assets]` section, redeploy with `wrangler deploy` |
| **Page loads unstyled** | CSS files served as text/plain | Check content-type headers with `curl -I` on static files |
| **JavaScript console errors** | JS files served as text/plain | Same as above - verify content-types |
| **503 Worker assets binding error** | ASSETS binding not configured | Check `[assets]` section exists in wrangler.toml with `binding = "ASSETS"` |
| **Assets return 404** | Asset files missing | Run `wrangler deploy` to upload missing assets from `.worker-assets` directory |
| **Static assets still broken after deploy** | Browser cache stale | Clear browser cache: DevTools → Settings → Clear browser cache |
| **Login page works but calendar UI broken** | Backend (Render) connection issue | Check Render app is running: `curl https://sherryjo-cal-app.onrender.com/health` |

---

## Issue Overview: Redirect Loop Fix

### The Problem
Your app was stuck in an **infinite 307 redirect loop** to `/login`. This happened because:

1. **Root cause:** The `html_handling = "none"` configuration was added to the `[assets]` section in `wrangler.toml`
2. **Impact:** Cloudflare stopped serving HTML files with proper `text/html` content-type headers
3. **Result:** Static assets (HTML, CSS, JS) were rejected by browsers, Worker fell back to proxy requests, which redirected to `/login`, creating a loop

### The Fix
**Removed one line from `wrangler.toml`:**
```toml
# BEFORE (broken):
[assets]
directory = "platform/cloudflare/.worker-assets"
binding = "ASSETS"
run_worker_first = true
html_handling = "none"  # ❌ This broke asset serving

# AFTER (fixed):
[assets]
directory = "platform/cloudflare/.worker-assets"
binding = "ASSETS"
run_worker_first = true
# ✅ Removed html_handling line - default behavior restores HTML serving
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  User Browser (https://sherryjo-cal-app.realty-cal.workers.dev)
└──────────────────┬──────────────────────────────┘
                   │
                   ↓
         ┌─────────────────────┐
         │ Cloudflare Worker   │  ← Main entry point
         │  (platform/cloudflare/src/worker.js)
         └──────────┬──────────┘
                    │
        ┌───────────┴──────────────┐
        ↓                          ↓
    ┌────────────┐        ┌──────────────┐
    │ ASSETS     │        │ Proxy to     │
    │ (Static    │        │ Render       │
    │ HTML/CSS/JS)        │ (Origin API) │
    │ Served via │        └──────────────┘
    │ .worker-   │
    │ assets dir │
    └────────────┘
```

**Key Components:**
- **Cloudflare Worker:** Handles static assets (login.html, index.html, /static/*) and proxies API requests to Render
- **ASSETS Binding:** Maps to `platform/cloudflare/.worker-assets/` directory
- **Render Backend:** Runs FastAPI app at https://sherryjo-cal-app.onrender.com
- **html_handling Setting:** Controls how Cloudflare serves HTML files (removed in fix)

---

## Deployment Instructions

### Method 1: Deploy via Command Line (Recommended)

#### Prerequisites
```bash
# Ensure you're in the project root
cd /workspaces/SherryJo_Cal_App

# Check Node.js is installed (v24+ required)
node --version  # Should show v24.x.x

# Install Cloudflare Wrangler CLI (if not already installed)
npm install -g wrangler
```

#### Deploy to Cloudflare
```bash
# Navigate to project root
cd /workspaces/SherryJo_Cal_App

# Deploy the Worker and assets
wrangler deploy

# Expected output:
# ✨ Read 34 files from the assets directory...
# Uploaded sherryjo-cal-app (4.63 sec)
# Deployed sherryjo-cal-app triggers (0.90 sec)
#   https://sherryjo-cal-app.realty-cal.workers.dev
```

**Deployment takes ~5-10 seconds.** Your app is live once you see the success message.

#### Commit & Push Changes to GitHub
```bash
# Add the fixed wrangler.toml file
git add wrangler.toml

# Commit with descriptive message
git commit -m "Fix: Remove html_handling=none from assets config to restore HTML serving

The html_handling=none setting was preventing Cloudflare from serving static
HTML files with proper text/html content-type headers, causing redirect loops.
This fix restores default Cloudflare asset serving behavior."

# Push to GitHub
git push

# Verify push succeeded
git status  # Should show: "Your branch is up to date with 'origin/main'"
```

### Method 2: Deploy via Cloudflare Dashboard (Manual)

If you prefer GUI deployment:

1. **Log in to Cloudflare Dashboard:**
   - Visit https://dash.cloudflare.com
   - Sign in with your account

2. **Navigate to Workers:**
   - Left sidebar → Workers & Pages → Overview
   - Click on `sherryjo-cal-app` project

3. **Redeploy Latest Version:**
   - Click **Deployments** tab
   - Click **Edit and Deploy** on the latest commit
   - Review changes (should show `wrangler.toml` diff)
   - Click **Deploy** button

4. **Verify Deployment:**
   - Wait for "✓ Deployment Complete" message
   - Test URL: https://sherryjo-cal-app.realty-cal.workers.dev/login

---

## Verification & Testing Steps

### Step 1: Test Login Page Loads (No Redirect Loop)
```bash
# Test with curl (should return 200 or valid 3xx, NOT infinite 307)
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/login

# Expected output:
# HTTP/2 200
# content-type: text/html; charset=utf-8
# cache-control: no-store, max-age=0, must-revalidate
```

**If you still see 307:** The deployment didn't go through or browser cache is stale. Follow Step 2.

### Step 2: Verify Static Asset Content-Types

**Test HTML Asset:**
```bash
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/login
# Expected: content-type: text/html; charset=utf-8
```

**Test JavaScript Asset:**
```bash
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/static/calendar.js
# Expected: content-type: application/javascript or text/javascript
```

**Test CSS Asset:**
```bash
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/static/style.css
# Expected: content-type: text/css or text/css; charset=utf-8
```

**If any return `text/plain`:** Asset serving is broken. Redeploy with `wrangler deploy`.

### Step 3: Browser Testing (Most Important)

1. **Open Your App:**
   - Visit https://sherryjo-cal-app.realty-cal.workers.dev/login in your browser
   - Page should load with proper styling (logo, buttons visible)

2. **Open Browser DevTools:**
   - Press F12 (or Cmd+Shift+I on Mac)
   - Go to **Network** tab
   - Reload the page (Ctrl+R or Cmd+R)

3. **Check Static Assets:**
   - Look at each file in the Network tab
   - Click on `login.html` → **Response Headers** → check `content-type`
   - Should show: `text/html; charset=utf-8`
   - Click on any `.js` file → check `content-type`
   - Should show: `application/javascript`
   - Click on any `.css` file → check `content-type`
   - Should show: `text/css`

4. **Check for Errors in Console:**
   - Go to **Console** tab
   - Look for errors like:
     - ❌ "Failed to load as JavaScript: text/plain"
     - ❌ "Refused to apply style from ... because MIME type is text/plain"
   - If you see these: Asset serving failed, redeploy

5. **Clear Cache If Needed:**
   - DevTools → Settings (gear icon) → Check **Disable cache (while DevTools is open)**
   - Hard refresh: Ctrl+Shift+R (or Cmd+Shift+R on Mac)
   - Reload page again

### Step 4: Test Backend Connectivity

```bash
# Check if Render backend is running
curl https://sherryjo-cal-app.onrender.com/health

# Expected output:
# {"status":"ok","platform":"cloudflare-worker"}
```

If this fails (connection refused, timeout), the Render app may be down. See "Backend Down" section.

---

## Troubleshooting Guide

### Issue 1: Still Seeing 307 Redirect Loop

**Symptoms:**
- Browser shows "redirect loop" error
- Network tab shows multiple GET requests to `/login` with 307 status

**Diagnosis Steps:**
```bash
# Check what wrangler.toml actually contains
cat wrangler.toml | head -15

# Verify html_handling line is GONE
grep -i "html_handling" wrangler.toml
# Should return nothing (no match)

# Check deployment status
wrangler deployments list | head -5
```

**Solutions (in order):**

1. **Verify the fix was applied:**
   ```bash
   # Check local file
   grep -A3 "\[assets\]" wrangler.toml
   # Should show NO html_handling line
   
   # If html_handling still appears: Edit it out manually
   nano wrangler.toml
   # Remove the html_handling = "none" line, save (Ctrl+O, Enter, Ctrl+X)
   ```

2. **Redeploy:**
   ```bash
   wrangler deploy
   # Wait for "Uploaded sherryjo-cal-app" message
   ```

3. **Clear browser cache (CRITICAL):**
   - Press F12 → DevTools Settings (gear icon)
   - Check "Disable cache (while DevTools is open)"
   - Hard refresh: Ctrl+Shift+R
   - Wait 5 seconds, reload

4. **Wait for Cloudflare edge cache to clear:**
   - Cloudflare caches responses globally
   - First request after deploy clears the edge cache
   - Try again in 30 seconds

5. **Check git log to see if fix was actually committed:**
   ```bash
   git log --oneline -5 wrangler.toml
   git show HEAD:wrangler.toml | head -12
   # Verify html_handling is absent
   ```

---

### Issue 2: Page Loads But CSS/JS Not Applied (Unstyled)

**Symptoms:**
- Login page appears but no styling or interactive elements work
- DevTools Console shows errors about CSS/JS MIME types

**Root Cause:** Static assets are served as `text/plain` instead of proper content-types.

**Diagnosis:**
```bash
# Check what content-type CSS is served as
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/static/style.css | grep content-type
# If shows: content-type: text/plain → Asset serving is broken

# Check what content-type JS is served as
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/static/calendar.js | grep content-type
# If shows: content-type: text/plain → Asset serving is broken
```

**Solutions:**

1. **Verify assets directory has files:**
   ```bash
   ls -la platform/cloudflare/.worker-assets/ | head -20
   # Should show index.html, login.html, static/ folder, etc.
   ```

2. **Redeploy assets:**
   ```bash
   wrangler deploy
   # Key line: "✨ Read 34 files from the assets directory"
   # If it says "No updated asset files": Assets already uploaded
   ```

3. **Hard refresh browser (CRITICAL):**
   - DevTools → Network tab → Right-click → Clear browser cache
   - Hard refresh: Ctrl+Shift+R
   - Wait 5-10 seconds for response

4. **Check Cloudflare cache settings:**
   - Go to https://dash.cloudflare.com
   - Navigate to Workers & Pages → sherryjo-cal-app → Settings
   - Scroll to "Purge Cache" → Click "Purge Everything"
   - Wait 1-2 minutes, reload

---

### Issue 3: 503 "Worker assets binding is not configured"

**Symptoms:**
- HTTP 503 response
- Error message: `"error": "Worker assets binding is not configured"`

**Root Cause:** The ASSETS binding is missing or misconfigured.

**Solution:**

1. **Check wrangler.toml `[assets]` section:**
   ```bash
   grep -A5 "\[assets\]" wrangler.toml
   # Must show:
   # [assets]
   # directory = "platform/cloudflare/.worker-assets"
   # binding = "ASSETS"
   # run_worker_first = true
   ```

2. **If binding is missing, add it:**
   ```bash
   nano wrangler.toml
   # Find [vars] section
   # Add above it:
   # [assets]
   # directory = "platform/cloudflare/.worker-assets"
   # binding = "ASSETS"
   # run_worker_first = true
   ```

3. **Redeploy:**
   ```bash
   wrangler deploy
   ```

---

### Issue 4: Assets Return 404 Not Found

**Symptoms:**
- Network tab shows 404 status on static files
- Missing favicon, unstyled page

**Root Cause:** Asset files haven't been uploaded to Cloudflare.

**Diagnosis:**
```bash
# Check if assets directory exists locally
ls -la platform/cloudflare/.worker-assets/
# Should show files and folders

# Check deployment log for asset upload
wrangler deploy --verbose 2>&1 | grep -i asset
# Should show: "✨ Read X files from the assets directory"
```

**Solution:**

1. **Ensure `.worker-assets` directory has files:**
   ```bash
   ls platform/cloudflare/.worker-assets/ | wc -l
   # Should show count > 0
   
   find platform/cloudflare/.worker-assets/ -type f | head -10
   # Should list files like index.html, login.html, etc.
   ```

2. **Redeploy to upload assets:**
   ```bash
   wrangler deploy
   # Look for: "✨ Read 34 files from the assets directory"
   # Wait for: "Uploaded sherryjo-cal-app"
   ```

3. **If still 404 after deploy:**
   - Check exact file paths match what Worker requests
   - Verify no typos in filenames (case-sensitive!)
   - Check asset file isn't larger than Cloudflare limits (100MB per file)

---

### Issue 5: Backend Connection Error (Render App Down)

**Symptoms:**
- Page loads initially, but calendar/data won't load
- Console errors about failed API requests
- `500 Internal Server Error` or `Service Unavailable`

**Diagnosis:**
```bash
# Check if Render backend is alive
curl -I https://sherryjo-cal-app.onrender.com/health

# If shows:
# - Connection refused → App not running
# - 502 Bad Gateway → Render infrastructure issue
# - 200 OK → Backend is healthy
```

**Solutions:**

1. **Check Render Dashboard:**
   - Visit https://dashboard.render.com
   - Click your "sherryjo-cal-app" service
   - Check "Logs" tab for errors
   - Check service status (should be "Live")

2. **Restart Render Service:**
   - In Render dashboard → sherryjo-cal-app service
   - Click "⋮" (More) button → "Restart service"
   - Wait 30-60 seconds for service to become live

3. **Check Render Resource Usage:**
   - Render → sherryjo-cal-app → Metrics
   - CPU usage should be <80%
   - Memory usage should be <512MB (if free tier)
   - If maxed out → Service will be paused

4. **If Service is Paused:**
   - Free tier Render services auto-pause after 15 min inactivity
   - First request after pause takes 30-60 seconds (cold start)
   - To prevent pausing: Upgrade to paid plan or use Render's monitoring

5. **Redeploy Render App:**
   - Render dashboard → sherryjo-cal-app → Manual Deploy
   - Click "Deploy latest commit"
   - Wait for "Live" status

---

### Issue 6: CORS or Cross-Origin Errors

**Symptoms:**
- Console shows: "Access to XMLHttpRequest blocked by CORS policy"
- Calendar data not loading even though login page displays

**Diagnosis:**
```bash
# Check if API requests include proper origin headers
curl -H "Origin: https://sherryjo-cal-app.realty-cal.workers.dev" \
     https://sherryjo-cal-app.realty-cal.workers.dev/calendar/unified \
     -I | grep -i access-control
```

**Solution:**

1. **Check Worker forwards Origin header:**
   ```bash
   # Verify wrangler.toml doesn't strip headers
   grep -i header wrangler.toml
   ```

2. **Check Render CORS settings:**
   - File: `app/main.py` (Render backend)
   - Look for CORS configuration
   - Should allow origin: `https://sherryjo-cal-app.realty-cal.workers.dev`

3. **Restart both services:**
   ```bash
   # Cloudflare
   wrangler deploy
   
   # Then restart Render (via dashboard)
   ```

---

## Git Workflow: Commit & Push

### Scenario 1: You've Made Local Changes to wrangler.toml

```bash
# 1. Check what changed
cd /workspaces/SherryJo_Cal_App
git status
# Should show "modified: wrangler.toml"

# 2. Review the changes
git diff wrangler.toml
# Should show html_handling = "none" line removed

# 3. Stage the file
git add wrangler.toml

# 4. Commit with descriptive message
git commit -m "Fix: Remove html_handling=none from assets config

- Removed problematic html_handling=none setting from [assets] section
- Restores default Cloudflare HTML serving with proper content-types
- Fixes infinite 307 redirect loop to /login
- Assets now served with correct MIME types (text/html, application/javascript, text/css)"

# 5. Push to GitHub
git push

# 6. Verify push succeeded
git status
# Should show: "Your branch is up to date with 'origin/main'"
```

### Scenario 2: You Want to Check Git History

```bash
# See recent commits
git log --oneline -10

# See what changed in wrangler.toml across versions
git log --oneline -- wrangler.toml | head -5

# See the full diff of a specific commit
git show 4efa741:wrangler.toml | head -12
```

### Scenario 3: You Need to Rollback a Bad Change

```bash
# Revert to previous version (if you made a bad change)
git checkout HEAD -- wrangler.toml

# Or revert the last commit entirely
git revert HEAD

# Then push the revert
git push
```

---

## Redeploy Instructions

### Quick Redeploy (All Changes)

```bash
# 1. Commit all changes to git
git add -A
git commit -m "Your descriptive message"
git push

# 2. Deploy to Cloudflare
wrangler deploy

# 3. Verify deployment
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/login
# Should show HTTP/2 200 and proper content-type headers
```

### Redeploy Scenario 1: Only Code Changes (No Config)

```bash
# If you only changed files in platform/cloudflare/src/
cd /workspaces/SherryJo_Cal_App
wrangler deploy
# Cloudflare automatically redeploys Worker code

# Test immediately
curl https://sherryjo-cal-app.realty-cal.workers.dev/health
```

### Redeploy Scenario 2: Only Asset Changes (Static HTML/CSS/JS)

```bash
# If you changed files in platform/cloudflare/.worker-assets/
cd /workspaces/SherryJo_Cal_App
wrangler deploy
# Wrangler detects changes in .worker-assets/ and re-uploads them

# Verify assets were updated
wrangler deploy --verbose 2>&1 | grep -i asset
```

### Redeploy Scenario 3: Config Changes (wrangler.toml)

```bash
# If you changed wrangler.toml (vars, environment, bindings, etc.)
cd /workspaces/SherryJo_Cal_App

# 1. Commit the config change
git add wrangler.toml
git commit -m "Update: [Describe your config change]"
git push

# 2. Deploy with new config
wrangler deploy

# 3. Verify config took effect
wrangler deployments list | head -3
# Check deployment includes your config changes
```

### Redeploy Scenario 4: Full Production Cutover

If making critical changes, use a staged approach:

```bash
# 1. Test locally (if possible)
# 2. Commit to git
git add .
git commit -m "Production: [Detailed change description]"
git push

# 3. Deploy to Cloudflare
wrangler deploy

# 4. Run comprehensive verification
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/login
curl https://sherryjo-cal-app.realty-cal.workers.dev/health
curl https://sherryjo-cal-app.onrender.com/health

# 5. Manual testing (if critical)
# Open https://sherryjo-cal-app.realty-cal.workers.dev/login in browser
# Test key flows: login, calendar view, create event, etc.

# 6. If rollback needed (uncomment and run)
# git revert HEAD
# git push
# wrangler deploy
```

### Redeploy via Cloudflare Dashboard

If you don't have CLI access:

1. **Visit Cloudflare Dashboard:**
   - https://dash.cloudflare.com → Workers & Pages

2. **Navigate to sherryjo-cal-app:**
   - Click on your Worker project

3. **Go to Deployments Tab:**
   - Shows all deployment history
   - Each has commit hash and timestamp

4. **Redeploy Previous Version:**
   - Find the deployment you want
   - Click "⋮" (More options)
   - Click "Rollback to this version"
   - Confirm rollback

5. **Deploy Latest GitHub Commit:**
   - Make changes on GitHub
   - Cloudflare will auto-detect new commits (if integrated)
   - Or manually click "Deploy latest commit"

---

## Monitoring & Alerts

### Monitor Deployment Status

```bash
# Watch deployments in real-time
wrangler deployments list

# Expected output:
# Id          Date                 Message          Status    Author
# abc123...   2026-08-20 20:49:01  Latest deploy    SUCCESS   (auto-deploy)
# def456...   2026-08-20 19:32:15  Previous deploy  SUCCESS   (manual)
```

### Monitor Render Backend

```bash
# Regular health check
curl -s https://sherryjo-cal-app.onrender.com/health | jq .

# Expected response:
# {
#   "status": "ok",
#   "platform": "cloudflare-worker"
# }
```

### Check Cloudflare Worker Metrics

- Visit: https://dash.cloudflare.com → Workers & Pages → sherryjo-cal-app → Analytics
- Monitor:
  - Requests per minute
  - Error rate (4xx, 5xx)
  - Execution time
  - CPU time

---

## Emergency Procedures

### If App is Completely Down

1. **Check status of both platforms:**
   ```bash
   # Cloudflare Worker
   curl -I https://sherryjo-cal-app.realty-cal.workers.dev/health
   
   # Render backend
   curl -I https://sherryjo-cal-app.onrender.com/health
   ```

2. **If Cloudflare is down:**
   - Check https://www.cloudflarestatus.com
   - Wait for Cloudflare to recover OR use Render directly (temporary)

3. **If Render is down:**
   - Go to https://dashboard.render.com
   - Restart the service
   - Check logs for crash reasons

4. **If both are down:**
   - This is catastrophic
   - Check your internet connection
   - Verify GitHub has your latest code
   - Redeploy from scratch (see "Disaster Recovery" below)

### Disaster Recovery: Redeploy from Scratch

```bash
# 1. Ensure you have latest code
cd /workspaces/SherryJo_Cal_App
git pull origin main

# 2. Install dependencies
npm install -g wrangler
npm ci  # Install project dependencies

# 3. Rebuild assets
npm run build  # or whatever build command

# 4. Deploy to Cloudflare
wrangler deploy

# 5. Verify deployment
curl https://sherryjo-cal-app.realty-cal.workers.dev/login

# 6. Restart Render backend (manual via dashboard)
# - https://dashboard.render.com
# - Click sherryjo-cal-app → Restart service
```

---

## Additional Resources

- **Cloudflare Workers Docs:** https://developers.cloudflare.com/workers/
- **Wrangler CLI Docs:** https://developers.cloudflare.com/workers/wrangler/install-and-update/
- **Cloudflare Asset Serving:** https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- **Render Docs:** https://render.com/docs
- **Status Pages:**
  - Cloudflare: https://www.cloudflarestatus.com
  - Render: https://status.render.com

---

## Quick Command Reference

```bash
# Deploy
wrangler deploy

# Check status
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/login

# Verify assets
curl -I https://sherryjo-cal-app.realty-cal.workers.dev/static/calendar.js

# Check backend
curl https://sherryjo-cal-app.onrender.com/health

# View logs (Cloudflare)
wrangler tail

# Commit & push
git add wrangler.toml
git commit -m "Your message"
git push

# Check git log
git log --oneline -5

# Rollback
git revert HEAD
git push
wrangler deploy
```

---

**Last Updated:** 2026-08-20  
**Document Version:** 1.0  
**Tested Against:** wrangler 4.125.0, Cloudflare Workers, Render
