# Depth Parallax
Vite + TypeScript. No React. No CSS framework. ES modules only.
Run `npm run dev` to test. Run `npm run build` to verify no type errors.
ML stack: onnxruntime-web only. No Transformers.js. No other ML libs.
Do not add dependencies without asking.
Model file lives in public/model/ and is fetched at runtime via fetch().
WebGPU backend first, WASM fallback if unavailable.
