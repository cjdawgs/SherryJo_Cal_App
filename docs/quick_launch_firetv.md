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

### + Button

- Single press: move focus forward through interactive items.
- Long press 600ms: Zoom In one supported level.

### - Button

- Single press: move focus backward through interactive items.
- Long press 600ms: Zoom Out one supported level.

### F / Home

- Returns to Day view.
- Loads the saved Home Zoom preference automatically.

### Back / Escape

- Closes the editor, panel, or focused overlay.
- Returns to Day view when no overlay is active.

### Triple Select

- Toggles Arrow Mode on or off.
- When Arrow Mode is on, the virtual cursor can be moved with the arrow keys.

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

## Footer Status

The footer shows the current navigation mode and zoom state, for example:

- `Arrow OFF | Zoom 100%`
- `Arrow ON | Zoom 150%`

## Editing and Navigation

- Single Select: edit the focused event or sticky note.
- Double Select: open the context action.
- Create / Edit workflows are unchanged.
- Undo / Redo remain available in the sidebar.

## Kiosk Mode

Kiosk mode uses the same persistent token policy as TV pairing. It stays signed in until the token is explicitly revoked or the signing secret changes.

## Behavior Summary

- Single press + and - still move focus.
- Long press + and - now control zoom.
- F restores the saved Home Zoom.
- Zoom changes are persisted immediately.
- Cursor and debug overlays stay unscaled.