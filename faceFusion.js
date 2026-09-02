// Face fusion helpers
// This does not stack previous cells. It samples inherited pigments and creates
// a new unified hybrid tissue texture for the merged organism.

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function randRange(a, b) { return a + Math.random() * (b - a); }
function fusionMix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
function fusionCss(c, a = 1) {
  return `rgba(${Math.floor(clamp01(c[0]) * 255)},${Math.floor(clamp01(c[1]) * 255)},${Math.floor(clamp01(c[2]) * 255)},${a})`;
}

function drawSoftEllipseMask(ctx, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w * 0.40, h * 0.46, 0, 0, Math.PI * 2);
  ctx.clip();
}

function fusionSampleColor(src, x, y) {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const p = probe.getContext('2d', { willReadFrequently: true });
  try {
    p.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
    const d = p.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  } catch (e) {
    return [0.84, 0.88, 0.78];
  }
}

function fusionPalette(faces, color) {
  const points = [
    [150, 170], [256, 158], [355, 176],
    [184, 282], [256, 260], [330, 288],
    [180, 360], [256, 380], [340, 350],
  ];
  const colors = [color];
  for (const face of faces) {
    for (let i = 0; i < 2; i++) {
      const p = points[Math.floor(Math.random() * points.length)];
      colors.push(fusionSampleColor(face, p[0] + randRange(-18, 18), p[1] + randRange(-18, 18)));
    }
  }
  const avg = colors.reduce((sum, c) => [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]], [0, 0, 0]).map(v => v / colors.length);
  return {
    base: fusionMix(avg, color, 0.45),
    warm: fusionMix(avg, [0.98, 0.78, 0.54], 0.36),
    cool: fusionMix(avg, [0.62, 0.86, 0.88], 0.34),
    pale: fusionMix(avg, [0.96, 0.98, 0.88], 0.60),
    deep: fusionMix(avg, [0.36, 0.42, 0.36], 0.34),
    memories: colors.slice(1),
  };
}

function fusionBlobPath(ctx, cx, cy, rx, ry, wobble, seed) {
  ctx.beginPath();
  const n = 84;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1
      + Math.sin(a * 2.0 + seed) * wobble
      + Math.sin(a * 5.0 - seed * 0.6) * wobble * 0.52
      + Math.sin(a * 9.0 + seed * 0.32) * wobble * 0.24;
    const x = cx + Math.cos(a) * rx * w;
    const y = cy + Math.sin(a) * ry * w;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function createHybridFaceTexture(faceCanvases, color = [0.88, 0.92, 0.82]) {
  const faces = (faceCanvases || []).filter(Boolean).slice(-8);
  if (faces.length === 0) return null;

  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  const palette = fusionPalette(faces, color);
  const complexity = clamp01(0.18 + faces.length * 0.10);
  const seed = Math.random() * 1000 + faces.length * 91.17;

  // A single unified biological body. Source cells only contribute pigment,
  // not full visible layers.
  const bg = ctx.createRadialGradient(210, 180, 10, 256, 256, 260);
  bg.addColorStop(0, fusionCss(palette.pale, 0.86));
  bg.addColorStop(0.48, fusionCss(palette.base, 0.48));
  bg.addColorStop(1, fusionCss(palette.cool, 0.28));
  ctx.fillStyle = bg;
  fusionBlobPath(ctx, 256, 256, 214, 238, 0.020 + complexity * 0.035, seed);
  ctx.fill();

  drawSoftEllipseMask(ctx, 512, 512);

  // Soft tissue veils.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 8 + faces.length * 2; i++) {
    const tint = palette.memories[i % Math.max(1, palette.memories.length)] || palette.base;
    ctx.globalCompositeOperation = i % 2 ? 'screen' : 'multiply';
    ctx.strokeStyle = fusionCss(fusionMix(tint, i % 2 ? palette.pale : palette.deep, 0.42), 0.035 + complexity * 0.035);
    ctx.lineWidth = randRange(7, 20);
    const y = 150 + i * randRange(18, 28);
    ctx.beginPath();
    ctx.moveTo(105 + randRange(-12, 18), y + randRange(-24, 24));
    ctx.bezierCurveTo(
      170 + randRange(-45, 45), y - randRange(36, 86),
      330 + randRange(-45, 45), y + randRange(36, 86),
      410 + randRange(-26, 12), y + randRange(-30, 30)
    );
    ctx.stroke();
  }

  // A calm central nucleus formed from blended pigment, not stacked textures.
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + randRange(-0.28, 0.28);
    const x = 256 + Math.cos(a) * randRange(3, 34);
    const y = 258 + Math.sin(a) * randRange(3, 28);
    const tint = fusionMix(i % 2 ? palette.warm : palette.cool, palette.pale, 0.30);
    const g = ctx.createRadialGradient(x - 12, y - 12, 1, x, y, randRange(44, 72));
    g.addColorStop(0, 'rgba(255,255,240,0.42)');
    g.addColorStop(0.55, fusionCss(tint, 0.16));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    fusionBlobPath(ctx, x, y, randRange(34, 58), randRange(28, 56), 0.08 + complexity * 0.05, seed + i * 21.4);
    ctx.fill();
  }

  // Fine intracellular granules.
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 80 + faces.length * 18; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * 206;
    const x = 256 + Math.cos(a) * rr;
    const y = 256 + Math.sin(a) * rr * 1.08;
    const tint = palette.memories[i % Math.max(1, palette.memories.length)] || (i % 2 ? palette.warm : palette.cool);
    ctx.fillStyle = fusionCss(fusionMix(tint, palette.pale, 0.35), randRange(0.025, 0.105));
    ctx.beginPath();
    ctx.arc(x, y, randRange(0.8, 3.6), 0, Math.PI * 2);
    ctx.fill();
  }

  // Internal rings: inherited memories become structure rather than visible layers.
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 4 + Math.min(4, faces.length); i++) {
    const tint = i % 2 ? palette.warm : palette.cool;
    ctx.strokeStyle = fusionCss(tint, 0.045 + complexity * 0.04);
    ctx.lineWidth = randRange(5, 14);
    fusionBlobPath(
      ctx,
      256 + randRange(-10, 10),
      256 + randRange(-12, 12),
      54 + i * randRange(22, 31),
      62 + i * randRange(24, 34),
      0.035 + complexity * 0.035,
      seed + i * 38.1
    );
    ctx.stroke();
  }

  // Color wash and membrane. This unifies the image as one new organism.
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = fusionCss(palette.base, 0.18);
  ctx.fillRect(0, 0, 512, 512);

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

  // Outside fade / ellipse alpha.
  const masked = document.createElement('canvas');
  masked.width = 512;
  masked.height = 512;
  const m = masked.getContext('2d');
  m.clearRect(0, 0, 512, 512);
  m.save();
  m.beginPath();
  m.ellipse(256, 256, 218, 242, 0, 0, Math.PI * 2);
  m.clip();
  m.drawImage(out, 0, 0);
  m.restore();

  // soft inner glow
  const glow = m.createRadialGradient(190, 165, 0, 256, 256, 245);
  glow.addColorStop(0, 'rgba(255,255,255,0.24)');
  glow.addColorStop(0.55, 'rgba(255,255,255,0.045)');
  glow.addColorStop(1, fusionCss(palette.deep, 0.18));
  m.globalCompositeOperation = 'screen';
  m.fillStyle = glow;
  m.beginPath();
  m.ellipse(256, 256, 218, 242, 0, 0, Math.PI * 2);
  m.fill();
  m.globalCompositeOperation = 'source-over';

  const membrane = m.createRadialGradient(256, 256, 160, 256, 256, 248);
  membrane.addColorStop(0, 'rgba(255,255,255,0)');
  membrane.addColorStop(0.72, fusionCss(palette.pale, 0.045));
  membrane.addColorStop(1, fusionCss(palette.deep, 0.24));
  m.globalCompositeOperation = 'multiply';
  m.fillStyle = membrane;
  m.beginPath();
  m.ellipse(256, 256, 218, 242, 0, 0, Math.PI * 2);
  m.fill();
  m.globalCompositeOperation = 'source-over';

  return masked;
}
