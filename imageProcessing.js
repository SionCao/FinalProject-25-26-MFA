// OpenCV.js helpers. If OpenCV is not loaded yet, the code falls back to Canvas processing.
let cvReady = false;
window.Module = window.Module || {};
window.Module.onRuntimeInitialized = () => { cvReady = true; console.log('OpenCV.js ready'); };
const thermalColorProfiles = [];

function processFaceWithOpenCV(srcCanvas) {
  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  const octx = out.getContext('2d');
  octx.clearRect(0, 0, 512, 512);

  // 先用 canvas 做椭圆 alpha，保证整张脸在细胞核里
  octx.save();
  octx.beginPath();
  octx.ellipse(256, 256, 214, 242, 0, 0, Math.PI * 2);
  octx.clip();
  octx.drawImage(srcCanvas, 0, 0, 512, 512);
  octx.restore();

  if (!cvReady || typeof cv === 'undefined') return out;

  try {
    let src = cv.imread(out);
    let dst = new cv.Mat();
    let ksize = new cv.Size(3, 3);
    cv.GaussianBlur(src, dst, ksize, 0, 0, cv.BORDER_DEFAULT);
    cv.imshow(out, dst);
    src.delete();
    dst.delete();
  } catch (e) {
    console.warn('OpenCV processing skipped:', e);
  }
  return out;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * clamp(t, 0, 1); }

function analyzeFaceCanvas(canvas, faceBox = null) {
  const w = canvas.width;
  const h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let count = 0;
  let sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0, sumSat = 0;
  let leftL = 0, rightL = 0, leftCount = 0, rightCount = 0, symmetryDelta = 0, symmetryCount = 0;
  let edge = 0, edgeCount = 0;

  for (let y = 4; y < h; y += 4) {
    for (let x = 4; x < w; x += 4) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.08) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      count++;
      sumR += r;
      sumG += g;
      sumB += b;
      sumL += l;
      sumL2 += l * l;
      sumSat += max === 0 ? 0 : (max - min) / max;
      if (x < w * 0.5) {
        leftL += l;
        leftCount++;
      } else {
        rightL += l;
        rightCount++;
      }

      const left = ((y * w + (x - 4)) * 4);
      const up = (((y - 4) * w + x) * 4);
      if (data[left + 3] > 20 && data[up + 3] > 20) {
        const lLeft = 0.2126 * data[left] + 0.7152 * data[left + 1] + 0.0722 * data[left + 2];
        const lUp = 0.2126 * data[up] + 0.7152 * data[up + 1] + 0.0722 * data[up + 2];
        edge += Math.abs(l - lLeft) + Math.abs(l - lUp);
        edgeCount += 2;
      }

      const mx = w - 1 - x;
      const mirror = (y * w + mx) * 4;
      if (data[mirror + 3] > 20) {
        const mL = 0.2126 * data[mirror] + 0.7152 * data[mirror + 1] + 0.0722 * data[mirror + 2];
        symmetryDelta += Math.abs(l - mL);
        symmetryCount++;
      }
    }
  }

  if (!count) {
    return {
      brightness: 0.55,
      saturation: 0.24,
      contrast: 0.22,
      warmth: 0.5,
      edge: 0.18,
      faceArea: 0.18,
      faceAspect: 0.82,
      roundness: 0.75,
      facialSymmetry: 0.55,
      eyeDistance: 0.48,
    };
  }

  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;
  const meanL = sumL / count;
  const variance = Math.max(0, sumL2 / count - meanL * meanL);
  const faceAspect = faceBox ? clamp(faceBox.w / Math.max(0.01, faceBox.h), 0.48, 1.22) : 0.82;
  const faceArea = faceBox ? clamp(faceBox.w * faceBox.h * 3.1, 0, 1) : 0.24;
  const contrast = clamp(Math.sqrt(variance) / 92, 0, 1);
  const edgeDensity = clamp((edge / Math.max(1, edgeCount)) / 42, 0, 1);
  const symmetry = clamp(1 - (symmetryDelta / Math.max(1, symmetryCount)) / 76, 0, 1);
  const sideBalance = clamp(1 - Math.abs((leftL / Math.max(1, leftCount)) - (rightL / Math.max(1, rightCount))) / 72, 0, 1);
  const facialSymmetry = clamp(symmetry * 0.72 + sideBalance * 0.28, 0, 1);
  const roundness = clamp(1 - Math.abs(faceAspect - 0.82) / 0.48, 0, 1);
  const eyeDistance = clamp(0.36 + faceAspect * 0.24 + faceArea * 0.12 + facialSymmetry * 0.10, 0, 1);
  const textureComplexity = clamp(Math.sqrt(variance) / 112 + (edge / Math.max(1, edgeCount)) / 60, 0, 1);

  return {
    averageColor: [avgR / 255, avgG / 255, avgB / 255],
    brightness: clamp(meanL / 255, 0, 1),
    saturation: clamp(sumSat / count, 0, 1),
    contrast,
    warmth: clamp((avgR - avgB + 80) / 160, 0, 1),
    edge: edgeDensity,
    faceArea,
    faceAspect,
    roundness,
    eyeDistance,
    facialSymmetry,
    textureComplexity,
  };
}

function buildFaceMorphology(metrics, thermalMetrics = null) {
  const m = metrics || {};
  const thermal = thermalMetrics || m.thermal || defaultThermalMetrics();
  const detail = (m.contrast ?? 0.22) * 0.62 + (m.edge ?? 0.18) * 0.38;
  return {
    aspectRatio: m.faceAspect ?? 0.82,
    roundness: m.roundness ?? 0.75,
    eyeDistance: m.eyeDistance ?? 0.48,
    symmetry: m.facialSymmetry ?? 0.55,
    brightness: m.brightness ?? 0.55,
    dominantColor: m.averageColor || [0.68, 0.72, 0.70],
    contrast: m.contrast ?? 0.22,
    textureComplexity: m.textureComplexity ?? 0.25,
    edgeDensity: m.edge ?? 0.18,
    thermalType: thermal.thermalType ?? 0,
    thermalSpread: thermal.spread ?? 0.5,
    thermalContrast: thermal.contrast ?? 0.25,
    thermalAsymmetry: thermal.asymmetry ?? 0,
    membraneThickness: clamp(0.18 + detail * 0.54 + (thermal.contrast ?? 0.25) * 0.16, 0.14, 0.88),
    nucleusOffset: {
      x: clamp(((m.facialSymmetry ?? 0.55) - 0.5) * 0.32 + (thermal.asymmetry ?? 0) * 0.42, -0.28, 0.28),
      y: clamp(((m.brightness ?? 0.55) - 0.5) * -0.22 + ((thermal.nose ?? 0.5) - 0.5) * 0.18, -0.24, 0.24),
    },
    glowIntensity: clamp(0.16 + (m.brightness ?? 0.55) * 0.34 + (thermal.contrast ?? 0.25) * 0.30, 0.12, 0.86),
    movementSoftness: clamp(0.20 + (m.roundness ?? 0.75) * 0.36 + (thermal.spread ?? 0.5) * 0.32, 0.12, 0.92),
  };
}

function buildFaceFeatureVector(metrics, thermalMetrics = null) {
  const m = metrics || {};
  const thermal = thermalMetrics || m.thermal || defaultThermalMetrics();
  return [
    m.faceAspect ?? 0.82,
    m.roundness ?? 0.75,
    m.eyeDistance ?? 0.48,
    m.facialSymmetry ?? 0.55,
    m.brightness ?? 0.55,
    m.saturation ?? 0.24,
    m.warmth ?? 0.5,
    m.contrast ?? 0.22,
    m.textureComplexity ?? 0.25,
    m.edge ?? 0.18,
    thermal.forehead ?? 0.5,
    thermal.cheek ?? 0.5,
    thermal.nose ?? 0.5,
    thermal.mouth ?? 0.5,
    thermal.asymmetry ?? 0,
    thermal.spread ?? 0.5,
    thermal.contrast ?? 0.25,
  ].map(v => clamp(v, 0, 1));
}

function defaultThermalMetrics() {
  return {
    forehead: 0.5,
    cheek: 0.5,
    nose: 0.5,
    mouth: 0.5,
    asymmetry: 0,
    spread: 0.5,
    contrast: 0.25,
    thermalType: 0,
    signature: [0.5, 0.5, 0.5, 0.5, 0, 0.5, 0.25],
  };
}

function estimatePixelHeat(data, w, x, y) {
  const i = (y * w + x) * 4;
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const redBlue = clamp((r - b + 96) / 192, 0, 1);
  const saturation = max === 0 ? 0 : (max - min) / max;
  return clamp(light * 0.36 + redBlue * 0.44 + saturation * 0.20, 0, 1);
}

function sampleHeatRegion(imageData, x0, y0, x1, y1) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const sx0 = Math.floor(x0 * w);
  const sy0 = Math.floor(y0 * h);
  const sx1 = Math.floor(x1 * w);
  const sy1 = Math.floor(y1 * h);
  let sum = 0;
  let sum2 = 0;
  let count = 0;

  for (let y = sy0; y < sy1; y += 4) {
    for (let x = sx0; x < sx1; x += 4) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha < 20) continue;
      const heat = estimatePixelHeat(data, w, x, y);
      sum += heat;
      sum2 += heat * heat;
      count++;
    }
  }

  if (!count) return { mean: 0.5, variance: 0 };
  const mean = sum / count;
  return { mean, variance: Math.max(0, sum2 / count - mean * mean) };
}

function analyzePseudoThermal(srcCanvas) {
  const imageData = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const forehead = sampleHeatRegion(imageData, 0.31, 0.13, 0.69, 0.31);
  const leftCheek = sampleHeatRegion(imageData, 0.18, 0.38, 0.42, 0.66);
  const rightCheek = sampleHeatRegion(imageData, 0.58, 0.38, 0.82, 0.66);
  const nose = sampleHeatRegion(imageData, 0.39, 0.32, 0.61, 0.66);
  const mouth = sampleHeatRegion(imageData, 0.32, 0.64, 0.68, 0.84);
  const whole = sampleHeatRegion(imageData, 0.16, 0.12, 0.84, 0.88);

  const cheek = (leftCheek.mean + rightCheek.mean) * 0.5;
  const asymmetry = Math.abs(leftCheek.mean - rightCheek.mean);
  const rawValues = [forehead.mean, cheek, nose.mean, mouth.mean];
  const minHeat = Math.min(...rawValues);
  const maxHeat = Math.max(...rawValues);
  const heatSpan = Math.max(0.001, maxHeat - minHeat);
  const regionValues = rawValues.map(v => clamp((v - minHeat) / heatSpan, 0, 1));
  const hottest = regionValues.indexOf(Math.max(...regionValues));
  const contrast = clamp(Math.sqrt(whole.variance) * 4.2 + Math.max(forehead.variance, leftCheek.variance, rightCheek.variance, nose.variance, mouth.variance) * 5, 0, 1);
  const spread = clamp(1 - heatSpan * 8.0, 0, 1);
  const thermalType = heatSpan < 0.045 ? 5 : (asymmetry > 0.10 ? 4 : hottest);

  return {
    forehead: regionValues[0],
    cheek: regionValues[1],
    nose: regionValues[2],
    mouth: regionValues[3],
    heatMean: rawValues.reduce((sum, v) => sum + v, 0) / rawValues.length,
    heatSpan,
    asymmetry,
    spread,
    contrast,
    thermalType,
    signature: [
      regionValues[0],
      regionValues[1],
      regionValues[2],
      regionValues[3],
      clamp(asymmetry * 3.2, 0, 1),
      spread,
      contrast,
    ],
  };
}

function createFaceOnlyAnalysisCanvas(srcCanvas, faceBox = null) {
  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  const fb = faceBox || { x: 0.30, y: 0.18, w: 0.40, h: 0.50 };
  const cx = clamp(fb.x + fb.w * 0.5, 0.18, 0.82);
  const cy = clamp(fb.y + fb.h * 0.52, 0.18, 0.86);
  const cropW = clamp(fb.w * 1.36, 0.30, 0.70);
  const cropH = clamp(fb.h * 1.52, 0.36, 0.82);
  const sx = clamp(cx - cropW * 0.5, 0, 1 - cropW);
  const sy = clamp(cy - cropH * 0.48, 0, 1 - cropH);

  ctx.drawImage(
    srcCanvas,
    sx * srcCanvas.width,
    sy * srcCanvas.height,
    cropW * srcCanvas.width,
    cropH * srcCanvas.height,
    0,
    0,
    512,
    512
  );

  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  ctx.ellipse(256, 268, 178, 222, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

function faceMetricsToAppearance(metrics, thermalMetrics = null) {
  const m = metrics || {
    brightness: 0.55,
    saturation: 0.24,
    contrast: 0.22,
    warmth: 0.5,
    edge: 0.18,
    faceArea: 0.18,
    faceAspect: 0.82,
    averageColor: [0.68, 0.72, 0.70],
    textureComplexity: 0.25,
  };
  const thermal = thermalMetrics || m.thermal || defaultThermalMetrics();
  const warm = m.warmth;
  const bright = m.brightness;
  const sat = m.saturation;
  const detail = (m.contrast * 0.62 + m.edge * 0.38);
  const faceColor = m.averageColor || [0.68, 0.72, 0.70];
  const thermalPulse = thermal.forehead * 0.9 + thermal.cheek * 1.4 + thermal.nose * 1.1 + thermal.mouth * 0.8 + thermal.asymmetry * 2.2;
  const identity = (warm * 1.2 + sat * 2.2 + detail * 2.6 + m.faceAspect * 1.0 + bright * 0.8 + thermalPulse) % 1;
  const archetype = Math.floor(identity * 6) % 6;
  const thermalPalette = [
    [0.92, 0.30, 0.24], // forehead-dominant: warm coral
    [0.98, 0.58, 0.78], // cheek-dominant: rose
    [0.96, 0.82, 0.24], // nose-dominant: pollen yellow
    [0.36, 0.84, 0.96], // mouth/breath-dominant: cyan
    [0.64, 0.44, 0.96], // asymmetric thermal field: violet
    [0.48, 0.86, 0.64], // balanced face heat: green-blue
  ];
  const identityPalette = [
    [0.90, 0.26, 0.22],
    [0.94, 0.44, 0.72],
    [0.62, 0.42, 0.96],
    [0.28, 0.72, 0.98],
    [0.30, 0.88, 0.62],
    [0.96, 0.82, 0.24],
  ];
  const signature = thermal.signature || defaultThermalMetrics().signature;
  let matchedProfile = null;
  for (const profile of thermalColorProfiles) {
    const pv = profile.signature || [];
    let dist = 0;
    const n = Math.min(signature.length, pv.length);
    for (let i = 0; i < n; i++) dist += Math.pow((signature[i] ?? 0.5) - (pv[i] ?? 0.5), 2);
    if (n && Math.sqrt(dist / n) < 0.060) {
      matchedProfile = profile;
      break;
    }
  }
  const thermalBase = thermalPalette[thermal.thermalType] || thermalPalette[5];
  const identityBase = identityPalette[Math.floor(identity * identityPalette.length) % identityPalette.length];
  const lowLightDiversity = clamp(1 - thermal.spread * 7.5, 0, 1);
  const palette = matchedProfile ? matchedProfile.color : mixRgb(thermalBase, identityBase, 0.30 + lowLightDiversity * 0.32);
  if (!matchedProfile && thermalColorProfiles.length < 18) {
    thermalColorProfiles.push({ signature: signature.slice(), color: palette.slice() });
  }
  const relativeHue = ((thermal.forehead ?? 0.5) * 0.09 + (thermal.cheek ?? 0.5) * 0.22 + (thermal.nose ?? 0.5) * 0.37 + (thermal.mouth ?? 0.5) * 0.58 + (thermal.asymmetry ?? 0) * 0.33) % 1;
  const hue = (thermal.thermalType * 0.127 + relativeHue * 0.46 + thermal.spread * 0.071 + thermal.asymmetry * 0.053) % 1;
  const spectrumColor = hslToRgb(hue, clamp(0.58 + thermal.contrast * 0.28, 0.52, 0.88), clamp(0.50 + bright * 0.10, 0.45, 0.68));
  const dye = mixRgb(mixRgb(palette, spectrumColor, 0.34 + lowLightDiversity * 0.12), faceColor, 0.05);
  const milk = [0.90, 0.97, 0.89];
  const body = mixRgb(dye, milk, 0.10 + bright * 0.04 + thermal.spread * 0.05);
  const membraneIrregularity = clamp(detail * 0.68 + (m.textureComplexity || 0) * 0.32, 0, 1);
  const transparency = clamp(0.22 + bright * 0.42 + thermal.spread * 0.10, 0.18, 0.74);

  return {
    color: body.map(v => clamp(v, 0, 1)),
    baseR: clamp(13 + bright * 4 + m.faceArea * 8 + detail * 7, 13, 38),
    aspect: clamp(0.78 + m.faceAspect * 0.44 + (detail - 0.35) * 0.12, 0.72, 1.34),
    textureAlpha: clamp(0.94 - transparency * 0.42 + sat * 0.08 + detail * 0.10, 0.52, 0.92),
    membraneAlpha: clamp(0.20 + bright * 0.08 + detail * 0.18, 0.18, 0.46),
    fieldStrength: clamp(0.54 + m.faceArea * 0.20 + detail * 0.15, 0.46, 0.92),
    patternDensity: clamp(0.28 + sat * 0.22 + detail * 0.46 + thermal.contrast * 0.46, 0.20, 1),
    transparency,
    membraneIrregularity,
    averageColor: faceColor,
    hue,
    archetype,
    thermalType: thermal.thermalType,
    thermalContrast: thermal.contrast,
    membraneThickness: clamp(0.18 + detail * 0.54 + thermal.contrast * 0.16, 0.14, 0.88),
    nucleusOffset: {
      x: clamp(((m.facialSymmetry ?? 0.55) - 0.5) * 0.32 + thermal.asymmetry * 0.42, -0.28, 0.28),
      y: clamp((bright - 0.5) * -0.22 + (thermal.nose - 0.5) * 0.18, -0.24, 0.24),
    },
    glowIntensity: clamp(0.16 + bright * 0.34 + thermal.contrast * 0.30, 0.12, 0.86),
    movementSoftness: clamp(0.20 + (m.roundness ?? 0.75) * 0.36 + thermal.spread * 0.32, 0.12, 0.92),
  };
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function colorToCss(color, alpha = 1) {
  return `rgba(${Math.floor(color[0] * 255)},${Math.floor(color[1] * 255)},${Math.floor(color[2] * 255)},${alpha})`;
}

function mixRgb(a, b, t) {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ];
}

function hslToRgb(h, s, l) {
  const hue = ((h % 1) + 1) % 1;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue * 6) % 2 - 1));
  const m = l - chroma / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 1 / 6) [r, g, b] = [chroma, x, 0];
  else if (hue < 2 / 6) [r, g, b] = [x, chroma, 0];
  else if (hue < 3 / 6) [r, g, b] = [0, chroma, x];
  else if (hue < 4 / 6) [r, g, b] = [0, x, chroma];
  else if (hue < 5 / 6) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];
  return [r + m, g + m, b + m];
}

function sampleRgb(imageData, x, y) {
  const xx = Math.max(0, Math.min(imageData.width - 1, Math.floor(x)));
  const yy = Math.max(0, Math.min(imageData.height - 1, Math.floor(y)));
  const i = (yy * imageData.width + xx) * 4;
  if (imageData.data[i + 3] < 20) return [0.90, 0.96, 0.90];
  return [
    imageData.data[i] / 255,
    imageData.data[i + 1] / 255,
    imageData.data[i + 2] / 255,
  ];
}

function organicBlobPath(ctx, cx, cy, rx, ry, wobble, seed) {
  ctx.beginPath();
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1
      + Math.sin(a * 3.0 + seed) * wobble
      + Math.sin(a * 7.0 - seed * 0.7) * wobble * 0.54;
    const x = cx + Math.cos(a) * rx * w;
    const y = cy + Math.sin(a) * ry * w;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawCellTextureMask(target) {
  const masked = document.createElement('canvas');
  masked.width = target.width;
  masked.height = target.height;
  const m = masked.getContext('2d');
  m.clearRect(0, 0, masked.width, masked.height);

  m.save();
  m.beginPath();
  m.ellipse(256, 256, 218, 242, 0, 0, Math.PI * 2);
  m.clip();
  m.drawImage(target, 0, 0);
  m.restore();

  const edge = m.createRadialGradient(256, 256, 130, 256, 256, 246);
  edge.addColorStop(0, 'rgba(255,255,255,0)');
  edge.addColorStop(0.78, 'rgba(255,255,255,0.10)');
  edge.addColorStop(1, 'rgba(40,58,48,0.30)');
  m.globalCompositeOperation = 'multiply';
  m.fillStyle = edge;
  m.beginPath();
  m.ellipse(256, 256, 218, 242, 0, 0, Math.PI * 2);
  m.fill();
  m.globalCompositeOperation = 'source-over';

  return masked;
}

function drawArchetypeMotifs(ctx, archetype, rnd, seed, base, warm, cool, density, detail) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (archetype === 0) {
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 5 + Math.floor(density * 5); i++) {
      const a = rnd() * Math.PI * 2;
      const x = 256 + Math.cos(a) * (28 + rnd() * 118);
      const y = 256 + Math.sin(a) * (28 + rnd() * 118) * 1.08;
      ctx.strokeStyle = colorToCss(mixRgb(base, [0.42,0.18,0.28], 0.35), 0.09 + density * 0.08);
      ctx.lineWidth = 5 + rnd() * 10;
      organicBlobPath(ctx, x, y, 22 + rnd() * 42, 14 + rnd() * 34, 0.18, seed + i * 18.2);
      ctx.stroke();
    }
  } else if (archetype === 1) {
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 8 + Math.floor(density * 8); i++) {
      const a = rnd() * Math.PI * 2;
      const r0 = 18 + rnd() * 80;
      ctx.strokeStyle = colorToCss(cool, 0.16 + density * 0.10);
      ctx.lineWidth = 3 + rnd() * 6;
      ctx.beginPath();
      ctx.moveTo(256 + Math.cos(a) * r0, 256 + Math.sin(a) * r0);
      ctx.lineTo(256 + Math.cos(a) * (110 + rnd() * 120), 256 + Math.sin(a) * (112 + rnd() * 118) * 1.08);
      ctx.stroke();
    }
  } else if (archetype === 2) {
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 18 + Math.floor(density * 24); i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 205;
      ctx.fillStyle = colorToCss(i % 2 ? warm : cool, 0.10 + rnd() * 0.16);
      ctx.beginPath();
      ctx.arc(256 + Math.cos(a) * rr, 256 + Math.sin(a) * rr * 1.08, 4 + rnd() * 12, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (archetype === 3) {
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 4; i++) {
      const x = 192 + (i % 2) * 118 + (rnd() - 0.5) * 18;
      const y = 205 + Math.floor(i / 2) * 94 + (rnd() - 0.5) * 22;
      const g = ctx.createRadialGradient(x-8, y-10, 1, x, y, 54 + rnd() * 24);
      g.addColorStop(0, 'rgba(255,255,245,0.38)');
      g.addColorStop(0.52, colorToCss(warm, 0.20));
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      organicBlobPath(ctx, x, y, 34 + rnd()*18, 28 + rnd()*20, 0.12 + detail * 0.08, seed + i * 27);
      ctx.fill();
    }
  } else if (archetype === 4) {
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 7 + Math.floor(density * 6); i++) {
      const y = 128 + i * (34 + rnd() * 8);
      ctx.strokeStyle = colorToCss(mixRgb(base, cool, 0.35), 0.075 + density * 0.06);
      ctx.lineWidth = 8 + rnd() * 18;
      ctx.beginPath();
      ctx.moveTo(96 + rnd() * 34, y);
      ctx.bezierCurveTo(170, y - 35 + rnd() * 70, 342, y + 35 - rnd() * 70, 416 - rnd() * 38, y + (rnd() - 0.5) * 40);
      ctx.stroke();
    }
  } else {
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 6 + Math.floor(density * 8); i++) {
      const x = 180 + rnd() * 150;
      const y = 170 + rnd() * 160;
      ctx.strokeStyle = colorToCss(warm, 0.14 + density * 0.12);
      ctx.lineWidth = 2 + rnd() * 5;
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * Math.PI * 2 + rnd() * 0.28;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * (26 + rnd() * 46), y + Math.sin(a) * (26 + rnd() * 46));
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

function drawThermalMotifs(ctx, thermal, base, rnd, seed) {
  const points = [
    { v: thermal.forehead, x: 256, y: 150, rx: 78, ry: 40, c: [1.0, 0.26, 0.12] },
    { v: thermal.cheek, x: 184, y: 292, rx: 55, ry: 64, c: [1.0, 0.42, 0.60] },
    { v: thermal.cheek, x: 328, y: 292, rx: 55, ry: 64, c: [1.0, 0.42, 0.60] },
    { v: thermal.nose, x: 256, y: 268, rx: 42, ry: 78, c: [1.0, 0.78, 0.18] },
    { v: thermal.mouth, x: 256, y: 370, rx: 84, ry: 36, c: [0.40, 0.82, 1.0] },
  ];

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const heat = clamp((p.v - 0.34) / 0.48, 0, 1);
    if (heat <= 0.02) continue;
    const x = p.x + (rnd() - 0.5) * 18;
    const y = p.y + (rnd() - 0.5) * 18;
    const g = ctx.createRadialGradient(x - p.rx * 0.2, y - p.ry * 0.25, 1, x, y, Math.max(p.rx, p.ry) * (0.9 + heat * 0.6));
    g.addColorStop(0, colorToCss(mixRgb(p.c, [1, 1, 1], 0.18), 0.18 + heat * 0.34));
    g.addColorStop(0.55, colorToCss(mixRgb(p.c, base, 0.28), 0.08 + heat * 0.20));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    organicBlobPath(ctx, x, y, p.rx * (0.72 + heat * 0.34), p.ry * (0.72 + heat * 0.34), 0.08 + thermal.contrast * 0.16, seed + i * 39.4);
    ctx.fill();
  }

  if (thermal.asymmetry > 0.08) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = colorToCss([0.38, 0.22, 0.58], clamp(thermal.asymmetry * 0.9, 0.06, 0.22));
    ctx.lineWidth = 10 + thermal.asymmetry * 30;
    ctx.beginPath();
    ctx.moveTo(210 + rnd() * 20, 115);
    ctx.bezierCurveTo(178, 220, 345, 265, 298 + rnd() * 28, 430);
    ctx.stroke();
  }

  ctx.restore();
}

function createFaceCellTextureFromFace(srcCanvas, faceBox = null) {
  const faceOnlyCanvas = createFaceOnlyAnalysisCanvas(srcCanvas, faceBox);
  const metrics = analyzeFaceCanvas(faceOnlyCanvas, { x: 0.15, y: 0.08, w: 0.70, h: 0.84 });
  const thermal = analyzePseudoThermal(faceOnlyCanvas);
  metrics.thermal = thermal;
  metrics.morphology = buildFaceMorphology(metrics, thermal);
  metrics.featureVector = buildFaceFeatureVector(metrics, thermal);
  const appearance = faceMetricsToAppearance(metrics, thermal);
  const src = faceOnlyCanvas.getContext('2d').getImageData(0, 0, faceOnlyCanvas.width, faceOnlyCanvas.height);
  const detail = metrics.contrast * 0.62 + metrics.edge * 0.38;
  const density = appearance.patternDensity || detail;
  const seed = Math.floor(
    metrics.brightness * 100000
    + metrics.saturation * 37000
    + metrics.warmth * 71000
    + metrics.edge * 131000
    + metrics.faceAspect * 19000
  );
  const rnd = seededRandom(seed);

  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  const base = appearance.color;
  const cool = mixRgb(base, [0.70, 0.92, 0.95], 0.32 + (1 - metrics.warmth) * 0.28);
  const warm = mixRgb(base, [0.98, 0.78, 0.52], 0.22 + metrics.warmth * 0.34);
  const pale = mixRgb(base, [0.96, 1.0, 0.90], 0.54 + metrics.brightness * 0.22);

  const bg = ctx.createRadialGradient(210, 170, 12, 256, 256, 260);
  bg.addColorStop(0, colorToCss(pale, 0.82));
  bg.addColorStop(0.48, colorToCss(base, 0.44));
  bg.addColorStop(1, colorToCss(cool, 0.26));
  ctx.fillStyle = bg;
  organicBlobPath(ctx, 256, 256, 218, 242, 0.018 + detail * 0.045, seed * 0.01);
  ctx.fill();

  drawThermalMotifs(ctx, thermal, base, rnd, seed);
  drawArchetypeMotifs(ctx, appearance.archetype || 0, rnd, seed, base, warm, cool, density, detail);

  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 5 + Math.floor(density * 7); i++) {
    const r = 70 + i * (19 + metrics.faceArea * 8);
    ctx.strokeStyle = colorToCss(i % 2 ? warm : cool, 0.05 + detail * 0.05);
    ctx.lineWidth = 8 + rnd() * 16;
    organicBlobPath(ctx, 256 + (rnd() - 0.5) * 18, 256 + (rnd() - 0.5) * 18, r * (0.86 + rnd() * 0.22), r * (0.98 + rnd() * 0.24), 0.035 + detail * 0.05, seed + i * 13.7);
    ctx.stroke();
  }

  const faceSamples = [
    [150, 170], [246, 170], [350, 176],
    [190, 246], [260, 252], [326, 248],
    [168, 338], [256, 350], [344, 338],
    [132, 430], [380, 430],
  ];

  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < faceSamples.length; i++) {
    const p = faceSamples[i];
    const sampled = sampleRgb(src, p[0], p[1]);
    const pigment = mixRgb(sampled, i % 2 ? cool : warm, 0.62);
    const a = rnd() * Math.PI * 2;
    const rr = 24 + Math.sqrt(rnd()) * (132 + metrics.faceArea * 54);
    const x = 256 + Math.cos(a) * rr;
    const y = 256 + Math.sin(a) * rr * 1.08;
    const rx = 18 + rnd() * 42 + detail * 18;
    const ry = 13 + rnd() * 36 + metrics.faceArea * 16;

    const g = ctx.createRadialGradient(x - rx * 0.25, y - ry * 0.3, 1, x, y, Math.max(rx, ry) * 1.2);
    g.addColorStop(0, colorToCss(mixRgb(pigment, [1, 1, 1], 0.38), 0.34 + metrics.saturation * 0.14));
    g.addColorStop(1, colorToCss(pigment, 0.04 + detail * 0.10));
    ctx.fillStyle = g;
    organicBlobPath(ctx, x, y, rx, ry, 0.10 + metrics.edge * 0.10, seed + i * 31.13);
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'multiply';
  ctx.lineCap = 'round';
  const fibers = 24 + Math.floor(density * 58);
  for (let i = 0; i < fibers; i++) {
    const a = rnd() * Math.PI * 2;
    const r0 = 35 + rnd() * 150;
    const x = 256 + Math.cos(a) * r0;
    const y = 256 + Math.sin(a) * r0 * 1.08;
    const len = 44 + rnd() * 130;
    const bend = (rnd() - 0.5) * 80;
    ctx.strokeStyle = colorToCss(mixRgb(base, sampleRgb(src, rnd() * 512, rnd() * 512), 0.28), 0.035 + detail * 0.075);
    ctx.lineWidth = 1.2 + rnd() * (2.8 + detail * 4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 1.2) * bend, y + Math.sin(a + 1.2) * bend, x + Math.cos(a) * len, y + Math.sin(a) * len * 1.08);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'screen';
  const chambers = 4 + Math.floor(metrics.faceAspect * 3 + density * 5);
  for (let i = 0; i < chambers; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 38 + rnd() * 145;
    const x = 256 + Math.cos(a) * rr;
    const y = 256 + Math.sin(a) * rr * 1.06;
    const chamberColor = mixRgb(rnd() > 0.5 ? warm : cool, sampleRgb(src, 120 + rnd() * 270, 130 + rnd() * 250), 0.18);
    ctx.strokeStyle = colorToCss(chamberColor, 0.11 + density * 0.08);
    ctx.lineWidth = 2.5 + rnd() * 7.5;
    organicBlobPath(ctx, x, y, 18 + rnd() * 36, 14 + rnd() * 34, 0.12 + detail * 0.10, seed + i * 91.2);
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'multiply';
  const veins = 3 + Math.floor(density * 6);
  for (let i = 0; i < veins; i++) {
    const start = rnd() * Math.PI * 2;
    ctx.strokeStyle = colorToCss(mixRgb(base, [0.32, 0.45, 0.38], 0.35), 0.045 + density * 0.05);
    ctx.lineWidth = 3 + rnd() * 7;
    ctx.beginPath();
    for (let j = 0; j < 6; j++) {
      const r = 25 + j * (24 + rnd() * 11);
      const a = start + Math.sin(j * 1.7 + seed) * (0.25 + density * 0.42);
      const x = 256 + Math.cos(a) * r;
      const y = 256 + Math.sin(a) * r * 1.10;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'screen';
  const nucleusCount = 1 + Math.floor(metrics.faceArea * 2.4 + metrics.contrast * 2.2);
  for (let i = 0; i < nucleusCount; i++) {
    const x = 220 + rnd() * 86;
    const y = 215 + rnd() * 90;
    const rx = 28 + rnd() * 38 + metrics.faceArea * 18;
    const ry = 24 + rnd() * 42 + detail * 18;
    const g = ctx.createRadialGradient(x - rx * 0.2, y - ry * 0.25, 2, x, y, Math.max(rx, ry) * 1.2);
    g.addColorStop(0, 'rgba(255,255,245,0.36)');
    g.addColorStop(0.58, colorToCss(warm, 0.18 + metrics.saturation * 0.10));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    organicBlobPath(ctx, x, y, rx, ry, 0.08 + metrics.edge * 0.10, seed + i * 47.4);
    ctx.fill();
  }

  const dotCount = 80 + Math.floor(density * 240 + metrics.saturation * 90);
  for (let i = 0; i < dotCount; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 214;
    const x = 256 + Math.cos(a) * rr;
    const y = 256 + Math.sin(a) * rr * 1.1;
    ctx.fillStyle = colorToCss(rnd() > 0.5 ? warm : cool, 0.035 + rnd() * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, 0.7 + rnd() * (1.8 + detail * 2.2), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'source-over';
  const membrane = ctx.createRadialGradient(180, 150, 0, 256, 256, 245);
  membrane.addColorStop(0, 'rgba(255,255,255,0.22)');
  membrane.addColorStop(0.70, 'rgba(255,255,255,0.03)');
  membrane.addColorStop(1, colorToCss(base, 0.28 + appearance.membraneAlpha * 0.36));
  ctx.fillStyle = membrane;
  organicBlobPath(ctx, 256, 256, 218, 242, 0.018 + detail * 0.035, seed * 0.021);
  ctx.fill();

  const masked = drawCellTextureMask(out);
  masked._faceMetrics = metrics;
  masked._appearance = appearance;
  masked._thermalMetrics = thermal;
  masked._thermalSignature = thermal.signature;
  masked._morphology = metrics.morphology;
  masked._featureVector = metrics.featureVector;
  return masked;
}
