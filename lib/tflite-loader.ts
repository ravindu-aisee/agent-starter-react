/**
 * Enhanced LiteRT Model Loader with Multi-Scale Detection
 * Optimized for mobile web browsers with better scale handling
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
  confThreshold?: number;
  iouThreshold?: number;
  inputSize?: number;
  classNames?: string[];
  allowedClassNames?: string[];
  minBoxArea?: number;
  aspectRatioRange?: [number, number];
}

class LiteRTModelManager {
  private modelCache = new Map<string, LiteRTModelCache>();
  private isInitialized = false;
  private supportsWebGPU = false;
  private isMobile = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    console.log('[LiteRT] Initializing... Mobile:', this.isMobile);

    try {
      await loadLiteRt('/litert-wasm/');
      console.log('[LiteRT] WASM loaded successfully');
    } catch (error) {
      console.error('[LiteRT] Failed to load WASM:', error);
      throw new Error(`LiteRT WASM loading failed: ${error}`);
    }

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

      const model = await loadAndCompile(modelPath, {
        accelerator: accelerator,
      });

      const loadTime = performance.now() - t0;
      console.log(`[LiteRT] Model loaded in ${loadTime.toFixed(0)}ms using ${accelerator}`);

      this.modelCache.set(modelPath, { model, loadTime, accelerator });
      return model;
    } catch (error) {
      console.error(`[LiteRT] Failed to load model from ${modelPath}:`, error);
      throw new Error(`Model loading failed: ${error}`);
    }
  }

  /**
   * Enhanced preprocessing with better aspect ratio handling
   * Uses letterboxing to preserve aspect ratio
   */
  async preprocessImage(
    videoElement: HTMLVideoElement,
    targetSize = 640
  ): Promise<{ tensor: Tensor; scale: number; padX: number; padY: number }> {
    const srcW = videoElement.videoWidth;
    const srcH = videoElement.videoHeight;

    // Calculate scale to fit image in targetSize square while preserving aspect ratio
    const scale = Math.min(targetSize / srcW, targetSize / srcH);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);

    // Calculate padding to center the image
    const padX = Math.floor((targetSize - scaledW) / 2);
    const padY = Math.floor((targetSize - scaledH) / 2);

    console.log(
      `[LiteRT] Preprocessing: ${srcW}x${srcH} -> ${scaledW}x${scaledH} (scale: ${scale.toFixed(3)}, pad: ${padX},${padY})`
    );

    // Create canvas with letterboxing
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,
    });

    if (!ctx) throw new Error('Canvas 2D context not available');

    // Fill with gray background (114/255 = 0.447 - standard YOLO padding)
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, targetSize, targetSize);

    // Draw scaled image centered
    ctx.drawImage(videoElement, padX, padY, scaledW, scaledH);

    const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
    const { data } = imageData;

    // Convert to CHW format normalized to [0,1]
    const C = 3;
    const planeSize = targetSize * targetSize;
    const image = new Float32Array(planeSize * C);

    for (let c = 0; c < C; c++) {
      for (let i = 0; i < planeSize; i++) {
        image[c * planeSize + i] = data[i * 4 + c] / 255.0;
      }
    }

    const accelerator = this.getAccelerator();
    const inputTensor = await new Tensor(image, [1, C, targetSize, targetSize]).moveTo(accelerator);

    return { tensor: inputTensor, scale, padX, padY };
  }

  /**
   * Multi-scale preprocessing for better detection at various distances
   */
  async preprocessMultiScale(
    videoElement: HTMLVideoElement,
    sizes: number[] = [640, 800, 960]
  ): Promise<Array<{ tensor: Tensor; scale: number; padX: number; padY: number; size: number }>> {
    const results = [];

    for (const size of sizes) {
      const result = await this.preprocessImage(videoElement, size);
      results.push({ ...result, size });
    }

    return results;
  }

  async runInference(model: any, inputTensor: Tensor): Promise<Float32Array> {
    try {
      console.log('[LiteRT] Running inference...');

      let outputs: any;

      if (typeof model === 'function') {
        outputs = model(inputTensor);
      } else if (model && typeof (model as any).run === 'function') {
        outputs = (model as any).run([inputTensor]);
      } else {
        try {
          outputs = model(inputTensor);
        } catch (e) {
          throw new Error(`Model is not callable. Type: ${typeof model}, Error: ${e}`);
        }
      }

      // Clean up input tensor
      inputTensor.delete();

      const outList: any[] = Array.isArray(outputs) ? outputs : [outputs];

      if (outList.length === 0) {
        throw new Error('Model returned no outputs');
      }

      const outputTensorCpu = await outList[0].moveTo('wasm');
      const outputData = outputTensorCpu.toTypedArray() as Float32Array;

      console.log('[LiteRT] Output shape inferred:', this.inferOutputShape(outputData));

      outputTensorCpu.delete();

      return outputData;
    } catch (error) {
      try {
        inputTensor.delete();
      } catch (e) {}
      console.error('[LiteRT] Inference error:', error);
      throw new Error(`Inference failed: ${error}`);
    }
  }

  /**
   * Infer output shape from data length
   */
  private inferOutputShape(data: Float32Array): string {
    const len = data.length;

    // Common YOLO11 output shapes
    const possibleShapes = [
      { anchors: 8400, attrs: 6, desc: '[1, 6, 8400] - YOLO11 standard' },
      { anchors: 8400, attrs: 5, desc: '[1, 5, 8400] - no objectness' },
      { anchors: 10647, attrs: 6, desc: '[1, 6, 10647] - larger stride' },
      { anchors: 25200, attrs: 6, desc: '[1, 6, 25200] - high res' },
    ];

    for (const shape of possibleShapes) {
      if (len === shape.anchors * shape.attrs) {
        return shape.desc;
      }
    }

    return `Unknown: ${len} values`;
  }

  /**
   * Enhanced detection processing with better coordinate transformation
   */
  processDetections(
    outputData: Float32Array,
    videoWidth: number,
    videoHeight: number,
    scale: number,
    padX: number,
    padY: number,
    confThreshold = 0.25,
    iouThreshold = 0.45,
    inputSize = 640,
    opts: PostprocessOpts = {}
  ): Detection[] {
    const {
      classNames = ['busnumber'],
      allowedClassNames = ['busnumber'],
      minBoxArea = 12 * 12,
      aspectRatioRange = [0.25, 4],
    } = opts;

    const total = outputData.length;

    // Determine output format
    let numBoxes = 8400; // Default for YOLO11
    let numAttr = Math.floor(total / numBoxes);
    let transposed = false;

    // Try to match known formats
    if (total === 8400 * 6) {
      numBoxes = 8400;
      numAttr = 6;
      transposed = false; // [1, 6, 8400]
    } else if (total === 6 * 8400) {
      numBoxes = 8400;
      numAttr = 6;
      transposed = true; // [1, 8400, 6]
    }

    console.log(
      `[LiteRT] Processing ${numBoxes} boxes with ${numAttr} attributes (transposed: ${transposed})`
    );

    // Determine if we have objectness
    const hasObj = numAttr > 5;
    const numClasses = hasObj ? numAttr - 5 : numAttr - 4;

    const dets: Detection[] = [];

    const attrAt = (i: number, attrIndex: number) =>
      transposed ? outputData[i * numAttr + attrIndex] : outputData[attrIndex * numBoxes + i];

    for (let i = 0; i < numBoxes; i++) {
      // Get box coordinates (in model input space)
      const cx = attrAt(i, 0);
      const cy = attrAt(i, 1);
      const w = attrAt(i, 2);
      const h = attrAt(i, 3);

      const obj = hasObj ? attrAt(i, 4) : 1.0;

      // Get class scores
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

      // Filter by class
      const name = classNames[bestClass] ?? `${bestClass}`;
      if (allowedClassNames.length && !allowedClassNames.includes(name)) continue;

      // Transform coordinates from model space to original image space
      // 1. Remove padding
      const x_model = cx - w / 2;
      const y_model = cy - h / 2;

      const x_unpadded = x_model - padX;
      const y_unpadded = y_model - padY;

      // 2. Scale back to original size
      const x_orig = x_unpadded / scale;
      const y_orig = y_unpadded / scale;
      const w_orig = w / scale;
      const h_orig = h / scale;

      // Clip to video bounds
      const bx = Math.max(0, x_orig);
      const by = Math.max(0, y_orig);
      const bw = Math.min(videoWidth - bx, w_orig);
      const bh = Math.min(videoHeight - by, h_orig);

      if (bw <= 0 || bh <= 0) continue;

      // Quality filters
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
