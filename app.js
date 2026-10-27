'use strict';
/*
 * AE86 Desktop Companion - Milestone 3 (reminder sequence: drift in, ask, drive away)
 * One file, three roles. Electron runs it as:
 *   MAIN     (process.type === 'browser')  window, tray, shortcuts, show/hide
 *   PRELOAD  (process.type === 'renderer') tiny, safe bridge exposed to the page
 *   PAGE     (no `process` at all)         Three.js scene and animation
 * The page never gets Node access: context isolation and the sandbox stay on.
 */
const MODEL_FILE = 'assets/toyota_trueno_ae86_initial_d.glb';

// Everything you may want to tweak lives here.
const CFG = {
  carLength: 4.4,        // world units; with viewWidth this sets the car's on-screen size
  viewWidth: 20,         // world units visible across the screen at the car's distance
  fov: 28,
  elevationDeg: 35,      // camera looks down at the "road" from this angle
  // The car appears at `start` (x, y as screen fractions: off the right edge, mid-height) and slides down
  // onto the bottom line. Its height there is NOT set here: it is solved from the window size and the car's
  // bounding box so that wheels, spinning body and smoke clear the bottom edge by `bottomPadPx`.
  start: [1.22, 0.50],
  bottomPadPx: 6,       // free space kept under the car's near tyre edge.
  buttonGapPx: 20,       // gap between the buttons and the highest point the car can reach
  // Positions along the bottom line (x only, as screen fractions from the left): it slides and spins at
  // `drift`, drives to `center` and waits; `turn` is where it spins around on Later; the exits are just off-screen.
  floorX: { drift: 0.26, center: 0.50, turn: 0.64, exitRight: 1.28, exitLeft: -0.28 },
};

const role = typeof process === 'undefined' ? 'page' : process.type === 'browser' ? 'main' : 'preload';
if (role === 'main') startMain();
else if (role === 'preload') startPreload();
else startRenderer().catch((e) => console.error('FATAL', e));

/* ------------------------------ MAIN PROCESS ------------------------------ */
function startMain() {
  const { app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, ipcMain } = require('electron');
  const path = require('path');
  const { Analytics } = require('./analytics');
  const KEY_DRIFT = 'CommandOrControl+Alt+Shift+D';
  const KEY_QUIT = 'CommandOrControl+Alt+Q';
  let win, tray, ready, dashWin = null, busy = false;
  let analytics;


  function drift(reminder) {
    if (!ready || busy) return;
    const payload =
      reminder && typeof reminder === 'object' && typeof reminder.type === 'string'
        ? { type: reminder.type }
        : { type: 'default' };
    busy = true;
    win.setBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
    setTimeout(() => win.webContents.send('drift', payload), 80);
  }
  function finish() {
    busy = false;
    win.setIgnoreMouseEvents(true, { forward: true }); // always return to click-through
    win.hide(); // overlay disappears completely when idle
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

  app.whenReady().then(() => {
    win = new BrowserWindow({
      ...screen.getPrimaryDisplay().workArea,
      transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
      focusable: false, acceptFirstMouse: true, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: __filename, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    analytics = new Analytics(app.getPath('userData'));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true }); // click-through, but mouse moves still reach the page
    if (app.dock) app.dock.hide();  // menu-bar style app: no Dock icon

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
    // Only accept messages from our own window; the messages carry no data.
    ipcMain.on('ready', (e) => {
      if (e.sender !== win.webContents) return;
      ready = true;
      console.log(`Ready. Trigger: ${KEY_DRIFT} or the menu-bar car. Quit: ${KEY_QUIT}.`);
      drift(); // one demo run at startup
    });
    ipcMain.on('done', (e) => { if (e.sender === win.webContents) finish(); });
    // The page asks for real mouse input only while the pointer is over a button.
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

    win.loadFile(path.join(__dirname, 'index.html'));
    if (process.env.DEBUG) win.webContents.openDevTools({ mode: 'detach' });

    try {
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle('\u{1F3CE}');
      tray.setToolTip('AE86 Companion');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Drift now', click: drift },
        { label: 'Insights…', click: openDashboard },
        { label: 'Quit', click: () => app.quit() },
      ]));
    } catch (err) { console.warn('Tray unavailable:', err.message); }

    if (!globalShortcut.register(KEY_DRIFT, drift)) console.warn('Could not register', KEY_DRIFT);
    if (!globalShortcut.register(KEY_QUIT, () => app.quit())) console.warn('Could not register', KEY_QUIT);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}

/* --------------------------------- PRELOAD -------------------------------- */
// The only things the page can do: hear "drift", say "ready" / "done", and ask for mouse input over a button.
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
  });
}

/* ---------------------------------- PAGE ---------------------------------- */
async function startRenderer() {
  document.addEventListener('securitypolicyviolation', (e) =>
    console.error('CSP blocked:', e.blockedURI, 'by', e.violatedDirective));

  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const V3 = THREE.Vector3;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /* ---- renderer, scene, light, camera ---- */
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
  // Camera looks at the origin from above-front; distance is chosen so ~viewWidth units span the screen.
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

  /* ---- soft blobs (shadow + smoke), generated in code: no extra assets ---- */
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

  /* ---- load + inspect the model ---- */
  const gltf = await new GLTFLoader().loadAsync(new URL(MODEL_FILE, location.href).href);
  const body = gltf.scene;
  body.updateMatrixWorld(true);
  const rawSize = new THREE.Box3().setFromObject(body).getSize(new V3());
  console.log('Model size:', rawSize.toArray().map((n) => n.toFixed(3)).join(' x '),
    '| clips:', gltf.animations.map((a) => `${a.name || '(unnamed)'} ${a.duration.toFixed(2)}s`).join(', ') || 'none (we animate in code)');

  // Rig: car (path position + heading) > tilt (pitch/roll) > body (the model).
  // Scale to a real-car size, centre on the origin, and sit the tyres on y = 0.
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
  // Bounding-box facts used for layout: height, and the radius of the footprint circle swept by a spinning car.
  const carHeight = fitted.max.y - fitted.min.y;
  const footRadius = Math.hypot(carWidth, fitted.max.z - fitted.min.z) / 2;

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blob('0,0,0', 0.6), transparent: true, depthWrite: false, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  shadow.scale.set(carWidth * 1.9, CFG.carLength * 1.35, 1);
  car.add(shadow);

  // Wheels: put each wheel group on its own pivot at the tyre centre, so it spins in place
  // (steer pivot -> spin pivot -> wheel). The model faces -z with its axles along x.
  const wheels = [];
  let wheelReach = 0; // how far the outer tyre edges are from the car's centre (smoke starts there)
  for (const [name, rear] of [['fl', false], ['fr', false], ['rl', true], ['rr', true]]) {
    const group = body.getObjectByName(name);
    if (!group) { console.warn('Wheel group not found:', name); continue; }
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
    spin.attach(group); // keeps the wheel exactly where it was
    const radius = (tb.max.y - tb.min.y) / 2;
    wheels.push({ steer: rear ? null : steer, spin, rear, radius });
    console.log(`Wheel ${name}: radius ${radius.toFixed(3)}, pivot ${centre.toArray().map((n) => n.toFixed(2)).join(', ')}`);
  }

  /* ---- smoke ---- */
  const SMOKE_MAX = 3.6; // largest puff diameter in world units
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

  /* ---- the sequence: a small state machine with one pose function per state ---- */
  const K = {}; // key points on the ground plane, planned from CFG (screen fractions + the solved bottom line) at each start
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

  // <layout>
  // Where the car sits vertically. We look for the lowest ground line that still leaves `bottomPadPx` free under
  // the near tyre edge, using the real camera, window size and car bounding box, so it adapts to any screen.
  // Pixel rows below are measured from the top.
  const probe = new V3();
  const projectY = (p) => ((1 - p.project(camera).y) / 2) * window.innerHeight;
  // lowest on-screen point is the near-side tyre: car's z-half-extent, not the diagonal sweep circle
  const nearEdge = (fitted.max.z - fitted.min.z) / 2;   // ≈ 2.2, in fitted/scaled units
  const lowestPx = (z) => projectY(probe.set(0, 0, z + nearEdge));
  function floorRow() { // returns the ground line as a screen-row fraction (0 = top, 1 = bottom)
    const limit = window.innerHeight - CFG.bottomPadPx;
    let lo = -40, hi = camera.position.z - 2; // lo: far away (high on screen); hi: beside the camera (too low)
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (lowestPx(mid) > limit) hi = mid; else lo = mid;
    }
    return projectY(probe.set(0, 0, lo)) / window.innerHeight;
  }
  // Highest screen row (px) the car's swept volume can reach while standing on the bottom line: buttons go above it.
  const roofPx = () => projectY(probe.set(K.center.x, carHeight, K.center.z - footRadius));
  // </layout>

  // <sequence>
  const YAW_LEFT = Math.PI / 2, YAW_RIGHT = 1.5 * Math.PI; // car faces -x / +x: side-on to the camera
  const YAW_IN = YAW_LEFT + 0.5;                            // nose slightly toward the camera on entry
  const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
  const ease3 = (u) => u * u * (3 - 2 * u);
  const skew = (u, k) => ease3(Math.pow(u, k));             // k < 1: quick launch, long glide
  const sin2 = (x) => Math.pow(Math.sin(Math.PI * clamp01(x)), 2);
  const T_ENTER = 0.55, T_DRIFT = 1.15;
  // ENTER and DRIFT share one decelerating slide, so speed is continuous across their boundary.
  const glide = (t, o) => o.pos.copy(K.start).lerp(K.drift, 1 - Math.pow(1 - t / (T_ENTER + T_DRIFT), 2));
  // pose(u, o): u = progress 0..1 in this state. Fills o: pos, yaw, plus m (drift intensity: smoke, lean),
  // dir (turn direction), steer (front-wheel angle), lift (nose up), burn (rear wheelspin).
  const STATES = {
    ENTER: {
      dur: T_ENTER, next: 'DRIFT_TO_PROFILE', pose(u, o) {
        glide(u * T_ENTER, o);
        o.yaw = YAW_IN; o.dir = 1; o.steer = -0.25;
      }
    },
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
        const wig = 0.5 * sin2(u / 0.5);                       // tail kicks out, then straightens
        o.yaw = YAW_RIGHT + wig;
        o.m = Math.sin(Math.PI * clamp01(u / 0.55)); o.burn = o.m; o.dir = 1; o.steer = -wig;
        o.lift = 0.05 * Math.sin(Math.PI * clamp01(u / 0.6));
      }
    },
    TURN_AROUND: {
      dur: 1.0, next: 'EXIT_LEFT', pose(u, o) {
        o.pos.copy(K.center).lerp(K.turn, skew(u, 0.6));       // launch right, then slide to a stop
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
  // Advance the clock; a finished state rolls over into its `next`. WAIT_FOR_CHOICE and DONE never finish.
  const advance = (st, dt) => {
    st.t += dt;
    for (let s; st.t >= (s = STATES[st.name]).dur;) { st.t -= s.dur; st.name = s.next; }
  };
  // </sequence>

  /* ---- runner: frames are drawn only while something moves ---- */
  const S = { name: 'DONE', t: 0 };
  const pose = { pos: new V3(), yaw: 0, m: 0, dir: 0, steer: 0, lift: 0, burn: 0 };
  const prev = new V3(), step = new V3(), fwd = new V3();
  let steerNow = 0, running = false, locked = false, raf = 0, last = 0;
  let currentType = 'default';
  let reminderTriggeredAt = 0;

  // Reminder buttons. The window is click-through; it only listens to the mouse while the pointer is on a button.
  const ui = document.getElementById('choices');
  const btns = [...ui.querySelectorAll('button')];
  const setInteractive = (on) => window.companion && window.companion.interactive(on);
  function showChoices() { // centred above the car, clear of everything it can sweep through
    const mid = new V3(K.center.x, 0, K.center.z).project(camera);
    ui.hidden = false; // unhide first so the button row can be measured
    ui.style.left = `${((mid.x + 1) / 2) * window.innerWidth}px`;
    ui.style.top = `${Math.max(8, roofPx() - CFG.buttonGapPx - ui.offsetHeight)}px`;
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
    tilt.rotation.set(-(0.04 + 0.03 * o.m) + o.lift, 0, -o.dir * 0.07 * o.m); // downhill pitch, lean outward
    // Wheels roll with the distance travelled along the car's own axis (negative while sliding tail-first).
    const travelled = step.copy(o.pos).sub(prev).dot(fwd.set(-Math.sin(o.yaw), 0, -Math.cos(o.yaw)));
    prev.copy(o.pos);
    steerNow += (o.steer - steerNow) * Math.min(1, dt * 12); // smooth counter-steer
    for (const w of wheels) {
      w.spin.rotation.x -= (travelled / w.radius) * (w.rear ? 1 + 0.8 * o.m : 1);
      if (w.rear) w.spin.rotation.x -= o.burn * dt * 30;        // rear wheels light up
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
    if (S.name === 'DONE' && !smoking) {          // last frame was empty: tidy up and let main hide the window
      running = false;
      ui.hidden = true;
      setInteractive(false);
      window.companion.done();
    } else if (S.name !== 'WAIT_FOR_CHOICE' || smoking) schedule(); // waiting for a click costs no frames
  }

  function choose(next) {
    if (S.name !== 'WAIT_FOR_CHOICE' || locked) return;
    locked = true;
    btns.forEach((b) => (b.disabled = true));
    setInteractive(false);
    window.companion?.logReminder({
      type: currentType,
      status: next === 'EXIT_RIGHT' ? 'completed' : 'postponed',
      triggeredAt: reminderTriggeredAt,
      respondedAt: Date.now(),
    });
    go(next);
    last = performance.now();
    schedule();
  }
  document.getElementById('btn-drink').addEventListener('click', () => choose('EXIT_RIGHT'));
  document.getElementById('btn-later').addEventListener('click', () => choose('TURN_AROUND'));
  for (const b of btns) {
    b.addEventListener('mouseenter', () => { if (!locked) setInteractive(true); });
    b.addEventListener('mouseleave', () => setInteractive(false));
  }

  function start(payload) {
    if (running) return;
    running = true;
    locked = false;
    steerNow = 0;
    smokeClock = 0;
    currentType =
      payload && typeof payload.type === 'string' && payload.type
        ? payload.type.slice(0, 64)
        : 'default';
    reminderTriggeredAt = Date.now();
    placeCamera();
    plan();
    ui.hidden = true;
    btns.forEach((b) => (b.disabled = false));
    car.visible = true;
    go('ENTER');
    STATES.ENTER.pose(0, pose);
    prev.copy(pose.pos);
    last = performance.now();
    schedule();
  }

  // Warm-up: compile shaders and upload textures once while the window is still hidden.
  car.visible = true; render(); car.visible = false; render();

  if (!window.companion) return console.error('Preload bridge missing; cannot receive triggers.');
  window.companion.onDrift(start);
  window.companion.ready();
}