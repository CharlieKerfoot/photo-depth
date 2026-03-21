import * as THREE from 'three';

const NUM_LAYERS = 5;
const LAYER_THRESHOLDS = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const PARALLAX_PX = 12;
const LERP_BASE = 0.06;
const INACTIVITY_TIMEOUT = 1000;

let renderer: THREE.WebGLRenderer | null = null;
let camera: THREE.OrthographicCamera;
let scene: THREE.Scene;
let layers: THREE.Mesh[] = [];
let targetOffset = { x: 0, y: 0 };
let currentOffset = { x: 0, y: 0 };
let gyroOffset = { x: 0, y: 0 };
let hasGyro = false;
let inputActive = false;
let lastInputTime = 0;
let animFrameId = 0;
let lastTimestamp = 0;
let containerEl: HTMLDivElement;

const isMobile = () => window.innerWidth < 768;

function getMaxTextureSize(): number {
  return isMobile() ? 1024 : 2048;
}

function clampImageSize(
  w: number, h: number, maxSize: number,
): { w: number; h: number } {
  const longer = Math.max(w, h);
  if (longer <= maxSize) return { w, h };
  const scale = maxSize / longer;
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function createLayerCanvas(
  img: HTMLImageElement,
  depthMap: Float32Array,
  layerIndex: number,
  texW: number,
  texH: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(texW, texH);
  const ctx = canvas.getContext('2d')!;

  // Draw the original image scaled to texture size
  ctx.drawImage(img, 0, 0, texW, texH);
  const imageData = ctx.getImageData(0, 0, texW, texH);
  const pixels = imageData.data;

  const lo = LAYER_THRESHOLDS[layerIndex];
  const hi = LAYER_THRESHOLDS[layerIndex + 1];
  const featherPx = 10 * (Math.max(texW, texH) / 518);
  const featherDepth = featherPx / Math.max(texW, texH) * (hi - lo);

  // Scale factors for mapping depthMap coords to texture coords
  const srcW = Math.round(Math.sqrt(depthMap.length * (texW / texH)));
  const srcH = Math.round(depthMap.length / srcW);
  const xRatio = srcW / texW;
  const yRatio = srcH / texH;

  for (let y = 0; y < texH; y++) {
    for (let x = 0; x < texW; x++) {
      // Sample depth with nearest neighbor (depth map may be different size)
      const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
      const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
      const depth = depthMap[sy * srcW + sx];

      let alpha = 0;
      if (depth >= lo && depth < hi) {
        alpha = 1;
        // Feather at lower boundary (fade in)
        if (depth - lo < featherDepth && layerIndex > 0) {
          alpha = (depth - lo) / featherDepth;
        }
        // Feather at upper boundary (fade out)
        if (hi - depth < featherDepth && layerIndex < NUM_LAYERS - 1) {
          alpha = (hi - depth) / featherDepth;
        }
      }

      const idx = (y * texW + x) * 4;
      pixels[idx + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function initParallax(container: HTMLDivElement) {
  containerEl = container;
  const w = container.clientWidth;
  const h = container.clientHeight;

  scene = new THREE.Scene();

  const aspect = w / h;
  camera = new THREE.OrthographicCamera(
    -aspect / 2, aspect / 2, 0.5, -0.5, 0.1, 10,
  );
  camera.position.z = 5;

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  setupInputHandlers();
}

function setupInputHandlers() {
  // Mouse
  window.addEventListener('mousemove', (e) => {
    targetOffset.x = (e.clientX / window.innerWidth) * 2 - 1;
    targetOffset.y = -((e.clientY / window.innerHeight) * 2 - 1);
    inputActive = true;
    lastInputTime = performance.now();
  });

  // Touch
  const handleTouch = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    const touch = e.touches[0];
    targetOffset.x = (touch.clientX / window.innerWidth) * 2 - 1;
    targetOffset.y = -((touch.clientY / window.innerHeight) * 2 - 1);
    inputActive = true;
    lastInputTime = performance.now();
  };
  window.addEventListener('touchstart', handleTouch, { passive: true });
  window.addEventListener('touchmove', handleTouch, { passive: true });
  window.addEventListener('touchend', () => {
    inputActive = false;
    lastInputTime = performance.now();
  });

  // Gyroscope
  const handleOrientation = (e: DeviceOrientationEvent) => {
    if (e.gamma === null || e.beta === null) return;
    hasGyro = true;
    gyroOffset.x = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 30));
    gyroOffset.y = Math.max(-1, Math.min(1, ((e.beta ?? 0) - 45) / 30));
  };

  if ('DeviceOrientationEvent' in window) {
    window.addEventListener('deviceorientation', handleOrientation);
  }

  // Resize
  window.addEventListener('resize', () => {
    if (!renderer) return;
    const w = containerEl.clientWidth;
    const h = containerEl.clientHeight;
    renderer.setSize(w, h);
    const aspect = w / h;
    camera.left = -aspect / 2;
    camera.right = aspect / 2;
    camera.updateProjectionMatrix();
  });
}

export async function requestGyroPermission(): Promise<boolean> {
  const DOE = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  if (typeof DOE.requestPermission === 'function') {
    try {
      const result = await DOE.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

export function buildLayers(
  img: HTMLImageElement,
  depthMap: Float32Array,
  imgW: number,
  imgH: number,
) {
  // Clear existing layers
  for (const layer of layers) {
    scene.remove(layer);
    layer.geometry.dispose();
    (layer.material as THREE.MeshBasicMaterial).map?.dispose();
    (layer.material as THREE.MeshBasicMaterial).dispose();
  }
  layers = [];

  const maxTex = getMaxTextureSize();
  const { w: texW, h: texH } = clampImageSize(imgW, imgH, maxTex);
  const aspect = texW / texH;

  for (let i = 0; i < NUM_LAYERS; i++) {
    const canvas = createLayerCanvas(img, depthMap, i, texW, texH);

    const texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const scale = 1.0 + i * 0.05;
    const geo = new THREE.PlaneGeometry(aspect * scale, 1 * scale);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = i * 0.1;
    mesh.renderOrder = i;

    // Start with opacity 0 for fade-in
    mat.opacity = 0;

    scene.add(mesh);
    layers.push(mesh);
  }

  // Fade in
  const fadeStart = performance.now();
  const fadeDuration = 400;
  const fadeIn = () => {
    const t = Math.min(1, (performance.now() - fadeStart) / fadeDuration);
    for (const layer of layers) {
      (layer.material as THREE.MeshBasicMaterial).opacity = t;
    }
    if (t < 1) requestAnimationFrame(fadeIn);
  };
  requestAnimationFrame(fadeIn);
}

export function startAnimationLoop() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  lastTimestamp = 0;

  const animate = (timestamp: number) => {
    animFrameId = requestAnimationFrame(animate);

    if (!lastTimestamp) {
      lastTimestamp = timestamp;
      return;
    }

    const dt = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    // Normalize lerp factor to 60Hz
    const lerpFactor = 1 - Math.pow(1 - LERP_BASE, dt * 60);

    // Determine target based on input state
    let tx: number, ty: number;
    const timeSinceInput = performance.now() - lastInputTime;

    if (inputActive) {
      tx = targetOffset.x;
      ty = targetOffset.y;
    } else if (hasGyro && timeSinceInput > INACTIVITY_TIMEOUT) {
      tx = gyroOffset.x;
      ty = gyroOffset.y;
    } else if (timeSinceInput > INACTIVITY_TIMEOUT) {
      tx = 0;
      ty = 0;
    } else {
      tx = targetOffset.x;
      ty = targetOffset.y;
    }

    currentOffset.x += (tx - currentOffset.x) * lerpFactor;
    currentOffset.y += (ty - currentOffset.y) * lerpFactor;

    // Update layer positions
    const containerW = containerEl.clientWidth;
    const containerH = containerEl.clientHeight;

    for (let i = 0; i < layers.length; i++) {
      const offsetPx = i * PARALLAX_PX;
      layers[i].position.x = (currentOffset.x * offsetPx) / containerW;
      layers[i].position.y = (currentOffset.y * offsetPx) / containerH;
    }

    renderer?.render(scene, camera);
  };

  animFrameId = requestAnimationFrame(animate);
}

export function stopAnimationLoop() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = 0;
  }
}

export function dispose() {
  stopAnimationLoop();
  for (const layer of layers) {
    scene.remove(layer);
    layer.geometry.dispose();
    (layer.material as THREE.MeshBasicMaterial).map?.dispose();
    (layer.material as THREE.MeshBasicMaterial).dispose();
  }
  layers = [];
  renderer?.dispose();
  renderer?.domElement.remove();
  renderer = null;
}
