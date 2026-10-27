# 🏎 AE86 Desktop Companion

A lightweight, transparent desktop overlay featuring a drifting Toyota AE86. It slides in to deliver custom reminders, waits for your response, and drifts away. 

Includes a local-only **Insights Dashboard** to track your completion rates and response times.

## Features
- **Transparent Overlay:** A frameless, click-through desktop companion that stays out of your way.
- **Drifting Animation:** A custom Three.js sequence with drifting physics, tire smoke, and suspension tilt.
- **Reminders:** Pops up to ask for a response (e.g., "Drink" or "Later").
- **Local Analytics:** Automatically logs outcomes and response times to a local JSON file, viewable in a separate dashboard window.
- **Privacy First:** 100% offline. No network requests, no telemetry, no external database.

## Setup & Run

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm start
   ```

## Usage

- **Trigger a reminder:** Press `Cmd/Ctrl + Alt + Shift + D` or click the 🏎 tray icon and select **Drift now**.
- **Quit the app:** Press `Cmd/Ctrl + Alt + Q` or select **Quit** from the tray menu.
- **View Insights:** Click the tray icon and select **Insights…** to open the analytics dashboard.

## Architecture

The app is built to be compact. Almost everything runs out of a single `app.js` file, which branches into three distinct roles based on the Electron process:

- **`MAIN`** (`process.type === 'browser'`): Handles window creation, tray menus, global shortcuts, and file system access.
- **`PRELOAD`** (`process.type === 'renderer'`): A tiny, secure bridge (`contextBridge`) exposing safe IPC methods to the page.
- **`PAGE`** (No `process`): The Three.js scene, animation state machine, and UI logic. It has no Node access and runs in a sandbox.

### File Structure
- `app.js`: The main Electron entry point and renderer logic.
- `analytics.js`: A tiny, dependency-free JSON storage class.
- `index.html`: The HTML shell for the transparent overlay.
- `dashboard.html`: The standalone UI for the Insights dashboard.
- `assets/`: Contains the 3D model (`toyota_trueno_ae86_initial_d.glb`).

### The Analytics Pipeline
The app uses a local JSON file to store analytics without needing a database (like SQLite). 
1. When you click a button, the renderer sends an IPC message via `window.companion.logReminder()`.
2. The main process catches this and writes it to `analytics.json` inside your OS's standard `userData` folder.
3. The dashboard asks the main process for a snapshot of the data via `window.companion.getAnalytics()`.

*Your local data is stored at:*
- **macOS:** `~/Library/Application Support/ae86-companion/analytics.json`
- **Windows:** `%APPDATA%\ae86-companion\analytics.json`
- **Linux:** `~/.config/ae86-companion/analytics.json`

## Customization
You can tweak the animation, physics, and layout by editing the `CFG` object at the top of `app.js`. Camera angles, car scale, and the screen positions of the drift paths are all highly configurable.

## Dependencies
- [Electron](https://www.electronjs.org/)
- [Three.js](https://threejs.org/)