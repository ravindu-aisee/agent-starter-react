'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { useDataChannel } from '@livekit/components-react';
import { METRICS, performanceMonitor } from '@/lib/performance-monitor';
import { Detection, literTModelManager } from '@/lib/tflite-loader';

interface DataChannelMessage {
  type: 'query' | 'response';
  bus_number?: string;
  timestamp?: number;
  result?: string;
}

interface OCRResult {
  success: boolean;
  text: string;
  detections: Array<{ text: string; bounds: any }>;
  wordCount?: number;
  message?: string;
}

export function CameraComponent() {
  // ---- UI / state ----
  const [showCamera, setShowCamera] = useState(false);
  const [lastQuery, setLastQuery] = useState<DataChannelMessage | null>(null);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelStatus, setModelStatus] = useState('Not initialized');
  const [plateDetections, setPlateDetections] = useState<Detection[]>([]);
  const [ocrResults, setOcrResults] = useState<string[]>([]);
  const [detectedBuses, setDetectedBuses] = useState<Map<number, string>>(new Map());
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [frameRate, setFrameRate] = useState(0);
  const [showDebug, setShowDebug] = useState(true); // Show debug by default

  // ---- refs / infra ----
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modelRef = useRef<any>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // processing guards
  const processingIdsRef = useRef<Set<number>>(new Set());
  const processedObjectsRef = useRef<Map<number, number>>(new Map());
  const announcedBusesRef = useRef<Set<string>>(new Set());
  const frameCountRef = useRef(0);
  const matchFoundRef = useRef(false);
  const targetBusNumberRef = useRef<string>('');

  // Performance tracking
  const lastFrameTimeRef = useRef(0);
  const frameTimesRef = useRef<number[]>([]);
  const adaptiveFrameSkip = useRef(2);
  const performanceScores = useRef<number[]>([]);

  // Preprocessing state for coordinate transformation
  const preprocessStateRef = useRef<{
    scale: number;
    padX: number;
    padY: number;
  }>({ scale: 1, padX: 0, padY: 0 });

  // ---------------------------------- constants ----------------------------------------
  const VALID_BUS_ROUTES = [
    '382W',
    '386',
    '50',
    '136',
    '43M',
    '34',
    '110',
    '84',
    '117',
    '36',
    '190',
    '83',
    '502',
    '972M',
    '518',
    '16',
    '123',
    '167',
    '7',
    '143',
    '175',
    '27',
    '506',
    '858',
    '48',
    '272',
    '27A',
    '34A',
    '14',
  ];
  const OBJECT_COOLDOWN_MS = 5000;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const DETECTION_INTERVAL_MS = isMobile ? 150 : 100;
  const CLASS_NAMES = ['busnumber'];
  const ALLOWED = ['busnumber'];
  const INPUT_SIZE = 640;
  const YOLO_CONF = isMobile ? 0.15 : 0.2; // Lower threshold for mobile
  const YOLO_IOU = 0.5;

  // --------------------------- LiveKit datachannel handler ---------------------------
  const { send } = useDataChannel((message) => {
    try {
      const data: DataChannelMessage = JSON.parse(new TextDecoder().decode(message.payload));
      console.log('Received data from backend:', data);

      if (data.type === 'query') {
        console.log('Opening camera for query:', data.bus_number);

        // Reset all state for new query
        setShowCamera(true);
        setLastQuery(data);
        setDetectedBuses(new Map());
        setPlateDetections([]);
        setOcrResults([]);
        setDebugInfo('');

        processingIdsRef.current.clear();
        processedObjectsRef.current.clear();
        announcedBusesRef.current.clear();
        frameCountRef.current = 0;
        matchFoundRef.current = false;
        adaptiveFrameSkip.current = isMobile ? 3 : 2;

        const normalizedTarget = normalizeBusNumber(data.bus_number);
        targetBusNumberRef.current = normalizedTarget || '';
        console.log(`Target bus number: ${data.bus_number} → Normalized: ${normalizedTarget}`);

        if (data.bus_number) {
          sendResponse(`Camera started - scanning for bus number ${data.bus_number}...`);
        } else {
          sendResponse('Camera started successfully');
        }
      }
    } catch (error) {
      console.error('Failed to parse data channel message', error);
    }
  });

  // ----------------------- helpers: normalize the bus number/ fuzzy validate ------------------------
  const normalizeBusNumber = useCallback((busNumber?: string): string => {
    if (!busNumber) return '';
    return busNumber.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }, []);

  const levenshteinDistance = (a: string, b: string): number => {
    const m = a.length,
      n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : Math.min(dp[i - 1][j - 1] + 1, dp[i][j - 1] + 1, dp[i - 1][j] + 1);
      }
    }
    return dp[m][n];
  };

  const findClosestValidRoute = useCallback(
    (ocrTextRaw: string): string => {
      const ocrText = normalizeBusNumber(ocrTextRaw);
      if (!ocrText || ocrText === 'NONE') return 'None';

      console.log(`Validating OCR result: "${ocrText}"`);
      if (ocrText.length < 2) return 'None';

      // exact match
      if (VALID_BUS_ROUTES.includes(ocrText)) return ocrText;

      // route contained in OCR
      for (const r of VALID_BUS_ROUTES)
        if (ocrText.includes(r) && r.length >= ocrText.length * 0.5) return r;

      // OCR contained in route
      for (const r of VALID_BUS_ROUTES)
        if (r.includes(ocrText) && ocrText.length >= r.length * 0.6) return r;

      // close edit distance
      let best = 'None',
        bestD = Infinity;
      for (const r of VALID_BUS_ROUTES) {
        const d = levenshteinDistance(ocrText, r);
        if (d <= 1 && Math.abs(ocrText.length - r.length) <= 1 && d < bestD) {
          best = r;
          bestD = d;
        }
      }
      return best !== 'None' ? best : 'None';
    },
    [normalizeBusNumber]
  );

  // ---------------------------------- model init -----------------------------------------
  useEffect(() => {
    if (showCamera && !modelLoaded && !modelRef.current) {
      (async () => {
        try {
          setModelStatus('Initializing LiteRT…');
          await literTModelManager.initialize();

          setModelStatus('Loading model…');
          modelRef.current = await literTModelManager.loadModel('/models/yolo_trained.tflite');

          setModelLoaded(true);
          setModelStatus('Model ready - detecting bus number plates');
          console.log('LiteRT model loaded successfully!');
        } catch (e: any) {
          const errorMsg = `Init error: ${e?.message ?? e}`;
          setModelStatus(errorMsg);
          console.error('Model loading error:', errorMsg, e);
        }
      })();
    }
  }, [showCamera, modelLoaded]);

  // ----------------------------------- detection loop lifecycle -----------------------------------
  useEffect(() => {
    if (showCamera && modelLoaded && modelRef.current) {
      console.log('Starting detection loop…');
      startLoop();
      return () => {
        console.log('Stopping detection loop…');
        stopLoop();
      };
    } else {
      stopLoop();
    }
  }, [showCamera, modelLoaded]);

  const startLoop = useCallback(() => {
    stopLoop();
    detectionIntervalRef.current = setInterval(runDetection, DETECTION_INTERVAL_MS);
  }, [DETECTION_INTERVAL_MS]);

  const stopLoop = useCallback(() => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    const c = canvasRef.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    processedObjectsRef.current.clear();
    processingIdsRef.current.clear();
  }, []);

  // ---------------------------------- responses / TTS ----------------------------------
  const sendResponse = useCallback(
    (result: string) => {
      if (!send) {
        console.error('Data channel send function not available');
        return;
      }
      const response: DataChannelMessage = { type: 'response', result };
      try {
        send(new TextEncoder().encode(JSON.stringify(response)), { reliable: true });
      } catch (e) {
        console.error('Failed to send response:', e);
      }
    },
    [send]
  );

  const clearAllStates = () => {
    console.log('Clearing all states…');
    setPlateDetections([]);
    setOcrResults([]);
    setDetectedBuses(new Map());
    setLastQuery(null);
    setDebugInfo('');
    frameCountRef.current = 0;
    processingIdsRef.current.clear();
    processedObjectsRef.current.clear();
    announcedBusesRef.current.clear();
    matchFoundRef.current = false;
    targetBusNumberRef.current = '';
    frameTimesRef.current = [];
    performanceScores.current = [];
    adaptiveFrameSkip.current = isMobile ? 3 : 2;
    const c = canvasRef.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  };

  const playTTSAnnouncement = async (busNumber: string): Promise<void> => {
    if (announcedBusesRef.current.has(busNumber)) {
      console.log(`Skipping TTS for ${busNumber} - already announced`);
      return;
    }
    try {
      const text = `Bus ${busNumber} has arrived.`;
      announcedBusesRef.current.add(busNumber);

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        console.error(`TTS API error: ${response.statusText}`);
        announcedBusesRef.current.delete(busNumber);
        return;
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.play().catch((err) => {
        console.error('Error playing TTS:', err);
        announcedBusesRef.current.delete(busNumber);
      });

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        console.log(' TTS playback finished');
        setShowCamera(false);
        setTimeout(() => clearAllStates(), 300);
      };
    } catch (error) {
      console.error('TTS error:', error);
      announcedBusesRef.current.delete(busNumber);
    }
  };

  // ----------------------------- vision helpers -----------------------------
  const generateObjectId = useCallback((bbox: number[]): number => {
    const [x, y, w, h] = bbox;
    const gridSize = 100;
    const centerX = Math.round((x + w / 2) / gridSize);
    const centerY = Math.round((y + h / 2) / gridSize);
    const sizeGrid = 50;
    const sizeW = Math.round(w / sizeGrid);
    const sizeH = Math.round(h / sizeGrid);
    return centerX * 10000000 + centerY * 10000 + sizeW * 100 + sizeH;
  }, []);

  const cropWithPadding = (
    video: HTMLVideoElement,
    bbox: [number, number, number, number],
    pad = 0.2
  ): string => {
    const [x, y, w, h] = bbox;
    const vx = Math.max(0, x - w * pad);
    const vy = Math.max(0, y - h * pad);
    const vw = Math.min(video.videoWidth - vx, w + 2 * w * pad);
    const vh = Math.min(video.videoHeight - vy, h + 2 * h * pad);

    const c = document.createElement('canvas');
    c.width = vw;
    c.height = vh;
    const g = c.getContext('2d');
    if (!g) return '';
    g.drawImage(video, vx, vy, vw, vh, 0, 0, vw, vh);
    return c.toDataURL('image/jpeg', 0.95);
  };

  async function saveImageAsync(imageDataUrl: string, filename: string): Promise<void> {
    try {
      const response = await fetch('/api/save-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageDataUrl, filename }),
      });
      if (response.ok) {
        const result = await response.json();
        console.log(`Image saved: ${result.path}`);
      } else {
        console.error('Save image error:', response.statusText);
      }
    } catch (error) {
      console.error('Save image network error:', error);
    }
  }

  const annotateAndSaveImage = (
    imageData: string,
    text: string,
    confidence: number,
    filename: string
  ) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(img, 0, 0);

      const fontSize = Math.max(20, Math.floor(img.height / 10));
      ctx.font = `bold ${fontSize}px Arial`;
      ctx.fillStyle = 'rgba(0, 255, 0, 0.9)';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 3;

      const label = `${text} (${(confidence * 100).toFixed(1)}%)`;
      const tm = ctx.measureText(label);
      const pad = 10;

      ctx.fillRect(0, 0, tm.width + pad * 2, fontSize + pad * 2);
      ctx.strokeText(label, pad, fontSize + pad / 2);
      ctx.fillStyle = '#000000';
      ctx.fillText(label, pad, fontSize + pad / 2);

      const annotated = canvas.toDataURL('image/jpeg', 0.95);
      saveImageAsync(annotated, filename);
    };
    img.src = imageData;
  };

  function drawBoxes(dets: Detection[], w: number, h: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    dets.forEach((d) => {
      const [x, y, bw, bh] = d.bbox;
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, bw, bh);

      const corner = Math.min(bw, bh) * 0.15;
      ctx.lineWidth = 4;

      // corners
      ctx.beginPath();
      ctx.moveTo(x, y + corner);
      ctx.lineTo(x, y);
      ctx.lineTo(x + corner, y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x + bw - corner, y);
      ctx.lineTo(x + bw, y);
      ctx.lineTo(x + bw, y + corner);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x, y + bh - corner);
      ctx.lineTo(x, y + bh);
      ctx.lineTo(x + corner, y + bh);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x + bw - corner, y + bh);
      ctx.lineTo(x + bw, y + bh);
      ctx.lineTo(x + bw, y + bh - corner);
      ctx.stroke();

      // Label with coordinates
      const label = `${d.class_name ?? 'busnumber'} ${(d.confidence * 100).toFixed(1)}%`;
      const coordLabel = `[${x.toFixed(0)},${y.toFixed(0)} ${bw.toFixed(0)}x${bh.toFixed(0)}]`;

      ctx.font = 'bold 16px Arial';
      const tm = ctx.measureText(label);
      ctx.font = '12px monospace';
      const tm2 = ctx.measureText(coordLabel);
      const maxWidth = Math.max(tm.width, tm2.width);

      ctx.fillStyle = 'rgba(0,255,0,0.9)';
      ctx.fillRect(x, Math.max(0, y - 46), maxWidth + 12, 44);
      ctx.fillStyle = '#000';

      ctx.font = 'bold 16px Arial';
      ctx.fillText(label, x + 6, Math.max(16, y - 28));

      ctx.font = '12px monospace';
      ctx.fillText(coordLabel, x + 6, Math.max(30, y - 10));
    });
  }

  // --------------------------------------- OCR call ---------------------------------------
  async function runOCR(imgDataUrl: string): Promise<string> {
    const t = performanceMonitor.start(METRICS.OCR);
    try {
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imgDataUrl }),
      });

      if (!response.ok) return 'None';

      const result: OCRResult = await response.json();
      if (result.success && result.text) {
        const normalized = normalizeBusNumber(result.text);
        console.log(`OCR raw: "${result.text}" → normalized: "${normalized}"`);
        return normalized || 'None';
      }
      return 'None';
    } catch (error) {
      console.error('OCR processing error:', error);
      return 'None';
    } finally {
      performanceMonitor.end(t);
    }
  }

  // ------------------------------ Main detection pipeline ---------------------------------
  const runDetection = useCallback(async () => {
    const video = webcamRef.current?.video as HTMLVideoElement | undefined;
    const model = modelRef.current;
    if (!video || !model || video.readyState !== 4) return;

    if (matchFoundRef.current) return;

    frameCountRef.current++;

    // Adaptive frame skipping
    if (frameCountRef.current % adaptiveFrameSkip.current !== 0) return;

    // Calculate FPS
    const now = performance.now();
    if (lastFrameTimeRef.current) {
      const delta = now - lastFrameTimeRef.current;
      frameTimesRef.current.push(delta);
      if (frameTimesRef.current.length > 30) frameTimesRef.current.shift();

      const avgDelta =
        frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
      setFrameRate(Math.round(1000 / avgDelta));
    }
    lastFrameTimeRef.current = now;

    const pipelineTimer = performanceMonitor.start(METRICS.DETECTION_PIPELINE);

    try {
      // Enhanced preprocessing with letterboxing
      const preId = performanceMonitor.start(METRICS.PREPROCESSING);
      const {
        tensor: inputTensor,
        scale,
        padX,
        padY,
      } = await literTModelManager.preprocessImage(video, INPUT_SIZE);

      // Store preprocessing state for coordinate transformation
      preprocessStateRef.current = { scale, padX, padY };

      performanceMonitor.end(preId);

      console.log(
        `[Preprocess] Video: ${video.videoWidth}x${video.videoHeight}, Scale: ${scale.toFixed(3)}, Pad: ${padX},${padY}`
      );

      // Run inference
      const infId = performanceMonitor.start(METRICS.INFERENCE);
      const raw = await literTModelManager.runInference(model, inputTensor);
      const inferenceTime = performanceMonitor.end(infId);

      // Postprocess with proper coordinate transformation
      const postId = performanceMonitor.start(METRICS.POSTPROCESSING);
      const boxes = literTModelManager.processDetections(
        raw,
        video.videoWidth,
        video.videoHeight,
        scale, // Scale for coordinate transformation
        padX, // Padding X
        padY, // Padding Y
        YOLO_CONF,
        YOLO_IOU,
        INPUT_SIZE,
        {
          classNames: CLASS_NAMES,
          allowedClassNames: ALLOWED,
          minBoxArea: isMobile ? 10 * 10 : 12 * 12, // Smaller minimum for mobile
          aspectRatioRange: [0.15, 6], // More flexible aspect ratio
        }
      );
      performanceMonitor.end(postId);

      const pipelineTime = performanceMonitor.end(pipelineTimer);

      // // Update debug info
      // setDebugInfo(`Device: ${isMobile ? 'Mobile' : 'Desktop'}
      // Resolution: ${video.videoWidth}x${video.videoHeight}
      // Scale: ${scale.toFixed(3)} | Pad: ${padX},${padY}
      // Detections: ${boxes.length}
      // Confidence: ${YOLO_CONF} | IOU: ${YOLO_IOU}
      // Inference: ${inferenceTime.toFixed(1)}ms
      // Pipeline: ${pipelineTime.toFixed(1)}ms
      // FPS: ${frameRate} | Skip: ${adaptiveFrameSkip.current}
      // Target: ${targetBusNumberRef.current || 'None'}`);

      // Adaptive performance management
      performanceScores.current.push(pipelineTime);
      if (performanceScores.current.length > 10) {
        performanceScores.current.shift();

        const avgTime =
          performanceScores.current.reduce((a, b) => a + b, 0) / performanceScores.current.length;

        // Adjust frame skip for mobile performance
        if (avgTime > 250 && adaptiveFrameSkip.current < 5) {
          adaptiveFrameSkip.current++;
          console.log(
            `[Perf] Increasing frame skip to ${adaptiveFrameSkip.current} (avg: ${avgTime.toFixed(0)}ms)`
          );
        } else if (avgTime < 150 && adaptiveFrameSkip.current > 1) {
          adaptiveFrameSkip.current--;
          console.log(
            `[Perf] Decreasing frame skip to ${adaptiveFrameSkip.current} (avg: ${avgTime.toFixed(0)}ms)`
          );
        }
      }

      setPlateDetections(boxes);
      drawBoxes(boxes, video.videoWidth, video.videoHeight);

      if (!boxes.length) return;

      const targetBusRaw = targetBusNumberRef.current;
      const targetBus = normalizeBusNumber(targetBusRaw);

      // Log all detections with coordinates
      boxes.forEach((det, idx) => {
        const [x, y, w, h] = det.bbox;
        console.log(
          `[Det ${idx}] bbox=[${x.toFixed(0)}, ${y.toFixed(0)}, ${w.toFixed(0)}, ${h.toFixed(0)}] conf=${(det.confidence * 100).toFixed(1)}%`
        );
      });

      // Process detections
      await Promise.all(
        boxes.map(async (det) => {
          if (matchFoundRef.current) return;

          const objectId = generateObjectId(det.bbox);
          const now = Date.now();

          const lastProcessedTime = processedObjectsRef.current.get(objectId);
          if (lastProcessedTime && now - lastProcessedTime < OBJECT_COOLDOWN_MS) return;
          if (processingIdsRef.current.has(objectId)) return;

          processingIdsRef.current.add(objectId);

          try {
            // Crop uses already-transformed coordinates
            const crop = cropWithPadding(video, det.bbox, 0.2);
            const ts = Date.now();
            const label = det.class_name ?? `cls${det.class_id}`;

            const ocrStart = performance.now();
            const ocrNorm = await runOCR(crop);
            const validated = findClosestValidRoute(ocrNorm);
            const ocrMs = performance.now() - ocrStart;

            console.log(`OCR ${ocrMs.toFixed(1)}ms | raw="${ocrNorm}" | validated="${validated}"`);

            processedObjectsRef.current.set(objectId, Date.now());
            processingIdsRef.current.delete(objectId);

            if (!validated || validated === 'None') return;

            const isMatch = !!targetBus && validated === targetBus;

            console.log('='.repeat(60));
            console.log(
              `COMPARISON: OCR="${validated}" vs TARGET="${targetBus}" → ${isMatch ? '✅ MATCH' : '❌ NO MATCH'}`
            );
            console.log('='.repeat(60));

            if (isMatch) {
              matchFoundRef.current = true;
              console.log('MATCH FOUND! Stopping all processing...');
              stopLoop();
              //sendResponse(`Bus number ${validated} detected successfully!`);
              await playTTSAnnouncement(validated);

              const filename = `captured_images/${label}_${objectId}_${ts}.jpg`;
              const annotated = `bus_${validated}_${objectId}_${ts}.jpg`;
              saveImageAsync(crop, filename).catch(() => {});
              annotateAndSaveImage(crop, validated, det.confidence, annotated);
              return;
            }

            setDetectedBuses((prev) => new Map(prev).set(objectId, validated));
            setOcrResults((prev) => [validated, ...prev].slice(0, 5));
            //sendResponse(`Detected bus: ${validated}`);

            const filename = `captured_images/${label}_${objectId}_${ts}.jpg`;
            const annotated = `bus_${validated}_${objectId}_${ts}.jpg`;
            saveImageAsync(crop, filename).catch(() => {});
            annotateAndSaveImage(crop, validated, det.confidence, annotated);
          } catch (err) {
            console.error('❌ Detection item error:', err);
            processingIdsRef.current.delete(objectId);
          }
        })
      );
    } catch (e) {
      console.error('❌ Detection pipeline error:', e);
    } finally {
      performanceMonitor.end(pipelineTimer);
    }
  }, [
    generateObjectId,
    sendResponse,
    stopLoop,
    normalizeBusNumber,
    findClosestValidRoute,
    frameRate,
  ]);

  // ---------------------------------------- UI ----------------------------------------
  if (!showCamera) {
    return (
      <div
      // style={{
      //   position: 'fixed',
      //   bottom: 20,
      //   right: 20,
      //   padding: '12px 20px',
      //   backgroundColor: modelLoaded ? 'rgba(0, 255, 0, 0.2)' : 'rgba(255, 165, 0, 0.2)',
      //   border: modelLoaded ? '2px solid #00ff00' : '2px solid #ffa500',
      //   borderRadius: 8,
      //   color: 'white',
      //   fontSize: '.85rem',
      //   zIndex: 999,
      //   boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
      // }}
      >
        {/* <strong>YOLO Model:</strong> {modelLoaded ? 'Ready' : 'Loading...'}
        {!modelLoaded && (
          <div style={{ fontSize: '.75rem', marginTop: 4, opacity: 0.8 }}>{modelStatus}</div>
        )} */}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.95)',
        color: 'white',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {!modelLoaded && (
        <div
          style={{
            marginBottom: 20,
            fontSize: '1.2rem',
            textAlign: 'center',
            padding: 20,
            background: 'rgba(255,165,0,0.2)',
            borderRadius: 8,
            border: '2px solid #fa0',
          }}
        >
          <div>{modelStatus}</div>
          <div style={{ fontSize: '.9rem', marginTop: 10, opacity: 0.8 }}>
            Please wait while the model is loading...
          </div>
        </div>
      )}

      <div
        style={{
          position: 'relative',
          width: '90%',
          maxWidth: 600,
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          border: plateDetections.length ? '3px solid #0f0' : '3px solid #666',
          opacity: modelLoaded ? 1 : 0.5,
        }}
      >
        <Webcam
          audio={false}
          ref={webcamRef}
          screenshotFormat="image/jpeg"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          videoConstraints={{
            facingMode: 'environment',
            width: { ideal: isMobile ? 1920 : 1920, max: 3840 }, // Higher resolution for mobile
            height: { ideal: isMobile ? 1080 : 1080, max: 2160 },
            frameRate: { ideal: 30, max: 30 },
            aspectRatio: 16 / 9,
          }}
        />
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
      </div>

      <div
        style={{
          marginTop: 12,
          padding: 12,
          background: 'rgba(255,255,255,0.1)',
          borderRadius: 8,
          fontSize: '.85rem',
          maxWidth: 600,
          width: '90%',
        }}
      >
        <strong>Model:</strong> {modelLoaded ? 'Loaded Successfully' : 'Loading…'}
        <br />
        <strong>Detection:</strong>{' '}
        {plateDetections.length ? ` ${plateDetections.length} plate(s)` : 'Scanning…'}
        <br />
        <strong>Detected Buses:</strong>{' '}
        {detectedBuses.size ? Array.from(detectedBuses.values()).join(', ') : 'None yet'}
        {lastQuery?.bus_number && (
          <>
            <br />
            <strong>Target Bus:</strong> {lastQuery.bus_number} (Normalized:{' '}
            {normalizeBusNumber(lastQuery.bus_number)})
          </>
        )}
      </div>

      {ocrResults.length > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            background: 'rgba(0,255,0,0.15)',
            borderRadius: 8,
            fontSize: '.8rem',
            maxWidth: 600,
            width: '90%',
            maxHeight: 100,
            overflowY: 'auto',
          }}
        >
          <strong>Recent Detections:</strong>
          {ocrResults.map((t, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              {i + 1}. {t}
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => {
          setShowCamera(false);
          stopLoop();
          clearAllStates();
        }}
        style={{
          marginTop: 12,
          padding: '10px 20px',
          fontSize: '1rem',
          background: '#dc3545',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          cursor: 'pointer',
        }}
      >
        Close Camera
      </button>
    </div>
  );
}
