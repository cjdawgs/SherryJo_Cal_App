# App Store Release Checklist

## Package

- [x] iPhone and iPad Xcode project generated
- [x] Bundle identifier configured as `com.sherryjo.calendar`
- [x] Production Cloudflare origin restricted to HTTPS
- [x] No user credentials or deployment secrets embedded
- [x] App icon and splash images generated
- [x] Offline launch page included
- [x] Dependencies pinned by `package-lock.json`
- [ ] In-app SherryJo login-account deletion available and tested

## Apple Developer

- [ ] Bundle identifier registered in Certificates, Identifiers & Profiles
- [ ] App Store Connect app record created
- [ ] Apple Developer team selected in Xcode
- [ ] Version and build number confirmed
- [ ] Archive built and validated in current Xcode
- [ ] Archive uploaded to App Store Connect

## Store Listing

- [ ] Public HTTPS privacy-policy URL
- [ ] Public HTTPS support URL
- [ ] App privacy questionnaire completed
- [ ] Age rating completed
- [ ] iPhone screenshots uploaded
- [ ] iPad screenshots uploaded
- [ ] App description, subtitle, keywords, and category completed
- [ ] Non-admin App Review demonstration account supplied privately in App Review notes
- [ ] Review notes explain calendar-provider authorization and account-deletion flow

## TestFlight

- [ ] Fresh installation opens the production login screen
- [ ] New user registration and existing user login tested
- [ ] Calendar create, update, and delete tested
- [ ] Google, Microsoft, and Apple account connection paths tested as applicable
- [ ] App relaunch preserves the signed-in session
- [ ] Sign-out and login as a different user tested
- [ ] Login-account deletion removes the user and associated data
- [ ] iPhone portrait and landscape checked
- [ ] iPad portrait, landscape, and split view checked