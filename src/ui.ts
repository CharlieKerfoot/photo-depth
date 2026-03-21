export type AppState = 'idle' | 'loading' | 'displaying' | 'error';

let currentState: AppState = 'idle';
let container: HTMLDivElement;
let dropZone: HTMLDivElement;
let loadingEl: HTMLDivElement;
let progressEl: HTMLSpanElement;
let errorEl: HTMLDivElement;
let canvasContainer: HTMLDivElement;
let inferenceTimeEl: HTMLDivElement;
let tiltButton: HTMLButtonElement;

let onDrop: ((file: File) => void) | null = null;
let onSample: (() => void) | null = null;
let onRetry: (() => void) | null = null;
let onTiltRequest: (() => void) | null = null;

export function initUI(
  appEl: HTMLDivElement,
  handlers: {
    onDrop: (file: File) => void;
    onSample: () => void;
    onRetry: () => void;
    onTiltRequest: () => void;
  },
) {
  container = appEl;
  onDrop = handlers.onDrop;
  onSample = handlers.onSample;
  onRetry = handlers.onRetry;
  onTiltRequest = handlers.onTiltRequest;

  dropZone = document.createElement('div');
  dropZone.id = 'drop-zone';
  Object.assign(dropZone.style, {
    position: 'absolute', inset: '0', display: 'flex',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '16px', cursor: 'pointer',
  });
  dropZone.innerHTML = `
    <div style="font-size: 48px; opacity: 0.4;">📷</div>
    <div style="font-size: 18px; opacity: 0.7;">Drop any photo here</div>
    <div style="font-size: 14px; opacity: 0.4;">or click to browse</div>
  `;

  const sampleBtn = document.createElement('button');
  sampleBtn.textContent = 'Try sample image';
  Object.assign(sampleBtn.style, {
    marginTop: '12px', padding: '8px 20px', background: '#333',
    color: '#eee', border: '1px solid #555', borderRadius: '6px',
    cursor: 'pointer', fontSize: '14px',
  });
  sampleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onSample?.();
  });
  dropZone.appendChild(sampleBtn);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) onDrop?.(fileInput.files[0]);
    fileInput.value = '';
  });
  dropZone.appendChild(fileInput);

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.background = 'rgba(255,255,255,0.05)';
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.background = 'transparent';
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.background = 'transparent';
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) onDrop?.(file);
  });

  loadingEl = document.createElement('div');
  Object.assign(loadingEl.style, {
    position: 'absolute', inset: '0', display: 'none',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '12px',
  });
  progressEl = document.createElement('span');
  progressEl.style.fontSize = '16px';
  progressEl.style.opacity = '0.7';
  progressEl.textContent = 'Loading...';
  const spinner = document.createElement('div');
  Object.assign(spinner.style, {
    width: '32px', height: '32px', border: '3px solid #333',
    borderTop: '3px solid #eee', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  });
  const style = document.createElement('style');
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
  loadingEl.appendChild(spinner);
  loadingEl.appendChild(progressEl);

  errorEl = document.createElement('div');
  Object.assign(errorEl.style, {
    position: 'absolute', inset: '0', display: 'none',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '16px',
  });
  const errorMsg = document.createElement('div');
  errorMsg.id = 'error-msg';
  errorMsg.style.fontSize = '16px';
  errorMsg.style.color = '#ff6b6b';
  errorMsg.textContent = 'Something went wrong';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Try another image';
  Object.assign(retryBtn.style, {
    padding: '8px 20px', background: '#333', color: '#eee',
    border: '1px solid #555', borderRadius: '6px', cursor: 'pointer',
    fontSize: '14px',
  });
  retryBtn.addEventListener('click', () => onRetry?.());
  errorEl.appendChild(errorMsg);
  errorEl.appendChild(retryBtn);

  canvasContainer = document.createElement('div');
  canvasContainer.id = 'canvas-container';
  Object.assign(canvasContainer.style, {
    position: 'absolute', inset: '0', display: 'none',
  });

  inferenceTimeEl = document.createElement('div');
  Object.assign(inferenceTimeEl.style, {
    position: 'absolute', bottom: '12px', left: '12px',
    fontSize: '12px', opacity: '0.5', display: 'none',
    pointerEvents: 'none',
  });

  tiltButton = document.createElement('button');
  tiltButton.textContent = 'Enable tilt';
  Object.assign(tiltButton.style, {
    position: 'absolute', bottom: '12px', right: '12px',
    padding: '6px 14px', background: 'rgba(0,0,0,0.5)',
    color: '#eee', border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
    display: 'none', backdropFilter: 'blur(8px)',
  });
  tiltButton.addEventListener('click', () => onTiltRequest?.());

  container.appendChild(dropZone);
  container.appendChild(loadingEl);
  container.appendChild(errorEl);
  container.appendChild(canvasContainer);
  container.appendChild(inferenceTimeEl);
  container.appendChild(tiltButton);

  // Allow dropping on the canvas too (for dropping a new image while displaying)
  canvasContainer.addEventListener('dragover', (e) => e.preventDefault());
  canvasContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) onDrop?.(file);
  });
}

export function setState(state: AppState) {
  currentState = state;
  dropZone.style.display = state === 'idle' ? 'flex' : 'none';
  loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
  errorEl.style.display = state === 'error' ? 'flex' : 'none';
  canvasContainer.style.display = state === 'displaying' ? 'block' : 'none';
  inferenceTimeEl.style.display = state === 'displaying' ? 'block' : 'none';
  tiltButton.style.display = 'none';
}

export function setProgress(text: string) {
  progressEl.textContent = text;
}

export function setError(msg: string) {
  const el = errorEl.querySelector('#error-msg');
  if (el) el.textContent = msg;
  setState('error');
}

export function setInferenceTime(ms: number) {
  inferenceTimeEl.textContent = `Depth estimated in ${Math.round(ms)}ms`;
}

export function getCanvasContainer(): HTMLDivElement {
  return canvasContainer;
}

export function showTiltButton() {
  if (currentState === 'displaying') {
    tiltButton.style.display = 'block';
  }
}

export function hideTiltButton() {
  tiltButton.style.display = 'none';
}

export function getState(): AppState {
  return currentState;
}
