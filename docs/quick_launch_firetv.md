# SherryJo FireTV Quick Launch Guide

This guide covers the FireTV remote behavior for the TV dashboard and kiosk display. It is written for 10 to 20 foot viewing and remote-only operation.

## Start Here

1. Open the TV dashboard.
2. Pair the TV once with the pairing code from the admin TV Mode flow.
3. Use the FireTV remote to navigate, edit, zoom, and return Home.

## Remote Map

### Select / Enter

- Single press: select the current item or open/edit the focused event or sticky note.
- Long press 600ms: create a new event on day/week views or a new sticky note on month view.
- Triple press: cycle NAV and CURSOR modes.
- In LOCKED mode, triple press unlocks back to NAV mode.

### + Button

- Single press: move focus forward through interactive items.
- Long press 600ms: Zoom In one supported level.
- FireTV note: some remotes route volume keys to system volume only; if so, use long press FF or Channel Up for zoom in.

### - Button

- Single press: move focus backward through interactive items.
- Long press 600ms: Zoom Out one supported level.
- FireTV note: if volume down is OS-captured, use long press REW or Channel Down for zoom out.

### Input Modes

- Mode NAV: arrow keys navigate calendar focus and sections.
- Mode CURSOR: arrow keys move a virtual cursor and Select clicks at cursor position.
- Mode LOCKED: app-level remote actions are paused (OS-level FireTV/TV actions still run).
- Settings panel includes direct mode toggles and lock/unlock actions.

### F / Home

- Returns to Day view.
- Loads the saved Home Zoom preference automatically.

### Back / Escape

- Closes the editor, panel, or focused overlay.
- Returns to Day view when no overlay is active.

### Action Echo (center-lower)

- A subtle status bubble appears near the lower center after remote actions.
- It shows concise action words such as `Nav Left`, `Select`, `Long Select Create`, `Zoom In`, `Mode LOCKED`.
- These words match the behavior naming used in this guide.

### Mute

- Toggles the remote debug overlay.

## Zoom Levels

Supported zoom levels are discrete and stable:

- 100%
- 110%
- 125%
- 150%
- 175%
- 200%

Zoom persists across refreshes and restarts using `tv_zoom_level`.

## Home Zoom

Use the TV Settings panel and choose **Save Current As Home** to persist the current zoom as the Home/F default.

When you return Home with F, the dashboard opens at that saved zoom level.

## Visible Settings Panel

Open **Settings** from the sidebar to see:

- Current zoom level
- Home zoom level
- Zoom in / zoom out actions
- Save current zoom as home
- Restore home zoom now
- Reset to 100%
- Lock/Unlock remote input mode
- Detected controls on this specific device

## Footer Status

The footer shows the current navigation mode and zoom state, for example:

- `Mode NAV • Zoom 100%`
- `Mode CURSOR • Zoom 150%`
- `Mode LOCKED • Zoom 100%`

The right side help text is dynamic and only advertises controls confirmed on this device.

## Editing and Navigation

- Single Select: edit the focused event or sticky note.
- Double Select: open the context action.
- Create / Edit workflows are unchanged.
- Undo / Redo remain available in the sidebar.

## Kiosk Mode

Kiosk mode uses the same persistent token policy as TV pairing. It stays signed in until the token is explicitly revoked or the signing secret changes.

## Automatic Updates

- After one refresh on each TV, future deployments auto-propagate.
- When a new app version is detected, TV shows a subtle update notice and reloads automatically after a short delay.

## Behavior Summary

- Single press + and - still move focus.
- Long press + and - now control zoom.
- F restores the saved Home Zoom.
- Zoom changes are persisted immediately.
- Cursor and debug overlays stay unscaled.