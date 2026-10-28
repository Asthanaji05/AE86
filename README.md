# 🏎 AE86 Desktop Companion
![Electron](https://img.shields.io/badge/Electron-45.0.0-blue.svg)
![Three.js](https://img.shields.io/badge/Three.js-r186-green.svg)
![Platform](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)
![Privacy](https://img.shields.io/badge/Privacy-100%25_Offline-success.svg)

https://github.com/user-attachments/assets/f4d6bf4a-e941-4afe-b75c-03b982054912

A lightweight, transparent desktop overlay featuring a drifting Toyota AE86. It stays hidden in your menu bar, slides onto your screen to deliver custom reminders, and waits for your response before drifting away.

Built with **Electron**, **Three.js**, and **Vanilla JavaScript**.

Includes a local-only **Insights Dashboard** to track your completion rates and response times.

## ✨ Features

- **Transparent 3D Overlay:** A click-through frameless window that comes to life with a custom Three.js drift sequence, complete with tire smoke and suspension tilt.
- **Custom Reminders:** Schedule up to 4 customized reminders using specific days, daily times, or recurring intervals.
- **Dynamic Action Buttons:** Choose exactly which actions appear when a reminder fires (Complete, Snooze, Skip, Custom).
- **Local Analytics:** Automatically tracks your response times and completion rates in a local JSON file. No servers, no tracking, 100% offline.
- **Insights Dashboard:** A beautiful, dark-mode dashboard to visualize your productivity patterns.
- **Menu Bar Native:** Runs silently in the background (macOS `LSUIElement`), launching instantly from your menu bar.

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

## Building the Mac App

This project uses esbuild to bundle the Three.js renderer into a single, hyper-fast script, and electron-builder to package the final .dmg.

```bash
npm run dist
```

Open the .dmg in the dist/ folder, drag it to Applications, and you are ready to go.


## Architecture & Tech Stack
The app is designed to be incredibly compact. It uses a custom 3-role architecture inside a single app.js entry point:

MAIN `(process.type === 'browser')` : Handles the window lifecycle, global shortcuts, tray menu, and the background reminder scheduler.

PRELOAD `(process.type === 'renderer')` : A tiny, secure contextBridge that exposes only the necessary IPC channels to the UI.

PAGE (Sandboxed): The Three.js scene, the 3D model rigging, and the UI logic. It has zero Node.js access.

### Storage
`reminders.json` : Stores your up to 4 custom reminders.

`analytics.json` : Stores up to 50,000 recent events for the Insights dashboard.

Both are stored securely in your OS's standard userData folder.

## The 3D Drift Physics
Instead of using heavy physics engines, the car uses a custom, lightweight kinematic state machine. It interpolates between key screen positions using easing curves (ease3, sin2, skew), and applies procedural yaw, pitch, and wheel spin based on acceleration.

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


## Custom Reminders & Scheduling
You can configure up to 4 custom reminders via the **Settings…** tray menu. 
- **Scheduling:** Choose between manual only, daily, specific days, or recurring intervals.
- **Actions:** Choose up to 4 actions (`Complete`, `Snooze`, `Skip`, `Custom`) that will appear as a horizontal row above the car when the reminder fires.

Data is saved locally in `reminders.json` inside your OS's standard `userData` folder.
