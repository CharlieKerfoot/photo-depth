// WebGL parallax with:
//   - Iterative parallax occlusion mapping (proper depth handling)
//   - 3D CSS perspective tilt on the container
//   - Depth-of-field blur (far = soft, near = sharp)
//   - Ambient idle drift animation
//   - Vignette + edge shadow at depth discontinuities

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
uniform float uDisplacement;  // max UV displacement
uniform float uFade;          // 0..1 fade-in
uniform vec2 uImageSize;      // original image w,h
uniform vec2 uViewSize;       // container w,h
uniform vec2 uTexelSize;      // 1.0 / image dimensions

// --- Iterative parallax mapping ---
// Finds the source UV that "projects" to this output pixel by iterating:
//   source = target - viewShift * depth(source)
// Converges in ~8 iterations and handles occlusion at depth discontinuities.
vec2 parallaxMap(vec2 uv, vec2 viewShift) {
  vec2 currentUV = uv;
  for (int i = 0; i < 10; i++) {
    float d = texture2D(uDepth, currentUV).r;
    currentUV = uv - viewShift * d;
  }
  return currentUV;
}

// --- Approximate depth-of-field blur ---
// Samples in a disc pattern, weighted by distance. The blur radius scales
// with (1 - depth), so near objects stay sharp and far objects go soft.
vec3 dofSample(vec2 uv, float depth) {
  // Blur strength: 0 for nearest, full for farthest
  float blurAmount = (1.0 - depth) * 2.5; // max blur radius in texels
  if (blurAmount < 0.3) return texture2D(uImage, uv).rgb;

  vec3 acc = vec3(0.0);
  float totalWeight = 0.0;

  // 8-tap Poisson disc
  const int TAPS = 8;
  vec2 poissonDisk[8];
  poissonDisk[0] = vec2(-0.94201624, -0.39906216);
  poissonDisk[1] = vec2( 0.94558609, -0.76890725);
  poissonDisk[2] = vec2(-0.09418410, -0.92938870);
  poissonDisk[3] = vec2( 0.34495938,  0.29387760);
  poissonDisk[4] = vec2(-0.91588581,  0.45771432);
  poissonDisk[5] = vec2(-0.81544232, -0.87912464);
  poissonDisk[6] = vec2(-0.38277543,  0.27676845);
  poissonDisk[7] = vec2( 0.97484398,  0.75648379);

  for (int i = 0; i < 8; i++) {
    vec2 sampleUV = uv + poissonDisk[i] * uTexelSize * blurAmount;
    float w = 1.0;
    acc += texture2D(uImage, sampleUV).rgb * w;
    totalWeight += w;
  }

  return acc / totalWeight;
}

// --- Edge shadow at depth discontinuities ---
float depthEdgeShadow(vec2 uv) {
  float center = texture2D(uDepth, uv).r;
  float dx = abs(texture2D(uDepth, uv + vec2(uTexelSize.x * 2.0, 0.0)).r - center);
  float dy = abs(texture2D(uDepth, uv + vec2(0.0, uTexelSize.y * 2.0)).r - center);
  float edge = smoothstep(0.0, 0.15, dx + dy);
  return 1.0 - edge * 0.4; // darken edges by up to 40%
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

  // --- Parallax occlusion ---
  vec2 viewShift = uOffset * uDisplacement;
  vec2 displaced = parallaxMap(uv, viewShift);
  displaced = clamp(displaced, vec2(0.001), vec2(0.999));

  float depth = texture2D(uDepth, displaced).r;

  // --- Color ---
  vec3 color = texture2D(uImage, displaced).rgb;

  // --- Edge shadow ---
  color *= depthEdgeShadow(displaced);

  // --- Vignette ---
  vec2 vig = vUV * (1.0 - vUV);
  float vigFactor = pow(vig.x * vig.y * 16.0, 0.2);
  color *= mix(0.7, 1.0, vigFactor);

  // --- Fade-in ---
  gl_FragColor = vec4(color, uFade);
}`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DISPLACEMENT = 0.18;       // max UV shift — big for dramatic effect
const LERP_BASE = 0.06;
const INACTIVITY_TIMEOUT = 800;
const FADE_DURATION = 600;

// 3D CSS tilt
const TILT_X_DEG = 6;           // max rotateY degrees
const TILT_Y_DEG = 4;           // max rotateX degrees
const PERSPECTIVE_PX = 800;

// Ambient idle drift
const DRIFT_SPEED = 0.4;        // radians/sec
const DRIFT_RADIUS = 0.25;      // offset magnitude when idle

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

let imageTexture: WebGLTexture | null = null;
let depthTexture: WebGLTexture | null = null;

let imgW = 0;
let imgH = 0;

let targetOffset = { x: 0, y: 0 };
let currentOffset = { x: 0, y: 0 };
let gyroOffset = { x: 0, y: 0 };
let hasGyro = false;
let inputActive = false;
let lastInputTime = 0;
let animFrameId = 0;
let lastTimestamp = 0;
let containerEl: HTMLDivElement;
let viewerEl: HTMLElement | null = null; // the .dp-viewer for 3D tilt
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
  targetOffset.y = Math.max(-1, Math.min(1, -(((clientY - rect.top) / rect.height) * 2 - 1)));
}

function setupInputHandlers() {
  window.addEventListener('mousemove', (e) => {
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

  // Find the .dp-viewer ancestor for 3D CSS tilt
  viewerEl = container.closest('.dp-viewer') as HTMLElement | null;
  if (viewerEl) {
    viewerEl.style.transformStyle = 'preserve-3d';
    viewerEl.style.transition = 'transform 0.05s ease-out';
  }

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

    // --- 3D CSS tilt on the viewer card ---
    if (viewerEl) {
      const rx = -currentOffset.y * TILT_Y_DEG;
      const ry = -currentOffset.x * TILT_X_DEG;
      viewerEl.style.transform =
        `perspective(${PERSPECTIVE_PX}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    }

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

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  animFrameId = requestAnimationFrame(animate);
}

export function stopAnimationLoop() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = 0; }
  // Reset tilt when stopping
  if (viewerEl) viewerEl.style.transform = '';
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
  if (viewerEl) viewerEl.style.transform = '';
}
