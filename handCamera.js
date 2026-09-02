const handCameraSelect = document.getElementById('handCameraSelect');
const handDetectionModeSelect = document.getElementById('handDetectionMode');
const handCameraStatus = document.getElementById('handCameraStatus');
const handPreviewCanvas = document.getElementById('handPreviewCanvas');
const handPreviewCtx = handPreviewCanvas ? handPreviewCanvas.getContext('2d') : null;
const handMirrorXButton = document.getElementById('handMirrorX');
const handMirrorYButton = document.getElementById('handMirrorY');
const handResetMapButton = document.getElementById('handResetMap');
const handMappingState = document.getElementById('handMappingState');

const handVideoElement = document.createElement('video');
handVideoElement.playsInline = true;
handVideoElement.muted = true;
handVideoElement.style.display = 'none';
document.body.appendChild(handVideoElement);

let handStream = null;
let handDeviceId = localStorage.getItem('handCameraDeviceId') || null;
let handDetectionMode = 'mediapipe';
let handModel = null;
let handLoopRunning = false;
let handLastProcess = 0;
let handMediaPipeFailures = 0;
let lastHandStoragePost = 0;
let lastHandPreviewDraw = 0;
let handMapping = readHandMappingConfig();
let latestHandLandmarks = null;
let activeFingertipIndex = 8;
let latestHandData = {
  detected: false,
  x: 0.5,
  y: 0.5,
  distanceToCenter: 1,
  velocity: 0,
  dwellTime: 0,
  movementAngle: 0,
  circularity: 0,
  openness: 0,
  gestureIntensity: 0,
  method: 'none',
  time: Date.now(),
};

const handChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('face-cell-petri') : null;
const handMotionCanvas = document.createElement('canvas');
const handMotionCtx = handMotionCanvas.getContext('2d', { willReadFrequently: true });
const handMotionState = {
  bg: null,
  lastX: 0.5,
  lastY: 0.5,
  lastTime: performance.now(),
  stillSince: 0,
  history: [],
};

function setHandCameraStatus(text) {
  if (handCameraStatus) handCameraStatus.textContent = text;
}

function saveHandMappingConfig(next) {
  handMapping = {
    ...readHandMappingConfig(),
    ...next,
  };
  try {
    localStorage.setItem('face-cell-hand-mapping', JSON.stringify(handMapping));
  } catch (e) {}
  updateHandMappingControls();
  drawHandCameraPreview();
}

function updateHandMappingControls() {
  const mapping = readHandMappingConfig();
  if (handMirrorXButton) handMirrorXButton.classList.toggle('active', !!mapping.mirrorX);
  if (handMirrorYButton) handMirrorYButton.classList.toggle('active', !!mapping.mirrorY);
  if (handMappingState) {
    handMappingState.textContent = `${mapping.mirrorX ? 'X flipped' : 'X normal'} / ${mapping.mirrorY ? 'Y flipped' : 'Y normal'}`;
  }
}

function markHandMappingUserAdjusted(next) {
  saveHandMappingConfig({
    ...next,
    userAdjusted: true,
  });
}

function isSameDevice(a, b) {
  return !!a && !!b && a === b;
}

function isLikelyTopCamera(label = '') {
  const name = label.toLowerCase();
  return name.includes('top') || name.includes('overhead') || name.includes('usb') || name.includes('webcam');
}

function isLogiHandCamera(label = '') {
  const name = label.toLowerCase();
  return (
    name.includes('logi') ||
    name.includes('logitech') ||
    name.includes('c270') ||
    name.includes('c920') ||
    name.includes('720p')
  );
}

async function listHandVideoDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}

function fillHandCameraSelect(devices) {
  if (!handCameraSelect) return;
  handCameraSelect.innerHTML = '';
  devices.forEach((device, i) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `Camera ${i + 1}`;
    handCameraSelect.appendChild(opt);
  });
  if (handDeviceId) handCameraSelect.value = handDeviceId;
}

function chooseDefaultHandCamera(devices) {
  const faceId = typeof activeDeviceId !== 'undefined' ? activeDeviceId : null;
  const notFace = devices.filter(d => !isSameDevice(d.deviceId, faceId));
  const stored = notFace.find(d => d.deviceId === handDeviceId);
  const logi = notFace.find(d => isLogiHandCamera(d.label));
  return logi || stored || notFace.find(d => isLikelyTopCamera(d.label)) || notFace[0] || devices[0] || null;
}

function applyHandCameraDefaultMapping(label = '') {
  const mapping = readHandMappingConfig();
  if (mapping.userAdjusted) return;
  if (isLogiHandCamera(label)) {
    saveHandMappingConfig({
      mirrorX: true,
      mirrorY: false,
      userAdjusted: false,
    });
  }
}

async function startHandVideoStream(deviceId) {
  if (handStream) handStream.getTracks().forEach(t => t.stop());

  const constraints = {
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 15, max: 24 },
    },
  };

  handStream = await navigator.mediaDevices.getUserMedia(constraints);
  handVideoElement.srcObject = handStream;
  await handVideoElement.play();

  const track = handStream.getVideoTracks()[0];
  handDeviceId = track.getSettings().deviceId || deviceId || handDeviceId;
  localStorage.setItem('handCameraDeviceId', handDeviceId);
  if (handCameraSelect) handCameraSelect.value = handDeviceId;
  applyHandCameraDefaultMapping(track.label || '');
  resetMotionDetector();
  setHandCameraStatus(`Using hand camera: ${track.label || 'selected camera'} (${handDetectionMode})`);
}

async function setupHandModel() {
  if (handModel || typeof Hands === 'undefined') return handModel;
  handModel = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  handModel.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.62,
    minTrackingConfidence: 0.55,
  });
  handModel.onResults(onHandResults);
  return handModel;
}

async function setupHandCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setHandCameraStatus('Hand camera unavailable in this browser.');
    return;
  }

  try {
    const devices = await listHandVideoDevices();
    fillHandCameraSelect(devices);
    const chosen = chooseDefaultHandCamera(devices);
    if (!chosen) throw new Error('No hand camera found');
    handDeviceId = chosen.deviceId;
    handDetectionMode = handDetectionModeSelect ? handDetectionModeSelect.value : 'mediapipe';
    handDetectionMode = 'mediapipe';
    if (handDetectionModeSelect) handDetectionModeSelect.value = 'mediapipe';
    await startHandVideoStream(handDeviceId);
  } catch (err) {
    console.warn('Hand camera setup failed:', err);
    setHandCameraStatus('Hand camera failed. Select a second webcam.');
    return;
  }

  if (handCameraSelect) {
    handCameraSelect.addEventListener('change', async () => {
      handDeviceId = handCameraSelect.value;
      localStorage.setItem('handCameraDeviceId', handDeviceId);
      try {
        await startHandVideoStream(handDeviceId);
      } catch (err) {
        console.warn('Hand camera switch failed:', err);
        setHandCameraStatus('Hand camera switch failed.');
      }
    });
  }

  if (handDetectionModeSelect) {
    handDetectionModeSelect.addEventListener('change', () => {
      handDetectionMode = handDetectionModeSelect.value;
      handMediaPipeFailures = 0;
      resetMotionDetector();
      setHandCameraStatus(`Using ${handDetectionMode} hand detection.`);
    });
  }

  if (handMirrorXButton) {
    handMirrorXButton.addEventListener('click', () => {
      const mapping = readHandMappingConfig();
      markHandMappingUserAdjusted({ mirrorX: !mapping.mirrorX });
    });
  }

  if (handMirrorYButton) {
    handMirrorYButton.addEventListener('click', () => {
      const mapping = readHandMappingConfig();
      markHandMappingUserAdjusted({ mirrorY: !mapping.mirrorY });
    });
  }

  if (handResetMapButton) {
    handResetMapButton.addEventListener('click', () => {
      const track = handVideoElement.srcObject?.getVideoTracks?.()[0];
      markHandMappingUserAdjusted({
        centerX: 0.5,
        centerY: 0.5,
        radiusX: 0.46,
        radiusY: 0.46,
        mirrorX: isLogiHandCamera(track?.label || ''),
        mirrorY: false,
      });
    });
  }

  updateHandMappingControls();

  if (!handLoopRunning) {
    handLoopRunning = true;
    runHandDetectionLoop();
  }
}

async function runHandDetectionLoop(now = performance.now()) {
  if (!handLoopRunning) return;
  const interval = handDetectionMode === 'mediapipe' ? 82 : 100;

  if (handVideoElement.readyState >= 2 && now - handLastProcess > interval) {
    handLastProcess = now;
    try {
      if (handDetectionMode === 'mediapipe' && typeof Hands !== 'undefined') {
        const model = await setupHandModel();
        await model.send({ image: handVideoElement });
        handMediaPipeFailures = 0;
      } else if (handDetectionMode === 'motion') {
        updateHandFromMotion();
      } else {
        publishHandData({ detected: false, method: 'mediapipe' });
        setHandCameraStatus('MediaPipe Hands loading. Waiting for hand node model.');
      }
    } catch (err) {
      console.warn('Hand detection frame skipped:', err);
      if (handDetectionMode === 'mediapipe') {
        handMediaPipeFailures++;
        publishHandData({ detected: false, method: 'mediapipe' });
        setHandCameraStatus(`MediaPipe Hands retrying (${handMediaPipeFailures}). Keep your hand inside the selected hand camera view.`);
      } else {
        setHandCameraStatus('Motion mode frame skipped; retrying.');
      }
    }
  }

  requestAnimationFrame(runHandDetectionLoop);
}

function onHandResults(results) {
  const landmarks = results.multiHandLandmarks && results.multiHandLandmarks[0];
  latestHandLandmarks = landmarks || null;
  if (!landmarks || !landmarks[8]) {
    publishHandData({ detected: false, method: 'mediapipe' });
    setHandCameraStatus('MediaPipe Hands active: no hand nodes detected.');
    return;
  }

  handMediaPipeFailures = 0;
  const activeTip = chooseActiveFingertip(landmarks);
  const tip = activeTip.point || landmarks[8];
  activeFingertipIndex = activeTip.index || 8;
  const gesture = estimateHandGesture(landmarks);
  updateHandDataFromPoint(tip.x, tip.y, true, 'mediapipe', {
    ...gesture,
    tipIndex: activeFingertipIndex,
  });
  setHandCameraStatus(`MediaPipe Hands active: fingertip ${activeFingertipIndex} controls cells.`);
}

function chooseActiveFingertip(landmarks) {
  const tips = [4, 8, 12, 16, 20].map(index => ({ index, point: landmarks[index] })).filter(item => item.point);
  if (!tips.length) return { index: 8, point: landmarks[8] };

  let best = tips[0];
  let bestScore = Infinity;
  for (const item of tips) {
    const mapped = mapHandPointToInstallation(item.point.x, item.point.y);
    // The touching fingertip is usually the one nearest to the mapped petri center.
    const score = mapped.distanceToCenter + (item.index === 8 ? -0.08 : 0);
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function estimateHandGesture(landmarks) {
  const wrist = landmarks[0];
  const tips = [4, 8, 12, 16, 20].map(i => landmarks[i]).filter(Boolean);
  const mids = [3, 6, 10, 14, 18].map(i => landmarks[i]).filter(Boolean);
  if (!wrist || tips.length < 5 || mids.length < 5) {
    return { openness: 0.5, gestureIntensity: 0.5 };
  }
  const dist = (a, b) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  const palm = Math.max(0.001, dist(wrist, landmarks[9] || tips[2]));
  const tipSpread = tips.reduce((sum, p) => sum + dist(wrist, p), 0) / tips.length / palm;
  const curl = tips.reduce((sum, p, i) => sum + (dist(wrist, p) - dist(wrist, mids[i])), 0) / tips.length / palm;
  const openness = clampHand01((tipSpread - 1.15) / 1.15 + curl * 0.35);
  return {
    openness,
    gestureIntensity: Math.abs(openness - 0.5) * 2,
  };
}

function resetMotionDetector() {
  handMotionState.bg = null;
  handMotionState.history = [];
  handMotionState.lastX = 0.5;
  handMotionState.lastY = 0.5;
  handMotionState.lastTime = performance.now();
  handMotionState.stillSince = 0;
}

function updateHandFromMotion() {
  const w = 160;
  const h = 120;
  handMotionCanvas.width = w;
  handMotionCanvas.height = h;
  handMotionCtx.drawImage(handVideoElement, 0, 0, w, h);
  const frame = handMotionCtx.getImageData(0, 0, w, h);
  const data = frame.data;

  if (!handMotionState.bg || handMotionState.bg.length !== data.length) {
    handMotionState.bg = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) handMotionState.bg[i] = data[i];
    publishHandData({ detected: false, method: 'motion' });
    return;
  }

  let sumX = 0;
  let sumY = 0;
  let weightSum = 0;
  const bg = handMotionState.bg;

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(data[i] - bg[i]);
      const dg = Math.abs(data[i + 1] - bg[i + 1]);
      const db = Math.abs(data[i + 2] - bg[i + 2]);
      const diff = (dr + dg + db) / 3;
      const learning = diff > 28 ? 0.005 : 0.028;
      bg[i] = bg[i] * (1 - learning) + data[i] * learning;
      bg[i + 1] = bg[i + 1] * (1 - learning) + data[i + 1] * learning;
      bg[i + 2] = bg[i + 2] * (1 - learning) + data[i + 2] * learning;

      if (diff > 34) {
        const weight = Math.min(1, diff / 90);
        sumX += x * weight;
        sumY += y * weight;
        weightSum += weight;
      }
    }
  }

  if (weightSum < 22) {
    publishHandData({ detected: false, method: 'motion' });
    return;
  }

  updateHandDataFromPoint(sumX / weightSum / w, sumY / weightSum / h, true, 'motion', {
    openness: 0.5,
    gestureIntensity: Math.min(1, weightSum / 240),
  });
}

function updateHandDataFromPoint(x, y, detected, method, gesture = {}) {
  const now = performance.now();
  const mapped = mapHandPointToInstallation(x, y);
  const last = latestHandData;
  const dt = Math.max(16, now - (last.perfTime || now));
  const dx = mapped.x - (last.x ?? mapped.x);
  const dy = mapped.y - (last.y ?? mapped.y);
  const velocity = Math.sqrt(dx * dx + dy * dy) / (dt / 1000);
  const distanceToCenter = mapped.distanceToCenter;
  const movementAngle = Math.atan2(dy, dx);
  const isStill = detected && mapped.inside && velocity < 0.045;
  const dwellTime = isStill ? (last.dwellTime || 0) + dt : 0;
  const circularity = updateCircularity(mapped.x, mapped.y, now);

  publishHandData({
    detected: detected && mapped.inside,
    rawX: clampHand01(x),
    rawY: clampHand01(y),
    x: mapped.x,
    y: mapped.y,
    distanceToCenter: clampHand01(distanceToCenter),
    velocity: Math.min(3, velocity),
    dwellTime,
    movementAngle,
    circularity,
    openness: Number.isFinite(gesture.openness) ? gesture.openness : latestHandData.openness,
    gestureIntensity: Number.isFinite(gesture.gestureIntensity) ? gesture.gestureIntensity : latestHandData.gestureIntensity,
    tipIndex: Number.isFinite(gesture.tipIndex) ? gesture.tipIndex : latestHandData.tipIndex,
    method,
    perfTime: now,
  });
}

function updateCircularity(x, y, now) {
  const history = handMotionState.history;
  history.push({ x, y, t: now });
  while (history.length > 18 || (history[0] && now - history[0].t > 1600)) history.shift();
  if (history.length < 6) return 0;

  let angleTravel = 0;
  for (let i = 2; i < history.length; i++) {
    const a0 = Math.atan2(history[i - 1].y - 0.5, history[i - 1].x - 0.5);
    const a1 = Math.atan2(history[i].y - 0.5, history[i].x - 0.5);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    angleTravel += Math.abs(da);
  }
  return clampHand01(angleTravel / (Math.PI * 1.35));
}

function publishHandData(partial) {
  const now = performance.now();
  const sessionId = getHandSessionId();
  latestHandData = {
    ...latestHandData,
    ...partial,
    time: Date.now(),
    sessionId,
    perfTime: partial.perfTime || now,
  };
  window.latestFaceCellHandData = { ...latestHandData };
  if (latestHandData.detected) window.latestFaceCellHandSeenAt = latestHandData.time;

  if (!latestHandData.detected) {
    latestHandData.velocity *= 0.88;
    latestHandData.dwellTime = 0;
    latestHandData.circularity *= 0.90;
  }

  if (handChannel) {
    const handData = {
      detected: latestHandData.detected,
      rawX: latestHandData.rawX,
      rawY: latestHandData.rawY,
      x: latestHandData.x,
      y: latestHandData.y,
      distanceToCenter: latestHandData.distanceToCenter,
      velocity: latestHandData.velocity,
      dwellTime: latestHandData.dwellTime,
      movementAngle: latestHandData.movementAngle,
      circularity: latestHandData.circularity,
      openness: latestHandData.openness,
      gestureIntensity: latestHandData.gestureIntensity,
      tipIndex: latestHandData.tipIndex,
      method: latestHandData.method,
      sessionId: latestHandData.sessionId,
      time: latestHandData.time,
    };
    handChannel.postMessage({
      type: 'HAND_DATA',
      sessionId,
      handData,
    });
  }
  if (now - lastHandStoragePost > 95) {
    lastHandStoragePost = now;
    try {
      localStorage.setItem('face-cell-hand', JSON.stringify({
        type: 'HAND_DATA',
        sessionId,
        handData: latestHandData,
      }));
    } catch (e) {}
  }
  drawHandCameraPreview();
}

function clampHand01(v) {
  return Math.max(0, Math.min(1, v));
}

function getHandSessionId() {
  if (typeof ACTIVE_SESSION_ID !== 'undefined') return ACTIVE_SESSION_ID;
  try {
    return localStorage.getItem('face-cell-active-session') || '';
  } catch (e) {
    return '';
  }
}

function readHandMappingConfig() {
  const defaults = {
    centerX: 0.5,
    centerY: 0.5,
    radiusX: 0.46,
    radiusY: 0.46,
    mirrorX: false,
    mirrorY: false,
    userAdjusted: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem('face-cell-hand-mapping') || '{}');
    return {
      ...defaults,
      ...saved,
      radiusX: Math.max(0.12, Number(saved.radiusX ?? saved.radius ?? defaults.radiusX)),
      radiusY: Math.max(0.12, Number(saved.radiusY ?? saved.radius ?? defaults.radiusY)),
      centerX: clampHand01(Number(saved.centerX ?? defaults.centerX)),
      centerY: clampHand01(Number(saved.centerY ?? defaults.centerY)),
      mirrorX: !!saved.mirrorX,
      mirrorY: !!saved.mirrorY,
      userAdjusted: !!saved.userAdjusted,
    };
  } catch (e) {
    return defaults;
  }
}

function displayHandX(rawX, mapping = readHandMappingConfig()) {
  return clampHand01(mapping.mirrorX ? 1 - rawX : rawX);
}

function displayHandY(rawY, mapping = readHandMappingConfig()) {
  return clampHand01(mapping.mirrorY ? 1 - rawY : rawY);
}

function drawMappedHandVideo(ctx, w, h, mapping = readHandMappingConfig()) {
  ctx.save();
  if (mapping.mirrorX || mapping.mirrorY) {
    ctx.translate(mapping.mirrorX ? w : 0, mapping.mirrorY ? h : 0);
    ctx.scale(mapping.mirrorX ? -1 : 1, mapping.mirrorY ? -1 : 1);
  }
  ctx.drawImage(handVideoElement, 0, 0, w, h);
  ctx.restore();
}

function mapHandPointToInstallation(rawX, rawY) {
  handMapping = readHandMappingConfig();
  const x0 = handMapping.mirrorX ? 1 - rawX : rawX;
  const y0 = handMapping.mirrorY ? 1 - rawY : rawY;
  const nx = (x0 - handMapping.centerX) / handMapping.radiusX;
  const ny = (y0 - handMapping.centerY) / handMapping.radiusY;
  const radial = Math.sqrt(nx * nx + ny * ny);
  const safeRadial = Math.max(1, radial);
  const clippedX = nx / safeRadial;
  const clippedY = ny / safeRadial;
  return {
    x: clampHand01(0.5 + clippedX * 0.5),
    y: clampHand01(0.5 + clippedY * 0.5),
    distanceToCenter: clampHand01(radial),
    inside: radial <= 1.18,
  };
}

function drawHandCameraPreview() {
  if (!handPreviewCanvas || !handPreviewCtx) return;
  const now = performance.now();
  if (now - lastHandPreviewDraw < 66) return;
  lastHandPreviewDraw = now;

  const w = handPreviewCanvas.width;
  const h = handPreviewCanvas.height;
  const ctx = handPreviewCtx;
  ctx.clearRect(0, 0, w, h);
  const mapping = readHandMappingConfig();

  if (handVideoElement.readyState >= 2) {
    drawMappedHandVideo(ctx, w, h, mapping);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = 'rgba(8,12,10,1)';
    ctx.fillRect(0, 0, w, h);
  }

  const mx = mapping.centerX * w;
  const my = mapping.centerY * h;
  const mrX = mapping.radiusX * w;
  const mrY = mapping.radiusY * h;

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.58)';
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  ctx.ellipse(mx, my, mrX, mrY, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(180,255,205,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx - 10, my);
  ctx.lineTo(mx + 10, my);
  ctx.moveTo(mx, my - 10);
  ctx.lineTo(mx, my + 10);
  ctx.stroke();
  ctx.restore();

  drawHandLandmarkOverlay(ctx, w, h, mapping);

  const rawX = Number.isFinite(latestHandData.rawX) ? latestHandData.rawX : latestHandData.x;
  const rawY = Number.isFinite(latestHandData.rawY) ? latestHandData.rawY : latestHandData.y;
  const px = displayHandX(rawX ?? 0.5, mapping) * w;
  const py = displayHandY(rawY ?? 0.5, mapping) * h;
  const targetX = mx + ((latestHandData.x ?? 0.5) - 0.5) * mrX * 2;
  const targetY = my + ((latestHandData.y ?? 0.5) - 0.5) * mrY * 2;
  const detected = !!latestHandData.detected;

  if (latestHandData.method !== 'none') {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = 'rgba(255,230,120,0.72)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.fillStyle = detected ? 'rgba(255,232,112,0.96)' : 'rgba(255,220,140,0.56)';
    ctx.strokeStyle = 'rgba(255,255,230,0.92)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetX, targetY, detected ? 9 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = detected ? 'rgba(120,255,155,0.92)' : 'rgba(255,190,120,0.72)';
    ctx.strokeStyle = detected ? 'rgba(230,255,230,0.96)' : 'rgba(255,235,210,0.80)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, detected ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = detected ? 0.34 : 0.18;
    ctx.beginPath();
    ctx.arc(px, py, detected ? 24 : 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const status = detected ? 'HAND DETECTED' : 'NO HAND';
  const mapped = `tip ${latestHandData.tipIndex ?? '-'} | mapped ${latestHandData.x?.toFixed?.(2) ?? '-'}, ${latestHandData.y?.toFixed?.(2) ?? '-'}`;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.54)';
  ctx.fillRect(0, h - 34, w, 34);
  ctx.fillStyle = detected ? 'rgba(180,255,195,0.95)' : 'rgba(255,220,180,0.90)';
  ctx.font = '700 12px Arial';
  ctx.fillText(status, 12, h - 14);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = '11px Arial';
  ctx.fillText(`${latestHandData.method || 'waiting'} | ${mapped}`, 118, h - 14);
  ctx.restore();
}

function drawHandLandmarkOverlay(ctx, w, h, mapping = readHandMappingConfig()) {
  if (!latestHandLandmarks || latestHandLandmarks.length < 21) return;
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(185,245,255,0.58)';
  for (const [a, b] of edges) {
    const pa = latestHandLandmarks[a];
    const pb = latestHandLandmarks[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(displayHandX(pa.x, mapping) * w, displayHandY(pa.y, mapping) * h);
    ctx.lineTo(displayHandX(pb.x, mapping) * w, displayHandY(pb.y, mapping) * h);
    ctx.stroke();
  }

  for (let i = 0; i < latestHandLandmarks.length; i++) {
    const p = latestHandLandmarks[i];
    const isTip = [4, 8, 12, 16, 20].includes(i);
    const active = i === activeFingertipIndex;
    ctx.fillStyle = active ? 'rgba(120,255,155,0.98)' : (isTip ? 'rgba(255,245,170,0.88)' : 'rgba(180,235,255,0.70)');
    ctx.beginPath();
    ctx.arc(displayHandX(p.x, mapping) * w, displayHandY(p.y, mapping) * h, active ? 5.5 : (isTip ? 4.2 : 2.7), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
