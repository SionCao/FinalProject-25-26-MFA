const videoElement = document.querySelector('.input_video');
const cameraSelect = document.getElementById('cameraSelect');
const cameraStatus = document.getElementById('cameraStatus');

let latestFaceBox = null;
let latestSegmentation = null;
let faceReady = false;
let segmentationReady = false;
let activeStream = null;
let activeDeviceId = null;
let mediaPipeRunning = false;
let faceDetectionModel = null;
let selfieSegmentationModel = null;
let storedFaceDeviceId = localStorage.getItem('faceCameraDeviceId') || '';
let lockedFaceBox = null;
let lockedFaceLastSeenAt = 0;
let lockedFaceStillStartedAt = 0;
let lockedFaceLostAt = 0;
let latestFaceSelectionStatus = 'waiting for one participant';

const rawCropCanvas = document.createElement('canvas');
const rawCropCtx = rawCropCanvas.getContext('2d');
const FACE_CAPTURE_FLIP_X = true;
const FACE_LOCK_LOST_MS = 1500;
const FACE_SWITCH_MARGIN = 1.38;
const FACE_STILL_RESET_DISTANCE = 0.035;
const FACE_STILL_RESET_AREA_DELTA = 0.24;

function faceLerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function setCameraStatus(text) {
  if (cameraStatus) cameraStatus.textContent = text;
}

function isObsbotTiny(label = '') {
  const name = label.toLowerCase();
  return name.includes('obsbot') || name.includes('tiny3') || name.includes('tiny 3') || name.includes('tiny');
}

function isBuiltInFaceCamera(label = '') {
  const name = label.toLowerCase();
  return (
    name.includes('facetime') ||
    name.includes('macbook') ||
    name.includes('built-in') ||
    name.includes('built in') ||
    name.includes('internal') ||
    name.includes('内建') ||
    name.includes('內建')
  );
}

function isHighQualityFaceCamera(label = '') {
  const name = label.toLowerCase();
  return (
    isObsbotTiny(label) ||
    name.includes('4k') ||
    name.includes('uhd') ||
    name.includes('brio')
  );
}

async function listVideoDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}

function fillCameraSelect(devices) {
  if (!cameraSelect) return;
  cameraSelect.innerHTML = '';
  devices.forEach((device, i) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(opt);
  });
  if (activeDeviceId) cameraSelect.value = activeDeviceId;
}

async function chooseFaceCameraDefault() {
  // First permission pass: device labels are often hidden until camera permission is granted.
  const firstStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  firstStream.getTracks().forEach(t => t.stop());

  const devices = await listVideoDevices();
  fillCameraSelect(devices);

  const stored = devices.find(d => d.deviceId === storedFaceDeviceId);
  const obsbot = devices.find(d => isObsbotTiny(d.label));
  const preferred = devices.find(d => isHighQualityFaceCamera(d.label));
  const nonLogi = devices.find(d => !/logi|logitech|720p/i.test(d.label || ''));
  const trustedStored = stored && isHighQualityFaceCamera(stored.label) ? stored : null;
  const chosen = obsbot || trustedStored || preferred || stored || nonLogi || devices[0];
  if (!chosen) throw new Error('No camera found');
  activeDeviceId = chosen.deviceId;
  localStorage.setItem('faceCameraDeviceId', activeDeviceId);
  if (cameraSelect) cameraSelect.value = activeDeviceId;
  setCameraStatus(`Using face camera: ${chosen.label || 'default camera'}`);
  return activeDeviceId;
}

async function startVideoStream(deviceId) {
  if (activeStream) activeStream.getTracks().forEach(t => t.stop());

  const constraints = {
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
    },
  };

  activeStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElement.srcObject = activeStream;
  videoElement.muted = true;
  videoElement.playsInline = true;
  await videoElement.play();

  const track = activeStream.getVideoTracks()[0];
  activeDeviceId = track.getSettings().deviceId || deviceId || activeDeviceId;
  localStorage.setItem('faceCameraDeviceId', activeDeviceId);
  setCameraStatus(`Using camera: ${track.label || 'selected camera'}`);
}

function selectPrimaryFace(detections) {
  if (!detections || !detections.length) return null;
  const now = performance.now();
  const candidates = detections
    .map(normalizeFaceDetection)
    .filter(Boolean)
    .filter(c => c.area >= 0.010)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;

  if (lockedFaceBox) {
    const tracked = candidates
      .map(c => ({ ...c, trackingDistance: faceBoxDistance(lockedFaceBox, c) }))
      .sort((a, b) => a.trackingDistance - b.trackingDistance)[0];
    const strongest = candidates[0];
    const trackedValid = tracked && tracked.trackingDistance < 0.30;
    const strongestIsMuchCloser = strongest && strongest !== tracked && strongest.score > (tracked?.score || 0) * FACE_SWITCH_MARGIN && faceBoxDistance(lockedFaceBox, strongest) > 0.34;

    if (trackedValid && !strongestIsMuchCloser) {
      latestFaceSelectionStatus = candidates.length > 1
        ? `locked nearest still face; ignoring ${candidates.length - 1} background face${candidates.length > 2 ? 's' : ''}`
        : 'locked nearest still face';
      return updateLockedFace(tracked, now);
    }

    if (now - lockedFaceLastSeenAt < FACE_LOCK_LOST_MS && !strongestIsMuchCloser) {
      latestFaceSelectionStatus = 'holding current participant lock';
      return { detection: null, box: lockedFaceBox, locked: true, held: true };
    }
  }

  const primary = candidates[0];
  latestFaceSelectionStatus = candidates.length > 1
    ? `selected closest face; ignoring ${candidates.length - 1} background face${candidates.length > 2 ? 's' : ''}`
    : 'selected closest face';
  return updateLockedFace(primary, now, true);
}

function normalizeFaceDetection(detection) {
  if (!detection || !detection.boundingBox) return null;
  const b = detection.boundingBox;
  const w = Math.max(0, b.width || 0);
  const h = Math.max(0, b.height || 0);
  const cx = b.xCenter ?? 0.5;
  const cy = b.yCenter ?? 0.5;
  const area = w * h;
  const centerDistance = Math.hypot(cx - 0.5, cy - 0.48);
  const centerBias = 1 - Math.min(1, centerDistance * 1.25);
  const lowerPenalty = Math.max(0, cy - 0.68) * 0.22;
  const confidence = detection.score ? detection.score[0] : 1;
  const score = area * (1.05 + centerBias * 0.22) * (0.72 + confidence * 0.28) - lowerPenalty;
  return {
    detection,
    x: cx - w / 2,
    y: cy - h / 2,
    cx,
    cy,
    w,
    h,
    area,
    score,
    confidence,
  };
}

function faceBoxDistance(a, b) {
  if (!a || !b) return Infinity;
  const center = Math.hypot((a.cx ?? (a.x + a.w * 0.5)) - b.cx, (a.cy ?? (a.y + a.h * 0.5)) - b.cy);
  const areaA = Math.max(0.001, a.area ?? a.w * a.h);
  const areaB = Math.max(0.001, b.area ?? b.w * b.h);
  const areaDelta = Math.abs(Math.log(areaB / areaA));
  return center * 0.78 + areaDelta * 0.10;
}

function updateLockedFace(candidate, now, forceNew = false) {
  const previous = lockedFaceBox;
  const centerDelta = previous ? Math.hypot(candidate.cx - previous.cx, candidate.cy - previous.cy) : 0;
  const previousArea = previous ? Math.max(0.001, previous.area ?? previous.w * previous.h) : candidate.area;
  const areaDelta = previous ? Math.abs(candidate.area - previousArea) / previousArea : 0;
  const smooth = forceNew || !previous ? 1 : 0.32;
  const next = {
    x: previous && !forceNew ? faceLerp(previous.x, candidate.x, smooth) : candidate.x,
    y: previous && !forceNew ? faceLerp(previous.y, candidate.y, smooth) : candidate.y,
    w: previous && !forceNew ? faceLerp(previous.w, candidate.w, smooth) : candidate.w,
    h: previous && !forceNew ? faceLerp(previous.h, candidate.h, smooth) : candidate.h,
    cx: previous && !forceNew ? faceLerp(previous.cx, candidate.cx, smooth) : candidate.cx,
    cy: previous && !forceNew ? faceLerp(previous.cy, candidate.cy, smooth) : candidate.cy,
    area: previous && !forceNew ? faceLerp(previous.area, candidate.area, smooth) : candidate.area,
    score: candidate.confidence,
  };

  if (forceNew || !previous || centerDelta > FACE_STILL_RESET_DISTANCE || areaDelta > FACE_STILL_RESET_AREA_DELTA) {
    lockedFaceStillStartedAt = now;
    if (typeof captureStart !== 'undefined') captureStart = null;
  } else if (!lockedFaceStillStartedAt) {
    lockedFaceStillStartedAt = now;
  }

  lockedFaceBox = next;
  lockedFaceLastSeenAt = now;
  lockedFaceLostAt = 0;
  return { detection: candidate.detection, box: next, locked: true, held: false };
}

function resetFaceSubjectLock() {
  lockedFaceBox = null;
  lockedFaceLastSeenAt = 0;
  lockedFaceStillStartedAt = 0;
  lockedFaceLostAt = 0;
  latestFaceSelectionStatus = 'waiting for one participant';
}

async function setupMediaPipe(onFrameReady) {
  faceDetectionModel = new FaceDetection({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
  });
  faceDetectionModel.setOptions({ model: 'short', minDetectionConfidence: 0.55 });
  faceDetectionModel.onResults((results) => {
    const primaryFace = selectPrimaryFace(results.detections);
    if (!primaryFace) {
      const now = performance.now();
      if (lockedFaceBox && now - lockedFaceLastSeenAt < FACE_LOCK_LOST_MS) {
        latestFaceBox = { ...lockedFaceBox };
        faceReady = true;
        latestFaceSelectionStatus = 'holding current participant lock';
        return;
      }
      resetFaceSubjectLock();
      latestFaceBox = null;
      faceReady = false;
      return;
    }
    latestFaceBox = { ...primaryFace.box };
    faceReady = true;
  });

  selfieSegmentationModel = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
  });
  selfieSegmentationModel.setOptions({ modelSelection: 1 });
  selfieSegmentationModel.onResults((results) => {
    latestSegmentation = results;
    segmentationReady = true;
  });

  try {
    const deviceId = await chooseFaceCameraDefault();
    await startVideoStream(deviceId);
    const devices = await listVideoDevices();
    fillCameraSelect(devices);
  } catch (err) {
    console.warn('Camera setup failed:', err);
    setCameraStatus('Camera failed. Check browser camera permission / OBSBOT connection.');
    return;
  }

  if (cameraSelect) {
    cameraSelect.addEventListener('change', async () => {
      resetFaceSubjectLock();
      latestFaceBox = null;
      faceReady = false;
      captureStart = null;
      hasCapturedThisFace = false;
      try {
        await startVideoStream(cameraSelect.value);
        localStorage.setItem('faceCameraDeviceId', cameraSelect.value);
      } catch (err) {
        console.warn('Camera switch failed:', err);
        setCameraStatus('Camera switch failed. Try unplugging/replugging OBSBOT.');
      }
    });
  }

  if (!mediaPipeRunning) {
    mediaPipeRunning = true;
    runMediaPipeLoop(onFrameReady);
  }
}

async function runMediaPipeLoop(onFrameReady) {
  if (!mediaPipeRunning) return;
  if (videoElement.readyState >= 2 && faceDetectionModel && selfieSegmentationModel) {
    try {
      await faceDetectionModel.send({ image: videoElement });
      await selfieSegmentationModel.send({ image: videoElement });
      if (onFrameReady) onFrameReady();
    } catch (e) {
      console.warn('MediaPipe frame skipped:', e);
    }
  }
  requestAnimationFrame(() => runMediaPipeLoop(onFrameReady));
}

function getFullFaceCrop() {
  if (!latestFaceBox || videoElement.readyState < 2) return null;

  const vw = videoElement.videoWidth || 1280;
  const vh = videoElement.videoHeight || 720;

  // 关键：用原始摄像头裁大范围，不用 segmentation 直接裁，避免脸被切掉。
  const fx = latestFaceBox.x * vw;
  const fy = latestFaceBox.y * vh;
  const fw = latestFaceBox.w * vw;
  const fh = latestFaceBox.h * vh;

  const cx = fx + fw * 0.5;
  const cy = fy + fh * 0.50;
  const cropW = fw * 2.45;
  const cropH = fh * 2.85;
  const sx = Math.max(0, Math.min(vw - cropW, cx - cropW * 0.5));
  const sy = Math.max(0, Math.min(vh - cropH, cy - cropH * 0.47));

  rawCropCanvas.width = 512;
  rawCropCanvas.height = 512;
  rawCropCtx.clearRect(0, 0, 512, 512);
  rawCropCtx.save();
  if (FACE_CAPTURE_FLIP_X) {
    rawCropCtx.translate(512, 0);
    rawCropCtx.scale(-1, 1);
  }
  rawCropCtx.drawImage(videoElement, sx, sy, cropW, cropH, 0, 0, 512, 512);
  rawCropCtx.restore();

  if (typeof createFaceCellTextureFromFace === 'function') {
    const localX = (fx - sx) / cropW;
    const localW = fw / cropW;
    const localFaceBox = {
      x: FACE_CAPTURE_FLIP_X ? 1 - localX - localW : localX,
      y: (fy - sy) / cropH,
      w: localW,
      h: fh / cropH,
    };
    return createFaceCellTextureFromFace(rawCropCanvas, localFaceBox);
  }

  return processFaceWithOpenCV(rawCropCanvas);
}
