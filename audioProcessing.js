let audienceAudioContext = null;
let audienceMicStream = null;
let audienceMicDeviceId = localStorage.getItem('audienceMicDeviceId') || '';

function isTonorMic(mic) {
  return /tonor\s*td510|td510\s*air|tonor/i.test(mic?.label || '');
}

function isObsbotTinyMic(mic) {
  return /obsbot\s+tiny\s+3\s+lite\s+microphone|obsbot.*tiny.*microphone|obsbot.*microphone/i.test(mic?.label || '');
}

function pickPreferredAudienceMic(mics) {
  return mics.find(isTonorMic)
    || mics.find(isObsbotTinyMic)
    || mics.find(m => /obsbot|tiny/i.test(m.label || ''))
    || null;
}

function setMicrophoneStatus(text) {
  const el = document.getElementById('microphoneStatus');
  if (el) el.textContent = text;
}

async function refreshAudienceMicrophones() {
  const select = document.getElementById('microphoneSelect');
  if (!select || !navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');
  select.innerHTML = '';
  for (const mic of mics) {
    const opt = document.createElement('option');
    opt.value = mic.deviceId;
    opt.textContent = mic.label || `Microphone ${select.options.length + 1}`;
    select.appendChild(opt);
  }
  const preferred = pickPreferredAudienceMic(mics);
  if (preferred) {
    audienceMicDeviceId = preferred.deviceId;
    localStorage.setItem('audienceMicDeviceId', audienceMicDeviceId);
  }
  if (audienceMicDeviceId && [...select.options].some(o => o.value === audienceMicDeviceId)) {
    select.value = audienceMicDeviceId;
  }
  const active = mics.find(m => m.deviceId === select.value);
  setMicrophoneStatus(active ? `Using: ${active.label || 'selected microphone'}` : 'Using system microphone');
}

function initAudienceMicrophoneSelector() {
  const select = document.getElementById('microphoneSelect');
  if (!select) return;
  refreshAudienceMicrophones().catch(() => {});
  select.addEventListener('change', () => {
    audienceMicDeviceId = select.value;
    localStorage.setItem('audienceMicDeviceId', audienceMicDeviceId);
    if (audienceMicStream) audienceMicStream.getTracks().forEach(track => track.stop());
    audienceMicStream = null;
    const label = select.options[select.selectedIndex]?.textContent || 'selected microphone';
    setMicrophoneStatus(`Using: ${label}`);
  });
}

function audioClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function audioLerp(a, b, t) { return a + (b - a) * audioClamp(t, 0, 1); }

async function ensureAudienceMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone is not available in this browser');
  }
  if (navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      const preferred = pickPreferredAudienceMic(mics);
      if (preferred && audienceMicDeviceId !== preferred.deviceId) {
        audienceMicDeviceId = preferred.deviceId;
        localStorage.setItem('audienceMicDeviceId', audienceMicDeviceId);
        if (audienceMicStream) audienceMicStream.getTracks().forEach(track => track.stop());
        audienceMicStream = null;
        setMicrophoneStatus(`Using: ${preferred.label || 'TONOR TD510 Air S Mic'}`);
      }
    } catch (e) {}
  }
  if (!audienceAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audienceAudioContext = new AudioContextClass();
  }
  if (audienceAudioContext.state === 'suspended') {
    await audienceAudioContext.resume();
  }
  if (!audienceMicStream || !audienceMicStream.active) {
    const audioSettings = {
      ...(audienceMicDeviceId ? { deviceId: { exact: audienceMicDeviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      audienceMicStream = await navigator.mediaDevices.getUserMedia({
        audio: audioSettings,
        video: false,
      });
    } catch (err) {
      audienceMicDeviceId = '';
      localStorage.removeItem('audienceMicDeviceId');
      audienceMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
    }
    refreshAudienceMicrophones().catch(() => {});
  }
  return audienceMicStream;
}

async function captureAudienceAudio(durationMs = 5000, onProgress = null) {
  const stream = await ensureAudienceMic();
  const ctx = audienceAudioContext;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.18;
  source.connect(analyser);

  const timeData = new Float32Array(analyser.fftSize);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const frames = [];
  let lastSpectrum = null;
  const started = performance.now();

  return new Promise((resolve) => {
    function sample(now) {
      analyser.getFloatTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);

      let sumSq = 0;
      let peak = 0;
      let crossings = 0;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i];
        sumSq += v * v;
        peak = Math.max(peak, Math.abs(v));
        if (i > 0 && ((timeData[i - 1] < 0 && v >= 0) || (timeData[i - 1] >= 0 && v < 0))) crossings++;
      }

      let magSum = 0;
      let weighted = 0;
      let low = 0;
      let mid = 0;
      let high = 0;
      let flux = 0;
      for (let i = 0; i < freqData.length; i++) {
        const mag = freqData[i] / 255;
        magSum += mag;
        weighted += mag * i;
        if (i < freqData.length * 0.16) low += mag;
        else if (i < freqData.length * 0.42) mid += mag;
        if (i > freqData.length * 0.42) high += mag;
        if (lastSpectrum) {
          const diff = mag - lastSpectrum[i];
          if (diff > 0) flux += diff;
        }
      }

      const spectrum = new Float32Array(freqData.length);
      for (let i = 0; i < freqData.length; i++) spectrum[i] = freqData[i] / 255;
      lastSpectrum = spectrum;

      const rms = Math.sqrt(sumSq / timeData.length);
      const frame = {
        rms,
        peak,
        zcr: crossings / timeData.length,
        centroid: magSum > 0 ? (weighted / magSum) / freqData.length : 0,
        lowRatio: magSum > 0 ? low / magSum : 0,
        midRatio: magSum > 0 ? mid / magSum : 0,
        highRatio: magSum > 0 ? high / magSum : 0,
        flux: flux / freqData.length,
      };
      frames.push(frame);

      const progress = audioClamp((now - started) / durationMs, 0, 1);
      if (onProgress) onProgress(progress, frame);

      if (progress < 1) {
        requestAnimationFrame(sample);
      } else {
        source.disconnect();
        analyser.disconnect();
        resolve(summarizeAudioFrames(frames));
      }
    }
    requestAnimationFrame(sample);
  });
}

function summarizeAudioFrames(frames) {
  if (!frames.length) return defaultAudioMetrics();
  const avg = (key) => frames.reduce((sum, f) => sum + f[key], 0) / frames.length;
  const rms = avg('rms');
  const centroid = avg('centroid');
  const zcr = avg('zcr');
  const flux = avg('flux');
  const lowRatio = avg('lowRatio');
  const midRatio = avg('midRatio');
  const highRatio = avg('highRatio');
  const peak = frames.reduce((m, f) => Math.max(m, f.peak), 0);
  const silenceRatio = frames.filter(f => f.rms < 0.012).length / frames.length;
  const speechRatio = frames.filter(f => f.rms >= 0.018).length / frames.length;
  const variance = frames.reduce((sum, f) => sum + Math.pow(f.rms - rms, 2), 0) / frames.length;
  const sortedRms = frames.map(f => f.rms).sort((a, b) => a - b);
  const q10 = sortedRms[Math.floor(sortedRms.length * 0.10)] || 0;
  const q90 = sortedRms[Math.floor(sortedRms.length * 0.90)] || 0;
  const dynamicRange = Math.max(0, q90 - q10);
  let attackCount = 0;
  let pauseCount = 0;
  let lastSpeaking = frames[0]?.rms >= 0.018;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (cur.rms - prev.rms > 0.010) attackCount++;
    const speaking = cur.rms >= 0.018;
    if (lastSpeaking && !speaking) pauseCount++;
    lastSpeaking = speaking;
  }
  const attackRate = attackCount / Math.max(1, frames.length - 1);
  const pauseRate = pauseCount / Math.max(1, frames.length - 1);
  const voicedCentroids = frames.filter(f => f.rms >= 0.018).map(f => f.centroid);
  const centroidMean = voicedCentroids.length ? voicedCentroids.reduce((s, v) => s + v, 0) / voicedCentroids.length : centroid;
  const centroidVariance = voicedCentroids.length
    ? voicedCentroids.reduce((s, v) => s + Math.pow(v - centroidMean, 2), 0) / voicedCentroids.length
    : 0;

  return {
    rms,
    peak,
    centroid,
    zcr,
    flux,
    lowRatio,
    midRatio,
    highRatio,
    silenceRatio,
    speechRatio,
    energyVariance: variance,
    dynamicRange,
    attackRate,
    pauseRate,
    centroidVariance,
  };
}

function defaultAudioMetrics() {
  return {
    rms: 0,
    peak: 0,
    centroid: 0,
    zcr: 0,
    flux: 0,
    lowRatio: 0,
    midRatio: 0,
    highRatio: 0,
    silenceRatio: 1,
    speechRatio: 0,
    energyVariance: 0,
    dynamicRange: 0,
    attackRate: 0,
    pauseRate: 0,
    centroidVariance: 0,
  };
}

function buildVoiceProfile(metrics) {
  const m = metrics || defaultAudioMetrics();
  const volume = audioClamp((m.rms - 0.006) / 0.075, 0, 1);
  const pitchTone = audioClamp((m.centroid - 0.035) * 7.5 + m.zcr * 3.2 + m.highRatio * 0.42, 0, 1);
  const brightness = audioClamp(pitchTone * 0.54 + (m.highRatio || 0) * 0.42 + (m.centroidVariance || 0) * 4.6, 0, 1);
  const depth = audioClamp((m.lowRatio || 0) * 1.35 + (1 - pitchTone) * 0.42, 0, 1);
  const rhythm = audioClamp((m.attackRate || 0) * 5.8 + (m.pauseRate || 0) * 2.4 + (m.flux || 0) * 7.0, 0, 1);
  const volatility = audioClamp(Math.sqrt(m.energyVariance || 0) * 48 + (m.dynamicRange || 0) * 10 + (m.flux || 0) * 6, 0, 1);
  const continuity = audioClamp((m.speechRatio || 0) * 0.82 + (1 - (m.pauseRate || 0) * 8) * 0.18, 0, 1);
  const breathiness = audioClamp((m.highRatio || 0) * 0.88 + (m.zcr || 0) * 5.0 - volume * 0.16, 0, 1);
  const quietness = audioClamp((m.silenceRatio || 0) * 0.82 + (1 - volume) * 0.18, 0, 1);
  const presence = audioClamp((m.speechRatio || 0) * 1.12 + volume * 0.32, 0, 1);

  let voiceType = 'quiet';
  if (quietness > 0.78) voiceType = 'dormant';
  else if (depth > 0.62 && volume > 0.32) voiceType = 'deep';
  else if (brightness > 0.62 && breathiness > 0.34) voiceType = 'bright';
  else if (rhythm > 0.58 || volatility > 0.62) voiceType = 'fragmented';
  else if (continuity > 0.62) voiceType = 'continuous';

  return {
    voiceType,
    volume,
    pitchTone,
    brightness,
    depth,
    rhythm,
    volatility,
    continuity,
    breathiness,
    quietness,
    presence,
    lowRatio: audioClamp(m.lowRatio || 0, 0, 1),
    midRatio: audioClamp(m.midRatio || 0, 0, 1),
    highRatio: audioClamp(m.highRatio || 0, 0, 1),
  };
}

function buildAudioFeatureVector(metrics) {
  const p = buildVoiceProfile(metrics);
  return [
    p.volume,
    p.pitchTone,
    p.brightness,
    p.depth,
    p.rhythm,
    p.volatility,
    p.continuity,
    p.breathiness,
    p.quietness,
    p.presence,
    p.lowRatio,
    p.midRatio,
    p.highRatio,
  ];
}

function audioMetricsToPersonality(metrics) {
  const m = metrics || defaultAudioMetrics();
  const voiceProfile = buildVoiceProfile(m);
  const audioFeatureVector = buildAudioFeatureVector(m);
  const volume = audioClamp((m.rms - 0.006) / 0.075, 0, 1);
  const peak = audioClamp((m.peak - 0.025) / 0.38, 0, 1);
  const pitchTone = audioClamp((m.centroid - 0.035) * 7.5 + m.zcr * 3.2 + m.highRatio * 0.42, 0, 1);
  const lowTone = 1 - pitchTone;
  const highFrequency = audioClamp(pitchTone * 0.62 + m.highRatio * 0.58, 0, 1);
  const volumeVariation = audioClamp(Math.sqrt(m.energyVariance) * 48 + m.flux * 7 + (m.dynamicRange || 0) * 4, 0, 1);
  const voicePresence = audioClamp(m.speechRatio * 1.16 + volume * 0.26, 0, 1);
  const silence = audioClamp(m.silenceRatio, 0, 1);
  const quietness = audioClamp(silence * 0.82 + (1 - volume) * 0.18, 0, 1);
  const activeLowVoice = audioClamp(voiceProfile.depth * voicePresence * 0.58 + volume * 0.25 + volumeVariation * 0.17, 0, 1);
  const softHighVoice = audioClamp(voiceProfile.brightness * voicePresence * 0.72 + voiceProfile.breathiness * 0.18 + silence * 0.18, 0, 1);
  const rhythmicEnergy = audioClamp(voiceProfile.rhythm * 0.56 + voiceProfile.volatility * 0.34 + peak * 0.10, 0, 1);
  const sizeScale = audioClamp(0.68 + volume * 0.22 + voiceProfile.depth * 0.14 + volumeVariation * 0.12 - quietness * 0.18, 0.54, 1.12);
  const activityScale = audioClamp(0.18 + activeLowVoice * 0.48 + rhythmicEnergy * 0.28 + peak * 0.12 - quietness * 0.18, 0.06, 1.0);

  let temperament = 'quiet';
  if (silence > 0.78) temperament = 'dormant';
  else if (activeLowVoice > 0.58 && volumeVariation > 0.28) temperament = 'vital';
  else if (voiceProfile.brightness > 0.58) temperament = 'soft';
  else if (volume > 0.58 && rhythmicEnergy > 0.45) temperament = 'restless';
  else if (voicePresence > 0.45) temperament = 'social';

  return {
    temperament,
    voiceProfile,
    audioFeatureVector,
    speed: audioClamp(audioLerp(0.04, 3.60, volume) * audioLerp(0.22, 1.16, 1 - quietness) * audioLerp(1.22, 0.52, voiceProfile.brightness) * audioLerp(0.72, 1.28, voiceProfile.depth), 0.03, 3.80),
    curiosity: audioClamp(voicePresence * 0.32 + highFrequency * 0.24 + voiceProfile.rhythm * 0.18 + voiceProfile.continuity * 0.16 + volumeVariation * 0.10, 0, 1),
    nervousness: audioClamp(voiceProfile.volatility * 0.54 + peak * 0.20 + highFrequency * 0.12 + voiceProfile.rhythm * 0.14, 0, 1),
    fusionDesire: audioClamp(voicePresence * 0.40 + volume * 0.16 + voiceProfile.continuity * 0.22 + (1 - quietness) * 0.12 + (1 - Math.abs(pitchTone - 0.5) * 2) * 0.10, 0, 1),
    quietness,
    averageVolume: volume,
    volumeVariation,
    highFrequency,
    pitchTone,
    sizeScale,
    activityScale,
    depth: voiceProfile.depth,
    rhythm: voiceProfile.rhythm,
    volatility: voiceProfile.volatility,
    continuity: voiceProfile.continuity,
    breathiness: voiceProfile.breathiness,
    softness: audioClamp(0.18 + softHighVoice * 0.78, 0.08, 0.96),
    soundEnergy: volume,
    speedMul: audioClamp(audioLerp(0.08, 4.10, activeLowVoice) * audioLerp(0.24, 1.10, 1 - silence) * audioLerp(1.20, 0.50, voiceProfile.brightness), 0.06, 4.25),
    wanderMul: audioClamp(audioLerp(0.10, 4.20, activeLowVoice * 0.50 + rhythmicEnergy * 0.36 + peak * 0.08 + voiceProfile.breathiness * 0.06), 0.08, 4.35),
    rangeMul: audioClamp(audioLerp(0.10, 4.80, activeLowVoice * 0.66 + voiceProfile.depth * 0.20 + rhythmicEnergy * 0.14), 0.08, 4.95),
    social: audioClamp(audioLerp(0.24, 1.32, voicePresence * 0.58 + voiceProfile.continuity * 0.26 + (1 - Math.abs(pitchTone - 0.5) * 2) * 0.16) * audioLerp(0.62, 1.0, 1 - silence), 0.16, 1.42),
    fusionBias: audioClamp(audioLerp(0.04, 0.88, voicePresence * 0.28 + volume * 0.16 + voiceProfile.continuity * 0.24 + (1 - quietness) * 0.18 + (1 - Math.abs(pitchTone - 0.5) * 2) * 0.14), 0.035, 0.90),
    pulseAmp: audioClamp(audioLerp(0.02, 1.30, volume * 0.20 + rhythmicEnergy * 0.26 + highFrequency * 0.26 + softHighVoice * 0.18 + voiceProfile.breathiness * 0.10), 0.02, 1.35),
    spinMul: audioClamp(audioLerp(0.28, 2.25, lowTone * 0.36 + rhythmicEnergy * 0.32 + peak * 0.18 + voiceProfile.depth * 0.14), 0.20, 2.45),
    homeMul: audioClamp(audioLerp(1.55, 0.42, activeLowVoice), 0.34, 1.68),
    trajectoryBias: audioClamp(voiceProfile.rhythm * 0.40 + voiceProfile.depth * 0.24 + voiceProfile.breathiness * 0.20 + voiceProfile.continuity * 0.16, 0, 1),
    isolation: audioClamp(quietness * 0.86 + (1 - voicePresence) * 0.28, 0, 1),
  };
}

function audioMetricsToBehavior(metrics) {
  return audioMetricsToPersonality(metrics);
}
