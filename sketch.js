// Communio: Welcome to Symbiosis
// Sion Cao
// 2026.9.2

// Instructions:
// Communio is an interactive computational installation that transforms
// participant data into individual digital cells within a shared ecosystem.
// Enter your name to begin, then position your face in front of the camera
// and remain still while the system captures and analyses facial and
// pseudo-thermal features. These features determine the visual appearance
// and identity of your digital cell.
//
// Next, speak into the microphone for approximately five seconds.
// Volume, pitch, rhythm, variation, and silence are analysed and translated
// into the cell's size, movement, activity, and behavioural characteristics.
// Silence is also accepted as a valid input.
//
// Once generated, the cell enters the shared computational ecosystem.
// Use your hand and index finger in front of the gesture camera to interact
// with the cells. Cells continuously compare their identity signatures and
// behavioural characteristics. Similar and compatible cells can communicate,
// attract, gather, and gradually fuse over time.


// Optional Blurb:
// Communio explores the emerging symbiotic relationship between humans and
// computational systems. Rather than displaying participant data directly,
// facial, pseudo-thermal, and voice data are translated into digital cells
// with individual appearances and behaviours.
//
// As these cells enter a shared computational ecosystem, relationships emerge
// through similarity, compatibility, proximity, and time. Individual
// contributions gradually become part of a collective system, making normally
// invisible processes of data interpretation, connection, and computational
// mediation perceptible.
//
// Individuals become a collective. Data becomes life.


// Acknowledgements:
// Google MediaPipe. Face Detection / Face Landmarker.
// https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js

// Acknowledgements:
// Google MediaPipe. Selfie Segmentation.
// https://developers.google.com/mediapipe/solutions/vision/selfie_segmentation

// Acknowledgements:
// OpenCV.js. Image Processing (imgproc module).
// https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html

// Acknowledgements:
// p5.js / p5.sound. p5.FFT — Audio Analysis.
// https://p5js.org/reference/p5.sound/p5.FFT/

// Acknowledgements:
// Reynolds, C. W. Boids: Background and Update.
// Reference for autonomous agents and collective behaviour.
// https://www.red3d.com/cwr/boids/

// Acknowledgements:
// The Coding Train. Flocking Simulation.
// Reference for steering, attraction, cohesion, and collective movement.
// https://thecodingtrain.com/challenges/124-flocking-simulation/

const MODE = document.body.dataset.mode || 'capture';
const IS_CAPTURE = MODE === 'capture';
const IS_PROJECTION = MODE === 'projection';
const APP_VERSION = 'thermal-preview-20260716-55';
const FACE_PREVIEW_FLIP_X = true;
const urlParams = new URLSearchParams(window.location.search);
const VISUAL_FUSION_MATURITY_FRAMES = 60 * (urlParams.get('fusionFast') === '1' ? 45 : 300);
const ACTIVE_SESSION_ID = IS_CAPTURE
  ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  : (urlParams.get('session') || localStorage.getItem('face-cell-active-session') || 'standalone');
let projectionSessionId = ACTIVE_SESSION_ID;

const glCanvas = document.getElementById('webglCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const ctx = overlayCanvas.getContext('2d');
const gl = glCanvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });

let W = 0, H = 0;
let program, uniforms = {}, attribs = {};
let cells = new CellSystem();
let lastCapture = 0;
let captureStart = null;
let hasCapturedThisFace = false;
let bgmStarted = false;
let bgmVolume = 0.28;
let bgmPlaybackRate = 1;
let projectionOpened = false;
let projectionWindowRef = null;
let interactionPhase = IS_CAPTURE ? 'intro' : 'face';
let phaseStartedAt = performance.now();
let participantName = '';
let participantId = '';
let pendingFaceCell = null;
let audioProgress = 0;
let audioStartedAt = 0;
let audioStatus = '';
let currentAudioRunId = 0;
let handExitStartedAt = 0;
const finalizedCellIds = new Set();
const thermalPreviewCanvas = document.createElement('canvas');
const thermalPreviewCtx = thermalPreviewCanvas.getContext('2d', { willReadFrequently: true });
let capturePreviewRect = null;
let birthChamber = null;
let birthQueue = [];
const queuedBirthIds = new Set();
const pendingBirthFinals = new Map();
const pendingBirthAudio = new Map();
let birthAddTimers = new Set();
let projectionStats = {
  previews: 0,
  audioFrames: 0,
  finals: 0,
  queued: 0,
  added: 0,
  lastStatus: 'waiting',
  lastId: '',
  lastAt: 0,
};

const captureNeed = 5000;
const faceFormationNeed = 4000;
const audioNeed = 5000;
const createdHoldNeed = 5000;
const handExitNeed = 4000;
const captureCooldown = 3000;
const projectionBirthHoldNeed = 2600;
const channel = ('BroadcastChannel' in window) ? new BroadcastChannel('face-cell-petri') : null;
const seenCellIds = new Set();
const scheduledCellIds = new Set();
const sentBirthEventIds = new Set();
const sentFinalEventIds = new Set();
const processedProjectionEventIds = new Set();
let lastStoragePoll = 0;
let lastBirthPollTime = 0;
let lastAudioPollTime = 0;

if (IS_CAPTURE) {
  try {
    localStorage.setItem('face-cell-active-session', ACTIVE_SESSION_ID);
    localStorage.removeItem('face-cell-latest');
    localStorage.removeItem('face-cell-queue');
    localStorage.removeItem('face-cell-birth');
    localStorage.removeItem('face-cell-audio');
    localStorage.removeItem('face-cell-events');
    localStorage.removeItem('face-cell-event-ping');
  } catch (e) {}
}

const nameGate = document.getElementById('nameGate');
const nameForm = document.getElementById('nameForm');
const participantNameInput = document.getElementById('participantNameInput');

function makeParticipantId(name) {
  const clean = (name || 'participant').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').slice(0, 24) || 'participant';
  return `${clean}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function updateNameGateVisibility() {
  if (!IS_CAPTURE || !nameGate) return;
  nameGate.classList.toggle('hidden', interactionPhase !== 'intro');
  if (interactionPhase === 'intro' && participantNameInput) {
    setTimeout(() => participantNameInput.focus(), 40);
  }
}

function beginParticipantFromName(name) {
  const cleanName = (name || '').trim();
  if (!cleanName) return;
  participantName = cleanName.slice(0, 32);
  participantId = makeParticipantId(participantName);
  captureStart = null;
  hasCapturedThisFace = false;
  pendingFaceCell = null;
  audioProgress = 0;
  audioStatus = '';
  handExitStartedAt = 0;
  setInteractionPhase('face');
}

if (IS_CAPTURE && nameForm) {
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    beginParticipantFromName(participantNameInput?.value || '');
  });
  updateNameGateVisibility();
}

function setInteractionPhase(phase) {
  interactionPhase = phase;
  phaseStartedAt = performance.now();
  updateNameGateVisibility();
}

function resetCaptureCycle() {
  if (!IS_CAPTURE) return;
  currentAudioRunId++;
  pendingFaceCell = null;
  audioProgress = 0;
  audioStartedAt = 0;
  audioStatus = '';
  captureStart = null;
  hasCapturedThisFace = false;
  handExitStartedAt = 0;
  birthChamber = null;
  birthQueue = [];
  queuedBirthIds.clear();
  pendingBirthFinals.clear();
  pendingBirthAudio.clear();
  participantName = '';
  participantId = '';
  if (participantNameInput) participantNameInput.value = '';
}

function isCaptureHandDetected() {
  if (!IS_CAPTURE) return false;
  const hand = window.latestFaceCellHandData;
  if (!hand || !hand.detected) return false;
  return Date.now() - (hand.time || 0) < 950;
}

function isMessageForSession(msg) {
  if (!msg) return false;
  if (!msg.sessionId) return true;
  if (msg.sessionId === projectionSessionId) return true;
  if (IS_PROJECTION) {
    const active = localStorage.getItem('face-cell-active-session');
    if (active && msg.sessionId === active) return true;
  }
  return false;
}

function syncProjectionSession() {
  if (!IS_PROJECTION) return;
  try {
    const active = localStorage.getItem('face-cell-active-session');
    if (active && active !== projectionSessionId) {
      projectionSessionId = active;
      seenCellIds.clear();
      scheduledCellIds.clear();
      processedProjectionEventIds.clear();
      queuedBirthIds.clear();
      pendingBirthFinals.clear();
      pendingBirthAudio.clear();
      birthQueue = [];
      birthAddTimers.forEach(timer => clearTimeout(timer));
      birthAddTimers.clear();
      birthChamber = null;
      cells.cells = [];
      projectionStats = {
        previews: 0,
        audioFrames: 0,
        finals: 0,
        queued: 0,
        added: 0,
        lastStatus: 'new session',
        lastId: '',
        lastAt: performance.now(),
      };
      lastBirthPollTime = 0;
      lastAudioPollTime = 0;
    }
  } catch (e) {}
}

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  glCanvas.width = overlayCanvas.width = W;
  glCanvas.height = overlayCanvas.height = H;
  if (gl) gl.viewport(0, 0, W, H);
}
window.addEventListener('resize', resize);
resize();

function dish() {
  if (IS_PROJECTION) {
    // Projection page: reserve a visible right-side incubation area for cell formation.
    const r = Math.min(H * 0.42, W * 0.32);
    const cx = Math.max(r + W * 0.035, W * 0.38);
    const cy = H * 0.56;
    return { cx, cy, r };
  }
  // Capture page: no visible petri dish, but we keep a small off-screen-ish dish model
  // so captured cells can still be previewed if needed.
  const cx = W * 0.78;
  const cy = H * 0.52;
  const r = Math.min(W * 0.18, H * 0.25);
  return { cx, cy, r };
}

function startBGM() {
  if (!IS_PROJECTION) return;
  if (bgmStarted) return;
  const bgm = document.getElementById('bgm');
  if (!bgm) return;
  bgm.volume = 0.28;
  bgm.play().then(() => { bgmStarted = true; }).catch(() => {});
}
window.addEventListener('pointerdown', startBGM);
window.addEventListener('keydown', startBGM);

function updateInteractiveBGM() {
  if (!IS_PROJECTION || !bgmStarted) return;
  const bgm = document.getElementById('bgm');
  if (!bgm) return;

  const hand = cells.handSignal;
  const handIsActive = !!(
    hand &&
    hand.detected &&
    Date.now() - (hand.lastDetectedAt || hand.time || 0) < 900
  );
  let targetVolume = 0.28;
  let targetRate = 1;

  if (handIsActive) {
    const x = Math.max(0, Math.min(1, hand.x ?? 0.5));
    const y = Math.max(0, Math.min(1, hand.y ?? 0.5));
    const speed = Math.max(0, Math.min(1, (hand.velocity || 0) / 1.4));
    const openness = Math.max(0, Math.min(1, hand.openness ?? 0.5));

    // Higher/open hands reveal more of the music; horizontal movement changes
    // its pace and pitch slightly, while fast gestures add a short lift.
    targetVolume = 0.20 + (1 - y) * 0.10 + openness * 0.035 + speed * 0.035;
    targetRate = 0.965 + x * 0.07 + speed * 0.025;
  }

  bgmVolume += (targetVolume - bgmVolume) * 0.035;
  bgmPlaybackRate += (targetRate - bgmPlaybackRate) * 0.025;
  bgm.volume = Math.max(0, Math.min(0.42, bgmVolume));
  bgm.playbackRate = Math.max(0.94, Math.min(1.08, bgmPlaybackRate));
}

const openBtn = document.getElementById('openProjection');
if (openBtn) {
  openBtn.addEventListener('click', () => {
    const features = 'popup=yes,width=1280,height=720,left=0,top=0,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes,fullscreen=yes';
    const projectionParams = new URLSearchParams({ v: APP_VERSION, session: ACTIVE_SESSION_ID });
    if (urlParams.get('fusionFast') === '1') projectionParams.set('fusionFast', '1');
    const w = window.open(`petri.html?${projectionParams.toString()}`, 'FaceCellPetriProjection', features);
    projectionWindowRef = w;
    projectionOpened = !!w;
    if (w) {
      w.focus();
      try {
        w.moveTo(0, 0);
        w.resizeTo(screen.availWidth, screen.availHeight);
      } catch (e) {}
    }
    startBGM();
  });
}

function sendDirectProjectionMessage(msg) {
  if (!IS_CAPTURE || !projectionWindowRef || projectionWindowRef.closed) return;
  try {
    projectionWindowRef.postMessage({ source: 'face-cell-capture', ...msg }, window.location.origin);
  } catch (e) {}
}

function appendProjectionEvent(type, payload) {
  if (!IS_CAPTURE || !payload) return null;
  const event = {
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    time: Date.now(),
    sessionId: ACTIVE_SESSION_ID,
    payload: { ...payload, type, sessionId: ACTIVE_SESSION_ID },
  };
  try {
    const existing = JSON.parse(localStorage.getItem('face-cell-events') || '[]');
    const events = Array.isArray(existing) ? existing : [];
    events.push(event);
    // Keep this short because each birth/final event contains a PNG data URL.
    localStorage.setItem('face-cell-events', JSON.stringify(events.slice(-10)));
    localStorage.setItem('face-cell-event-ping', JSON.stringify(event));
  } catch (e) {
    try {
      localStorage.setItem('face-cell-events', JSON.stringify([event]));
      localStorage.setItem('face-cell-event-ping', JSON.stringify(event));
    } catch (err) {}
  }
  return event;
}

function processProjectionEvent(event) {
  if (!IS_PROJECTION || !event || !event.eventId || processedProjectionEventIds.has(event.eventId)) return;
  const msg = event.payload || {};
  if (!isMessageForSession(msg)) return;
  processedProjectionEventIds.add(event.eventId);
  if (processedProjectionEventIds.size > 160) processedProjectionEventIds.clear();

  if (event.type === 'CELL_BIRTH_PREVIEW' && msg.image) {
    if (msg.id && (seenCellIds.has(msg.id) || scheduledCellIds.has(msg.id))) return;
    showBirthPreview(msg);
    return;
  }
  if (event.type === 'ADD_FACE_CELL' && msg.image) {
    addCellFromMessage(msg, { source: 'event-log' });
    startBGM();
  }
}

function pollProjectionEvents() {
  if (!IS_PROJECTION) return;
  try {
    const events = JSON.parse(localStorage.getItem('face-cell-events') || '[]');
    if (Array.isArray(events)) events.forEach(processProjectionEvent);

    const ping = JSON.parse(localStorage.getItem('face-cell-event-ping') || '{}');
    processProjectionEvent(ping);
  } catch (e) {}
}

function handleProjectionMessage(msg) {
  if (!IS_PROJECTION || !isMessageForSession(msg)) return;
  if (msg.type === 'CELL_BIRTH_PREVIEW' && msg.image) showBirthPreview(msg);
  if (msg.type === 'CELL_AUDIO_PROGRESS') updateBirthAudio(msg);
  if (msg.type === 'ADD_FACE_CELL' && msg.image) {
    addCellFromMessage(msg);
    startBGM();
  }
  if (msg.type === 'CLEAR_CELLS') cells.cells = [];
  if (msg.type === 'HAND_DATA' && msg.handData) cells.setHandData(msg.handData);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const msg = event.data || {};
  if (msg.source !== 'face-cell-capture') return;
  handleProjectionMessage(msg);
});

if (channel) {
  channel.onmessage = (event) => {
    const msg = event.data || {};
    handleProjectionMessage(msg);
  };
}

window.addEventListener('storage', (event) => {
  if (!IS_PROJECTION) return;
  try {
    if (event.key === 'face-cell-event-ping') {
      processProjectionEvent(JSON.parse(event.newValue || '{}'));
      return;
    }
    if (event.key === 'face-cell-events') {
      const events = JSON.parse(event.newValue || '[]');
      if (Array.isArray(events)) events.forEach(processProjectionEvent);
      return;
    }
    const msg = JSON.parse(event.newValue || '{}');
    if (!isMessageForSession(msg)) return;
    if (event.key === 'face-cell-latest' && msg.image) addCellFromMessage(msg);
    if (event.key === 'face-cell-birth' && msg.type === 'CELL_BIRTH_PREVIEW' && msg.image) showBirthPreview(msg);
    if (event.key === 'face-cell-audio' && msg.type === 'CELL_AUDIO_PROGRESS') updateBirthAudio(msg);
    if (event.key === 'face-cell-hand' && msg.type === 'HAND_DATA' && msg.handData) cells.setHandData(msg.handData);
  } catch (e) {}
});

function broadcastFaceCell(payload) {
  const id = payload.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msg = { type: 'ADD_FACE_CELL', ...payload, id, sessionId: ACTIVE_SESSION_ID, time: Date.now() };
  if (channel) channel.postMessage(msg);
  sendDirectProjectionMessage(msg);
  if (!sentFinalEventIds.has(msg.id)) {
    sentFinalEventIds.add(msg.id);
    if (IS_CAPTURE) releaseCaptureBirthCell(msg);
    appendProjectionEvent('ADD_FACE_CELL', msg);
  }
  try {
    localStorage.setItem('face-cell-latest', JSON.stringify(msg));
    const existing = JSON.parse(localStorage.getItem('face-cell-queue') || '[]');
    const queue = Array.isArray(existing) ? existing.filter(item => item && item.id !== msg.id) : [];
    queue.push(msg);
    localStorage.setItem('face-cell-queue', JSON.stringify(queue.slice(-6)));
  } catch (e) {}
}

function broadcastFaceCellReliably(payload) {
  const stablePayload = { ...payload, id: payload.id || `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  broadcastFaceCell(stablePayload);
  setTimeout(() => broadcastFaceCell(stablePayload), 320);
  setTimeout(() => broadcastFaceCell(stablePayload), 920);
}

function broadcastBirthEvent(type, payload) {
  const msg = { type, ...payload, sessionId: ACTIVE_SESSION_ID, time: Date.now() };
  if (channel) channel.postMessage(msg);
  sendDirectProjectionMessage(msg);
  if (IS_CAPTURE) {
    if (type === 'CELL_BIRTH_PREVIEW' && msg.image) showBirthPreview(msg);
    if (type === 'CELL_AUDIO_PROGRESS') updateBirthAudio(msg);
  }
  if (type === 'CELL_BIRTH_PREVIEW' && msg.id && !sentBirthEventIds.has(msg.id)) {
    sentBirthEventIds.add(msg.id);
    appendProjectionEvent(type, msg);
  }
  try {
    localStorage.setItem(type === 'CELL_AUDIO_PROGRESS' ? 'face-cell-audio' : 'face-cell-birth', JSON.stringify(msg));
  } catch (e) {}
}

function pollLatestStoredCell() {
  if (!IS_PROJECTION) return;
  syncProjectionSession();
  const now = performance.now();
  if (now - lastStoragePoll < 90) return;
  lastStoragePoll = now;
  try {
    pollProjectionEvents();

    const birth = JSON.parse(localStorage.getItem('face-cell-birth') || '{}');
    if (
      birth &&
      birth.type === 'CELL_BIRTH_PREVIEW' &&
      birth.image &&
      isMessageForSession(birth) &&
      (birth.time || 0) > lastBirthPollTime
    ) {
      lastBirthPollTime = birth.time || Date.now();
      showBirthPreview(birth);
    }

    const audio = JSON.parse(localStorage.getItem('face-cell-audio') || '{}');
    if (
      audio &&
      audio.type === 'CELL_AUDIO_PROGRESS' &&
      isMessageForSession(audio) &&
      (audio.time || 0) > lastAudioPollTime
    ) {
      lastAudioPollTime = audio.time || Date.now();
      updateBirthAudio(audio);
    }

    const hand = JSON.parse(localStorage.getItem('face-cell-hand') || '{}');
    if (hand && hand.type === 'HAND_DATA' && hand.handData && isMessageForSession(hand)) {
      cells.setHandData(hand.handData);
    }

    const queue = JSON.parse(localStorage.getItem('face-cell-queue') || '[]');
    if (Array.isArray(queue)) {
      for (const item of queue) {
        if (isMessageForSession(item) && item && item.image && item.id && !seenCellIds.has(item.id) && !scheduledCellIds.has(item.id)) {
          addCellFromMessage(item, { source: 'queue' });
        }
      }
    }
    const msg = JSON.parse(localStorage.getItem('face-cell-latest') || '{}');
    if (!isMessageForSession(msg)) return;
    if (!msg || !msg.image || !msg.id) return;
    if (seenCellIds.has(msg.id)) return;
    if (scheduledCellIds.has(msg.id)) return;
    addCellFromMessage(msg, { source: 'latest' });
  } catch (e) {}
}

function markProjectionStatus(status, msg = null) {
  if (!IS_PROJECTION) return;
  projectionStats.lastStatus = status;
  projectionStats.lastId = msg?.id || projectionStats.lastId;
  projectionStats.lastAt = performance.now();
}

function addCellFromMessage(msg, meta = {}) {
  const opts = buildCellOptionsFromMessage(msg);
  if (IS_PROJECTION) {
    if (msg.id && (seenCellIds.has(msg.id) || scheduledCellIds.has(msg.id) || pendingBirthFinals.has(msg.id))) {
      markProjectionStatus(`duplicate skipped ${meta.source || ''}`.trim(), msg);
      return;
    }
    projectionStats.finals++;
    queueFinalCellForBirth(msg, opts, meta);
    return;
  }
  if (msg.id) {
    if (seenCellIds.has(msg.id)) return;
    seenCellIds.add(msg.id);
    if (seenCellIds.size > 80) seenCellIds.clear();
  }
  addCellFromDataURL(msg.image, opts);
}

function buildCellOptionsFromMessage(msg) {
  return {
    id: msg.id,
    participantName: msg.participantName,
    participantId: msg.participantId,
    appearance: msg.appearance,
    personality: msg.personality || msg.behavior,
    behavior: msg.behavior || msg.personality,
    voiceProfile: msg.voiceProfile || msg.personality?.voiceProfile,
    audioFeatureVector: msg.audioFeatureVector || msg.personality?.audioFeatureVector,
    faceMetrics: msg.faceMetrics,
    morphology: msg.morphology,
    featureVector: msg.featureVector,
    audioMetrics: msg.audioMetrics,
    thermalMetrics: msg.thermalMetrics,
    thermalSignature: msg.thermalSignature,
    parentIds: msg.parentIds,
  };
}

function addCellFromDataURL(dataURL, opts = {}) {
  const img = new Image();
  img.onload = () => {
    cells.add(img, dish(), opts);
    if (opts.id) {
      seenCellIds.add(opts.id);
      scheduledCellIds.delete(opts.id);
    }
    if (IS_PROJECTION) {
      projectionStats.added++;
      markProjectionStatus(`added to dish (${cells.cells.length})`, opts);
    }
  };
  img.onerror = () => {
    if (opts.id) scheduledCellIds.delete(opts.id);
    if (IS_PROJECTION) markProjectionStatus('image load failed', opts);
  };
  img.src = dataURL;
}

function birthChamberLayout() {
  if (IS_CAPTURE) {
    const r = Math.max(72, Math.min(132, W * 0.078, H * 0.115));
    if (capturePreviewRect) {
      const cx = capturePreviewRect.x + capturePreviewRect.w * 0.5;
      const cy = Math.min(H - r - 34, capturePreviewRect.y + capturePreviewRect.h + r * 1.72);
      return { cx, cy, r };
    }
    return { cx: W * 0.5, cy: H * 0.72, r };
  }
  const d = dish();
  const sideRoom = W - (d.cx + d.r);
  const r = Math.max(118, Math.min(230, Math.min(W, H) * 0.20, sideRoom * 0.34));
  const cx = sideRoom > r * 1.45 ? d.cx + d.r + sideRoom * 0.52 : Math.min(W - r * 0.85, d.cx + d.r * 0.70);
  const cy = H * 0.50;
  return { cx, cy, r };
}

function showBirthPreview(msg) {
  if (IS_PROJECTION && msg?.id && (seenCellIds.has(msg.id) || scheduledCellIds.has(msg.id))) return;
  if (IS_PROJECTION && birthChamber && msg?.id && birthChamber.id !== msg.id) {
    if (!queuedBirthIds.has(msg.id) && !pendingBirthFinals.has(msg.id)) {
      birthQueue.push({ type: 'preview', msg });
      queuedBirthIds.add(msg.id);
      markProjectionStatus('birth preview queued', msg);
    }
    return;
  }
  displayBirthPreviewNow(msg);
}

function displayBirthPreviewNow(msg) {
  if (IS_PROJECTION) {
    projectionStats.previews++;
    markProjectionStatus('birth preview', msg);
  }
  if (birthChamber && msg?.id && birthChamber.id === msg.id) {
    birthChamber.image = msg.image || birthChamber.image;
    birthChamber.appearance = msg.appearance || birthChamber.appearance || {};
    birthChamber.faceMetrics = msg.faceMetrics || birthChamber.faceMetrics || {};
    return;
  }
  const img = new Image();
  const layout = birthChamberLayout();
  birthChamber = {
    id: msg.id,
    image: msg.image,
    img,
    appearance: msg.appearance || {},
    faceMetrics: msg.faceMetrics || {},
    personality: null,
    audio: { progress: 0, volume: 0, highRatio: 0, lowRatio: 0, flux: 0 },
    phase: 'face',
    createdAt: performance.now(),
    releaseStart: 0,
    releaseTarget: null,
    x: layout.cx,
    y: layout.cy,
  };
  img.src = msg.image;

  if (msg.id && pendingBirthAudio.has(msg.id)) {
    const audio = pendingBirthAudio.get(msg.id);
    pendingBirthAudio.delete(msg.id);
    updateBirthAudio(audio);
  }
}

function queueFinalCellForBirth(msg, opts = {}, meta = {}) {
  if (!IS_PROJECTION) {
    releaseBirthCell(msg, opts);
    return;
  }
  if (msg.id && (seenCellIds.has(msg.id) || scheduledCellIds.has(msg.id))) {
    markProjectionStatus(`duplicate skipped ${meta.source || ''}`.trim(), msg);
    return;
  }

  if (!birthChamber || (msg.id && birthChamber.id === msg.id)) {
    releaseBirthCell(msg, opts);
    return;
  }

  if (msg.id) pendingBirthFinals.set(msg.id, { msg, opts });
  if (!msg.id || !queuedBirthIds.has(msg.id)) {
    birthQueue.push({ type: 'final', msg });
    if (msg.id) queuedBirthIds.add(msg.id);
  }
  markProjectionStatus('queued for birth chamber', msg);
}

function advanceBirthQueue() {
  if (!IS_PROJECTION || birthChamber || birthQueue.length === 0) return;
  const next = birthQueue.shift();
  if (!next || !next.msg) return;
  if (next.msg.id) queuedBirthIds.delete(next.msg.id);

  const pendingFinal = next.msg.id ? pendingBirthFinals.get(next.msg.id) : null;
  if (pendingFinal) {
    pendingBirthFinals.delete(next.msg.id);
    releaseBirthCell(pendingFinal.msg, pendingFinal.opts);
    return;
  }

  if (next.type === 'final') {
    releaseBirthCell(next.msg, buildCellOptionsFromMessage(next.msg));
  } else {
    displayBirthPreviewNow(next.msg);
  }
}

function releaseCaptureBirthCell(msg) {
  if (!IS_CAPTURE || !msg) return;
  if (!birthChamber || (msg.id && birthChamber.id !== msg.id)) {
    displayBirthPreviewNow(msg);
  }
  if (!birthChamber) return;

  birthChamber.personality = msg.personality || msg.behavior || null;
  birthChamber.audio = {
    ...(birthChamber.audio || {}),
    progress: 1,
    volume: msg.personality?.averageVolume ?? msg.personality?.soundEnergy ?? birthChamber.audio?.volume ?? 0,
    highRatio: msg.personality?.highFrequency ?? birthChamber.audio?.highRatio ?? 0,
    lowRatio: msg.personality?.depth ?? birthChamber.audio?.lowRatio ?? 0,
    flux: msg.personality?.volumeVariation ?? birthChamber.audio?.flux ?? 0,
  };

  const layout = birthChamberLayout();
  birthChamber.phase = 'release';
  birthChamber.releaseStart = performance.now();
  birthChamber.releaseTarget = {
    x: Math.min(W - layout.r * 0.78, layout.cx + layout.r * 2.15),
    y: Math.max(layout.r * 1.05, layout.cy - layout.r * 0.95),
  };
}

function updateBirthAudio(msg) {
  if (!birthChamber || (msg.id && birthChamber.id !== msg.id)) {
    if (msg?.id) pendingBirthAudio.set(msg.id, msg);
    return;
  }
  if (IS_PROJECTION) {
    projectionStats.audioFrames++;
    markProjectionStatus('audio shaping', msg);
  }
  birthChamber.phase = 'voice';
  birthChamber.audio = {
    progress: Math.max(birthChamber.audio?.progress || 0, msg.progress || 0),
    volume: msg.volume || 0,
    highRatio: msg.highRatio || 0,
    lowRatio: msg.lowRatio || 0,
    flux: msg.flux || 0,
  };
}

function releaseBirthCell(msg, opts = {}) {
  if (msg.id && seenCellIds.has(msg.id)) {
    markProjectionStatus('already added', msg);
    return;
  }
  if (msg.id && scheduledCellIds.has(msg.id)) {
    markProjectionStatus('already queued', msg);
    return;
  }
  if (msg.id) scheduledCellIds.add(msg.id);
  if (scheduledCellIds.size > 120) scheduledCellIds.clear();
  projectionStats.queued++;
  markProjectionStatus('queued for dish', msg);
  const d = dish();
  const target = {
    x: d.cx + d.r * (0.50 + Math.random() * 0.24),
    y: d.cy + (Math.random() - 0.5) * d.r * 0.72,
  };

  const hadPreview = birthChamber && birthChamber.id === msg.id && birthChamber.img && birthChamber.img.complete;
  displayBirthPreviewNow(msg);
  if (birthChamber) {
    birthChamber.personality = msg.personality || msg.behavior || null;
    birthChamber.audio = {
      ...(birthChamber.audio || {}),
      progress: 1,
      volume: msg.personality?.averageVolume ?? msg.personality?.soundEnergy ?? birthChamber.audio?.volume ?? 0,
      highRatio: msg.personality?.highFrequency ?? birthChamber.audio?.highRatio ?? 0,
      lowRatio: msg.personality?.depth ?? birthChamber.audio?.lowRatio ?? 0,
      flux: msg.personality?.volumeVariation ?? birthChamber.audio?.flux ?? 0,
    };
  }

  const startRelease = () => {
    if (birthChamber && birthChamber.id === msg.id) {
      birthChamber.phase = 'release';
      birthChamber.releaseStart = performance.now();
      birthChamber.releaseTarget = target;
    }
    scheduleBirthCellAdd(msg, opts, target);
  };

  const visualDelay = hadPreview ? projectionBirthHoldNeed : projectionBirthHoldNeed + 900;
  const timer = setTimeout(() => {
    birthAddTimers.delete(timer);
    startRelease();
  }, visualDelay);
  birthAddTimers.add(timer);
}

function scheduleBirthCellAdd(msg, opts, target) {
  const timer = setTimeout(() => {
    birthAddTimers.delete(timer);
    addCellFromDataURL(msg.image, {
      ...opts,
      x: target.x,
      y: target.y,
      vx: -0.05 - Math.random() * 0.035,
      vy: (Math.random() - 0.5) * 0.035,
      reaction: 0.82,
    });
  }, 980);
  birthAddTimers.add(timer);
}

function buildFaceCellPayload(canvas) {
  const faceMetrics = canvas._faceMetrics || (typeof analyzeFaceCanvas === 'function' ? analyzeFaceCanvas(canvas, latestFaceBox) : null);
  const appearance = canvas._appearance || (typeof faceMetricsToAppearance === 'function' ? faceMetricsToAppearance(faceMetrics) : {});
  const thermalMetrics = canvas._thermalMetrics || (faceMetrics ? faceMetrics.thermal : null);
  const thermalSignature = canvas._thermalSignature || (thermalMetrics ? thermalMetrics.signature : null);
  const morphology = canvas._morphology || faceMetrics?.morphology || (typeof buildFaceMorphology === 'function' ? buildFaceMorphology(faceMetrics, thermalMetrics) : null);
  const featureVector = canvas._featureVector || faceMetrics?.featureVector || (typeof buildFaceFeatureVector === 'function' ? buildFaceFeatureVector(faceMetrics, thermalMetrics) : null);
  return {
    image: canvas.toDataURL('image/png'),
    participantName,
    participantId,
    faceMetrics,
    morphology,
    featureVector,
    appearance,
    thermalMetrics,
    thermalSignature,
  };
}

function finalizePendingCellWithAudio(cell, audioMetrics, statusText = '') {
  if (!cell || !cell.id || finalizedCellIds.has(cell.id)) return;
  finalizedCellIds.add(cell.id);
  if (finalizedCellIds.size > 120) finalizedCellIds.clear();

  const metrics = audioMetrics || (typeof defaultAudioMetrics === 'function' ? defaultAudioMetrics() : null);
  const personality = typeof audioMetricsToPersonality === 'function'
    ? audioMetricsToPersonality(metrics)
    : (typeof audioMetricsToBehavior === 'function' ? audioMetricsToBehavior(metrics) : {});

  broadcastFaceCellReliably({
    ...cell,
    participantName: cell.participantName || participantName,
    participantId: cell.participantId || participantId,
    audioMetrics: metrics,
    voiceProfile: personality.voiceProfile,
    audioFeatureVector: personality.audioFeatureVector,
    personality,
    behavior: personality,
  });

  audioStatus = statusText || `Cell created: ${personality.temperament || 'neutral'} voice, speed ${Number(personality.speedMul || 1).toFixed(1)}x`;
  pendingFaceCell = null;
  lastCapture = performance.now();
  setInteractionPhase('created');
  hasCapturedThisFace = false;
  captureStart = null;
}

async function beginAudioForPendingCell() {
  if (!pendingFaceCell || interactionPhase === 'audio') return;
  if (!pendingFaceCell.id) pendingFaceCell.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cellForAudio = { ...pendingFaceCell };
  const audioRunId = ++currentAudioRunId;
  broadcastBirthEvent('CELL_BIRTH_PREVIEW', pendingFaceCell);
  const birthId = pendingFaceCell.id;
  setTimeout(() => {
    if (pendingFaceCell && pendingFaceCell.id === birthId) broadcastBirthEvent('CELL_BIRTH_PREVIEW', pendingFaceCell);
  }, 250);
  setTimeout(() => {
    if (pendingFaceCell && pendingFaceCell.id === birthId) broadcastBirthEvent('CELL_BIRTH_PREVIEW', pendingFaceCell);
  }, 900);
  setInteractionPhase('audio');
  audioProgress = 0;
  audioStartedAt = performance.now();
  audioStatus = 'Listening';
  let lastAudioBirthPost = 0;
  let lastAudioMetrics = null;

  try {
    const audioCapture = typeof captureAudienceAudio === 'function'
      ? captureAudienceAudio(audioNeed, (p, frame) => {
        if (audioRunId !== currentAudioRunId) return;
        audioProgress = p;
        const now = performance.now();
        if (frame && now - lastAudioBirthPost > 120) {
          lastAudioBirthPost = now;
          lastAudioMetrics = frame;
          broadcastBirthEvent('CELL_AUDIO_PROGRESS', {
            id: cellForAudio.id,
            progress: p,
            volume: Math.max(0, Math.min(1, ((frame.rms || 0) - 0.006) / 0.075)),
            highRatio: Math.max(0, Math.min(1, frame.highRatio || 0)),
            lowRatio: Math.max(0, Math.min(1, frame.lowRatio || 0)),
            flux: Math.max(0, Math.min(1, (frame.flux || 0) * 12)),
          });
        }
      })
      : Promise.resolve(typeof defaultAudioMetrics === 'function' ? defaultAudioMetrics() : null);
    const timeoutCapture = new Promise(resolve => {
      setTimeout(() => resolve({ __timeout: true }), audioNeed + 900);
    });
    const result = await Promise.race([
      audioCapture.then(metrics => ({ metrics })),
      timeoutCapture,
    ]);
    if (audioRunId !== currentAudioRunId) return;
    const audioMetrics = result?.__timeout
      ? (typeof defaultAudioMetrics === 'function' ? defaultAudioMetrics() : null)
      : result.metrics;
    finalizePendingCellWithAudio(cellForAudio, audioMetrics, result?.__timeout ? 'Cell created: voice capture settled by timeout' : '');
  } catch (err) {
    console.warn('Microphone capture failed, using silence behavior:', err);
    const audioMetrics = typeof defaultAudioMetrics === 'function' ? defaultAudioMetrics() : null;
    finalizePendingCellWithAudio(cellForAudio, audioMetrics, 'Cell created from silence');
  }
}

async function initWebGL() {
  if (!gl) return;
  const [vs, fs] = await Promise.all([
    fetch(`shaders/metaball.vert?v=${APP_VERSION}`).then(r => r.ok ? r.text() : fetch(`metaball.vert?v=${APP_VERSION}`).then(x => x.text())),
    fetch(`shaders/metaball.frag?v=${APP_VERSION}`).then(r => r.ok ? r.text() : fetch(`metaball.frag?v=${APP_VERSION}`).then(x => x.text()))
  ]);
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  program = gl.createProgram();
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  attribs.pos = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(attribs.pos);
  gl.vertexAttribPointer(attribs.pos, 2, gl.FLOAT, false, 0, 0);

  uniforms.res = gl.getUniformLocation(program, 'u_resolution');
  uniforms.time = gl.getUniformLocation(program, 'u_time');
  uniforms.count = gl.getUniformLocation(program, 'u_count');
  uniforms.cells = gl.getUniformLocation(program, 'u_cells');
  uniforms.colors = gl.getUniformLocation(program, 'u_colors');
  uniforms.aspects = gl.getUniformLocation(program, 'u_aspects');
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
  return s;
}

function renderField() {
  if (!program) return;
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (IS_PROJECTION && urlParams.get('field') !== '1') return;
  gl.useProgram(program);
  gl.uniform2f(uniforms.res, W, H);
  gl.uniform1f(uniforms.time, performance.now() * 0.001);
  gl.uniform1i(uniforms.count, Math.min(cells.cells.length, 36));

  const cellData = new Float32Array(36 * 4);
  const colorData = new Float32Array(36 * 4);
  const aspectData = new Float32Array(36);
  for (let i = 0; i < Math.min(cells.cells.length, 36); i++) {
    const c = cells.cells[i];
    cellData[i*4+0] = c.x / W;
    cellData[i*4+1] = c.y / H;
    cellData[i*4+2] = c.r;
    cellData[i*4+3] = Math.max(c.reaction, c.fusion || 0) * (c.fieldStrength || 1);
    colorData[i*4+0] = c.color[0];
    colorData[i*4+1] = c.color[1];
    colorData[i*4+2] = c.color[2];
    colorData[i*4+3] = 1;
    aspectData[i] = c.aspect;
  }
  gl.uniform4fv(uniforms.cells, cellData);
  gl.uniform4fv(uniforms.colors, colorData);
  gl.uniform1fv(uniforms.aspects, aspectData);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function drawOverlay() {
  ctx.clearRect(0, 0, W, H);
  if (IS_CAPTURE) {
    drawCapturePreview();
    drawBirthChamber();
    drawCaptureUI();
    return;
  }

  drawProjectionMask();
  drawDishFrame();
  if (urlParams.get('trails') === '1') {
    for (const c of cells.cells) drawCellTrail(c);
  }
  drawCommunicationLinks();
  if (urlParams.get('handMarker') === '1') drawHandInfluenceMarker();
  for (const c of cells.cells) drawNucleus(c);
  drawBirthChamber();
  drawProjectionDebug();
}

function drawCapturePreview() {
  ctx.save();
  ctx.fillStyle = 'rgba(235,238,229,1)';
  ctx.fillRect(0,0,W,H);
  capturePreviewRect = null;

  const shouldShowCamera = interactionPhase !== 'intro' && typeof videoElement !== 'undefined' && videoElement && videoElement.readyState >= 2;
  if (!shouldShowCamera) {
    ctx.restore();
    return;
  }

  const rightPanelW = W > 1180 ? Math.min(560, Math.max(430, W * 0.36)) : 0;
  const leftMargin = rightPanelW ? 72 : 0;
  const rightGutter = rightPanelW ? 64 : 0;
  const leftRegionRight = rightPanelW ? W - rightPanelW - rightGutter : W;
  const availableW = Math.max(360, leftRegionRight - leftMargin);
  const previewW = Math.min(availableW, H * 0.70 * 16/9, W * (rightPanelW ? 0.55 : 0.74), 1120);
  const previewH = previewW * 9/16;
  const px = rightPanelW ? leftMargin + (availableW - previewW) * 0.5 : (W - previewW) * 0.5;
  const py = H * (rightPanelW ? 0.44 : 0.43) - previewH * 0.5;
  capturePreviewRect = { x: px, y: py, w: previewW, h: previewH };

  ctx.shadowColor = 'rgba(0,0,0,0.10)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = 'rgba(255,255,255,0.44)';
  roundRect(ctx, px - 10, py - 10, previewW + 20, previewH + 20, 24);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  roundRect(ctx, px, py, previewW, previewH, 16);
  ctx.clip();
  drawThermalVideoPreview(ctx, videoElement, px, py, previewW, previewH);
  ctx.fillStyle = 'rgba(238,246,240,0.08)';
  ctx.fillRect(px, py, previewW, previewH);
  ctx.restore();
}

function drawThermalVideoPreview(context, video, x, y, w, h) {
  const tw = 320;
  const th = 180;
  thermalPreviewCanvas.width = tw;
  thermalPreviewCanvas.height = th;
  thermalPreviewCtx.clearRect(0, 0, tw, th);
  drawImageCover(thermalPreviewCtx, video, 0, 0, tw, th, FACE_PREVIEW_FLIP_X);
  const img = thermalPreviewCtx.getImageData(0, 0, tw, th);
  const data = img.data;
  const heatMap = new Float32Array(tw * th);
  const samples = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const redBlue = Math.max(0, Math.min(1, (r - b + 96) / 220));
    const sat = max === 0 ? 0 : (max - min) / max;
    const skinWarmth = Math.max(0, Math.min(1, (r * 1.00 + g * 0.18 - b * 0.64) / 255));
    const heat = Math.max(0, Math.min(1, light * 0.28 + redBlue * 0.30 + sat * 0.20 + skinWarmth * 0.22));
    const p = i / 4;
    heatMap[p] = heat;
    if (p % 2 === 0) samples.push(heat);
  }

  samples.sort((a, b) => a - b);
  const low = samples[Math.floor(samples.length * 0.04)] ?? 0;
  const high = samples[Math.floor(samples.length * 0.985)] ?? 1;
  const range = Math.max(0.08, high - low);

  for (let p = 0; p < heatMap.length; p++) {
    const i = p * 4;
    let heat = Math.max(0, Math.min(1, (heatMap[p] - low) / range));
    heat = Math.pow(heat, 0.94);
    heat = Math.round(heat * 32) / 32;

    const x0 = p % tw;
    const y0 = Math.floor(p / tw);
    const left = x0 > 0 ? heatMap[p - 1] : heatMap[p];
    const up = y0 > 0 ? heatMap[p - tw] : heatMap[p];
    const edge = Math.max(0, Math.min(1, (Math.abs(heatMap[p] - left) + Math.abs(heatMap[p] - up)) * 6.5));
    const c = thermalColorRamp(heat);
    const contour = heat > 0.54 ? [1.00, 1.00, 0.16] : [0.08, 0.96, 1.00];
    const edgeMix = edge * 0.42;
    data[i] = Math.floor((c[0] * (1 - edgeMix) + contour[0] * edgeMix) * 255);
    data[i + 1] = Math.floor((c[1] * (1 - edgeMix) + contour[1] * edgeMix) * 255);
    data[i + 2] = Math.floor((c[2] * (1 - edgeMix) + contour[2] * edgeMix) * 255);
    data[i + 3] = 255;
  }
  thermalPreviewCtx.putImageData(img, 0, 0);
  context.save();
  context.globalAlpha = 1;
  context.imageSmoothingEnabled = true;
  context.drawImage(thermalPreviewCanvas, x, y, w, h);
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = 0.16;
  context.drawImage(thermalPreviewCanvas, x, y, w, h);
  context.restore();
}

function thermalColorRamp(t) {
  const stops = [
    { p: 0.00, c: [0.03, 0.00, 0.16] },
    { p: 0.12, c: [0.06, 0.02, 0.52] },
    { p: 0.27, c: [0.00, 0.28, 1.00] },
    { p: 0.40, c: [0.00, 0.92, 0.78] },
    { p: 0.53, c: [0.18, 1.00, 0.05] },
    { p: 0.66, c: [1.00, 0.96, 0.00] },
    { p: 0.78, c: [1.00, 0.48, 0.00] },
    { p: 0.90, c: [1.00, 0.02, 0.00] },
    { p: 1.00, c: [1.00, 0.96, 0.38] },
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].p) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a.p) / Math.max(0.001, b.p - a.p);
      return [
        a.c[0] + (b.c[0] - a.c[0]) * k,
        a.c[1] + (b.c[1] - a.c[1]) * k,
        a.c[2] + (b.c[2] - a.c[2]) * k,
      ];
    }
  }
  return stops[stops.length - 1].c;
}

function drawCaptureUI(){
  const phaseElapsed = performance.now() - phaseStartedAt;

  if (interactionPhase === 'intro') {
    drawCenteredPrompt('enter your name', 'press enter to join the digital ecosystem', 0, 'wait');
    return;
  }

  if (interactionPhase === 'faceCaptured') {
    const p = Math.min(1, phaseElapsed / faceFormationNeed);
    drawFramePrompt('Face captured', 'forming your cell appearance', p, 'face');
    if (p >= 1) {
      if (pendingFaceCell) beginAudioForPendingCell();
      else setInteractionPhase('face');
    }
    return;
  }

  if (interactionPhase === 'audio') {
    const elapsed = Math.min(audioNeed, performance.now() - audioStartedAt);
    const p = Math.max(audioProgress, elapsed / audioNeed);
    drawFramePrompt('Speak to your cell for 5 seconds, or stay silent', 'your voice shapes its movement and personality', Math.min(1,p), 'voice');
    if (phaseElapsed > audioNeed + 1800 && pendingFaceCell) {
      finalizePendingCellWithAudio(
        { ...pendingFaceCell },
        typeof defaultAudioMetrics === 'function' ? defaultAudioMetrics() : null,
        'Cell created after voice timeout'
      );
    }
    return;
  }

  if (interactionPhase === 'created') {
    const p = Math.min(1, phaseElapsed / createdHoldNeed);
    drawFramePrompt('Cell created', audioStatus || 'your cell enters the petri dish', p, 'created');
    if (p >= 1) {
      handExitStartedAt = 0;
      setInteractionPhase('hand');
      return;
    }
    return;
  }

  if (interactionPhase === 'hand') {
    const handPresent = isCaptureHandDetected();
    if (handPresent) {
      handExitStartedAt = 0;
    } else if (!handExitStartedAt) {
      handExitStartedAt = performance.now();
    }
    const leaveProgress = handExitStartedAt ? Math.min(1, (performance.now() - handExitStartedAt) / handExitNeed) : 0;
    const subtitle = handExitStartedAt
      ? 'show your fingertip to keep interacting'
      : 'your fingertip guides similar cells';
    drawFramePrompt('Move your fingertip', subtitle, leaveProgress, 'voice');
    if (leaveProgress >= 1) {
      resetCaptureCycle();
      setInteractionPhase('intro');
    }
    return;
  }

  if (typeof faceReady !== 'undefined' && faceReady) {
    if(!captureStart) captureStart = performance.now();
    const p = Math.min(1, (performance.now() - captureStart) / captureNeed);
    drawFramePrompt('Hold still for 5 seconds', 'thermal face data is shaping your cell colour', p, 'face');
    if(p >= 1 && !hasCapturedThisFace && performance.now() - lastCapture > captureCooldown){
      startBGM();
      const tex = getFullFaceCrop();
      if(tex){
        pendingFaceCell = buildFaceCellPayload(tex);
        if (!pendingFaceCell.id) pendingFaceCell.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        broadcastBirthEvent('CELL_BIRTH_PREVIEW', pendingFaceCell);
        captureStart = null;
        hasCapturedThisFace = true;
        setInteractionPhase('faceCaptured');
      }
    }
  } else {
    captureStart = null;
    hasCapturedThisFace = false;
    drawFramePrompt('stand here', 'one person at a time', 0, 'wait');
  }
}

function drawFramePrompt(title, subtitle, progress = 0, mode = 'wait') {
  if (!capturePreviewRect) {
    drawCenteredPrompt(title, subtitle, progress, mode);
    return;
  }

  ctx.save();
  const r = capturePreviewRect;
  const y = Math.min(H - 72, r.y + r.h + 42);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const promptX = r.x + r.w / 2;
  const maxTitleW = r.w * 0.92;
  let titleSize = Math.max(22, Math.min(42, W * 0.027));
  ctx.fillStyle = 'rgba(24,30,27,0.84)';
  do {
    ctx.font = `600 ${titleSize}px Arial`;
    if (ctx.measureText(title).width <= maxTitleW || titleSize <= 22) break;
    titleSize -= 2;
  } while (titleSize > 22);
  ctx.fillText(title, promptX, y);

  ctx.fillStyle = 'rgba(24,30,27,0.52)';
  let subtitleSize = Math.max(13, Math.min(18, W * 0.012));
  do {
    ctx.font = `${subtitleSize}px Arial`;
    if (ctx.measureText(subtitle).width <= r.w * 0.78 || subtitleSize <= 12) break;
    subtitleSize -= 1;
  } while (subtitleSize > 12);
  ctx.fillText(subtitle, promptX, y + 32);

  if (progress > 0) {
    const barW = Math.min(420, r.w * 0.42);
    const barH = 5;
    const bx = promptX - barW / 2;
    const by = y + 56;
    ctx.fillStyle = 'rgba(24,30,27,0.10)';
    roundRect(ctx, bx, by, barW, barH, barH);
    ctx.fill();
    ctx.fillStyle = mode === 'voice' ? 'rgba(120,145,190,0.72)' : 'rgba(120,180,145,0.80)';
    roundRect(ctx, bx, by, barW * Math.min(1, progress), barH, barH);
    ctx.fill();
  }

  ctx.restore();
}

function drawCenteredPrompt(title, subtitle, progress = 0, mode = 'wait') {
  ctx.save();
  const y = H * 0.18;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const glowColor = mode === 'voice' ? 'rgba(120,145,190,0.22)' : 'rgba(120,180,145,0.18)';
  const glow = ctx.createRadialGradient(W/2, y, 8, W/2, y, Math.min(W,H)*0.30);
  glow.addColorStop(0, glowColor);
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(24,30,27,0.86)';
  ctx.font = `600 ${Math.max(28, Math.min(54, W * 0.034))}px Arial`;
  ctx.fillText(title, W/2, y);

  ctx.fillStyle = 'rgba(24,30,27,0.52)';
  ctx.font = `${Math.max(14, Math.min(20, W * 0.014))}px Arial`;
  ctx.fillText(subtitle, W/2, y + Math.max(34, H * 0.048));

  if (progress > 0) {
    const barW = Math.min(360, W * 0.28);
    const barH = 5;
    const bx = W / 2 - barW / 2;
    const by = y + Math.max(58, H * 0.078);
    ctx.fillStyle = 'rgba(24,30,27,0.10)';
    roundRect(ctx, bx, by, barW, barH, barH); ctx.fill();
    ctx.fillStyle = mode === 'voice' ? 'rgba(120,145,190,0.72)' : 'rgba(120,180,145,0.76)';
    roundRect(ctx, bx, by, barW * Math.min(1, progress), barH, barH); ctx.fill();
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function drawMiniProjectionStatus() {
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  roundRect(ctx, W - 260, H - 84, 226, 48, 18); ctx.fill();
  ctx.fillStyle = 'rgba(20,25,22,0.76)';
  ctx.font = '13px Arial';
  ctx.fillText(projectionOpened ? 'Projection window opened' : 'Open petri window, then drag to projector', W - 242, H - 55);
  ctx.restore();
}

function drawProjectionMask() {
  const d = dish();
  ctx.save();
  const base = ctx.createRadialGradient(d.cx, d.cy, d.r * 0.05, d.cx, d.cy, d.r);
  base.addColorStop(0, 'rgba(235,246,234,0.68)');
  base.addColorStop(0.72, 'rgba(226,240,228,0.54)');
  base.addColorStop(1, 'rgba(210,226,214,0.38)');
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
  ctx.fill();

  const edge = ctx.createRadialGradient(d.cx,d.cy,d.r*0.62,d.cx,d.cy,d.r*1.02);
  edge.addColorStop(0,'rgba(0,0,0,0)');
  edge.addColorStop(0.78,'rgba(36,54,46,0.025)');
  edge.addColorStop(1,'rgba(24,38,34,0.20)');
  ctx.fillStyle=edge;
  ctx.beginPath();
  ctx.arc(d.cx,d.cy,d.r,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function drawDishFrame() {
  const d = dish();
  ctx.save();
  ctx.beginPath(); ctx.arc(d.cx,d.cy,d.r,0,Math.PI*2); ctx.clip();
  ctx.globalAlpha = 0.055;
  for(let i=0;i<72;i++){
    const a=(i*12.9898 % 6.28318);
    const rr=((Math.sin(i*78.233)*43758.5453)%1+1)%1*d.r;
    const dotR=0.45+(((Math.sin(i*21.17)*1234.5)%1+1)%1)*0.85;
    ctx.fillStyle='rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(d.cx+Math.cos(a)*rr,d.cy+Math.sin(a)*rr,dotR,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();

  const grad=ctx.createRadialGradient(d.cx,d.cy,d.r*0.68,d.cx,d.cy,d.r);
  grad.addColorStop(0,'rgba(255,255,255,0)');
  grad.addColorStop(0.74,'rgba(180,190,185,0.06)');
  grad.addColorStop(1,'rgba(20,28,26,0.30)');
  ctx.fillStyle=grad; ctx.beginPath(); ctx.arc(d.cx,d.cy,d.r,0,Math.PI*2); ctx.fill();

  ctx.strokeStyle='rgba(225,238,226,0.38)'; ctx.lineWidth=IS_PROJECTION ? 2.2 : 3;
  ctx.beginPath(); ctx.arc(d.cx,d.cy,d.r,0,Math.PI*2); ctx.stroke();
  ctx.strokeStyle='rgba(40,55,50,0.18)'; ctx.lineWidth=5;
  ctx.beginPath(); ctx.arc(d.cx,d.cy,d.r*0.995,0,Math.PI*2); ctx.stroke();
}

function drawCellTrail(c) {
  if (!c.trail || c.trail.length < 3) return;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const color = projectionDisplayColor(c.color);
  const rgb = rgb255(color);
  const baseAlpha = 0.05 + Math.min(0.20, (c.personality?.speed || 0.5) * 0.06 + (c.personality?.nervousness || 0.3) * 0.08);
  for (let i = 1; i < c.trail.length; i++) {
    const p0 = c.trail[i - 1];
    const p1 = c.trail[i];
    const age = i / c.trail.length;
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(baseAlpha + (IS_PROJECTION ? 0.035 : 0)) * age})`;
    ctx.lineWidth = Math.max(1.2, c.r * 0.025 * age);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCommunicationLinks() {
  if (!cells.relationships || cells.relationships.size === 0) return;
  const byId = new Map(cells.cells.map(c => [c.id, c]));
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (const rel of cells.relationships.values()) {
    if (!rel) continue;
    const a = byId.get(rel.aId);
    const b = byId.get(rel.bId);
    if (!a || !b || a.dead || b.dead) continue;
    if ((rel.similarity || 0) < 0.66 || (rel.compatibility || 0) < 0.46) continue;
    const communication = Math.min(1, rel.communicationTime / Math.max(1, rel.minCommunicationTime));
    const proximity = Math.max(0, 1 - (rel.distance || 9999) / Math.max(1, rel.communicationDistance || 1));
    const maturity = Math.min(1, Math.max(rel.bondAge || 0, rel.fusionAge || 0) / VISUAL_FUSION_MATURITY_FRAMES);
    const fusionCharge = Math.min(1, rel.fusionCharge || 0);
    const affinity = Math.max(0, ((rel.similarity || 0) - 0.66) / 0.26);
    const p = Math.max(communication * 0.54 + maturity * 0.30, proximity * affinity * 0.24, fusionCharge * 0.52);
    if (p < 0.14) continue;

    const isColony = rel.state === 'fusing' || rel.state === 'clustered';
    const alpha = Math.min(0.20, 0.014 + p * 0.075 + (isColony ? 0.035 : 0));
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
    const nx = -dy / d;
    const ny = dx / d;
    const wave = Math.sin(performance.now() * 0.0018 + rel.communicationTime * 0.013) * d * 0.045 * p;

    const ac = projectionDisplayColor(a.color);
    const bc = projectionDisplayColor(b.color);
    const r = Math.floor((ac[0] * 0.52 + bc[0] * 0.48) * 255);
    const g = Math.floor((ac[1] * 0.52 + bc[1] * 0.48) * 255);
    const bl = Math.floor((ac[2] * 0.52 + bc[2] * 0.48) * 255);
    ctx.strokeStyle = `rgba(${r},${g},${bl},${alpha * 0.16})`;
    ctx.lineWidth = Math.max(0.7, Math.min(2.6, (a.r + b.r) * 0.010 * (0.45 + p)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx + nx * wave, my + ny * wave, b.x, b.y);
    ctx.stroke();

    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = `rgba(${r},${g},${bl},${alpha * 0.42})`;
    ctx.lineWidth = Math.max(0.35, Math.min(1.35, (a.r + b.r) * 0.006 * (0.55 + p)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx + nx * wave, my + ny * wave, b.x, b.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';

    if (isColony) {
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = rel.state === 'clustered'
        ? 0.055 + p * 0.075 + fusionCharge * 0.055
        : 0.075 + p * 0.12 + fusionCharge * 0.075;
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.24)`;
      ctx.lineWidth = Math.max(2.0, Math.min(9.0, (a.r + b.r) * (0.014 + fusionCharge * 0.018)));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx - nx * wave * 0.45, my - ny * wave * 0.45, b.x, b.y);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.045 + p * 0.075 + fusionCharge * 0.070;
      ctx.fillStyle = `rgba(${r},${g},${bl},0.12)`;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(7, Math.min(38, (a.r + b.r) * (0.10 + fusionCharge * 0.055))), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function projectionDisplayColor(color = [0.72, 0.92, 0.82]) {
  if (!IS_PROJECTION) return color;
  const r = color[0] ?? 0.72;
  const g = color[1] ?? 0.92;
  const b = color[2] ?? 0.82;
  const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const saturation = 1.72;
  const gain = 1.16;
  const lift = 0.045;
  return [
    Math.max(0, Math.min(1, (luma + (r - luma) * saturation) * gain + lift)),
    Math.max(0, Math.min(1, (luma + (g - luma) * saturation) * gain + lift)),
    Math.max(0, Math.min(1, (luma + (b - luma) * saturation) * gain + lift)),
  ];
}

function rgb255(color = [1, 1, 1]) {
  return [
    Math.floor(Math.max(0, Math.min(1, color[0] ?? 1)) * 255),
    Math.floor(Math.max(0, Math.min(1, color[1] ?? 1)) * 255),
    Math.floor(Math.max(0, Math.min(1, color[2] ?? 1)) * 255),
  ];
}

function drawHandInfluenceMarker() {
  if (!IS_PROJECTION || !cells.handData || !cells.handData.detected || Date.now() - cells.handData.time > 850) return;
  const d = dish();
  const hx = d.cx + (cells.handData.x - 0.5) * d.r * 2;
  const hy = d.cy + (cells.handData.y - 0.5) * d.r * 2;
  const dx = hx - d.cx;
  const dy = hy - d.cy;
  if (Math.sqrt(dx * dx + dy * dy) > d.r * 1.04) return;

  const t = performance.now() * 0.001;
  const dwell = Math.min(1, (cells.handData.dwellTime || 0) / 2200);
  const speed = Math.min(1, (cells.handData.velocity || 0) / 1.2);
  const pulse = 1 + Math.sin(t * (2.3 + speed * 4.0)) * 0.10;
  const r = d.r * (0.070 + dwell * 0.050 + speed * 0.024) * pulse;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.30 + dwell * 0.26 + speed * 0.12;
  const grad = ctx.createRadialGradient(hx, hy, 1, hx, hy, r * 2.6);
  grad.addColorStop(0, 'rgba(235,255,224,0.58)');
  grad.addColorStop(0.44, 'rgba(180,245,205,0.20)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(hx, hy, r * 2.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.56 + dwell * 0.24;
  ctx.strokeStyle = speed > 0.26 ? 'rgba(255,245,220,0.58)' : 'rgba(210,255,224,0.58)';
  ctx.lineWidth = Math.max(1.2, d.r * 0.0035);
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(230,255,220,0.78)';
  ctx.beginPath();
  ctx.arc(hx, hy, Math.max(4, d.r * 0.010), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBirthChamber() {
  if (!IS_PROJECTION && !IS_CAPTURE) return;
  if (IS_CAPTURE && !birthChamber) return;
  const now = performance.now();
  const layout = birthChamberLayout();
  const hasCell = !!(birthChamber && birthChamber.img && birthChamber.img.complete);
  const age = hasCell ? (now - birthChamber.createdAt) * 0.001 : now * 0.001;
  const audio = birthChamber?.audio || {};
  const personality = birthChamber?.personality || {};
  const color = projectionDisplayColor(birthChamber?.appearance?.color || [0.72, 0.92, 0.82]);
  const colorRgb = rgb255(color);
  const volume = audio.volume ?? personality.averageVolume ?? personality.soundEnergy ?? 0;
  const high = audio.highRatio ?? personality.highFrequency ?? 0;
  const low = audio.lowRatio ?? personality.depth ?? 0;
  const flux = audio.flux ?? personality.volumeVariation ?? 0;
  const activity = Math.max(volume, flux, personality.activityScale || 0, hasCell ? 0.12 : 0.04);
  const soft = Math.max(high, personality.softness || 0);
  const pulse = 1 + Math.sin(age * (1.6 + activity * 5.0)) * (0.035 + activity * 0.08);
  let cx = layout.cx;
  let cy = layout.cy;
  let r = layout.r * (hasCell ? (0.78 + volume * 0.18 + low * 0.10) : 0.52) * pulse;
  let alpha = 0.92;

  if (birthChamber?.phase === 'release' && birthChamber.releaseTarget) {
    const releaseMs = IS_CAPTURE ? 1900 : 1500;
    const p = Math.min(1, (now - birthChamber.releaseStart) / releaseMs);
    const ease = p * p * (3 - 2 * p);
    cx = cx + (birthChamber.releaseTarget.x - cx) * ease;
    cy = cy + (birthChamber.releaseTarget.y - cy) * ease;
    r *= IS_CAPTURE ? 1 - ease * 0.78 : 1 - ease * 0.58;
    alpha = IS_CAPTURE ? 1 - ease * 0.88 : 1 - ease * 0.78;
    if (p >= 1 && now - birthChamber.releaseStart > 1900) {
      birthChamber = null;
      if (IS_PROJECTION) advanceBirthQueue();
      return;
    }
  }

  ctx.save();
  ctx.globalAlpha = hasCell ? alpha : 0.78;
  ctx.globalCompositeOperation = 'screen';

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.34;
  const zone = ctx.createRadialGradient(layout.cx, layout.cy, layout.r * 0.26, layout.cx, layout.cy, layout.r * 1.82);
  zone.addColorStop(0, 'rgba(238,246,228,0.055)');
  zone.addColorStop(0.58, 'rgba(210,226,205,0.035)');
  zone.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = zone;
  ctx.beginPath();
  ctx.arc(layout.cx, layout.cy, layout.r * 1.90, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const chamberGlow = ctx.createRadialGradient(layout.cx, layout.cy, 1, layout.cx, layout.cy, layout.r * 1.62);
  chamberGlow.addColorStop(0, `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${hasCell ? 0.44 + activity * 0.24 : 0.26})`);
  chamberGlow.addColorStop(0.42, `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${hasCell ? 0.24 : 0.14})`);
  chamberGlow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = chamberGlow;
  ctx.beginPath();
  ctx.arc(layout.cx, layout.cy, layout.r * 1.72, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${hasCell ? 0.48 + audio.progress * 0.22 : 0.42})`;
  ctx.lineWidth = Math.max(2.6, layout.r * (hasCell ? 0.038 : 0.046));
  ctx.save();
  ctx.translate(layout.cx, layout.cy);
  organicEllipsePath(ctx, layout.r * 1.06, layout.r * 1.06, age * 0.5, age, 0.16 + activity);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,245,${hasCell ? 0.18 : 0.24})`;
  ctx.lineWidth = Math.max(1.2, layout.r * 0.018);
  organicEllipsePath(ctx, layout.r * 0.72, layout.r * 0.72, age * 0.9 + 2.0, age, 0.24 + activity * 0.6);
  ctx.stroke();
  ctx.restore();

  if (!hasCell) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.58 + Math.sin(age * 1.2) * 0.08;
    const core = ctx.createRadialGradient(layout.cx - layout.r * 0.18, layout.cy - layout.r * 0.22, 2, layout.cx, layout.cy, layout.r * 0.42);
    core.addColorStop(0, 'rgba(255,255,245,0.28)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(layout.cx, layout.cy, layout.r * 0.44, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  if (!birthChamber || !birthChamber.img) {
    ctx.restore();
    return;
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.translate(cx, cy);
  ctx.rotate(Math.sin(age * 0.28) * 0.08 + low * 0.12);
  ctx.scale(1 + low * 0.10, 1 + high * 0.06);

  const membrane = ctx.createRadialGradient(-r * 0.24, -r * 0.28, 2, 0, 0, r * 1.28);
  membrane.addColorStop(0, 'rgba(255,255,255,0.60)');
  membrane.addColorStop(0.50, `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${IS_PROJECTION ? 0.34 : 0.22})`);
  membrane.addColorStop(1, 'rgba(60,76,66,0.25)');
  ctx.fillStyle = membrane;
  organicEllipsePath(ctx, r * 1.12, r * 1.02, age * 0.7, age, 0.32 + soft * 1.0 + activity * 0.65);
  ctx.fill();

  ctx.save();
  organicEllipsePath(ctx, r * 0.92, r * 0.86, age * 0.9, age, 0.24 + soft * 0.82 + activity * 0.46);
  ctx.clip();
  ctx.globalAlpha = Math.min(0.98, 0.72 + audio.progress * 0.18);
  ctx.drawImage(birthChamber.img, -r, -r, r * 2, r * 2);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${(IS_PROJECTION ? 0.20 : 0.10) + high * 0.14})`;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();

  ctx.globalCompositeOperation = 'screen';
  ctx.strokeStyle = `rgba(255,255,238,${0.18 + activity * 0.24})`;
  ctx.lineWidth = Math.max(1.4, r * (0.018 + high * 0.018));
  organicEllipsePath(ctx, r * (1.26 + high * 0.10), r * (1.12 + soft * 0.12), age * 1.3, age, 0.42 + flux * 0.9);
  ctx.stroke();

  if (birthChamber.phase === 'release' && birthChamber.releaseTarget) {
    const tx = birthChamber.releaseTarget.x - cx;
    const ty = birthChamber.releaseTarget.y - cy;
    ctx.globalAlpha = Math.min(alpha, 0.30);
    ctx.strokeStyle = `rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.72)`;
    ctx.lineWidth = Math.max(1.2, r * 0.030);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(tx * 0.32, ty * 0.10 - r * 0.38, tx * 0.78, ty * 0.78);
    ctx.stroke();
  }

  ctx.restore();
}

function drawProjectionDebug() {
  if (!IS_PROJECTION) return;
  if (urlParams.get('debug') !== '1') return;
  ctx.save();
  const age = projectionStats.lastAt ? ((performance.now() - projectionStats.lastAt) / 1000).toFixed(1) : '-';
  const lines = [
    `cells ${cells.cells.length} | added ${projectionStats.added}`,
    `finals ${projectionStats.finals} | queued ${projectionStats.queued}`,
    `birth ${projectionStats.previews} | audio ${projectionStats.audioFrames}`,
    `birth queue ${birthQueue.length} | pending ${pendingBirthFinals.size}`,
    `${projectionStats.lastStatus} ${age}s`,
  ];
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  roundRect(ctx, W - 238, H - 126, 218, 104, 12);
  ctx.fill();
  ctx.globalAlpha = 0.70;
  ctx.fillStyle = 'rgba(230,245,232,0.82)';
  ctx.font = '11px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], W - 224, H - 112 + i * 18);
  }
  ctx.restore();
}

function drawNucleus(c) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  ctx.scale(c.aspect, 1);

  const t = performance.now()*0.001;
  const color = projectionDisplayColor(c.color);
  const colorRgb = rgb255(color);
  const absorbFade = c.absorbingInto ? Math.max(0.22, 1 - c.absorbProgress * 0.72) : 1;
  const stretch = c.signalStretch || 0;
  const mass = Math.max(1, c.fusionMass || (c.parentIds ? c.parentIds.length : 1));
  const massPresence = Math.min(0.26, Math.log2(mass) * 0.070 + (c.fusionGrowth || 0) * 0.08);
  const rx = c.r*0.72*(1+c.reaction*0.16+c.fusion*0.10+massPresence+(c.softness||0)*0.035+stretch*0.08);
  const ry = c.r*0.84*(1+c.reaction*0.10+c.fusion*0.08+massPresence*0.78+(c.softness||0)*0.055-stretch*0.025);

  ctx.globalAlpha = absorbFade;

  const membrane = ctx.createRadialGradient(-rx*0.15,-ry*0.2,1,0,0,ry*1.22);
  membrane.addColorStop(0,'rgba(255,255,255,0.48)');
  membrane.addColorStop(0.45,`rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${IS_PROJECTION ? Math.min(0.48, (c.membraneAlpha || 0.23) * 1.65 + 0.05) : (c.membraneAlpha || 0.23)})`);
  membrane.addColorStop(1,'rgba(68,82,70,0.27)');
  ctx.fillStyle=membrane;
  const membraneWave = (c.membraneIrregularity || 0) * 0.75 + ((c.personality && c.personality.highFrequency) || 0) * 0.55 + (c.signalGlow || 0) * 0.35;
  ctx.beginPath(); organicEllipsePath(ctx, rx*1.11, ry*1.11, c.phase+0.5, t, c.reaction + c.fusion + (c.softness||0)*0.42 + membraneWave); ctx.fill();

  ctx.save();
  organicEllipsePath(ctx, rx, ry, c.phase, t, c.reaction + c.fusion + (c.softness||0)*0.34 + membraneWave);
  ctx.clip();
  ctx.globalCompositeOperation='source-over';
  const parts = c.textures || [{tex:c.texture, ox:0, oy:0, scale:1, rot:0, alpha:0.82}];
  for (let i=0; i<parts.length; i++) {
    const part = parts[i];
    ctx.save();
    ctx.translate(part.ox * rx, part.oy * ry);
    ctx.rotate(part.rot + Math.sin(t*0.12+i)*0.025);
    const sc = part.scale;
    ctx.globalAlpha = Math.min(0.98, part.alpha * absorbFade * (i===0 ? 1.10 : 0.92) * (IS_PROJECTION ? 1.28 : 1));
    ctx.drawImage(part.tex, -rx*sc, -ry*sc, rx*2*sc, ry*2*sc);
    ctx.restore();
  }
  ctx.globalCompositeOperation='screen';
  ctx.fillStyle=`rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},${IS_PROJECTION ? 0.26 : 0.13})`;
  ctx.fillRect(-rx*1.2,-ry*1.2,rx*2.4,ry*2.4);
  ctx.restore();

  if (c.age < 420) {
    const birthFade = 1 - c.age / 420;
    ctx.save();
    ctx.globalCompositeOperation='screen';
    ctx.globalAlpha = 0.10 + birthFade * 0.36;
    ctx.strokeStyle=`rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.96)`;
    ctx.lineWidth = Math.max(1.4, c.r * 0.070 * birthFade);
    organicEllipsePath(ctx, rx * (1.64 + birthFade * 0.32), ry * (1.60 + birthFade * 0.32), c.phase + 2.4, t, 0.50 + birthFade * 0.70);
    ctx.stroke();
    ctx.restore();
  }

  if (c.kinshipGlow > 0.04) {
    ctx.save();
    ctx.globalCompositeOperation='screen';
    ctx.globalAlpha = Math.min(0.38, c.kinshipGlow * 0.42);
    ctx.strokeStyle=`rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.84)`;
    ctx.lineWidth = Math.max(2, c.r*0.045);
    organicEllipsePath(ctx, rx*1.28, ry*1.30, c.phase+1.7, t, 0.9);
    ctx.stroke();
    ctx.restore();
  }

  if (mass > 1.2) {
    ctx.save();
    ctx.globalCompositeOperation='screen';
    ctx.globalAlpha = Math.min(0.30, 0.075 + Math.log2(mass) * 0.055 + (c.fusionGrowth || 0) * 0.10);
    ctx.strokeStyle=`rgba(${colorRgb[0]},${colorRgb[1]},${colorRgb[2]},0.72)`;
    ctx.lineWidth = Math.max(1.2, c.r * 0.026);
    organicEllipsePath(ctx, rx * 1.46, ry * 1.40, c.phase + 3.3, t, 0.62 + Math.min(0.75, mass * 0.06));
    ctx.stroke();
    ctx.globalAlpha *= 0.62;
    ctx.lineWidth = Math.max(0.8, c.r * 0.014);
    organicEllipsePath(ctx, rx * 1.18, ry * 1.14, c.phase + 4.2, t, 0.48 + Math.min(0.50, mass * 0.04));
    ctx.stroke();
    ctx.restore();
  }

  if ((c.signalGlow || 0) > 0.035) {
    ctx.save();
    ctx.rotate((c.signalAngle || 0) - c.angle);
    ctx.globalCompositeOperation='screen';
    ctx.globalAlpha = Math.min(0.30, c.signalGlow * 0.35);
    const sc = c.signalColor || c.color;
    ctx.strokeStyle=`rgba(${Math.floor(sc[0]*255)},${Math.floor(sc[1]*255)},${Math.floor(sc[2]*255)},0.82)`;
    ctx.lineWidth = Math.max(2, c.r*(0.025 + (c.membraneThickness || 0.3) * 0.035));
    ctx.beginPath();
    ctx.moveTo(rx*0.42, -ry*0.10);
    ctx.bezierCurveTo(rx*0.82, -ry*0.18, rx*1.02, ry*0.12, rx*1.24, ry*0.04);
    ctx.stroke();
    ctx.restore();
  }

  if (c.absorbingInto) {
    const host = c.absorbingInto;
    const hx = (host.x - c.x) / c.aspect;
    const hy = (host.y - c.y);
    ctx.save();
    ctx.globalCompositeOperation='screen';
    ctx.globalAlpha = 0.28 * absorbFade;
    ctx.strokeStyle='rgba(255,255,225,0.72)';
    ctx.lineWidth = Math.max(6, c.r*0.18);
    ctx.beginPath(); ctx.moveTo(0,0); ctx.quadraticCurveTo(hx*0.35, hy*0.12, hx*0.68, hy*0.68); ctx.stroke();
    ctx.restore();
  }

  ctx.globalCompositeOperation='screen';
  const hi=ctx.createRadialGradient(-rx*0.38,-ry*0.42,0,-rx*0.38,-ry*0.42,rx*0.42);
  hi.addColorStop(0,'rgba(255,255,255,0.68)');
  hi.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=hi; ctx.beginPath(); ctx.arc(-rx*0.38,-ry*0.42,rx*0.42,0,Math.PI*2); ctx.fill();
  ctx.globalCompositeOperation='source-over';
  ctx.globalAlpha = 1;
  ctx.restore();
}

function organicEllipsePath(ctx, rx, ry, phase, t, reaction){
  ctx.beginPath();
  const n=80;
  for(let i=0;i<=n;i++){
    const a=i/n*Math.PI*2;
    const wob=(Math.sin(a*3+phase+t*0.7)*0.018 + Math.sin(a*7-phase+t*0.3)*0.012) * (1+reaction*2.2);
    const x=Math.cos(a)*rx*(1+wob), y=Math.sin(a)*ry*(1+wob);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath();
}

function drawImageCover(context,img,x,y,w,h,flipX=false){
  const iw=img.videoWidth||img.width, ih=img.videoHeight||img.height;
  const sc=Math.max(w/iw,h/ih), nw=iw*sc, nh=ih*sc;
  context.save();
  if (flipX) {
    context.translate(x + w, y);
    context.scale(-1, 1);
    context.drawImage(img, (w - nw) / 2, (h - nh) / 2, nw, nh);
  } else {
    context.drawImage(img,x+(w-nw)/2,y+(h-nh)/2,nw,nh);
  }
  context.restore();
}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();}

function loop(){
  pollLatestStoredCell();
  advanceBirthQueue();
  cells.update(dish());
  updateInteractiveBGM();
  renderField();
  drawOverlay();
  requestAnimationFrame(loop);
}

initWebGL();
if (IS_CAPTURE) {
  setupMediaPipe().then(() => {
    if (typeof initAudienceMicrophoneSelector === 'function') initAudienceMicrophoneSelector();
    if (typeof setupHandCamera === 'function') setupHandCamera();
  });
}
if (IS_PROJECTION) {
  setInterval(() => {
    pollLatestStoredCell();
    advanceBirthQueue();
  }, 90);
}
loop();
