# Canary setup checklist

Use these steps in order. This is the careful, brain-surgery version: one step at a time, no guessing, no shortcuts.

1. Pick the canary name
- Use the canary name `sherryjo-cal-app-canary`.
- Write it down exactly.
- Make sure this is the one you want to test before changing anything else.

2. Tell Google about it
- Add the exact canary callback URL to Google OAuth.
- Use the full HTTPS URL.
- Double-check the path and host. One tiny mismatch breaks the login flow.

3. Tell Microsoft about it
- Add the exact same canary callback URL to Microsoft OAuth.
- Make sure it matches exactly, character for character.
- Do not assume Google and Microsoft use the same format.

4. Put the secrets in place
- This means: add the hidden passwords and keys the canary needs.
- Some of these are new just for the canary.
- Some of these must be the same as the ones the app already uses.
- Do not type the secret values into Git, chat, or notes.
- If you do not have one of the values yet, stop and get it before going on.
- Run these one at a time so each value stays hidden:
```bash
npx --yes wrangler@4 secret put EDGE_PROXY_SECRET --env canary
npx --yes wrangler@4 secret put JWT_PUBLIC_KEYS_JSON --env canary
npx --yes wrangler@4 secret put GOOGLE_CLIENT_SECRET --env canary
npx --yes wrangler@4 secret put MS_CLIENT_SECRET --env canary
npx --yes wrangler@4 secret put TOKEN_ENCRYPTION_KEY --env canary
npx --yes wrangler@4 secret put JWT_PRIVATE_KEY --env canary
```
- Use the same `EDGE_PROXY_SECRET` value in both places that need it.
- If any secret is missing, stop before deploying.

5. Deploy the canary Worker
- Run the canary deploy from the repository.
- Wait for the deployment to finish.
- Check that the canary URL responds.
- If the deploy fails, do not guess. Read the error and fix the cause.

6. Run the first live smoke test
- Open the canary URL.
- Check health.
- Check login.
- Check one basic read.
- Check one basic write.
- If any check fails, stop and investigate before moving on.

7. Keep the rollback path ready
- Before you move any traffic, make sure you know how to undo the change.
- Keep the old working path available until the canary passes.
- Do not remove the backup path until the new one is proven.

8. If something fails, stop and fix it
- Do not move on just because something looks close.
- Fix the problem first, then try again.
- The goal is a clean, working canary, not a rushed one.
