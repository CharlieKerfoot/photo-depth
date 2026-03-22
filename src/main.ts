import { initSession, estimateDepth } from './depth.ts';
import {
  initParallax, buildLayers, startAnimationLoop,
  requestGyroPermission,
} from './parallax.ts';
import {
  initUI, setState, setProgress, setError,
  setInferenceTime, getCanvasContainer, showTiltButton,
  hideTiltButton, setOriginalImage,
} from './ui.ts';

let generation = 0;
let parallaxInitialized = false;

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

async function processImage(source: File | string) {
  const gen = ++generation;

  setState('loading');
  setProgress('Preparing...');

  try {
    // Ensure model is ready
    await initSession((loaded, total) => {
      const mb = (loaded / 1024 / 1024).toFixed(1);
      const totalMb = (total / 1024 / 1024).toFixed(1);
      setProgress(`Downloading model... ${mb}/${totalMb} MB`);
    });

    if (gen !== generation) return;

    // Load image
    setProgress('Loading image...');
    let img: HTMLImageElement;
    let previewSrc: string;
    if (source instanceof File) {
      const url = URL.createObjectURL(source);
      previewSrc = url;
      try {
        img = await loadImageElement(url);
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
    } else {
      img = await loadImageElement(source);
      previewSrc = source;
    }

    if (gen !== generation) return;

    // Set original preview for before/after comparison
    setOriginalImage(previewSrc);

    const width = img.naturalWidth;
    const height = img.naturalHeight;

    // Run depth estimation
    setProgress('Estimating depth...');
    const { depthMap, inferenceMs } = await estimateDepth(img, width, height);
    console.log(`Inference completed in ${inferenceMs.toFixed(0)}ms`);

    if (gen !== generation) return;

    // Initialize parallax renderer if needed
    if (!parallaxInitialized) {
      initParallax(getCanvasContainer());
      parallaxInitialized = true;
    }

    // Build layers and display
    setProgress('Building parallax layers...');
    buildLayers(img, depthMap, width, height);
    startAnimationLoop();

    setState('displaying');
    setInferenceTime(inferenceMs);

    // Show tilt button on mobile if gyro might be available
    if ('DeviceOrientationEvent' in window && window.innerWidth < 768) {
      showTiltButton();
    }
  } catch (err) {
    if (gen !== generation) return;
    console.error('Processing failed:', err);
    setError(err instanceof Error ? err.message : 'Something went wrong');
  }
}

function init() {
  const appEl = document.getElementById('app') as HTMLDivElement;

  initUI(appEl, {
    onDrop: (file) => processImage(file),
    onSample: (src) => processImage(src),
    onTiltRequest: async () => {
      const granted = await requestGyroPermission();
      if (!granted) hideTiltButton();
      else hideTiltButton();
    },
  });

  // Eagerly start loading the model
  initSession((loaded, total) => {
    const mb = (loaded / 1024 / 1024).toFixed(1);
    const totalMb = (total / 1024 / 1024).toFixed(1);
    console.log(`Model download: ${mb}/${totalMb} MB`);
  }).catch((err) => {
    console.warn('Eager model load failed, will retry on first use:', err);
  });
}

init();
