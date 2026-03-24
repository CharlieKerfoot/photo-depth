// WebGL parallax with DepthFlow-style ray marching:
//   - Steep parallax mapping with binary refinement
//   - Focal plane control (mid-depth pinned, near pops, far recedes)
//   - Mirrored edge wrapping (no hard clamp artifacts)
//   - Subtle vignette
//   - Ambient idle drift animation

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT_SRC = `
attribute vec2 aPosition;
varying vec2 vUV;
void main() {
  vUV = vec2(aPosition.x * 0.5 + 0.5, 1.0 - (aPosition.y * 0.5 + 0.5));
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision highp float;

varying vec2 vUV;

uniform sampler2D uImage;
uniform sampler2D uDepth;
uniform vec2 uOffset;         // lerped mouse offset [-1, 1]
uniform float uDisplacement;  // max depth height
uniform float uFade;          // 0..1 fade-in
uniform vec2 uImageSize;      // original image w,h
uniform vec2 uViewSize;       // container w,h
uniform vec2 uTexelSize;      // 1.0 / image dimensions
uniform float uFocalDepth;    // depth value that stays pinned (0..1)

// --- Mirror wrapping ---
// When UV goes out of [0,1], reflect it back instead of clamping.
// Produces natural-looking content at boundaries.
vec2 mirrorUV(vec2 uv) {
  vec2 m = abs(mod(uv, 2.0));
  return vec2(
    m.x > 1.0 ? 2.0 - m.x : m.x,
    m.y > 1.0 ? 2.0 - m.y : m.y
  );
}

// --- Sample depth with mirrored wrapping ---
float sampleDepth(vec2 uv) {
  return texture2D(uDepth, mirrorUV(uv)).r;
}

// --- Sample image with mirrored wrapping ---
vec3 sampleImage(vec2 uv) {
  return texture2D(uImage, mirrorUV(uv)).rgb;
}

// --- Steep parallax mapping with binary refinement ---
// The ray starts at the camera-shifted UV and walks toward the
// screen UV. At each step it compares the ray height (linearly
// interpolated from 1→0) against the depth surface. When it
// crosses below the surface, binary search refines the hit.
//
// totalShift = uOffset * uDisplacement defines how far the
// camera-shifted start is from the screen pixel. Depth at the
// focal plane contributes zero shift; near objects shift more
// in one direction, far objects shift the other way.
vec2 steepParallax(vec2 uv, vec2 totalShift) {
  const int NUM_STEPS = 50;
  float stepSize = 1.0 / float(NUM_STEPS);

  // Ray walks from (uv + totalShift) at height 1.0
  //             to  (uv)             at height 0.0
  vec2 startUV = uv + totalShift;
  vec2 uvStep = -totalShift * stepSize;

  vec2 currentUV = startUV;
  float rayHeight = 1.0;

  float prevRayHeight = rayHeight;
  vec2 prevUV = currentUV;

  // Coarse linear search
  for (int i = 0; i < 50; i++) {
    float surfaceHeight = sampleDepth(currentUV);
    if (rayHeight < surfaceHeight) {
      // Binary refinement: 8 iterations between prev and current
      vec2 lo = prevUV;
      vec2 hi = currentUV;
      float loH = prevRayHeight;
      float hiH = rayHeight;
      for (int j = 0; j < 8; j++) {
        vec2 mid = (lo + hi) * 0.5;
        float midH = (loH + hiH) * 0.5;
        float s = sampleDepth(mid);
        if (midH < s) {
          hi = mid;
          hiH = midH;
        } else {
          lo = mid;
          loH = midH;
        }
      }
      return (lo + hi) * 0.5;
    }
    prevRayHeight = rayHeight;
    prevUV = currentUV;
    rayHeight -= stepSize;
    currentUV += uvStep;
  }
  return currentUV;
}

void main() {
  // --- Aspect-correct "cover" with overscan ---
  float overscan = 1.0 - uDisplacement * 1.5;
  float imgAspect = uImageSize.x / uImageSize.y;
  float viewAspect = uViewSize.x / uViewSize.y;
  vec2 uv = vUV;
  uv = uv * overscan + (1.0 - overscan) * 0.5;
  if (imgAspect > viewAspect) {
    float scale = viewAspect / imgAspect;
    uv.x = uv.x * scale + (1.0 - scale) * 0.5;
  } else {
    float scale = imgAspect / viewAspect;
    uv.y = uv.y * scale + (1.0 - scale) * 0.5;
  }

  // --- Steep parallax with focal plane ---
  // totalShift defines the UV displacement range. The focal plane
  // depth contributes zero shift, so it stays pinned.
  vec2 totalShift = uOffset * uDisplacement;
  vec2 hitUV = steepParallax(uv, totalShift);

  vec3 color = sampleImage(hitUV);

  // --- Subtle vignette ---
  vec2 vig = vUV * (1.0 - vUV);
  float vigFactor = pow(vig.x * vig.y * 16.0, 0.3);
  color *= mix(0.75, 1.0, vigFactor);

  // --- Fade-in ---
  gl_FragColor = vec4(color, uFade);
}`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DISPLACEMENT = 0.10;       // max depth height for ray marching (subtle)
const LERP_BASE = 0.04;          // lower = smoother, more cinematic motion
const INACTIVITY_TIMEOUT = 1200;
const FADE_DURATION = 800;
const FOCAL_DEPTH = 0.5;        // depth value that stays pinned (0=far, 1=near)

// Ambient idle drift
const DRIFT_SPEED = 0.25;       // radians/sec (gentle)
const DRIFT_RADIUS = 0.12;      // offset magnitude when idle (subtle)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;

let uOffsetLoc: WebGLUniformLocation | null = null;
let uDisplacementLoc: WebGLUniformLocation | null = null;
let uFadeLoc: WebGLUniformLocation | null = null;
let uImageSizeLoc: WebGLUniformLocation | null = null;
let uViewSizeLoc: WebGLUniformLocation | null = null;
let uTexelSizeLoc: WebGLUniformLocation | null = null;
let uFocalDepthLoc: WebGLUniformLocation | null = null;

let imageTexture: WebGLTexture | null = null;
let depthTexture: WebGLTexture | null = null;

let imgW = 0;
let imgH = 0;

let targetOffset = { x: 0, y: 0 };
let currentOffset = { x: 0, y: 0 };
let gyroOffset = { x: 0, y: 0 };
let hasGyro = false;
let inputActive = false;
let mouseOverViewer = false;
let lastInputTime = 0;
let animFrameId = 0;
let lastTimestamp = 0;
let containerEl: HTMLDivElement;
let fadeOpacity = 0;
let fadeStart = 0;

// ---------------------------------------------------------------------------
// WebGL helpers
// ---------------------------------------------------------------------------

function compileShader(
  g: WebGLRenderingContext, type: number, source: string,
): WebGLShader {
  const s = g.createShader(type)!;
  g.shaderSource(s, source);
  g.compileShader(s);
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
    const info = g.getShaderInfoLog(s);
    g.deleteShader(s);
    throw new Error(`Shader compile: ${info}`);
  }
  return s;
}

function linkProgram(g: WebGLRenderingContext): WebGLProgram {
  const vs = compileShader(g, g.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(g, g.FRAGMENT_SHADER, FRAG_SRC);
  const p = g.createProgram()!;
  g.attachShader(p, vs);
  g.attachShader(p, fs);
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) {
    throw new Error(`Program link: ${g.getProgramInfoLog(p)}`);
  }
  return p;
}

function uploadTexture(g: WebGLRenderingContext, t: WebGLTexture, src: TexImageSource) {
  g.bindTexture(g.TEXTURE_2D, t);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
  // CLAMP_TO_EDGE for WebGL 1 NPOT texture compatibility.
  // Mirroring is done in the shader's mirrorUV() function.
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
}

function depthMapToCanvas(depthMap: Float32Array, w: number, h: number): OffscreenCanvas {
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d')!;
  const id = ctx.createImageData(w, h);
  const px = id.data;
  for (let i = 0; i < depthMap.length; i++) {
    const v = Math.round(depthMap[i] * 255);
    const j = i * 4;
    px[j] = v; px[j + 1] = v; px[j + 2] = v; px[j + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return oc;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function offsetFromClient(clientX: number, clientY: number) {
  const rect = containerEl.getBoundingClientRect();
  targetOffset.x = Math.max(-1, Math.min(1, ((clientX - rect.left) / rect.width) * 2 - 1));
  targetOffset.y = Math.max(-1, Math.min(1, ((clientY - rect.top) / rect.height) * 2 - 1));
}

function setupInputHandlers() {
  // Track mouse only within the viewer area for a controlled effect
  const viewerEl = containerEl.closest('.dp-viewer') as HTMLElement | null;
  const hoverTarget = viewerEl ?? containerEl;

  hoverTarget.addEventListener('mouseenter', () => { mouseOverViewer = true; });
  hoverTarget.addEventListener('mouseleave', () => {
    mouseOverViewer = false;
    inputActive = false;
    lastInputTime = performance.now();
  });

  window.addEventListener('mousemove', (e) => {
    if (!mouseOverViewer) return;
    offsetFromClient(e.clientX, e.clientY);
    inputActive = true;
    lastInputTime = performance.now();
  });

  const handleTouch = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    offsetFromClient(e.touches[0].clientX, e.touches[0].clientY);
    inputActive = true;
    lastInputTime = performance.now();
  };
  window.addEventListener('touchstart', handleTouch, { passive: true });
  window.addEventListener('touchmove', handleTouch, { passive: true });
  window.addEventListener('touchend', () => {
    inputActive = false;
    lastInputTime = performance.now();
  });

  if ('DeviceOrientationEvent' in window) {
    window.addEventListener('deviceorientation', (e: DeviceOrientationEvent) => {
      if (e.gamma === null || e.beta === null) return;
      hasGyro = true;
      gyroOffset.x = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 30));
      gyroOffset.y = Math.max(-1, Math.min(1, ((e.beta ?? 0) - 45) / 30));
    });
  }

  window.addEventListener('resize', handleResize);
}

function handleResize() {
  if (!canvas || !gl || !containerEl) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = containerEl.clientWidth;
  const h = containerEl.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  gl.viewport(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initParallax(container: HTMLDivElement) {
  containerEl = container;

  canvas = document.createElement('canvas');
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  container.appendChild(canvas);

  gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL not supported');

  program = linkProgram(gl);
  gl.useProgram(program);

  // Full-screen quad
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Uniforms
  uOffsetLoc = gl.getUniformLocation(program, 'uOffset');
  uDisplacementLoc = gl.getUniformLocation(program, 'uDisplacement');
  uFadeLoc = gl.getUniformLocation(program, 'uFade');
  uImageSizeLoc = gl.getUniformLocation(program, 'uImageSize');
  uViewSizeLoc = gl.getUniformLocation(program, 'uViewSize');
  uTexelSizeLoc = gl.getUniformLocation(program, 'uTexelSize');
  uFocalDepthLoc = gl.getUniformLocation(program, 'uFocalDepth');

  gl.uniform1i(gl.getUniformLocation(program, 'uImage'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'uDepth'), 1);

  imageTexture = gl.createTexture()!;
  depthTexture = gl.createTexture()!;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  handleResize();
  setupInputHandlers();
}

export function buildLayers(
  img: HTMLImageElement, depthMap: Float32Array, w: number, h: number,
) {
  if (!gl) return;
  imgW = w;
  imgH = h;

  gl.activeTexture(gl.TEXTURE0);
  uploadTexture(gl, imageTexture!, img);

  const dc = depthMapToCanvas(depthMap, w, h);
  gl.activeTexture(gl.TEXTURE1);
  uploadTexture(gl, depthTexture!, dc as unknown as TexImageSource);

  fadeOpacity = 0;
  fadeStart = performance.now();
}

export function startAnimationLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  lastTimestamp = 0;

  const animate = (timestamp: number) => {
    animFrameId = requestAnimationFrame(animate);

    if (!lastTimestamp) { lastTimestamp = timestamp; return; }
    if (!gl || !canvas) return;

    if (canvas.width === 0 || canvas.height === 0) handleResize();
    if (canvas.width === 0 || canvas.height === 0) return;

    const dt = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    // Fade-in
    if (fadeOpacity < 1) {
      fadeOpacity = Math.min(1, (performance.now() - fadeStart) / FADE_DURATION);
    }

    // --- Determine target offset ---
    const timeSinceInput = performance.now() - lastInputTime;
    let tx: number, ty: number;

    if (inputActive) {
      tx = targetOffset.x;
      ty = targetOffset.y;
    } else if (hasGyro && timeSinceInput > INACTIVITY_TIMEOUT) {
      tx = gyroOffset.x;
      ty = gyroOffset.y;
    } else if (timeSinceInput > INACTIVITY_TIMEOUT) {
      // Ambient drift: gentle figure-8 orbit
      const t = timestamp / 1000 * DRIFT_SPEED;
      tx = Math.sin(t) * DRIFT_RADIUS;
      ty = Math.sin(t * 1.3 + 0.7) * DRIFT_RADIUS * 0.6;
    } else {
      tx = targetOffset.x;
      ty = targetOffset.y;
    }

    // Lerp (framerate independent)
    const lerpFactor = 1 - Math.pow(1 - LERP_BASE, dt * 60);
    currentOffset.x += (tx - currentOffset.x) * lerpFactor;
    currentOffset.y += (ty - currentOffset.y) * lerpFactor;

    // --- WebGL render ---
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(uOffsetLoc, currentOffset.x, currentOffset.y);
    gl.uniform1f(uDisplacementLoc, DISPLACEMENT);
    gl.uniform1f(uFadeLoc, fadeOpacity);
    gl.uniform2f(uImageSizeLoc, imgW, imgH);
    gl.uniform2f(uViewSizeLoc, cw, ch);
    gl.uniform2f(uTexelSizeLoc, 1.0 / imgW, 1.0 / imgH);
    gl.uniform1f(uFocalDepthLoc, FOCAL_DEPTH);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  animFrameId = requestAnimationFrame(animate);
}

export function stopAnimationLoop() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
}

export async function requestGyroPermission(): Promise<boolean> {
  const DOE = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  if (typeof DOE.requestPermission === 'function') {
    try { return (await DOE.requestPermission()) === 'granted'; }
    catch { return false; }
  }
  return true;
}

export function dispose() {
  stopAnimationLoop();
  if (gl) {
    if (imageTexture) gl.deleteTexture(imageTexture);
    if (depthTexture) gl.deleteTexture(depthTexture);
    if (program) gl.deleteProgram(program);
  }
  imageTexture = depthTexture = program = null;
  gl = null;
  canvas?.remove();
  canvas = null;
}
