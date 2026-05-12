/** orb.js — Three.js audio-reactive particle orb centerpiece.
 *
 *  An alternative to the SVG instrument-cluster reactor. Renders ~5000
 *  particles on a sphere; vertex positions deform per-frame based on the
 *  voice waveform analyser (RMS + low/mid/high frequency bins). State
 *  hooks (idle / listening / thinking / speaking) modulate the breathing
 *  rate and overall scale so the orb visibly responds to the kiosk's
 *  conversational state, not just the audio signal.
 *
 *  Why this exists: parity with the visual standard the wider voice-AI
 *  community converged on (Three.js audio-reactive orb, ubiquitous in
 *  demo GIFs). Keeping the SVG reactor as the default means operators
 *  who prefer the instrument-cluster aesthetic don't lose it; the orb
 *  is opt-in via Settings → Centerpiece, and ?mode=reactor secondary
 *  windows render whichever centerpiece the operator picked.
 *
 *  Performance: shader-based vertex displacement runs on the GPU. Single
 *  draw call per frame. Throttles to 30fps via RAF gating to share the
 *  GPU budget with the existing voice waveform analyser.
 *
 *  Three.js loads from the unpkg CDN (no bundle step in the kiosk).
 *  Pinned major to avoid silent breakage when r170 ships some renamed
 *  uniform we depend on. */

const THREE_CDN = "https://unpkg.com/three@0.166.1/build/three.module.js";

let _scene = null;
let _camera = null;
let _renderer = null;
let _points = null;
let _material = null;
let _analyser = null;
let _freqBuffer = null;
let _container = null;
let _rafId = null;
let _state = "idle";
let _stateAt = performance.now();
let _running = false;

/* RAF throttle to 30fps — same cadence the speedo's voice waveform uses. */
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
let _lastFrameAt = 0;

/* Particle count — was 5000 → 1800 → 1200. 1800 still read as a "fuzzy ball"
 * per operator. At 1200 the negative space between dots becomes the dominant
 * visual, which is the look we want — points orbiting a void, not a sphere. */
const PARTICLE_COUNT = 1200;
const BASE_RADIUS = 1.0;

/** Distribute N points evenly on a unit sphere via Fibonacci spiral.
 *  Uniform-ish density without any clustering at the poles, no rejection
 *  sampling. Returns a Float32Array of [x, y, z, …]. */
function _fibonacciSphere(n) {
  const positions = new Float32Array(n * 3);
  const phi = Math.PI * (3 - Math.sqrt(5));   // golden angle
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = phi * i;
    positions[i * 3] = Math.cos(theta) * radius;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(theta) * radius;
  }
  return positions;
}

/** Read the operator's --accent CSS variable so the orb matches the
 *  workspace persona's colour. Falls back to cyan default. */
function _readAccentRGB() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      return [
        parseInt(v.slice(1, 3), 16) / 255,
        parseInt(v.slice(3, 5), 16) / 255,
        parseInt(v.slice(5, 7), 16) / 255,
      ];
    }
  } catch {}
  return [0, 0.831, 1];   // #00d4ff default
}

/** Lazily import Three.js. Returns the module on first call, cached
 *  thereafter. Allows the orb module to be imported without forcing a
 *  CDN fetch on operators using the SVG reactor. */
let _threePromise = null;
async function _loadThree() {
  if (_threePromise) return _threePromise;
  _threePromise = import(THREE_CDN);
  return _threePromise;
}

/** Mount the orb into the given container element. Sizes itself to the
 *  container; resizes on container resize via a single ResizeObserver.
 *
 *  @param {HTMLElement} container  Where to mount the canvas.
 *  @param {{ analyser?: AnalyserNode }} [opts]
 *  @returns {Promise<{ destroy, setState, setAnalyser }>}
 */
export async function init(container, { analyser = null } = {}) {
  if (_running) destroy();
  _container = container;
  const THREE = await _loadThree();

  _scene = new THREE.Scene();
  const w = container.clientWidth || 600;
  const h = container.clientHeight || 600;
  _camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  /* Was z=3 → 4.2 → 5.0. At z=5 the orb is ~60% of the original footprint,
   * which sits comfortably inside the centerpiece slot with the rest of the
   * HUD chrome breathing around it. Pull further to z=6 if the operator
   * wants it tinier still. */
  _camera.position.z = 5.0;
  _renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  _renderer.setSize(w, h);
  _renderer.setClearColor(0x000000, 0);   // transparent — reactor backdrop shows through
  container.appendChild(_renderer.domElement);

  /* Sphere geometry — 5000 points on a Fibonacci sphere. We pass them
   * as a BufferAttribute so the vertex shader can displace per-vertex. */
  const geometry = new THREE.BufferGeometry();
  const basePositions = _fibonacciSphere(PARTICLE_COUNT);
  geometry.setAttribute("position", new THREE.BufferAttribute(basePositions, 3));
  /* aSeed: deterministic per-vertex seed in [0, 1). Used by the vertex
   * shader to modulate displacement so vertices don't all pulse in lock-
   * step — gives the surface a more organic shimmer. */
  const seeds = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) seeds[i] = Math.random();
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const accent = _readAccentRGB();
  _material = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uAudioLow: { value: 0 },
      uAudioMid: { value: 0 },
      uAudioHigh: { value: 0 },
      uStateBreath: { value: 0.0 },     // 0 = static, 1 = breathing, increases with state intensity
      uStateScale: { value: 1.0 },       // overall sphere scale, swells when speaking
      uAccent: { value: new THREE.Vector3(accent[0], accent[1], accent[2]) },
      /* Was 2.5 — bumped to 3.5 because at z=5 the camera-distance scaling
       * makes points too small to register. Larger per-point size offsets
       * the wider FOV so each particle still reads cleanly. */
      uPointSize: { value: 3.5 * Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform float uAudioLow;
      uniform float uAudioMid;
      uniform float uAudioHigh;
      uniform float uStateBreath;
      uniform float uStateScale;
      uniform float uPointSize;
      varying float vGlow;
      varying float vDistFromCenter;
      void main() {
        vec3 base = position;
        // Per-vertex audio response — different bands contribute by polar angle so
        // low frequencies push the equator, highs ripple the poles.
        float lat = abs(base.y);                  // 0 at equator, 1 at poles
        float audio = mix(uAudioLow, uAudioHigh, lat) + uAudioMid * 0.5;
        // Per-vertex shimmer — phase offset from aSeed so vertices animate independently.
        float shimmer = sin(uTime * 2.0 + aSeed * 6.2831) * 0.04;
        // Breathing — gentle in idle, stronger in listening/thinking, expanded in speaking.
        float breath = sin(uTime * 1.8) * 0.06 * uStateBreath;
        float displacement = audio * 0.35 + shimmer + breath;
        vec3 dir = normalize(base);
        vec3 displaced = (base + dir * displacement) * uStateScale;
        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        gl_PointSize = uPointSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        vGlow = clamp(audio + breath * 2.0, 0.0, 1.0);
        vDistFromCenter = length(displaced);
      }
    `,
    fragmentShader: `
      uniform vec3 uAccent;
      varying float vGlow;
      varying float vDistFromCenter;
      void main() {
        // Soft circular point — fade alpha by squared distance from gl_PointCoord centre.
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = dot(c, c);
        if (d > 0.25) discard;
        float alpha = (1.0 - d * 4.0);
        // Brighter when audio-reactive, deeper at edges of the orb.
        vec3 col = mix(uAccent * 0.4, uAccent, vGlow);
        // Fall off intensity slightly with distance from sphere centre so the silhouette reads as 3D.
        col *= (1.2 - vDistFromCenter * 0.2);
        gl_FragColor = vec4(col, alpha * (0.7 + vGlow * 0.3));
      }
    `,
  });
  _points = new THREE.Points(geometry, _material);
  _scene.add(_points);

  if (analyser) setAnalyser(analyser);

  /* Resize observer — keeps the canvas + camera aspect aligned with the
   * container. ResizeObserver throttles natively so this is cheap. */
  const ro = new ResizeObserver((entries) => {
    if (!_renderer || !_camera) return;
    const e = entries[0];
    const newW = e.contentRect.width;
    const newH = e.contentRect.height;
    if (newW > 0 && newH > 0) {
      _renderer.setSize(newW, newH);
      _camera.aspect = newW / newH;
      _camera.updateProjectionMatrix();
    }
  });
  ro.observe(container);

  _running = true;
  _animate();

  return {
    destroy: () => destroy(),
    setState: (s) => setState(s),
    setAnalyser: (a) => setAnalyser(a),
  };
}

/** Bind an AnalyserNode (the same one the voice waveform uses). The orb
 *  reads frequency data once per frame and routes it into the shader's
 *  audio uniforms. */
export function setAnalyser(analyser) {
  _analyser = analyser || null;
  _freqBuffer = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
}

const STATE_PARAMS = {
  idle:      { breath: 0.5, scale: 1.00 },
  listening: { breath: 1.0, scale: 1.05 },
  thinking:  { breath: 1.6, scale: 1.02 },
  speaking:  { breath: 1.2, scale: 1.10 },
};
export function setState(s) {
  _state = STATE_PARAMS[s] ? s : "idle";
  _stateAt = performance.now();
}

function _animate() {
  if (!_running) return;
  _rafId = requestAnimationFrame(_animate);
  const now = performance.now();
  if (now - _lastFrameAt < FRAME_MS) return;
  _lastFrameAt = now;

  const u = _material.uniforms;
  u.uTime.value = now * 0.001;

  /* Audio binding. Split the frequency bins into low/mid/high thirds and
   * average each to a [0,1] value. When no analyser is bound the shader
   * still animates via breath, so the orb never freezes. */
  if (_analyser && _freqBuffer) {
    _analyser.getByteFrequencyData(_freqBuffer);
    const n = _freqBuffer.length;
    const third = Math.floor(n / 3);
    let lo = 0, mid = 0, hi = 0;
    for (let i = 0; i < third; i++) lo += _freqBuffer[i];
    for (let i = third; i < third * 2; i++) mid += _freqBuffer[i];
    for (let i = third * 2; i < n; i++) hi += _freqBuffer[i];
    /* Smooth toward target — avoids jittery flicker between frames. */
    const targetLo = (lo / third) / 255;
    const targetMid = (mid / third) / 255;
    const targetHi = (hi / (n - third * 2)) / 255;
    u.uAudioLow.value += (targetLo - u.uAudioLow.value) * 0.3;
    u.uAudioMid.value += (targetMid - u.uAudioMid.value) * 0.3;
    u.uAudioHigh.value += (targetHi - u.uAudioHigh.value) * 0.3;
  } else {
    /* No analyser — decay smoothly to zero so the orb settles into pure
     * breathing rather than holding the last audio frame. */
    u.uAudioLow.value *= 0.92;
    u.uAudioMid.value *= 0.92;
    u.uAudioHigh.value *= 0.92;
  }

  /* State easing — interpolate breath + scale toward the target on each
   * frame so a state change is visible (not snap). */
  const target = STATE_PARAMS[_state] || STATE_PARAMS.idle;
  u.uStateBreath.value += (target.breath - u.uStateBreath.value) * 0.08;
  u.uStateScale.value += (target.scale - u.uStateScale.value) * 0.08;

  /* Slow Y-axis rotation — gives the orb a sense of being a 3D object,
   * not a 2D shimmer. Independent of state so it's always present. */
  _points.rotation.y += 0.002;

  _renderer.render(_scene, _camera);
}

/** Re-read the --accent CSS variable and push it to the shader uniform.
 *  Workspace switching changes --accent; we hook this in hud.js so the
 *  orb's colour follows. */
export function refreshAccent() {
  if (!_material) return;
  const accent = _readAccentRGB();
  _material.uniforms.uAccent.value.set(accent[0], accent[1], accent[2]);
}

/** Tear down the renderer + scene. Called by the centerpiece picker
 *  when the operator switches back to reactor mode, OR on navigation
 *  away. Drops every Three.js handle so the GPU memory frees. */
export function destroy() {
  _running = false;
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = null;
  if (_renderer) {
    _renderer.dispose();
    if (_renderer.domElement?.parentNode) _renderer.domElement.parentNode.removeChild(_renderer.domElement);
  }
  if (_points) {
    _points.geometry?.dispose();
    _points.material?.dispose();
  }
  _scene = null;
  _camera = null;
  _renderer = null;
  _points = null;
  _material = null;
  _analyser = null;
  _freqBuffer = null;
  _container = null;
}
