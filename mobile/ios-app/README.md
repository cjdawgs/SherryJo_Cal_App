# SherryJo Calendar for iPhone and iPad

This directory is the App Store source package for the production Cloudflare application.

The binary contains no user email, password, calendar-provider credential, database URL, or deployment secret. On first launch it opens the production login screen. The user signs in or creates an account, and the server-issued session scopes calendar data to that user.

## Package status

The Capacitor project, Xcode project, iPhone/iPad configuration, branded icon, splash artwork, production URL allowlist, offline page, and dependency lockfile are generated. Run `npm run package:source` to create the portable Xcode source archive under `artifacts/mobile/`.

A signed `.ipa` cannot be produced in this Linux workspace. Apple requires macOS, Xcode, an active Apple Developer Program membership, an App Store Connect app record, and signing certificates.

Before App Store submission, add an in-app way for a signed-in user to delete their SherryJo login account and associated data. The current account deletion UI disconnects calendar providers only; Apple treats that differently from deleting the app login account.

## Production configuration

- App name: `SherryJo Calendar`
- Bundle ID: `com.sherryjo.calendar`
- Production URL: `https://sherryjo-cal-app.realty-cal.workers.dev/login`
- Devices: iPhone and iPad
- Transport: HTTPS only

## Build on a Mac

1. Install current Xcode from the Mac App Store and open it once.
2. Install Node.js 24 or newer.
3. In Terminal, change to this directory.
4. Run `npm ci`.
5. Run `npm run assets`.
6. Run `npm run sync`.
7. Run `npm run open`.
8. In Xcode, select the `App` project and the `App` target.
9. Under **Signing & Capabilities**, select the Apple Developer team.
10. Confirm the bundle identifier is available. If not, replace `com.sherryjo.calendar` in Xcode and `capacitor.config.ts` with an identifier owned by that team.
11. Select **Any iOS Device (arm64)**, then choose **Product > Archive**.
12. In Organizer, choose **Distribute App > App Store Connect > Upload**.

## App Store Connect

Create the app record with the same bundle ID before uploading. Provide iPhone and iPad screenshots, support and privacy-policy URLs, an age rating, and App Review credentials for a non-admin demonstration account. Do not place real production credentials in this repository or in App Store review notes visible outside App Review.

The App Store privacy questionnaire must disclose the account and calendar data the production service collects and links to a user. The privacy-policy and support URLs must be public HTTPS pages, not repository files or private documents.

The upload must be signed on macOS with an active Apple Developer Program membership. Linux and Windows can validate and maintain this package but cannot produce the signed App Store archive.