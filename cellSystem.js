function cellClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function cellLerp(a, b, t) { return a + (b - a) * cellClamp(t, 0, 1); }

const FUSION_DEBUG_FAST = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fusionFast') === '1';
const FUSION_ABSORB_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('absorbFusion') === '1';
// Pair relationships can develop before fusion, but physical fusion is delayed
// until both cells have lived in the ecosystem for about twenty minutes.
const FUSION_MATURITY_FRAMES = 60 * (FUSION_DEBUG_FAST ? 45 : 300);
const FUSION_MIN_CELL_AGE_MS = (FUSION_DEBUG_FAST ? 60 : 20 * 60) * 1000;
const FUSION_CONTACT_FRAMES = 60 * (FUSION_DEBUG_FAST ? 8 : 14);
const HAND_SIGNAL_HOLD_MS = 4800;
const HAND_SIGNAL_REPEAT_MS = 4300;
// Finger gathering may overlap cells, but each cell must retain a visible rim.
const HAND_MIN_VISIBLE_RIM = 0.32;
const HAND_MIN_CENTER_DISTANCE = 0.38;
const HAND_MIN_PROFILE_SIMILARITY = 0.78;
const HAND_MAX_FOLLOWERS = 7;

function cellPairKey(a, b) {
  const ai = a.id || '';
  const bi = b.id || '';
  return ai < bi ? `${ai}|${bi}` : `${bi}|${ai}`;
}

function makeCellSignature(faceMetrics = {}, audioMetrics = {}, appearance = {}, behavior = {}) {
  const featureVector = faceMetrics.featureVector || [];
  const audioFeature = (behavior.audioFeatureVector || []).map(v => 0.5 + ((v ?? 0.5) - 0.5) * 0.35);
  const thermal = appearance.thermalSignature || faceMetrics.thermal?.signature || [];
  const base = [
    faceMetrics.brightness ?? 0.5,
    faceMetrics.saturation ?? 0.25,
    faceMetrics.warmth ?? 0.5,
    faceMetrics.contrast ?? 0.25,
    faceMetrics.edge ?? 0.2,
    faceMetrics.roundness ?? 0.75,
    faceMetrics.eyeDistance ?? 0.48,
    faceMetrics.facialSymmetry ?? 0.55,
    cellClamp((faceMetrics.faceAspect ?? 0.82) / 1.22, 0, 1),
    behavior.pitchTone ?? 0.5,
    behavior.soundEnergy ?? 0,
    behavior.softness ?? 0.3,
    appearance.hue ?? 0.5,
    ...(thermal.length ? thermal : [0.5, 0.5, 0.5, 0.5, 0, 0.5, 0.25]),
  ];
  const facePart = featureVector.length ? featureVector.concat(base.slice(8)) : base;
  return audioFeature.length ? facePart.concat(audioFeature) : facePart;
}

function cellSimilarity(a, b) {
  const av = a.signature || [];
  const bv = b.signature || [];
  if (!av.length || !bv.length) return 0.35;
  let d = 0;
  const n = Math.min(av.length, bv.length);
  for (let i = 0; i < n; i++) d += Math.pow((av[i] ?? 0.5) - (bv[i] ?? 0.5), 2);
  return cellClamp(1 - Math.sqrt(d / n) * 1.72, 0, 1);
}

function behaviorCompatibility(a, b) {
  const ap = a.personality || {};
  const bp = b.personality || {};
  const diffs = [
    Math.abs((ap.speed ?? 0.5) - (bp.speed ?? 0.5)) / 3,
    Math.abs((ap.curiosity ?? 0.5) - (bp.curiosity ?? 0.5)),
    Math.abs((ap.fusionDesire ?? 0.35) - (bp.fusionDesire ?? 0.35)),
    Math.abs((ap.quietness ?? 0.4) - (bp.quietness ?? 0.4)),
    Math.abs((ap.rhythm ?? 0.3) - (bp.rhythm ?? 0.3)),
    Math.abs((ap.continuity ?? 0.5) - (bp.continuity ?? 0.5)),
    Math.abs((ap.depth ?? 0.4) - (bp.depth ?? 0.4)),
    Math.abs((a.pitchTone ?? 0.5) - (b.pitchTone ?? 0.5)),
  ];
  const avg = diffs.reduce((sum, v) => sum + v, 0) / diffs.length;
  return cellClamp(1 - avg, 0, 1);
}

function vectorSimilarity(a = [], b = [], scale = 1.72) {
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.pow((a[i] ?? 0.5) - (b[i] ?? 0.5), 2);
  return cellClamp(1 - Math.sqrt(d / n) * scale, 0, 1);
}

function colorSimilarity(a = [], b = []) {
  if (!a.length || !b.length) return null;
  const dr = (a[0] ?? 0.5) - (b[0] ?? 0.5);
  const dg = (a[1] ?? 0.5) - (b[1] ?? 0.5);
  const db = (a[2] ?? 0.5) - (b[2] ?? 0.5);
  return cellClamp(1 - Math.sqrt(dr * dr + dg * dg + db * db) / 1.16, 0, 1);
}

function personalitySimilarity(a = {}, b = {}) {
  const keys = ['speed', 'curiosity', 'nervousness', 'fusionDesire', 'quietness', 'depth', 'rhythm', 'continuity'];
  let total = 0;
  for (const key of keys) total += Math.abs((a[key] ?? 0.5) - (b[key] ?? 0.5));
  return cellClamp(1 - total / keys.length, 0, 1);
}

function normalizeCellProfile(source = {}) {
  const appearance = source.appearance || {};
  const personality = source.personality || source.audioBehaviour || source.behavior || {};
  return {
    id: source.id,
    participantName: source.participantName,
    participantId: source.participantId,
    signature: (source.signature || makeCellSignature(source.faceMetrics, source.audioMetrics, appearance, personality) || []).slice(),
    thermalSignature: (source.thermalSignature || appearance.thermalSignature || source.thermalMetrics?.signature || []).slice(),
    thermalType: source.thermalType ?? appearance.thermalType ?? source.thermalMetrics?.thermalType,
    color: (source.color || appearance.color || source.baseColor || []).slice(),
    personality: { ...personality },
  };
}

function cellProfileSimilarity(cell, profile) {
  if (!profile) return 0.42;
  if (profile.id && cell.id === profile.id) return 1;

  const signature = vectorSimilarity(cell.signature || [], profile.signature || [], 1.72);
  const thermal = vectorSimilarity(cell.thermalSignature || [], profile.thermalSignature || [], 1.44);
  const color = colorSimilarity(cell.baseColor || cell.color || [], profile.color || []);
  const voice = personalitySimilarity(cell.personality || {}, profile.personality || {});
  const sameThermalType = Number.isFinite(cell.thermalType) && Number.isFinite(profile.thermalType) && cell.thermalType === profile.thermalType ? 0.08 : 0;

  const faceScore = signature ?? thermal ?? color ?? 0.45;
  const thermalScore = thermal ?? faceScore;
  const colorScore = color ?? faceScore;
  return cellClamp(
    faceScore * 0.42 +
    thermalScore * 0.30 +
    colorScore * 0.16 +
    voice * 0.12 +
    sameThermalType,
    0,
    1
  );
}

class FaceCell {
  constructor(texture, dish, opts = {}) {
    const appearance = opts.appearance || {};
    const behavior = opts.personality || opts.behavior || {};
    this.id = opts.id || `cell-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.createdAtMs = opts.createdAtMs || Date.now();
    this.participantName = opts.participantName || '';
    this.participantId = opts.participantId || '';
    this.texture = texture;
    const quietFade = 1 - (behavior.quietness ?? 0) * 0.32;
    this.textures = opts.textures || [{ tex: texture, ox: 0, oy: 0, scale: 1, rot: 0, alpha: (appearance.textureAlpha ?? 0.82) * quietFade }];
    this.parentIds = opts.parentIds || [this.id];
    this.fusionMass = opts.fusionMass ?? Math.max(1, this.parentIds.length);
    this.fusionGeneration = opts.fusionGeneration ?? 0;
    this.fusionGrowth = opts.fusionGrowth ?? 0;
    this.morphology = opts.morphology || opts.faceMetrics?.morphology || {};
    this.featureVector = opts.featureVector || opts.faceMetrics?.featureVector || [];
    this.audioBehaviour = behavior;
    this.voiceProfile = behavior.voiceProfile || opts.voiceProfile || {};
    this.audioFeatureVector = behavior.audioFeatureVector || opts.audioFeatureVector || [];
    this.similarityRelations = {};
    this.communicationState = 'drifting';
    this.communicationTimers = {};
    this.fusionProgress = 0;
    this.sizeScale = behavior.sizeScale ?? 0.84;
    this.activityScale = behavior.activityScale ?? 0.34;
    this.energy = cellClamp(0.14 + (behavior.soundEnergy ?? 0) * 0.52 + (behavior.highFrequency ?? 0) * 0.10 + this.activityScale * 0.34, 0, 1);

    const a = opts.angle ?? Math.random() * Math.PI * 2;
    const rr = opts.rr ?? (dish.r * (0.16 + Math.sqrt(Math.random()) * 0.66));
    this.x = opts.x ?? dish.cx + Math.cos(a) * rr;
    this.y = opts.y ?? dish.cy + Math.sin(a) * rr;
    this.prevX = this.x;
    this.prevY = this.y;
    this.trail = [];

    this.speedMul = behavior.speedMul ?? 1;
    this.wanderMul = behavior.wanderMul ?? 1;
    this.social = behavior.social ?? 1;
    this.fusionBias = behavior.fusionBias ?? 1;
    this.pulseAmp = behavior.pulseAmp ?? 0.28;
    this.spinMul = behavior.spinMul ?? 1;
    this.homeMul = behavior.homeMul ?? 1;
    this.rangeMul = behavior.rangeMul ?? 1;
    this.pitchTone = behavior.pitchTone ?? 0.5;
    this.softness = behavior.softness ?? 0.28;
    this.soundEnergy = behavior.soundEnergy ?? 0;
    this.temperament = behavior.temperament || 'neutral';
    this.personality = {
      speed: behavior.speed ?? behavior.speedMul ?? 1,
      curiosity: behavior.curiosity ?? behavior.social ?? 0.5,
      nervousness: behavior.nervousness ?? behavior.wanderMul ?? 0.35,
      fusionDesire: behavior.fusionDesire ?? behavior.fusionBias ?? 0.35,
      quietness: behavior.quietness ?? 0,
      highFrequency: behavior.highFrequency ?? 0,
      volumeVariation: behavior.volumeVariation ?? 0,
      depth: behavior.depth ?? behavior.voiceProfile?.depth ?? 0.4,
      rhythm: behavior.rhythm ?? behavior.voiceProfile?.rhythm ?? 0.25,
      volatility: behavior.volatility ?? behavior.voiceProfile?.volatility ?? 0.25,
      continuity: behavior.continuity ?? behavior.voiceProfile?.continuity ?? 0.45,
      breathiness: behavior.breathiness ?? behavior.voiceProfile?.breathiness ?? 0.18,
      trajectoryBias: behavior.trajectoryBias ?? 0.45,
      isolation: behavior.isolation ?? behavior.quietness ?? 0,
      activityScale: this.activityScale,
      sizeScale: this.sizeScale,
    };
    appearance.thermalSignature = opts.thermalSignature || opts.thermalMetrics?.signature || appearance.thermalSignature;
    this.thermalSignature = appearance.thermalSignature || [];
    this.thermalType = appearance.thermalType ?? opts.thermalMetrics?.thermalType ?? 0;
    this.signature = opts.signature || makeCellSignature(opts.faceMetrics, opts.audioMetrics, appearance, behavior);

    this.vx = opts.vx ?? (Math.random() - 0.5) * 0.034 * this.speedMul * this.rangeMul;
    this.vy = opts.vy ?? (Math.random() - 0.5) * 0.034 * this.speedMul * this.rangeMul;

    const voiceSize = cellClamp(this.sizeScale * (0.86 + this.activityScale * 0.18), 0.50, 1.16);
    this.baseR = opts.baseR ?? ((appearance.baseR ?? (14 + Math.pow(Math.random(), 1.55) * 24)) * voiceSize);
    this.baseR = cellClamp(this.baseR, 10, 36);
    this.r = opts.r ?? this.baseR;
    this.aspect = opts.aspect ?? appearance.aspect ?? (0.78 + Math.random() * 0.52);
    this.angle = opts.cellAngle ?? Math.random() * Math.PI * 2;
    this.spin = opts.spin ?? (Math.random() - 0.5) * 0.00042 * this.spinMul;
    this.phase = Math.random() * Math.PI * 2;
    this.seed = Math.random() * 999;
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.driftAngle = Math.random() * Math.PI * 2;
    this.driftTurn = (Math.random() - 0.5) * 0.004 * (0.65 + this.personality.rhythm * 0.85 + this.personality.volatility * 0.70);
    this.voicePhase = Math.random() * Math.PI * 2;
    this.voiceOrbit = (this.personality.depth - this.personality.breathiness) * 0.5 + (Math.random() - 0.5) * 0.35;
    this.membraneAlpha = appearance.membraneAlpha ?? 0.23;
    this.membraneIrregularity = appearance.membraneIrregularity ?? 0.28;
    this.membraneThickness = appearance.membraneThickness ?? this.morphology.membraneThickness ?? 0.32;
    this.nucleusOffset = appearance.nucleusOffset || this.morphology.nucleusOffset || { x: 0, y: 0 };
    this.glowIntensity = appearance.glowIntensity ?? this.morphology.glowIntensity ?? 0.38;
    this.movementSoftness = appearance.movementSoftness ?? this.morphology.movementSoftness ?? this.softness;
    this.fieldStrength = appearance.fieldStrength ?? 1;
    this.kinshipGlow = 0;
    this.signalGlow = 0;
    this.signalStretch = 0;
    this.signalAngle = 0;
    this.signalColor = null;
    this.handAffinity = 0;
    this.handResponse = 0;
    this.releaseAngle = Math.random() * Math.PI * 2;
    this.releaseJitter = (Math.random() - 0.5) * 0.9;

    this.reaction = opts.reaction ?? 0;
    this.fusion = opts.fusion ?? 0;
    this.absorbProgress = 0;
    this.absorbingInto = null;
    this.dead = false;
    this.age = 0;

    const palettes = [
      [0.96, 0.88, 0.55], // warm milk yellow
      [0.78, 0.92, 0.82], // pale green
      [0.72, 0.90, 0.88], // cyan milk
      [0.94, 0.78, 0.68], // peach
      [0.88, 0.82, 0.96], // lavender
      [0.96, 0.74, 0.82], // pink
      [0.82, 0.94, 0.64], // acid green
    ];
    this.color = appearance.color || opts.color || palettes[Math.floor(Math.random() * palettes.length)];
    this.baseColor = this.color.slice();
  }

  startAbsorbing(host, relation = null) {
    if (this.absorbingInto || host.absorbingInto || this === host) return;
    this.absorbingInto = host;
    this.absorbProgress = 0;
    host.pendingFusionSimilarity = relation?.similarity ?? cellSimilarity(this, host);
    host.fusionGrowth = Math.min(1, host.fusionGrowth + 0.12);
    host.fusion = Math.min(1, host.fusion + 0.22);
    host.reaction = Math.min(1, host.reaction + 0.18);
  }

  finishAbsorb(prey) {
    // 真正融合：重新生成一个统一的 hybrid tissue texture，
    // 不再把过去的细胞图层完整叠上去。
    const sourceFaces = [];
    for (const part of this.textures) if (part.tex) sourceFaces.push(part.tex);
    for (const part of prey.textures) if (part.tex) sourceFaces.push(part.tex);

    this.color = [
      this.color[0] * 0.66 + prey.color[0] * 0.34,
      this.color[1] * 0.66 + prey.color[1] * 0.34,
      this.color[2] * 0.66 + prey.color[2] * 0.34,
    ];
    this.speedMul = this.speedMul * 0.72 + prey.speedMul * 0.28;
    this.wanderMul = this.wanderMul * 0.72 + prey.wanderMul * 0.28;
    this.social = this.social * 0.72 + prey.social * 0.28;
    this.fusionBias = this.fusionBias * 0.72 + prey.fusionBias * 0.28;
    this.pulseAmp = this.pulseAmp * 0.72 + prey.pulseAmp * 0.28;
    this.homeMul = this.homeMul * 0.72 + prey.homeMul * 0.28;
    this.rangeMul = this.rangeMul * 0.72 + prey.rangeMul * 0.28;
    this.pitchTone = this.pitchTone * 0.72 + prey.pitchTone * 0.28;
    this.softness = this.softness * 0.72 + prey.softness * 0.28;
    this.soundEnergy = Math.max(this.soundEnergy, prey.soundEnergy * 0.78);
    this.signature = this.signature.map((v, i) => v * 0.72 + (prey.signature[i] ?? v) * 0.28);
    this.audioFeatureVector = this.audioFeatureVector.map((v, i) => v * 0.72 + (prey.audioFeatureVector[i] ?? v) * 0.28);
    this.featureVector = this.signature.slice(0, Math.max(this.featureVector.length, prey.featureVector.length));
    this.morphology = {
      ...this.morphology,
      aspectRatio: cellLerp(this.morphology.aspectRatio ?? this.aspect, prey.morphology.aspectRatio ?? prey.aspect, 0.28),
      roundness: cellLerp(this.morphology.roundness ?? 0.75, prey.morphology.roundness ?? 0.75, 0.28),
      symmetry: cellLerp(this.morphology.symmetry ?? 0.55, prey.morphology.symmetry ?? 0.55, 0.28),
      textureComplexity: cellLerp(this.morphology.textureComplexity ?? 0.25, prey.morphology.textureComplexity ?? 0.25, 0.28),
    };
    this.parentIds = Array.from(new Set([...(this.parentIds || [this.id]), ...(prey.parentIds || [prey.id])]));
    this.fusionMass = Math.max(1, (this.fusionMass || 1) + (prey.fusionMass || 1));
    this.fusionGeneration = Math.max(this.fusionGeneration || 0, prey.fusionGeneration || 0) + 1;
    this.fusionGrowth = Math.min(1, this.fusionGrowth + 0.32 + Math.min(0.16, this.fusionMass * 0.018));

    if (typeof createHybridFaceTexture === 'function') {
      const hybrid = createHybridFaceTexture(sourceFaces, this.color);
      if (hybrid) {
        this.texture = hybrid;
        this.textures = [{ tex: hybrid, ox: 0, oy: 0, scale: 1, rot: 0, alpha: 0.92 }];
      }
    } else {
      this.textures = this.textures.slice(-1);
    }

    const inheritedSimilarity = cellClamp(this.pendingFusionSimilarity ?? cellSimilarity(this, prey), 0.72, 1);
    const similarityGrowth = cellClamp((inheritedSimilarity - 0.72) / 0.28, 0, 1);
    // Preserve most of both cells' visible area. Every completed fusion therefore
    // produces a clearly larger host, and repeated fusions keep accumulating size.
    const combinedAreaRadius = Math.sqrt(
      this.baseR * this.baseR + prey.baseR * prey.baseR * (0.84 + similarityGrowth * 0.10)
    );
    const cumulativeMassBoost = 1 + Math.min(0.30, Math.log2(Math.max(1, this.fusionMass)) * 0.055);
    this.baseR = Math.min(
      Math.max(this.baseR * 1.05, combinedAreaRadius * cumulativeMassBoost),
      128
    );
    this.pendingFusionSimilarity = null;
    this.r = Math.max(this.r, this.baseR * 0.94);
    this.membraneIrregularity = cellClamp(this.membraneIrregularity * 0.68 + prey.membraneIrregularity * 0.18 + 0.10, 0.12, 0.72);
    this.membraneAlpha = cellClamp(this.membraneAlpha * 0.78 + prey.membraneAlpha * 0.16 + 0.03, 0.16, 0.42);
    this.fusion = 0.62;
    this.reaction = 0.78;
    this.hybridAge = 0;
  }

  update(cells, dish, handData = null, relationships = null) {
    this.age++;
    this.prevX = this.x;
    this.prevY = this.y;
    this.phase += 0.0024 * (0.72 + this.pulseAmp);
    this.angle += this.spin;
    this.reaction *= 0.990;
    this.fusion *= 0.996;
    this.kinshipGlow *= 0.985;
    this.signalGlow *= 0.982;
    this.signalStretch *= 0.974;

    const t = performance.now() * 0.001;

    // 被吞噬中的细胞：缓慢滑入宿主细胞内部，半径逐渐缩小，像被包裹/吞没。
    if (this.absorbingInto && !this.absorbingInto.dead) {
      const host = this.absorbingInto;
      this.absorbProgress += 0.00034 * Math.max(0.42, this.fusionBias); // 相似细胞会很慢地融合，避免一碰就消失。
      const p = Math.min(1, this.absorbProgress);
      const ease = p * p * (3 - 2 * p);
      this.x += (host.x - this.x) * (0.010 + ease * 0.018);
      this.y += (host.y - this.y) * (0.010 + ease * 0.018);
      this.vx *= 0.92;
      this.vy *= 0.92;
      this.r += (this.baseR * (1 - ease * 0.76) - this.r) * 0.018;
      this.reaction = Math.min(1, this.reaction + 0.012);
      this.fusion = Math.min(1, this.fusion + 0.010);
      host.reaction = Math.min(1, host.reaction + 0.010);
      host.fusion = Math.min(1, host.fusion + 0.010);

      if (p >= 1) {
        host.finishAbsorb(this);
        this.dead = true;
      }
      return;
    }

    // 稳定漂浮：不要每帧随机抖，使用正弦微流动。
    const curiosityForce = 0.72 + this.personality.curiosity * 0.72;
    const nervousForce = 0.70 + this.personality.nervousness * 0.72 + this.personality.volatility * 0.48;
    const quietDrag = 1 - this.personality.quietness * 0.42 - this.personality.isolation * 0.10;
    const lowVoiceDrive = 0.72 + this.personality.depth * 0.58;
    const brightSoftness = 0.70 + this.personality.breathiness * 0.22 + this.personality.highFrequency * 0.28;
    const rhythmSwing = Math.sin(t * (0.18 + this.personality.rhythm * 0.55) + this.voicePhase) * 0.0018 * this.personality.rhythm;
    this.driftAngle += this.driftTurn + rhythmSwing + Math.sin(t * 0.07 + this.seed) * 0.0008 * nervousForce;
    const longArc = 0.00078 * this.rangeMul * this.speedMul * (0.55 + this.personality.speed * 0.65) * quietDrag * lowVoiceDrive * (1 - this.personality.breathiness * 0.22);
    this.vx += Math.cos(this.driftAngle) * longArc;
    this.vy += Math.sin(this.driftAngle) * longArc;
    this.vx += Math.sin(t * (0.19 + this.personality.rhythm * 0.18) + this.seed) * 0.00026 * this.wanderMul * curiosityForce * quietDrag * brightSoftness;
    this.vy += Math.cos(t * (0.17 + this.personality.rhythm * 0.15) + this.seed * 1.7) * 0.00026 * this.wanderMul * curiosityForce * quietDrag * brightSoftness;
    this.vx += Math.sin(t * 0.063 + this.seed * 0.37) * 0.00072 * this.rangeMul * this.speedMul * nervousForce * quietDrag * (0.76 + this.personality.trajectoryBias * 0.38);
    this.vy += Math.cos(t * 0.057 + this.seed * 0.51) * 0.00072 * this.rangeMul * this.speedMul * nervousForce * quietDrag * (0.76 + this.personality.trajectoryBias * 0.38);
    this.vx += Math.cos(this.driftAngle + Math.PI * 0.5) * 0.00028 * this.voiceOrbit * this.personality.rhythm;
    this.vy += Math.sin(this.driftAngle + Math.PI * 0.5) * 0.00028 * this.voiceOrbit * this.personality.rhythm;

    // 培养皿内部有很轻的环流，不会全部死在原地。
    const toCx = dish.cx - this.x;
    const toCy = dish.cy - this.y;
    this.vx += toCx * 0.0000014 * this.homeMul * (0.72 + this.personality.isolation * 0.46) + (-toCy) * 0.00000115 * this.wanderMul * this.orbitDir * (0.8 + this.rangeMul * 0.35 + this.personality.rhythm * 0.25);
    this.vy += toCy * 0.0000014 * this.homeMul * (0.72 + this.personality.isolation * 0.46) + ( toCx) * 0.00000115 * this.wanderMul * this.orbitDir * (0.8 + this.rangeMul * 0.35 + this.personality.rhythm * 0.25);

    if (handData && handData.detected) this.applyHandInfluence(handData, dish);
    else this.applyHandRelease(cells, dish, handData);

    this.communicationState = 'drifting';
    for (const other of cells) {
      if (other === this || other.dead || other.absorbingInto) continue;
      const dx = other.x - this.x;
      const dy = other.y - this.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const sumR = this.r + other.r;
      const relation = relationships ? relationships.get(cellPairKey(this, other)) : null;
      const similarity = relation ? relation.similarity : cellSimilarity(this, other);
      const communication = relation ? cellClamp(relation.communicationTime / relation.minCommunicationTime, 0, 1) : 0;
      const compatibility = relation ? relation.compatibility : behaviorCompatibility(this, other);
      const kin = cellClamp((similarity - 0.66) / 0.26, 0, 1);
      const maturity = relation ? cellClamp(Math.max(relation.bondAge || 0, relation.fusionAge || 0) / FUSION_MATURITY_FRAMES, 0, 1) : 0;
      const attractD = sumR * (1.05 + this.social * 0.16 + this.personality.curiosity * 0.22 + kin * (1.08 + maturity * 1.02) + communication * (0.22 + maturity * 0.54));
      const colonyD = sumR * (0.88 + kin * 0.18 + maturity * 0.18);
      const membraneD = sumR * (1.03 + kin * 0.10);
      const swallowD = sumR * (0.50 + kin * 0.16 + maturity * 0.06);
      const fusionReadyD = sumR * (1.04 + kin * 0.22 + maturity * 0.20);
      const nx = dx / d;
      const ny = dy / d;

      // Fusion now behaves like a small colony: cells can belong together without
      // collapsing into the same centre point.
      if (d < colonyD) {
        const crowd = cellClamp(1 - d / colonyD, 0, 1);
        const repel = crowd * crowd * 0.028 * (0.58 + kin * 0.76 + maturity * 0.44);
        this.vx -= nx * repel;
        this.vy -= ny * repel;
        if (d < sumR * 0.72) {
          const hardPush = (1 - d / (sumR * 0.72)) * 0.038;
          this.x -= nx * hardPush;
          this.y -= ny * hardPush;
          this.vx -= nx * hardPush * 0.08;
          this.vy -= ny * hardPush * 0.08;
        }
      }

      if (kin > 0.08 && compatibility > 0.46 && d < attractD) {
        // 相似的细胞慢慢靠近，不相似的细胞保持轻微距离。
        const distanceBand = Math.max(1, attractD - colonyD);
        const approach = cellClamp((d - colonyD) / distanceBand, 0, 1);
        const strength = approach * 0.0000065 * (0.65 + this.personality.curiosity) * this.social * kin * (0.30 + compatibility * 0.48 + communication * 0.52 + maturity * 1.12);
        this.vx += dx * strength;
        this.vy += dy * strength;
        this.kinshipGlow = Math.min(1, this.kinshipGlow + 0.0018 * kin);
        other.kinshipGlow = Math.min(1, other.kinshipGlow + 0.0012 * kin);
      } else if (similarity < 0.58 && d < sumR * 1.95) {
        const repel = (1 - d / (sumR * 1.95)) * 0.000014;
        this.vx -= dx * repel;
        this.vy -= dy * repel;
      }

      if (relation && relation.state !== 'idle') {
        this.communicationState = relation.state;
        this.communicationTimers[other.id] = relation.communicationTime;
        this.similarityRelations[other.id] = {
          similarity: relation.similarity,
          communicationTime: relation.communicationTime,
          state: relation.state,
        };
        const align = communication * compatibility * kin * (0.42 + maturity * 0.82);
        const avgVx = (this.vx + other.vx) * 0.5;
        const avgVy = (this.vy + other.vy) * 0.5;
        this.vx = cellLerp(this.vx, avgVx, 0.0025 * align);
        this.vy = cellLerp(this.vy, avgVy, 0.0025 * align);
        this.signalGlow = Math.min(1, this.signalGlow + 0.006 * align);
        this.signalStretch = Math.min(1, this.signalStretch + 0.0045 * align);
        this.signalAngle = Math.atan2(dy, dx);
        this.signalColor = other.color;
        this.reaction = Math.min(1, this.reaction + 0.0015 * align);
        if (maturity >= 1) {
          this.fusion = Math.min(1, this.fusion + 0.00075 * align * this.fusionBias);
        }

        if (relation.state === 'attracting' || relation.state === 'fusing' || relation.state === 'clustered') {
          const distanceBand = Math.max(1, attractD - colonyD);
          const approach = cellClamp((d - colonyD) / distanceBand, 0, 1);
          const pull = approach * 0.000012 * align * (relation.state === 'fusing' ? 1.22 : 1);
          this.vx += nx * pull;
          this.vy += ny * pull;
          if (relation.state === 'fusing' || relation.state === 'clustered') {
            const orbit = (1 - approach) * 0.000055 * align * (0.55 + this.personality.rhythm * 0.45 + maturity * 0.40);
            this.vx += -ny * orbit * this.orbitDir;
            this.vy += nx * orbit * this.orbitDir;
          }
        }
      }

      if (d < membraneD) {
        // 接触后降速、膜变软；真正融合只在细胞存在约 20 分钟后开始。
        this.vx *= 0.990;
        this.vy *= 0.990;
        this.reaction = Math.min(1, this.reaction + 0.0022 * (0.65 + this.pulseAmp + this.softness * 0.3));
        if (maturity >= 1) {
          this.fusion = Math.min(1, this.fusion + 0.00055 * this.fusionBias * (0.5 + this.personality.fusionDesire) * kin * (0.35 + communication));
        }
      }

      if (
        relation &&
        relation.state === 'fusing' &&
        d < Math.max(swallowD, fusionReadyD) &&
        Date.now() - this.createdAtMs >= FUSION_MIN_CELL_AGE_MS &&
        Date.now() - other.createdAtMs >= FUSION_MIN_CELL_AGE_MS &&
        similarity > relation.fusionThreshold &&
        relation.bondAge >= FUSION_MATURITY_FRAMES &&
        relation.fusionContactTime > FUSION_CONTACT_FRAMES
      ) {
        // 小的更容易被大的吞噬；如果差不多大，就随机选择一个宿主。
        const host = this.r >= other.r * 0.94 ? this : other;
        const prey = host === this ? other : this;
        relation.fusionCharge = cellClamp((relation.fusionCharge || 0) + 0.0014 * this.fusionBias * (0.35 + this.personality.fusionDesire) * Math.pow(kin, 1.45) * (0.45 + communication) * (0.35 + maturity), 0, 1.2);
        if (!prey.absorbingInto && !host.absorbingInto && relation.fusionCharge >= 1) {
          if (FUSION_ABSORB_MODE) {
            prey.startAbsorbing(host, relation);
            relation.state = 'merged';
          } else {
            relation.state = 'clustered';
            relation.clusteredAt = performance.now();
            host.fusionGrowth = Math.min(1, (host.fusionGrowth || 0) + 0.060 + kin * 0.070);
            prey.fusionGrowth = Math.min(1, (prey.fusionGrowth || 0) + 0.060 + kin * 0.070);
            host.fusionMass = Math.min(10, Math.max(host.fusionMass || 1, 1 + (host.fusionGrowth || 0) * 1.2));
            prey.fusionMass = Math.min(10, Math.max(prey.fusionMass || 1, 1 + (prey.fusionGrowth || 0) * 1.2));
            host.reaction = Math.min(1, host.reaction + 0.18);
            prey.reaction = Math.min(1, prey.reaction + 0.18);
            host.fusion = Math.min(1, host.fusion + 0.18);
            prey.fusion = Math.min(1, prey.fusion + 0.18);
          }
        }
      }
    }

    const activityPulse = this.activityScale * (0.028 + this.soundEnergy * 0.018);
    const livingPulse = Math.sin(t * (0.36 + this.speedMul * 0.20 + this.personality.highFrequency * 0.18 + this.personality.rhythm * 0.22) + this.seed) * (0.018 + activityPulse) * (this.pulseAmp + this.softness * 0.24 + this.personality.highFrequency * 0.18 + this.personality.breathiness * 0.12);
    const voiceBody = 1 + this.activityScale * 0.055 + this.soundEnergy * 0.035 - this.personality.quietness * 0.035;
    const longGrowth = cellClamp(
      Math.log2(Math.max(1, this.fusionMass || 1)) * 0.12 +
      (this.fusionGrowth || 0) * 0.13 +
      (this.hybridAge || 0) * 0.0000022,
      0,
      0.46
    );
    const targetR = this.baseR * (voiceBody + this.fusion * 0.13 + this.reaction * 0.045 + longGrowth + livingPulse);
    this.r += (targetR - this.r) * 0.010;
    if (this.fusionMass > 1) {
      this.hybridAge = (this.hybridAge || 0) + 1;
      this.fusionGrowth = Math.min(1, (this.fusionGrowth || 0) + 0.0000105);
    }

    const handBoost = 1 + (this.handResponse || 0) * 3.65;
    const baseMaxSpeed = 0.27 * handBoost * this.speedMul * (0.62 + this.rangeMul * 0.88) * (0.48 + this.personality.speed * 0.66) * quietDrag * lowVoiceDrive;
    const handMaxSpeed = (this.handResponse || 0) * (1.15 + (this.personality.speed ?? 0.5) * 1.95 + (this.personality.curiosity ?? 0.5) * 0.75);
    const maxSpeed = Math.max(baseMaxSpeed, handMaxSpeed);
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (sp > maxSpeed) {
      this.vx = (this.vx / sp) * maxSpeed;
      this.vy = (this.vy / sp) * maxSpeed;
    }

    this.x += this.vx + Math.sin(this.phase + this.seed) * 0.012 * this.wanderMul * (0.7 + this.softness * 0.6 + this.personality.breathiness * 0.25);
    this.y += this.vy + Math.cos(this.phase * 0.9 + this.seed) * 0.012 * this.wanderMul * (0.7 + this.softness * 0.6 + this.personality.breathiness * 0.25);
    const drag = 0.986 + this.softness * 0.004 + this.personality.quietness * 0.006 + this.personality.breathiness * 0.002;
    this.vx *= drag;
    this.vy *= drag;

    const bx = this.x - dish.cx;
    const by = this.y - dish.cy;
    const dist = Math.sqrt(bx * bx + by * by);
    const maxD = dish.r - this.r * 1.15;
    if (dist > maxD) {
      const nx = bx / dist;
      const ny = by / dist;
      this.x = dish.cx + nx * maxD;
      this.y = dish.cy + ny * maxD;
      const outward = this.vx * nx + this.vy * ny;
      if (outward > 0) {
        this.vx -= outward * nx;
        this.vy -= outward * ny;
      }
      this.vx *= 0.96;
      this.vy *= 0.96;
    }

    if (this.age % 3 === 0) {
      this.trail.push({ x: this.x, y: this.y });
      const maxTrail = Math.floor(16 + this.personality.speed * 20 + this.personality.nervousness * 18);
      if (this.trail.length > maxTrail) this.trail.shift();
    }
  }

  applyHandInfluence(handData, dish) {
    const affinity = cellProfileSimilarity(this, handData.participantProfile);
    this.handAffinity = cellLerp(this.handAffinity || 0, affinity, 0.06);
    const selectedFollowers = handData.followCellIds;
    if (Array.isArray(selectedFollowers) && !selectedFollowers.includes(this.id)) {
      this.handResponse = cellLerp(this.handResponse || 0, 0, 0.24);
      return;
    }
    const matchResponse = cellClamp((affinity - HAND_MIN_PROFILE_SIMILARITY) / 0.16, 0, 1);
    const signalStrength = Number.isFinite(handData.signalStrength) ? handData.signalStrength : 1;
    const signalPulse = Number.isFinite(handData.signalPulse) ? handData.signalPulse : 1;
    const signalHold = Number.isFinite(handData.signalHold) ? handData.signalHold : 0;
    const response = handData.participantProfile
      ? cellClamp((0.08 + matchResponse * 1.02) * signalStrength, 0, 1)
      : 0.82 * signalStrength;
    this.handResponse = cellLerp(this.handResponse || 0, response, 0.18 + signalPulse * 0.10);
    if (response <= 0.01) return;

    const handX = dish.cx + (handData.x - 0.5) * dish.r * 2;
    const handY = dish.cy + (handData.y - 0.5) * dish.r * 2;
    const orbitAngle = this.seed * 0.173 + this.orbitDir * performance.now() * 0.00018;
    const orbitRadius = this.r * (1.45 + matchResponse * 0.72) + dish.r * (0.014 + matchResponse * 0.018);
    const targetX = handX + Math.cos(orbitAngle) * orbitRadius;
    const targetY = handY + Math.sin(orbitAngle) * orbitRadius;
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
    const approach = cellClamp(1 - (handData.distanceToCenter ?? 1), 0, 1);
    const velocity = Math.min(2.5, handData.velocity || 0);
    const dwell = cellClamp((handData.dwellTime || 0) / 1800, 0, 1);
    const circularity = handData.circularity || 0;
    const openness = Number.isFinite(handData.openness) ? handData.openness : 0.5;
    const gestureIntensity = Number.isFinite(handData.gestureIntensity) ? handData.gestureIntensity : 0.5;
    const nx = dx / d;
    const ny = dy / d;
    const radius = dish.r * (0.70 + approach * 0.36 + dwell * 0.24 + response * 0.26);
    const local = Math.pow(cellClamp(1 - d / Math.max(1, radius), 0, 1), 0.42);
    const global = cellClamp((dish.r * 2.16 - d) / Math.max(1, dish.r * 2.16), 0, 1);
    const scatter = cellClamp((velocity - 0.78) / 1.35, 0, 1) * (1 - matchResponse * 0.88);
    const openAttract = cellClamp((openness - 0.42) / 0.46, 0, 1);
    const closedCompress = cellClamp((0.58 - openness) / 0.46, 0, 1);
    const gather = cellClamp(0.46 + dwell * 0.62 + approach * 0.30 + openAttract * 0.18 + matchResponse * 0.24, 0, 1) * (1 - scatter * 0.30);
    const curiosity = this.personality.curiosity ?? 0.5;
    const pullField = cellClamp((local * 0.86 + global * 0.32 + dwell * 0.12) * (0.62 + signalStrength * 0.48 + signalPulse * 0.22), 0, 1);

    if (pullField > 0.015) {
      const force = pullField * response * gather * 0.088 * (0.62 + curiosity * 0.78) * (0.72 + signalPulse * 0.46);
      this.vx += nx * force;
      this.vy += ny * force;
      this.kinshipGlow = Math.min(1, this.kinshipGlow + pullField * response * 0.012);
      this.signalGlow = Math.min(1, this.signalGlow + pullField * response * 0.006);
      this.signalAngle = Math.atan2(dy, dx);
    }

    if (scatter > 0.05 && matchResponse < 0.72) {
      const force = local * response * scatter * 0.012 * (1 - matchResponse) * (0.75 + this.personality.nervousness + gestureIntensity * 0.18);
      this.vx -= nx * force;
      this.vy -= ny * force;
      this.reaction = Math.min(1, this.reaction + local * scatter * 0.045);
    }

    if (gather > 0.02) {
      const force = local * response * gather * 0.056 * (0.55 + curiosity) * (0.76 + signalPulse * 0.40);
      this.vx += nx * force;
      this.vy += ny * force;
      this.kinshipGlow = Math.min(1, this.kinshipGlow + local * response * gather * 0.014);
    }

    if (response > 0.32 && pullField > 0.005) {
      const desiredSpeed = 1.04 + response * 3.05 + velocity * 0.38 + dwell * 0.38 + approach * 0.28 + signalHold * 0.36;
      const steer = cellClamp(0.050 + pullField * response * 0.170 + matchResponse * 0.070 + signalPulse * 0.028, 0.050, 0.285);
      const follow = cellClamp(response * (0.50 + matchResponse * 0.70), 0.22, 1.18);
      this.vx = cellLerp(this.vx, nx * desiredSpeed * follow, steer);
      this.vy = cellLerp(this.vy, ny * desiredSpeed * follow, steer);
      this.reaction = Math.min(1, this.reaction + pullField * response * 0.012);
    }

    if (matchResponse > 0.62 && pullField > 0.01) {
      const directFollow = cellClamp(0.030 + matchResponse * 0.105 + velocity * 0.020 + dwell * 0.018 + signalPulse * 0.018, 0.030, 0.190) * pullField;
      this.x = cellLerp(this.x, handX, directFollow);
      this.y = cellLerp(this.y, handY, directFollow);
      this.vx = cellLerp(this.vx, nx * (0.85 + matchResponse * 1.65 + velocity * 0.28), 0.12 * matchResponse * pullField);
      this.vy = cellLerp(this.vy, ny * (0.85 + matchResponse * 1.65 + velocity * 0.28), 0.12 * matchResponse * pullField);
      this.kinshipGlow = Math.min(1, this.kinshipGlow + 0.030 * matchResponse);
      this.signalGlow = Math.min(1, this.signalGlow + 0.020 * matchResponse);
    }

    if (closedCompress > 0.04 && velocity < 0.55) {
      const force = local * response * closedCompress * 0.0058 * (0.6 + dwell * 0.7);
      this.vx += nx * force;
      this.vy += ny * force;
      this.fusion = Math.min(1, this.fusion + local * closedCompress * 0.0026);
      this.signalGlow = Math.min(1, this.signalGlow + local * closedCompress * 0.004);
    }

    if (circularity > 0.08) {
      const tangent = (handData.movementAngle || 0) + Math.PI * 0.5;
      const force = local * response * circularity * 0.0090 * (0.60 + this.personality.speed * 0.40);
      this.vx += Math.cos(tangent) * force;
      this.vy += Math.sin(tangent) * force;
      this.fusion = Math.min(1, this.fusion + local * circularity * 0.003);
    }

    this.pulseAmp = Math.min(1.15, this.pulseAmp + local * response * (scatter * 0.018 + gather * 0.008 + circularity * 0.010));
  }

  applyHandRelease(cells, dish, lastHandData = null) {
    const release = this.handResponse || 0;
    if (release <= 0.01) {
      this.handResponse = 0;
      this.handAffinity *= 0.96;
      return;
    }

    this.handResponse *= 0.925;
    this.handAffinity *= 0.965;
    this.releaseAngle += 0.006 + this.releaseJitter * 0.0015;

    if (lastHandData && Number.isFinite(lastHandData.x) && Number.isFinite(lastHandData.y)) {
      const handX = dish.cx + (lastHandData.x - 0.5) * dish.r * 2;
      const handY = dish.cy + (lastHandData.y - 0.5) * dish.r * 2;
      const dx = this.x - handX;
      const dy = this.y - handY;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const nx = dx / d;
      const ny = dy / d;
      const field = cellClamp(1 - d / (dish.r * 0.62), 0, 1);
      const force = field * release * (0.020 + this.personality.nervousness * 0.010 + this.personality.speed * 0.006);
      this.vx += nx * force;
      this.vy += ny * force;
    }

    const spreadRadius = this.r * (2.15 + release * 2.4);
    for (const other of cells) {
      if (other === this || other.dead || other.absorbingInto) continue;
      const dx = this.x - other.x;
      const dy = this.y - other.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      if (d >= spreadRadius) continue;
      const push = Math.pow(1 - d / spreadRadius, 1.4) * release * 0.018;
      this.vx += (dx / d) * push;
      this.vy += (dy / d) * push;
    }

    const orbit = 0.0045 * release * (0.45 + this.rangeMul * 0.55);
    this.vx += Math.cos(this.releaseAngle) * orbit;
    this.vy += Math.sin(this.releaseAngle) * orbit;
    this.reaction = Math.min(1, this.reaction + release * 0.0025);
    this.kinshipGlow *= 0.96;
    this.signalGlow *= 0.94;
  }
}

class CellSystem {
  constructor() {
    this.cells = [];
    this.handData = null;
    this.handFade = 0;
    this.handSignal = null;
    this.activeParticipantProfile = null;
    this.relationships = new Map();
    this.frame = 0;
  }
  add(texture, dish, opts = {}) {
    const cell = new FaceCell(texture, dish, opts);
    this.cells.push(cell);
    this.setActiveParticipantProfile(cell);
    if (this.cells.length > 72) this.cells.shift();
    this.rebuildRelationships();
  }
  setActiveParticipantProfile(source) {
    if (!source) return;
    this.activeParticipantProfile = normalizeCellProfile(source);
  }
  setHandData(handData) {
    const now = Date.now();
    const nextHand = {
      detected: !!handData.detected,
      rawX: Number.isFinite(handData.rawX) ? handData.rawX : handData.x,
      rawY: Number.isFinite(handData.rawY) ? handData.rawY : handData.y,
      x: Number.isFinite(handData.x) ? handData.x : 0.5,
      y: Number.isFinite(handData.y) ? handData.y : 0.5,
      distanceToCenter: Number.isFinite(handData.distanceToCenter) ? handData.distanceToCenter : 1,
      velocity: Number.isFinite(handData.velocity) ? handData.velocity : 0,
      dwellTime: Number.isFinite(handData.dwellTime) ? handData.dwellTime : 0,
      movementAngle: Number.isFinite(handData.movementAngle) ? handData.movementAngle : 0,
      circularity: Number.isFinite(handData.circularity) ? handData.circularity : 0,
      openness: Number.isFinite(handData.openness) ? handData.openness : 0.5,
      gestureIntensity: Number.isFinite(handData.gestureIntensity) ? handData.gestureIntensity : 0,
      method: handData.method || 'unknown',
      sessionId: handData.sessionId || '',
      time: handData.time || now,
    };
    this.handData = nextHand;
    if (nextHand.detected) {
      const previous = this.handSignal || nextHand;
      const dx = nextHand.x - (previous.x ?? nextHand.x);
      const dy = nextHand.y - (previous.y ?? nextHand.y);
      const jump = Math.sqrt(dx * dx + dy * dy);
      const smooth = jump > 0.26 ? 0.42 : 0.22;
      this.handSignal = {
        ...nextHand,
        detected: true,
        x: cellLerp(previous.x ?? nextHand.x, nextHand.x, smooth),
        y: cellLerp(previous.y ?? nextHand.y, nextHand.y, smooth),
        rawX: cellLerp(previous.rawX ?? nextHand.rawX, nextHand.rawX, smooth),
        rawY: cellLerp(previous.rawY ?? nextHand.rawY, nextHand.rawY, smooth),
        velocity: Math.max(nextHand.velocity, (previous.velocity || 0) * 0.82),
        dwellTime: Math.max(nextHand.dwellTime, previous.dwellTime || 0),
        lastDetectedAt: now,
        firstDetectedAt: previous.firstDetectedAt || now,
        pulseStartedAt: previous.pulseStartedAt || now,
      };
      if (now - this.handSignal.pulseStartedAt > HAND_SIGNAL_REPEAT_MS) {
        this.handSignal.pulseStartedAt = now;
      }
      this.handFade = 1;
    }
  }
  update(dish) {
    this.frame++;
    let activeHand = null;
    const now = Date.now();
    if (this.handData && now - this.handData.time > 1400) {
      this.handData.detected = false;
    }
    if (this.handSignal && now - this.handSignal.lastDetectedAt > HAND_SIGNAL_HOLD_MS) {
      this.handSignal.detected = false;
    }
    if (this.handSignal && this.handFade > 0.02) {
      const holdAge = Math.max(0, now - this.handSignal.lastDetectedAt);
      const hold = cellClamp(1 - holdAge / HAND_SIGNAL_HOLD_MS, 0, 1);
      const pulseAge = (now - (this.handSignal.pulseStartedAt || now)) % HAND_SIGNAL_REPEAT_MS;
      const pulse = 0.54 + 0.46 * Math.pow(0.5 + 0.5 * Math.sin((pulseAge / HAND_SIGNAL_REPEAT_MS) * Math.PI * 2), 1.6);
      activeHand = {
        ...this.handSignal,
        detected: hold > 0.02,
        velocity: this.handSignal.velocity * this.handFade * (0.72 + pulse * 0.28),
        dwellTime: (this.handSignal.dwellTime + hold * HAND_SIGNAL_HOLD_MS * 0.35) * this.handFade,
        circularity: this.handSignal.circularity * this.handFade,
        openness: this.handSignal.openness,
        gestureIntensity: this.handSignal.gestureIntensity * this.handFade,
        signalStrength: hold * this.handFade,
        signalPulse: pulse,
        signalHold: hold,
        participantProfile: this.activeParticipantProfile,
      };
      if (this.activeParticipantProfile) {
        activeHand.followCellIds = this.cells
          .map(cell => ({
            id: cell.id,
            similarity: cellProfileSimilarity(cell, this.activeParticipantProfile),
          }))
          .filter(item => item.id === this.activeParticipantProfile.id || item.similarity >= HAND_MIN_PROFILE_SIMILARITY)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, HAND_MAX_FOLLOWERS)
          .map(item => item.id);
      }
      if (!this.handSignal.detected) this.handFade *= 0.965;
    } else if (this.handSignal && this.handFade <= 0.02) {
      this.handSignal = null;
    }
    this.updateRelationships(dish);
    for (const c of this.cells) c.update(this.cells, dish, activeHand, this.relationships);
    this.cells = this.cells.filter(c => !c.dead);
    if (activeHand && activeHand.detected) this.resolveHandOverlaps(dish);
    if (this.frame % 180 === 0) this.rebuildRelationships();
  }

  resolveHandOverlaps(dish) {
    // Two light passes are enough to separate small hand-gathered clusters without
    // turning the cells into hard, non-overlapping circles.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.cells.length; i++) {
        const a = this.cells[i];
        if (a.dead || a.absorbingInto) continue;
        for (let j = i + 1; j < this.cells.length; j++) {
          const b = this.cells[j];
          if (b.dead || b.absorbingInto) continue;
          const handResponse = Math.max(a.handResponse || 0, b.handResponse || 0);
          if (handResponse < 0.08) continue;

          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < 0.001) {
            const angle = ((a.seed || 0) * 0.731 + (b.seed || 0) * 1.173) % (Math.PI * 2);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }

          const smallerR = Math.min(a.r, b.r);
          const radiusDifference = Math.abs(a.r - b.r);
          const visibleRimDistance = radiusDifference + smallerR * HAND_MIN_VISIBLE_RIM;
          const overlapDistance = (a.r + b.r) * HAND_MIN_CENTER_DISTANCE;
          const minDistance = Math.max(visibleRimDistance, overlapDistance);
          if (distance >= minDistance) continue;

          const nx = dx / distance;
          const ny = dy / distance;
          const correction = (minDistance - distance) * (0.50 + handResponse * 0.28);
          const aAnchor = 1 + (a.handResponse || 0) * 1.8;
          const bAnchor = 1 + (b.handResponse || 0) * 1.8;
          const aShare = bAnchor / (aAnchor + bAnchor);
          const bShare = aAnchor / (aAnchor + bAnchor);
          a.x -= nx * correction * aShare;
          a.y -= ny * correction * aShare;
          b.x += nx * correction * bShare;
          b.y += ny * correction * bShare;
          a.vx -= nx * 0.012 * handResponse;
          a.vy -= ny * 0.012 * handResponse;
          b.vx += nx * 0.012 * handResponse;
          b.vy += ny * 0.012 * handResponse;
        }
      }
    }

    for (const cell of this.cells) {
      if (cell.dead || cell.absorbingInto) continue;
      const dx = cell.x - dish.cx;
      const dy = cell.y - dish.cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const maxDistance = Math.max(0, dish.r - cell.r * 1.15);
      if (distance > maxDistance && distance > 0.001) {
        cell.x = dish.cx + (dx / distance) * maxDistance;
        cell.y = dish.cy + (dy / distance) * maxDistance;
      }
    }
  }

  rebuildRelationships() {
    const aliveIds = new Set(this.cells.map(c => c.id));
    for (const key of this.relationships.keys()) {
      const rel = this.relationships.get(key);
      if (!rel || !aliveIds.has(rel.aId) || !aliveIds.has(rel.bId)) this.relationships.delete(key);
    }
  }

  updateRelationships(dish) {
    const seen = new Set();
    for (let i = 0; i < this.cells.length; i++) {
      const a = this.cells[i];
      if (a.dead || a.absorbingInto) continue;
      for (let j = i + 1; j < this.cells.length; j++) {
        const b = this.cells[j];
        if (b.dead || b.absorbingInto) continue;
        const key = cellPairKey(a, b);
        seen.add(key);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const sumR = a.r + b.r;
        const similarity = cellSimilarity(a, b);
        const compatibility = behaviorCompatibility(a, b);
        const relation = this.relationships.get(key) || {
          aId: a.id,
          bId: b.id,
          similarity,
          compatibility,
          communicationTime: 0,
          bondAge: 0,
          fusionContactTime: 0,
          fusionCharge: 0,
          state: 'idle',
          minCommunicationTime: 60 * (240 + Math.random() * 120),
          fusionThreshold: 0.72 + Math.random() * 0.08,
          fusionAge: 0,
        };
        relation.bondAge ??= 0;
        relation.fusionAge ??= 0;
        relation.fusionContactTime ??= 0;
        relation.fusionCharge ??= 0;
        relation.minCommunicationTime ??= 60 * (240 + Math.random() * 120);
        relation.fusionThreshold ??= 0.72 + Math.random() * 0.08;

        const kin = cellClamp((similarity - 0.66) / 0.26, 0, 1);
        const biologicallySimilar = similarity > 0.70 && compatibility > 0.48;
        relation.fusionAge = cellClamp((relation.fusionAge || 0) + (biologicallySimilar ? 1 : -0.6), 0, FUSION_MATURITY_FRAMES * 1.45);
        const mature = cellClamp(Math.max(relation.bondAge || 0, relation.fusionAge || 0) / FUSION_MATURITY_FRAMES, 0, 1);
        const communicationDistance = sumR * (1.10 + kin * (1.30 + mature * 1.55) + compatibility * 0.22);
        const matureSearchDistance = dish.r * (0.18 + kin * 0.24 + compatibility * 0.05) * mature;
        const close = d < Math.max(communicationDistance, matureSearchDistance);
        const canTalk = similarity > 0.66 && compatibility > 0.46 && close;
        const relativeAlignment = this.velocityAlignment(a, b);
        const gain = canTalk
          ? (0.34 + kin * 0.92 + compatibility * 0.42 + relativeAlignment * 0.16)
          : -(similarity < 0.62 ? 2.35 : 1.18);

        relation.similarity = cellLerp(relation.similarity, similarity, 0.035);
        relation.compatibility = cellLerp(relation.compatibility, compatibility, 0.035);
        relation.distance = d;
        relation.relativeAlignment = relativeAlignment;
        relation.communicationDistance = communicationDistance;
        relation.bondAge = cellClamp((relation.bondAge || 0) + (canTalk ? 1 : (biologicallySimilar ? 0.18 : -0.45)), 0, FUSION_MATURITY_FRAMES * 1.45);
        relation.communicationTime = cellClamp(relation.communicationTime + gain, 0, relation.minCommunicationTime * 1.25);
        const fusionDistance = sumR * (1.06 + kin * 0.24 + mature * 0.18);
        const cellsAreOldEnough =
          Date.now() - a.createdAtMs >= FUSION_MIN_CELL_AGE_MS &&
          Date.now() - b.createdAtMs >= FUSION_MIN_CELL_AGE_MS;
        const fusionReady = mature >= 1 && cellsAreOldEnough && similarity > relation.fusionThreshold && compatibility > 0.52;
        const keepClustered = relation.state === 'clustered' && relation.fusionCharge > 0.55;
        relation.fusionContactTime = cellClamp(
          (relation.fusionContactTime || 0) + (fusionReady && d < fusionDistance ? 1 : -1.6),
          0,
          FUSION_CONTACT_FRAMES * 1.4
        );
        if (!fusionReady) relation.fusionCharge = Math.max(0, (relation.fusionCharge || 0) - 0.0025);

        if (!canTalk || relation.communicationTime < 10) relation.state = 'idle';
        else if (mature < 0.46) relation.state = 'communicating';
        else if (mature < 0.78 || relation.communicationTime < relation.minCommunicationTime * 0.92) relation.state = 'attracting';
        else if (keepClustered) relation.state = 'clustered';
        else if (fusionReady && d < fusionDistance) relation.state = 'fusing';
        else relation.state = 'attracting';

        this.relationships.set(key, relation);
      }
    }

    for (const key of this.relationships.keys()) {
      if (!seen.has(key)) this.relationships.delete(key);
    }
  }

  velocityAlignment(a, b) {
    const as = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
    const bs = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (as < 0.001 || bs < 0.001) return 0.5;
    const dot = (a.vx * b.vx + a.vy * b.vy) / (as * bs);
    return cellClamp((dot + 1) * 0.5, 0, 1);
  }
}
