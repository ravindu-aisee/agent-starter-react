/**
 * LiteRT Model Loader with WebGPU/WASM Acceleration
 * Optimized for mobile web browsers
 *
 * - Uses @litertjs/core for cloud-native LiteRT inference
 * - Supports WebGPU (desktop) and WASM with XNNPack (mobile)
 * - Efficient NCHW input format: [1, 3, 640, 640]
 * - Proper tensor lifecycle management
 * - Background-safe: no globals leaked; caller owns the loop timing
 */
import { Tensor, loadAndCompile, loadLiteRt } from '@litertjs/core';

type Accelerator = 'webgpu' | 'wasm';

interface LiteRTModelCache {
  model: any;
  loadTime: number;
  accelerator: Accelerator;
}

export interface Detection {
  bbox: [number, number, number, number];
  confidence: number;
  class_id: number;
  class_name?: string;
}

export interface PostprocessOpts {
  confThreshold?: number; // default 0.25
  iouThreshold?: number; // default 0.45
  inputSize?: number; // default 640
  classNames?: string[]; // e.g., ['busnumber']
  allowedClassNames?: string[]; // e.g., ['busnumber']
  minBoxArea?: number; // e.g., 12*12
  aspectRatioRange?: [number, number]; // e.g., [0.3, 4]
}

class LiteRTModelManager {
  private modelCache = new Map<string, LiteRTModelCache>();
  private isInitialized = false;
  private supportsWebGPU = false;
  private isMobile = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Detect mobile device
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    console.log('[LiteRT] Initializing... Mobile:', this.isMobile);

    try {
      // Load LiteRT wasm files - following exact doc pattern
      // Host LiteRT's Wasm files on your server
      await loadLiteRt('/litert-wasm/');
      console.log('[LiteRT] WASM loaded successfully');
    } catch (error) {
      console.error('[LiteRT] Failed to load WASM:', error);
      throw new Error(`LiteRT WASM loading failed: ${error}`);
    }

    // Probe WebGPU support (typically desktop only)
    this.supportsWebGPU = false;
    if ('gpu' in navigator && !this.isMobile) {
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (adapter) {
          this.supportsWebGPU = true;
          console.log('[LiteRT] WebGPU adapter found');
        }
      } catch (error) {
        console.log('[LiteRT] WebGPU not available, will use WASM');
        this.supportsWebGPU = false;
      }
    }

    const accelerator = this.getAccelerator();
    console.log(`[LiteRT] Using accelerator: ${accelerator}`);

    this.isInitialized = true;
  }

  getAccelerator(): Accelerator {
    // Use WASM with XNNPack on mobile for best performance
    // Use WebGPU on desktop if available
    return this.isMobile ? 'wasm' : this.supportsWebGPU ? 'webgpu' : 'wasm';
  }

  async loadModel(modelPath: string): Promise<any> {
    await this.initialize();

    const cached = this.modelCache.get(modelPath);
    if (cached) {
      console.log(`[LiteRT] Using cached model (${cached.accelerator})`);
      return cached.model;
    }

    const accelerator = this.getAccelerator();
    const t0 = performance.now();

    try {
      console.log(`[LiteRT] Loading model from ${modelPath} with ${accelerator}...`);

      // Load the model hosted from your server - following exact doc pattern
      const model = await loadAndCompile(modelPath, {
        accelerator: accelerator, // 'webgpu' or 'wasm' for XNNPack CPU inference
      });

      const loadTime = performance.now() - t0;
      console.log(`[LiteRT] Model loaded in ${loadTime.toFixed(0)}ms using ${accelerator}`);
      console.log('[LiteRT] Model type:', typeof model);
      console.log('[LiteRT] Model structure:', model);
      console.log('[LiteRT] Is function:', typeof model === 'function');

      // CompiledModel should be callable as a function
      if (typeof model !== 'function' && model) {
        console.log(
          '[LiteRT] Available methods:',
          Object.getOwnPropertyNames(Object.getPrototypeOf(model))
        );
      }

      this.modelCache.set(modelPath, { model, loadTime, accelerator });
      return model;
    } catch (error) {
      console.error(`[LiteRT] Failed to load model from ${modelPath}:`, error);
      throw new Error(`Model loading failed: ${error}`);
    }
  }

  /**
   * Preprocess video frame -> Float32 NCHW [1,3,640,640] in [0,1] range
   * Following @litertjs/core documentation pattern exactly
   */
  async preprocessImage(videoElement: HTMLVideoElement, targetSize = 640): Promise<Tensor> {
    const H = targetSize,
      W = targetSize,
      C = 3;

    // Use OffscreenCanvas on mobile for better performance (if supported)
    let imageData: ImageData;

    if (typeof OffscreenCanvas !== 'undefined' && this.isMobile) {
      try {
        const offscreen = new OffscreenCanvas(W, H);
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoElement, 0, 0, W, H);
          imageData = ctx.getImageData(0, 0, W, H);
        } else {
          throw new Error('OffscreenCanvas 2D context not available');
        }
      } catch {
        // Fallback to regular canvas
        imageData = this.getImageDataFromCanvas(videoElement, W, H);
      }
    } else {
      imageData = this.getImageDataFromCanvas(videoElement, W, H);
    }

    const { data } = imageData; // Uint8ClampedArray RGBA
    const planeSize = H * W; // 640 * 640 = 409,600
    const totalPixels = H * W; // 409,600
    const expectedLen = totalPixels * C; // 409,600 * 3 = 1,228,800

    console.log('[LiteRT] Creating Float32Array with length:', expectedLen);

    // Create Float32Array for image data
    const image = new Float32Array(expectedLen);

    // Convert RGBA -> CHW (float32 0..1)
    for (let c = 0; c < C; c++) {
      for (let i = 0; i < totalPixels; i++) {
        const rgbaIndex = i * 4;
        image[c * planeSize + i] = data[rgbaIndex + c] / 255.0;
      }
    }

    console.log(
      '[LiteRT] Image array created, length:',
      image.length,
      'shape: [1,',
      C,
      ',',
      H,
      ',',
      W,
      ']'
    );

    // Following exact doc pattern: create Tensor then moveTo device
    const accelerator = this.getAccelerator();
    const inputTensor = await new Tensor(image, /* shape */ [1, C, H, W]).moveTo(accelerator);

    return inputTensor;
  }

  private getImageDataFromCanvas(videoElement: HTMLVideoElement, W: number, H: number): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D context not available');

    ctx.drawImage(videoElement, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  }

  /**
   * Run inference following @litertjs/core documentation exactly
   * Returns first output as Float32Array with proper cleanup
   */
  async runInference(model: any, inputTensor: Tensor): Promise<Float32Array> {
    try {
      console.log('[LiteRT] Running inference...');

      // Run the model - CompiledModel should be callable as function per docs
      let outputs: any;

      if (typeof model === 'function') {
        // Direct function call as per docs: model(inputTensor)
        console.log('[LiteRT] Calling model as function');
        outputs = model(inputTensor);
      } else if (model && typeof (model as any).run === 'function') {
        // Fallback: try run method
        console.log('[LiteRT] Calling model.run()');
        outputs = (model as any).run([inputTensor]);
      } else {
        // Try to call it anyway - it might be callable but not show as function
        console.log('[LiteRT] Attempting direct call despite type check');
        try {
          outputs = model(inputTensor);
        } catch (e) {
          console.error('[LiteRT] Model object structure:', model);
          console.error('[LiteRT] Model prototype:', Object.getPrototypeOf(model));
          throw new Error(`Model is not callable. Type: ${typeof model}, Error: ${e}`);
        }
      }

      console.log('[LiteRT] Inference complete, outputs:', outputs);

      // Clean up input tensor immediately after inference
      inputTensor.delete();

      // Get output tensors as array
      const outList: any[] = Array.isArray(outputs) ? outputs : [outputs];

      if (outList.length === 0) {
        throw new Error('Model returned no outputs');
      }

      console.log('[LiteRT] Moving output to CPU...');

      // Move first output to CPU (wasm) to read it
      const outputTensorCpu = await outList[0].moveTo('wasm');
      const outputData = outputTensorCpu.toTypedArray() as Float32Array;

      console.log('[LiteRT] Output data length:', outputData.length);

      // Clean up output tensor
      outputTensorCpu.delete();

      return outputData;
    } catch (error) {
      // Make sure to clean up tensor even if error occurs
      try {
        inputTensor.delete();
      } catch (e) {
        // Tensor already deleted
      }
      console.error('[LiteRT] Inference error:', error);
      throw new Error(`Inference failed: ${error}`);
    }
  }

  /**
   * Postprocess a YOLO-style output vector into boxes
   * NOTE: If your exported graph emits a different layout, adjust here.
   */
  processDetections(
    outputData: Float32Array,
    videoWidth: number,
    videoHeight: number,
    confThreshold = 0.25,
    iouThreshold = 0.45,
    inputSize = 640,
    opts: PostprocessOpts = {}
  ): Detection[] {
    const {
      classNames = ['busnumber'], // <— put your training labels here
      allowedClassNames = ['busnumber'], // <— we only keep these
      minBoxArea = 12 * 12,
      aspectRatioRange = [0.25, 4],
    } = opts;

    const total = outputData.length;

    // Try common layouts; choose best match
    // Layout A: [numBoxes, 5+numClasses]  (cx,cy,w,h,obj, c0..cK)
    // Layout B: [numBoxes, 4+numClasses]  (cx,cy,w,h, c0..cK)           // no objectness
    // Layout C: [5+numClasses, numBoxes]  (channel-first)
    // Layout D: [4+numClasses, numBoxes]
    const guess = (numAttr: number, numBoxes: number, transposed: boolean) =>
      numAttr * numBoxes === total ? { numAttr, numBoxes, transposed } : null;

    const candidates = [
      guess(6, 8400, false),
      guess(5, 8400, false),
      guess(6, 8400, true),
      guess(5, 8400, true),
    ].filter(Boolean) as Array<{ numAttr: number; numBoxes: number; transposed: boolean }>;

    let picked = candidates[0];
    if (!picked) {
      // Fallback: assume [8400, N]
      const numBoxes = 8400;
      const numAttr = Math.floor(total / numBoxes);
      picked = { numAttr, numBoxes, transposed: false };
    }
    const { numAttr, numBoxes, transposed } = picked;

    // Identify if we have objectness and how many classes
    // If numAttr > 6 => 5 geom + obj + classes, or 4 geom + classes + maybe no obj
    // We’ll assume:
    //   with obj:   5 + numClasses
    //   w/o  obj:   4 + numClasses
    let hasObj = false;
    let numClasses = 0;
    if (numAttr >= 6) {
      // Try “with obj” first
      numClasses = numAttr - 5 - 0; // (cx,cy,w,h,obj,...classes)
      hasObj = true;
      if (numClasses <= 0) {
        // then try “no obj”
        numClasses = numAttr - 4;
        hasObj = false;
      }
    } else if (numAttr === 5) {
      // Could be 4+(1 class) or 5(without classes - unlikely)
      numClasses = 1; // minimal
      hasObj = false;
    } else {
      // Very custom heads; bail out conservatively
      numClasses = Math.max(1, numAttr - 4);
      hasObj = numAttr > 4 + numClasses;
    }

    const dets: Detection[] = [];
    const attrAt = (i: number, attrIndex: number) =>
      transposed ? outputData[i * numAttr + attrIndex] : outputData[attrIndex * numBoxes + i];

    for (let i = 0; i < numBoxes; i++) {
      const cx = attrAt(i, 0);
      const cy = attrAt(i, 1);
      const w = attrAt(i, 2);
      const h = attrAt(i, 3);

      const obj = hasObj ? attrAt(i, 4) : 1.0;

      // class scores start index
      const classStart = hasObj ? 5 : 4;
      let bestClass = 0;
      let bestProb = numClasses > 0 ? attrAt(i, classStart) : 1.0;

      for (let c = 1; c < numClasses; c++) {
        const p = attrAt(i, classStart + c);
        if (p > bestProb) {
          bestProb = p;
          bestClass = c;
        }
      }

      const score = obj * bestProb;
      if (score < confThreshold) continue;

      // Filter by allowed classes
      const name = classNames[bestClass] ?? `${bestClass}`;
      if (allowedClassNames.length && !allowedClassNames.includes(name)) continue;

      // Box to video coords
      const x = ((cx - w / 2) * videoWidth) / inputSize;
      const y = ((cy - h / 2) * videoHeight) / inputSize;
      const ww = (w * videoWidth) / inputSize;
      const hh = (h * videoHeight) / inputSize;

      const bx = Math.max(0, x);
      const by = Math.max(0, y);
      const bw = Math.min(videoWidth - bx, ww);
      const bh = Math.min(videoHeight - by, hh);
      if (bw <= 0 || bh <= 0) continue;

      // Extra heuristics to reduce noise
      const area = bw * bh;
      const ar = bw / Math.max(1, bh);
      if (area < minBoxArea) continue;
      if (ar < aspectRatioRange[0] || ar > aspectRatioRange[1]) continue;

      dets.push({
        bbox: [bx, by, bw, bh],
        confidence: score,
        class_id: bestClass,
        class_name: name,
      });
    }

    return this.applyNMS(dets, iouThreshold);
  }

  private applyNMS(dets: Detection[], iouThr: number): Detection[] {
    const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
    const keep: Detection[] = [];

    for (const d of sorted) {
      let ok = true;
      for (const k of keep) {
        const iou = this.iou(d.bbox, k.bbox);
        if (iou > iouThr) {
          ok = false;
          break;
        }
      }
      if (ok) keep.push(d);
    }
    return keep;
  }

  private iou(a: number[], b: number[]): number {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;

    const ax2 = ax + aw,
      ay2 = ay + ah;
    const bx2 = bx + bw,
      by2 = by + bh;

    const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax, bx));
    const ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay, by));
    const inter = iw * ih;
    const ua = aw * ah + bw * bh - inter;
    return ua <= 0 ? 0 : inter / ua;
  }

  dispose() {
    this.modelCache.clear();
    this.isInitialized = false;
    this.supportsWebGPU = false;
  }
}

export const literTModelManager = new LiteRTModelManager();
