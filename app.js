'use strict';
/*
 * AE86 Desktop Companion - Milestone 4 (Custom Reminders)
 * One file, three roles. Electron runs it as:
 *   MAIN     (process.type === 'browser')  window, tray, shortcuts, show/hide, scheduler
 *   PRELOAD  (process.type === 'renderer') tiny, safe bridge exposed to the page
 *   PAGE     (no `process` at all)         Three.js scene and animation
 * The page never gets Node access: context isolation and the sandbox stay on.
 */
const MODEL_FILE = 'assets/toyota_trueno_ae86_initial_d.glb';

const CFG = {
  carLength: 4.4,
  viewWidth: 20,
  fov: 28,
  elevationDeg: 35,
  start: [1.22, 0.50],
  bottomPadPx: 6,
  buttonGapPx: 20,
  floorX: { drift: 0.26, center: 0.50, turn: 0.64, exitRight: 1.28, exitLeft: -0.28 },
};

const role = typeof process === 'undefined' ? 'page' : process.type === 'browser' ? 'main' : 'preload';
if (role === 'main') startMain();
else if (role === 'preload') startPreload();
else startRenderer().catch((e) => console.error('FATAL', e));


/* ------------------------------ MAIN PROCESS ------------------------------ */
function startMain() {
  const { app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, ipcMain , protocol} = require('electron');
  protocol.registerSchemesAsPrivileged([
    { scheme: 'file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
  app.setName('ae86-companion');
  const path = require('path');
  const { Analytics } = require('./analytics');
  const { Reminders } = require('./reminders');

  const KEY_DRIFT = 'CommandOrControl+Alt+Shift+D';
  const KEY_QUIT = 'CommandOrControl+Alt+Q';
  let win, tray, ready, dashWin = null, settingsWin = null, busy = false;
  let analytics, remindersData;
  let checkInterval = null;
  let lastTriggeredKey = null;
  function drift(reminder) {
    if (!ready || busy) return;
    const activeReminder = reminder || { id: 'demo', title: 'Default', type: 'default', actions: ['completed', 'postponed'] };


    busy = true;
    win.setBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
    setTimeout(() => win.webContents.send('drift', activeReminder), 80);
  }

  function finish() {
    busy = false;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.hide();
  }

  function openDashboard() {
    if (dashWin && !dashWin.isDestroyed()) {
      if (dashWin.isMinimized()) dashWin.restore();
      dashWin.focus();
      return;
    }
    dashWin = new BrowserWindow({
      width: 1100, height: 780, minWidth: 720, minHeight: 560,
      title: 'AE86 Companion — Insights',
      webPreferences: { preload: __filename, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    dashWin.removeMenu?.();
    dashWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    dashWin.webContents.on('will-navigate', (e) => e.preventDefault());
    dashWin.loadFile(path.join(__dirname, 'dashboard.html'));
    dashWin.on('closed', () => { dashWin = null; });
  }

  function openSettings() {
    if (settingsWin && !settingsWin.isDestroyed()) {
      if (settingsWin.isMinimized()) settingsWin.restore();
      settingsWin.focus();
      return;
    }
    settingsWin = new BrowserWindow({
      width: 800, height: 600, minWidth: 600, minHeight: 500,
      title: 'AE86 Companion — Settings',
      webPreferences: { preload: __filename, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    settingsWin.removeMenu?.();
    settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
    settingsWin.loadFile(path.join(__dirname, 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
  }

  function updateTrayMenu() {
    if (!tray) return;
    const list = remindersData.getAll();

    // Create a menu item for each reminder
    const reminderItems = list.map(r => ({
      label: `Drift: ${r.title || 'Untitled'}`,
      click: () => drift(r)
    }));

    // If no reminders exist, add a disabled placeholder
    if (reminderItems.length === 0) {
      reminderItems.push({ label: 'No reminders configured', enabled: false });
    }

    const template = [
      { label: 'Trigger Default', click: () => drift() }, // Uses fallback
      { type: 'separator' },
      ...reminderItems, // Injects your specific reminders here
      { type: 'separator' },
      { label: 'Settings…', click: openSettings },
      { label: 'Insights…', click: openDashboard },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  // Scheduler logic
  function checkSchedule() {
    if (busy) return;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    console.log(`[Scheduler] Ticking at ${timeStr}. Loaded reminders: ${remindersData.getAll().length}`);

    const due = remindersData.getAll().find(r => {
      if (r.schedule === 'manual') return false;
      
      const key = `${r.id}_${now.toDateString()}_${timeStr}`;
      if (key === lastTriggeredKey) return false;

      if (r.schedule === 'daily') {
        return r.time === timeStr;
      }
      if (r.schedule === 'specific_days' && Array.isArray(r.days)) {
        return r.time === timeStr && r.days.includes(now.getDay());
      }
      if (r.schedule === 'interval') {
        // For intervals, fire on the hour, every N hours
        const hours = r.intervalHours || 1;
        return now.getMinutes() === 0 && now.getHours() % hours === 0;
      }
      return false;
    });

    if (due) {
      console.log(`[Scheduler] Firing: ${due.title} (${due.schedule})`);
      lastTriggeredKey = `${due.id}_${now.toDateString()}_${timeStr}`;
      drift(due);
    }
  }

  app.whenReady().then(() => {
    win = new BrowserWindow({
      ...screen.getPrimaryDisplay().workArea,
      transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
      focusable: false, acceptFirstMouse: true, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: __filename, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    analytics = new Analytics(app.getPath('userData'));
    remindersData = new Reminders(app.getPath('userData'));

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    if (app.dock) app.dock.hide();

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (...a) =>
      console.log('[renderer]', a[0] && a[0].message !== undefined ? a[0].message : a[2]));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc));
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error('[renderer gone]', d.reason);
      ready = false;
      if (!win.isDestroyed()) finish();
    });

    ipcMain.on('ready', (e) => {
      if (e.sender !== win.webContents) return;
      ready = true;
      console.log(`Ready. Trigger: ${KEY_DRIFT} or the menu-bar car. Quit: ${KEY_QUIT}.`);
    });

    ipcMain.on('done', (e) => { if (e.sender === win.webContents) finish(); });

    ipcMain.on('interactive', (e, on) => {
      if (e.sender !== win.webContents || typeof on !== 'boolean') return;
      if (on) win.setIgnoreMouseEvents(false);
      else win.setIgnoreMouseEvents(true, { forward: true });
    });

    ipcMain.on('analytics:log', (e, rec) => {
      if (e.sender !== win.webContents) return;
      analytics.log(rec || {});
      if (dashWin && !dashWin.isDestroyed()) dashWin.webContents.send('analytics:refresh');
    });

    ipcMain.handle('analytics:get', (e) =>
      e.sender === win.webContents || (dashWin && e.sender === dashWin.webContents)
        ? analytics.snapshot() : null);

    ipcMain.handle('reminders:get', (e) =>
      e.sender === settingsWin?.webContents ? remindersData.getAll() : null);

    ipcMain.on('reminders:save', (e, list) => {
      if (e.sender !== settingsWin?.webContents) return;
      remindersData.saveAll(list);
      updateTrayMenu(); // Refresh tray menu instantly
    });

    win.loadFile(path.join(__dirname, 'index.html'));
    if (process.env.DEBUG) win.webContents.openDevTools({ mode: 'detach' });

    try {
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('\u{1F3CE}');
      tray.setToolTip('AE86 Companion');
      updateTrayMenu(); // Build the initial menu
    } catch (err) { console.warn('Tray unavailable:', err.message); }

    if (!globalShortcut.register(KEY_DRIFT, () => drift())) console.warn('Could not register', KEY_DRIFT);
    if (!globalShortcut.register(KEY_QUIT, () => app.quit())) console.warn('Could not register', KEY_QUIT);

    // Check schedule every 30 seconds
    checkInterval = setInterval(checkSchedule, 30000);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (checkInterval) clearInterval(checkInterval);
  });
  app.on('window-all-closed', () => app.quit());
}

/* --------------------------------- PRELOAD -------------------------------- */
function startPreload() {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('companion', {
    onDrift: (cb) => ipcRenderer.on('drift', (_e, payload) => cb(payload)),
    ready: () => ipcRenderer.send('ready'),
    done: () => ipcRenderer.send('done'),
    interactive: (on) => ipcRenderer.send('interactive', !!on),
    logReminder: (rec) => ipcRenderer.send('analytics:log', rec),
    getAnalytics: () => ipcRenderer.invoke('analytics:get'),
    onAnalyticsRefresh: (cb) => ipcRenderer.on('analytics:refresh', () => cb()),
    // Settings bridges
    getReminders: () => ipcRenderer.invoke('reminders:get'),
    saveReminders: (list) => ipcRenderer.send('reminders:save', list),

  });
}

/* ---------------------------------- PAGE ---------------------------------- */
async function startRenderer() {
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  document.addEventListener('securitypolicyviolation', (e) =>
    console.error('CSP blocked:', e.blockedURI, 'by', e.violatedDirective));

  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const V3 = THREE.Vector3;
  const rnd = (a, b) => a + Math.random() * (b - a);

  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scene'), alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(CFG.fov, 1, 1, 200);
  const render = () => renderer.render(scene, camera);

  function placeCamera() {
    camera.aspect = window.innerWidth / window.innerHeight;
    const D = CFG.viewWidth / (2 * Math.tan(THREE.MathUtils.degToRad(CFG.fov / 2)) * camera.aspect);
    const el = THREE.MathUtils.degToRad(CFG.elevationDeg);
    camera.position.set(0, Math.sin(el) * D, Math.cos(el) * D);
    camera.near = D / 10;
    camera.far = D * 5;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeCamera();
    render();
  }
  window.addEventListener('resize', resize);
  resize();

  const blob = (rgb, alpha) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},${alpha})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  const gltf = await new GLTFLoader().loadAsync(new URL(MODEL_FILE, location.href).href);
  const body = gltf.scene;
  body.updateMatrixWorld(true);
  const rawSize = new THREE.Box3().setFromObject(body).getSize(new V3());

  body.scale.setScalar(CFG.carLength / rawSize.z);
  body.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(body);
  body.position.set(-(fitted.min.x + fitted.max.x) / 2, -fitted.min.y, -(fitted.min.z + fitted.max.z) / 2);
  const car = new THREE.Group(), tilt = new THREE.Group();
  tilt.add(body);
  car.add(tilt);
  scene.add(car);
  car.updateMatrixWorld(true);

  const carWidth = fitted.max.x - fitted.min.x;
  const carHeight = fitted.max.y - fitted.min.y;
  const footRadius = Math.hypot(carWidth, fitted.max.z - fitted.min.z) / 2;

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blob('0,0,0', 0.6), transparent: true, depthWrite: false, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  shadow.scale.set(carWidth * 1.9, CFG.carLength * 1.35, 1);
  car.add(shadow);

  const wheels = [];
  let wheelReach = 0;
  for (const [name, rear] of [['fl', false], ['fr', false], ['rl', true], ['rr', true]]) {
    const group = body.getObjectByName(name);
    if (!group) continue;
    const tyre = body.getObjectByName(`${name}_tyre_0`) || group;
    const tb = new THREE.Box3().setFromObject(tyre);
    const wc = tb.getCenter(new V3());
    wheelReach = Math.max(wheelReach, Math.hypot(wc.x, wc.z) + (tb.max.x - tb.min.x) / 2);
    const centre = body.worldToLocal(tb.getCenter(new V3()));
    const steer = new THREE.Object3D(), spin = new THREE.Object3D();
    steer.position.copy(centre);
    body.add(steer);
    steer.add(spin);
    body.updateMatrixWorld(true);
    spin.attach(group);
    const radius = (tb.max.y - tb.min.y) / 2;
    wheels.push({ steer: rear ? null : steer, spin, rear, radius });
  }

  const SMOKE_MAX = 3.6;
  const smokeTex = blob('232,232,232', 0.9);
  const puffs = Array.from({ length: 120 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0 }));
    s.visible = false;
    scene.add(s);
    return s;
  });
  let puffNext = 0, smokeClock = 0;
  const rearSpins = wheels.filter((w) => w.rear).map((w) => w.spin);

  function emitPuff(from) {
    const s = puffs[puffNext++ % puffs.length];
    from.getWorldPosition(s.position);
    s.position.set(s.position.x + rnd(-0.15, 0.15), 0.2, s.position.z + rnd(-0.15, 0.15));
    Object.assign(s.userData, {
      age: 0, life: rnd(0.8, 1.3), vx: rnd(-0.4, 0.4), vy: rnd(0.3, 0.6), vz: rnd(-0.4, 0.4),
      s0: rnd(0.6, 0.9), s1: rnd(2.4, SMOKE_MAX), o0: rnd(0.35, 0.5),
    });
    s.visible = true;
  }

  function updateSmoke(dt, emitting) {
    if (emitting) {
      smokeClock += dt;
      while (smokeClock > 0.03) { smokeClock -= 0.03; rearSpins.forEach(emitPuff); }
    }
    let alive = false;
    for (const s of puffs) {
      if (!s.visible) continue;
      const d = s.userData;
      d.age += dt;
      const k = d.age / d.life;
      if (k >= 1) { s.visible = false; continue; }
      alive = true;
      s.position.x += d.vx * dt; s.position.y += d.vy * dt; s.position.z += d.vz * dt;
      s.scale.setScalar(d.s0 + (d.s1 - d.s0) * Math.sqrt(k));
      s.material.opacity = d.o0 * Math.pow(1 - k, 1.5);
    }
    return alive;
  }

  const K = {};
  const ray = new V3();
  function groundAt(fx, fy, out) {
    ray.set(fx * 2 - 1, 1 - fy * 2, 0.5).unproject(camera).sub(camera.position);
    return out.copy(camera.position).addScaledVector(ray, -camera.position.y / ray.y);
  }

  const plan = () => {
    const row = floorRow();
    K.start = groundAt(CFG.start[0], Math.min(CFG.start[1], row - 0.04), new V3());
    for (const k in CFG.floorX) K[k] = groundAt(CFG.floorX[k], row, new V3());
  };

  const probe = new V3();
  const projectY = (p) => ((1 - p.project(camera).y) / 2) * window.innerHeight;
  const nearEdge = (fitted.max.z - fitted.min.z) / 2;
  const lowestPx = (z) => projectY(probe.set(0, 0, z + nearEdge));

  function floorRow() {
    const limit = window.innerHeight - CFG.bottomPadPx;
    let lo = -40, hi = camera.position.z - 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (lowestPx(mid) > limit) hi = mid; else lo = mid;
    }
    return projectY(probe.set(0, 0, lo)) / window.innerHeight;
  }

  const roofPx = () => projectY(probe.set(K.center.x, carHeight, K.center.z - footRadius));

  const YAW_LEFT = Math.PI / 2, YAW_RIGHT = 1.5 * Math.PI;
  const YAW_IN = YAW_LEFT + 0.5;
  const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
  const ease3 = (u) => u * u * (3 - 2 * u);
  const skew = (u, k) => ease3(Math.pow(u, k));
  const sin2 = (x) => Math.pow(Math.sin(Math.PI * clamp01(x)), 2);
  const T_ENTER = 0.55, T_DRIFT = 1.15;
  const glide = (t, o) => o.pos.copy(K.start).lerp(K.drift, 1 - Math.pow(1 - t / (T_ENTER + T_DRIFT), 2));

  const STATES = {
    ENTER: { dur: T_ENTER, next: 'DRIFT_TO_PROFILE', pose(u, o) { glide(u * T_ENTER, o); o.yaw = YAW_IN; o.dir = 1; o.steer = -0.25; } },
    DRIFT_TO_PROFILE: {
      dur: T_DRIFT, next: 'MOVE_TO_CENTER', pose(u, o) {
        glide(T_ENTER + u * T_DRIFT, o);
        o.yaw = YAW_IN + (YAW_RIGHT - YAW_IN) * ((1 - Math.cos(Math.PI * u)) / 2) + 0.12 * sin2((u - 0.65) / 0.35);
        o.m = Math.sin(Math.PI * u); o.dir = 1; o.steer = -0.25 - 0.25 * o.m;
      }
    },
    MOVE_TO_CENTER: {
      dur: 1.0, next: 'WAIT_FOR_CHOICE', pose(u, o) {
        o.pos.copy(K.drift).lerp(K.center, ease3(u));
        o.yaw = YAW_RIGHT;
        o.lift = 0.03 * Math.sin(Math.PI * clamp01(u / 0.45)) - 0.04 * Math.sin(Math.PI * clamp01((u - 0.55) / 0.45));
      }
    },
    WAIT_FOR_CHOICE: { dur: Infinity, pose(u, o) { o.pos.copy(K.center); o.yaw = YAW_RIGHT; } },
    EXIT_RIGHT: {
      dur: 1.3, next: 'DONE', pose(u, o) {
        o.pos.copy(K.center).lerp(K.exitRight, Math.pow(u, 2.2));
        const wig = 0.5 * sin2(u / 0.5);
        o.yaw = YAW_RIGHT + wig;
        o.m = Math.sin(Math.PI * clamp01(u / 0.55)); o.burn = o.m; o.dir = 1; o.steer = -wig;
        o.lift = 0.05 * Math.sin(Math.PI * clamp01(u / 0.6));
      }
    },
    TURN_AROUND: {
      dur: 1.0, next: 'EXIT_LEFT', pose(u, o) {
        o.pos.copy(K.center).lerp(K.turn, skew(u, 0.6));
        o.yaw = YAW_RIGHT - Math.PI * ease3(clamp01((u - 0.1) / 0.9));
        o.m = Math.sin(Math.PI * u); o.burn = 0.7 * Math.sin(Math.PI * clamp01(u / 0.5)); o.dir = -1; o.steer = 0.5 * o.m;
      }
    },
    EXIT_LEFT: {
      dur: 1.2, next: 'DONE', pose(u, o) {
        o.pos.copy(K.turn).lerp(K.exitLeft, Math.pow(u, 2.2));
        o.yaw = YAW_LEFT;
        o.m = 0.6 * Math.sin(Math.PI * clamp01(u / 0.5)); o.burn = o.m;
        o.lift = 0.04 * Math.sin(Math.PI * clamp01(u / 0.6));
      }
    },
    DONE: { dur: Infinity, pose() { } },
  };

  const advance = (st, dt) => {
    st.t += dt;
    for (let s; st.t >= (s = STATES[st.name]).dur;) { st.t -= s.dur; st.name = s.next; }
  };

  const S = { name: 'DONE', t: 0 };
  const pose = { pos: new V3(), yaw: 0, m: 0, dir: 0, steer: 0, lift: 0, burn: 0 };
  const prev = new V3(), step = new V3(), fwd = new V3();
  let steerNow = 0, running = false, locked = false, raf = 0, last = 0;
  let currentType = 'default';
  let reminderTriggeredAt = 0;
  let activeTitle = 'Reminder'; 
  let activeActions = [];

  // Dynamic Button Builder
  const ui = document.getElementById('choices');
  const setInteractive = (on) => window.companion && window.companion.interactive(on);
  const infoEl = document.getElementById('reminder-info');

  function showChoices() {
    ui.innerHTML = ''; 

    // Build the info block
    const timeStr = new Date(reminderTriggeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    infoEl.innerHTML = `${escapeHtml(activeTitle)}<small>Triggered at ${timeStr}</small>`;
    infoEl.hidden = false;

    // Build buttons from activeActions
    activeActions.forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
      if (action === 'completed') { b.textContent = 'Complete'; b.onclick = () => choose('EXIT_RIGHT', 'completed'); }
      else if (action === 'postponed') { b.textContent = 'Snooze'; b.onclick = () => choose('TURN_AROUND', 'snoozed'); }
      else if (action === 'skipped') { b.textContent = 'Skip'; b.onclick = () => choose('EXIT_LEFT', 'skipped'); }
      else { b.textContent = 'Custom'; b.onclick = () => choose('EXIT_RIGHT', 'custom'); }

      b.addEventListener('mouseenter', () => { if (!locked) setInteractive(true); });
      b.addEventListener('mouseleave', () => setInteractive(false));
      ui.appendChild(b);
    });

    const mid = new V3(K.center.x, 0, K.center.z).project(camera);
    ui.hidden = false;
    ui.style.left = `${((mid.x + 1) / 2) * window.innerWidth}px`;
    ui.style.top = `${Math.max(8, roofPx() - CFG.buttonGapPx - ui.offsetHeight)}px`;
    
    // Position the info block just above the buttons
    infoEl.style.left = ui.style.left;
    infoEl.style.top = `${parseFloat(ui.style.top) - 10}px`; 
  }

  function go(name) {
    S.name = name;
    S.t = 0;
    if (name === 'WAIT_FOR_CHOICE') showChoices();
    if (name === 'DONE') car.visible = false;
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(frame); };

  function applyPose(dt) {
    const o = pose;
    car.position.copy(o.pos);
    car.rotation.y = o.yaw;
    tilt.rotation.set(-(0.04 + 0.03 * o.m) + o.lift, 0, -o.dir * 0.07 * o.m);
    const travelled = step.copy(o.pos).sub(prev).dot(fwd.set(-Math.sin(o.yaw), 0, -Math.cos(o.yaw)));
    prev.copy(o.pos);
    steerNow += (o.steer - steerNow) * Math.min(1, dt * 12);
    for (const w of wheels) {
      w.spin.rotation.x -= (travelled / w.radius) * (w.rear ? 1 + 0.8 * o.m : 1);
      if (w.rear) w.spin.rotation.x -= o.burn * dt * 30;
      else w.steer.rotation.y = THREE.MathUtils.clamp(steerNow, -0.5, 0.5);
    }
    car.updateMatrixWorld(true);
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    const before = S.name;
    advance(S, dt);
    if (S.name !== before) go(S.name);
    if (S.name !== 'DONE') {
      pose.m = pose.dir = pose.steer = pose.lift = pose.burn = 0;
      STATES[S.name].pose(clamp01(S.t / STATES[S.name].dur), pose);
      applyPose(dt);
    }
    const smoking = updateSmoke(dt, S.name !== 'DONE' && pose.m > 0.35);
    render();
    if (S.name === 'DONE' && !smoking) {
      running = false;
      ui.hidden = true;
      infoEl.hidden = true;
      setInteractive(false);
      window.companion.done();
    } else if (S.name !== 'WAIT_FOR_CHOICE' || smoking) schedule();
  }

  function choose(nextState, logStatus) {
    if (S.name !== 'WAIT_FOR_CHOICE' || locked) return;
    locked = true;
    [...ui.querySelectorAll('button')].forEach((b) => (b.disabled = true));
    setInteractive(false);
    window.companion?.logReminder({
      type: currentType,
      title: activeTitle, 
      status: logStatus,
      triggeredAt: reminderTriggeredAt,
      respondedAt: Date.now(),
    });
    go(nextState);
    last = performance.now();
    schedule();
  }

  function start(payload) {
    if (running) return;
    running = true;
    locked = false;
    steerNow = 0;
    smokeClock = 0;
    currentType = payload?.type || 'default';
    activeTitle = payload?.title || 'Reminder'; // Save the title
    activeActions = payload?.actions || ['completed', 'postponed'];
    reminderTriggeredAt = Date.now();
    placeCamera();
    plan();
    ui.hidden = true;
    car.visible = true;
    go('ENTER');
    STATES.ENTER.pose(0, pose);
    prev.copy(pose.pos);
    last = performance.now();
    schedule();
  }

  car.visible = true; render(); car.visible = false; render();

  if (!window.companion) return console.error('Preload bridge missing; cannot receive triggers.');
  window.companion.onDrift(start);
  window.companion.ready();
}