# FireTV Remote Behavior: Detailed Reference

This document describes the current remote-input model used by the TV dashboard.

## Scope and Limits

- The app can control which keys trigger calendar actions.
- The app cannot disable FireTV OS-level or TV firmware-level operations.
- Buttons such as Home, Power, and often Volume are typically owned by FireTV OS or the TV.

## Tri-State Input Mode

The app now uses a tri-state mode model persisted per device:

- `NAV`
: Arrow keys navigate focus across day/week/month and sidebar regions.

- `CURSOR`
: Arrow keys move a virtual cursor, and Select clicks at the cursor point.

- `LOCKED`
: App-level remote actions are paused. The dashboard ignores navigation/select/zoom shortcuts.

### Mode transitions

- Triple Select cycles `NAV <-> CURSOR`.
- Triple Select while `LOCKED` unlocks to `NAV`.
- Settings panel includes explicit mode toggles and lock/unlock actions.
- Keyboard fallback `R` toggles between NAV and CURSOR (or unlocks from LOCKED to NAV).

## Device Capability Detection and Persistence

The app records observed keys and persists capability flags in local storage.

Storage keys:

- `tv_remote_capabilities_v1`
- `tv_input_mode`

Detected capability buckets:

- Arrows
- Select
- Back
- Menu/Context
- Volume
- Media (FF/REW)
- Channel (+/-)
- Mute

The app uses these capability flags to produce dynamic control hints and settings guidance.

## Dynamic Help Text

Lower-right footer help text is dynamic and shows only confirmed controls for the current device.

Examples:

- `Arrows navigate • SELECT open • Long SELECT create • Triple SELECT mode • BACK close • +/- hold zoom`
- If volume keys are not detected: `... • Zoom from Settings`
- In lock mode: `Mode locked • Triple SELECT unlock • Settings to change mode`

## Automatic Update Propagation

After one manual refresh to pick up this feature, future deployments propagate automatically to active TV sessions.

How it works:

- Backend emits an app version signal (`appVersion` in `/tv/events` payload and `X-TV-App-Version` response header).
- TV client compares server version to the in-memory client version during the existing poll cycle.
- If different, client shows a subtle notice and schedules reload after a short delay.
- Script URLs are cache-busted with `?v={{ app_version }}` so reload fetches the new bundle.

One-time caveat:

- A tab already running older JS cannot gain this logic until it refreshes once.

## Center-Lower Remote Action Echo

A subtle center-lower status bubble now echoes the action path taken by remote input.

Examples:

- `Nav Left`
- `Select`
- `Double Select`
- `Long Select Create`
- `Zoom In`
- `Mode CURSOR`
- `Mode LOCKED`

This echo is intentionally concise and aligned with naming used in documentation.

## FireTV OS-Owned vs App-Handled Keys

This varies by remote model, firmware, and HDMI-CEC setup, but practical behavior is:

Typically OS/TV-owned:

- Home
- Power
- Volume + / -
- Mute
- Voice/Microphone
- Vendor app shortcut keys

Typically app-available:

- Arrow keys
- Select/Enter
- Back

Sometimes app-available (device-dependent):

- Menu/Context
- Play/Pause
- Fast Forward/Rewind
- Channel + / -

## Mapping Strategy

To avoid unsupported UX promises, core navigation is designed around reliably app-available keys:

- Arrows
- Select
- Back

Optional keys are treated as accelerators:

- Volume or FF/REW or CH+/- for zoom behavior when detected.

## User-Visible Status Correlation

Lower-left status always reflects current app input mode and zoom:

- `Mode NAV • Zoom 100%`
- `Mode CURSOR • Zoom 150%`
- `Mode LOCKED • Zoom 100%`

Center-lower action echo confirms the immediate action path triggered by the remote key.

Together, these two statuses tell the operator:

- what input mode is active, and
- what action the last remote press actually triggered.
