export type AppState = 'idle' | 'loading' | 'displaying' | 'error';

const SAMPLE_SRC = '/sample2.jpg';

let currentState: AppState = 'idle';
let container: HTMLDivElement;

let viewerSection: HTMLDivElement;
let canvasContainer: HTMLDivElement;
let originalPreview: HTMLImageElement;
let overlayBar: HTMLDivElement;
let loadingOverlay: HTMLDivElement;
let progressEl: HTMLSpanElement;
let errorOverlay: HTMLDivElement;
let pickerRow: HTMLDivElement;
let fileInput: HTMLInputElement;

let showingOriginal = false;

let onFileSelect: ((file: File) => void) | null = null;
let onSampleSelect: ((src: string) => void) | null = null;
let onTiltRequest: (() => void) | null = null;

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }

    .dp-header {
      text-align: center;
      padding: 32px 24px 0;
    }
    .dp-header h1 {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #f0f0f0;
    }
    .dp-header p {
      margin-top: 6px;
      font-size: 14px;
      color: #888;
    }

    .dp-viewer {
      position: relative;
      width: 100%;
      max-width: 900px;
      margin: 28px auto 0;
      aspect-ratio: 16 / 10;
      background: #161616;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #222;
    }
    @media (max-width: 960px) {
      .dp-viewer { margin-left: 24px; margin-right: 24px; width: auto; }
    }

    .dp-viewer canvas {
      position: absolute; inset: 0;
      width: 100% !important; height: 100% !important;
      border-radius: 12px;
    }

    .dp-original-preview {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
      border-radius: 12px;
      z-index: 5;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }
    .dp-original-preview.visible { opacity: 1; }

    .dp-overlay-bar {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      display: none;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: linear-gradient(transparent, rgba(0,0,0,0.7));
      border-radius: 0 0 12px 12px;
      z-index: 10;
      pointer-events: none;
    }
    .dp-overlay-bar > * { pointer-events: auto; }
    .dp-overlay-bar .dp-info {
      font-size: 12px; color: rgba(255,255,255,0.5);
    }
    .dp-overlay-bar .dp-actions {
      display: flex; gap: 8px; align-items: center;
    }

    .dp-btn {
      padding: 6px 14px;
      background: rgba(255,255,255,0.12);
      color: #e0e0e0;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      backdrop-filter: blur(8px);
      transition: background 0.15s;
    }
    .dp-btn:hover { background: rgba(255,255,255,0.2); }

    .dp-loading-overlay {
      position: absolute; inset: 0;
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 12px;
      background: rgba(10,10,10,0.85);
      border-radius: 12px;
      z-index: 20;
    }
    .dp-spinner {
      width: 28px; height: 28px;
      border: 2.5px solid #333;
      border-top-color: #ccc;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    .dp-loading-text { font-size: 14px; color: #999; }

    .dp-error-overlay {
      position: absolute; inset: 0;
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 14px;
      background: rgba(10,10,10,0.9);
      border-radius: 12px;
      z-index: 20;
    }
    .dp-error-msg { font-size: 14px; color: #ff6b6b; }

    .dp-picker-row {
      max-width: 900px;
      margin: 24px auto 40px;
      padding: 0 24px;
      display: flex;
      gap: 12px;
    }
    @media (max-width: 960px) {
      .dp-picker-row { padding: 0 24px; }
    }

    .dp-thumb-card {
      flex: 1;
      cursor: pointer;
      border-radius: 8px;
      overflow: hidden;
      border: 2px solid transparent;
      transition: border-color 0.15s, transform 0.15s;
      background: #1a1a1a;
    }
    .dp-thumb-card:hover {
      border-color: rgba(255,255,255,0.2);
      transform: translateY(-2px);
    }
    .dp-thumb-card.active {
      border-color: rgba(255,255,255,0.5);
    }
    .dp-thumb-card img {
      width: 100%; height: 100px;
      object-fit: cover; display: block;
    }
    .dp-thumb-card .dp-thumb-label {
      padding: 6px 8px;
      font-size: 11px;
      color: #888;
      text-align: center;
    }

    .dp-upload-card {
      flex: 1;
      cursor: pointer;
      border-radius: 8px;
      border: 2px dashed #333;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: border-color 0.15s, transform 0.15s;
      color: #666;
      min-height: 132px;
    }
    .dp-upload-card:hover {
      border-color: #555;
      transform: translateY(-2px);
      color: #999;
    }
    .dp-upload-card .dp-upload-icon { font-size: 22px; }
    .dp-upload-card .dp-upload-text { font-size: 11px; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initUI(
  appEl: HTMLDivElement,
  handlers: {
    onDrop: (file: File) => void;
    onSample: (src: string) => void;
    onTiltRequest: () => void;
  },
) {
  container = appEl;
  onFileSelect = handlers.onDrop;
  onSampleSelect = handlers.onSample;
  onTiltRequest = handlers.onTiltRequest;

  injectStyles();

  const header = document.createElement('header');
  header.className = 'dp-header';
  header.innerHTML = `
    <h1>2.5D</h1>
  `;

  viewerSection = document.createElement('div');
  viewerSection.className = 'dp-viewer';

  const dropPrompt = document.createElement('div');
  dropPrompt.className = 'dp-drop-prompt';
  dropPrompt.id = 'drop-prompt';
  dropPrompt.style.cssText = `
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 8px; cursor: pointer;
    transition: background 0.15s;
    border-radius: 12px;
  `;
  dropPrompt.innerHTML = `
    <div style="font-size: 36px; opacity: 0.3;">+</div>
    <div style="font-size: 15px; opacity: 0.5;">Drop a photo or pick one below</div>
  `;

  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) onFileSelect?.(fileInput.files[0]);
    fileInput.value = '';
  });
  dropPrompt.appendChild(fileInput);
  dropPrompt.addEventListener('click', () => fileInput.click());
  dropPrompt.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropPrompt.style.background = 'rgba(255,255,255,0.06)';
  });
  dropPrompt.addEventListener('dragleave', () => {
    dropPrompt.style.background = '';
  });
  dropPrompt.addEventListener('drop', (e) => {
    e.preventDefault();
    dropPrompt.style.background = '';
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) onFileSelect?.(file);
  });

  // Canvas container
  canvasContainer = document.createElement('div');
  canvasContainer.id = 'canvas-container';
  canvasContainer.style.cssText = 'position:absolute;inset:0;display:none;border-radius:12px;overflow:hidden;';
  canvasContainer.addEventListener('dragover', (e) => e.preventDefault());
  canvasContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) onFileSelect?.(file);
  });

  // Original image preview (before/after)
  originalPreview = document.createElement('img');
  originalPreview.className = 'dp-original-preview';

  // Overlay bar
  overlayBar = document.createElement('div');
  overlayBar.className = 'dp-overlay-bar';
  overlayBar.innerHTML = `
    <span class="dp-info" id="dp-inference-time"></span>
    <div class="dp-actions">
      <button class="dp-btn" id="dp-before-after">Hold for Original</button>
      <button class="dp-btn" id="dp-change-btn">Change Image</button>
      <button class="dp-btn" id="dp-tilt-btn" style="display:none">Enable Tilt</button>
    </div>
  `;

  // Loading overlay
  loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'dp-loading-overlay';
  loadingOverlay.innerHTML = `
    <div class="dp-spinner"></div>
    <span class="dp-loading-text">Loading...</span>
  `;
  progressEl = loadingOverlay.querySelector('.dp-loading-text') as HTMLSpanElement;

  // Error overlay
  errorOverlay = document.createElement('div');
  errorOverlay.className = 'dp-error-overlay';
  errorOverlay.innerHTML = `
    <div class="dp-error-msg" id="dp-error-msg">Something went wrong</div>
    <button class="dp-btn" id="dp-error-retry">Try Again</button>
  `;

  viewerSection.appendChild(dropPrompt);
  viewerSection.appendChild(canvasContainer);
  viewerSection.appendChild(originalPreview);
  viewerSection.appendChild(overlayBar);
  viewerSection.appendChild(loadingOverlay);
  viewerSection.appendChild(errorOverlay);

  // --- Picker row: one sample + upload button ---
  pickerRow = document.createElement('div');
  pickerRow.className = 'dp-picker-row';

  const sampleCard = document.createElement('div');
  sampleCard.className = 'dp-thumb-card';
  sampleCard.dataset.src = SAMPLE_SRC;
  sampleCard.innerHTML = `
    <img src="${SAMPLE_SRC}" alt="Sample" loading="lazy" />
    <div class="dp-thumb-label">Try Sample</div>
  `;
  sampleCard.addEventListener('click', () => {
    onSampleSelect?.(SAMPLE_SRC);
  });

  const uploadCard = document.createElement('div');
  uploadCard.className = 'dp-upload-card';
  uploadCard.innerHTML = `
    <div class="dp-upload-icon">+</div>
    <div class="dp-upload-text">Your Own Photo</div>
  `;
  uploadCard.addEventListener('click', () => fileInput.click());

  pickerRow.appendChild(sampleCard);
  pickerRow.appendChild(uploadCard);

  // --- Assemble ---
  container.appendChild(header);
  container.appendChild(viewerSection);
  container.appendChild(pickerRow);

  // --- Wire up overlay bar buttons ---
  const beforeAfterBtn = overlayBar.querySelector('#dp-before-after') as HTMLButtonElement;
  beforeAfterBtn.addEventListener('mousedown', () => {
    showingOriginal = true;
    originalPreview.classList.add('visible');
    beforeAfterBtn.textContent = 'Showing Original';
  });
  beforeAfterBtn.addEventListener('mouseup', () => {
    showingOriginal = false;
    originalPreview.classList.remove('visible');
    beforeAfterBtn.textContent = 'Hold for Original';
  });
  beforeAfterBtn.addEventListener('mouseleave', () => {
    if (showingOriginal) {
      showingOriginal = false;
      originalPreview.classList.remove('visible');
      beforeAfterBtn.textContent = 'Hold for Original';
    }
  });
  beforeAfterBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    showingOriginal = true;
    originalPreview.classList.add('visible');
    beforeAfterBtn.textContent = 'Showing Original';
  }, { passive: false });
  beforeAfterBtn.addEventListener('touchend', () => {
    showingOriginal = false;
    originalPreview.classList.remove('visible');
    beforeAfterBtn.textContent = 'Hold for Original';
  });

  const changeBtn = overlayBar.querySelector('#dp-change-btn') as HTMLButtonElement;
  changeBtn.addEventListener('click', () => fileInput.click());

  const tiltBtn = overlayBar.querySelector('#dp-tilt-btn') as HTMLButtonElement;
  tiltBtn.addEventListener('click', () => onTiltRequest?.());

  const retryBtn = errorOverlay.querySelector('#dp-error-retry') as HTMLButtonElement;
  retryBtn.addEventListener('click', () => setState('idle'));
}

export function setState(state: AppState) {
  currentState = state;

  const dropPrompt = viewerSection.querySelector('#drop-prompt') as HTMLElement;
  dropPrompt.style.display = state === 'idle' ? 'flex' : 'none';
  canvasContainer.style.display = (state === 'displaying' || state === 'loading') ? 'block' : 'none';
  loadingOverlay.style.display = state === 'loading' ? 'flex' : 'none';
  errorOverlay.style.display = state === 'error' ? 'flex' : 'none';
  overlayBar.style.display = state === 'displaying' ? 'flex' : 'none';

  if (state === 'idle') {
    originalPreview.classList.remove('visible');
  }
}

export function setProgress(text: string) {
  progressEl.textContent = text;
}

export function setError(msg: string) {
  const el = errorOverlay.querySelector('#dp-error-msg');
  if (el) el.textContent = msg;
  setState('error');
}

export function setInferenceTime(ms: number) {
  const el = overlayBar.querySelector('#dp-inference-time');
  if (el) el.textContent = `Depth estimated in ${Math.round(ms)}ms`;
}

export function getCanvasContainer(): HTMLDivElement {
  return canvasContainer;
}

export function showTiltButton() {
  if (currentState === 'displaying') {
    const btn = overlayBar.querySelector('#dp-tilt-btn') as HTMLElement;
    btn.style.display = 'block';
  }
}

export function hideTiltButton() {
  const btn = overlayBar.querySelector('#dp-tilt-btn') as HTMLElement;
  btn.style.display = 'none';
}

export function getState(): AppState {
  return currentState;
}

export function setOriginalImage(src: string) {
  originalPreview.src = src;
}
