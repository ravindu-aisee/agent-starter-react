'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { useDataChannel } from '@livekit/components-react';
import { toastAlert } from '@/components/livekit/alert-toast';
import { warmupOCRAPI } from '@/lib/ocr-warmup';
import { MatchCallback, ValidationCallback, parallelOCRProcessor } from '@/lib/parallel-ocr';
import { METRICS, performanceMonitor } from '@/lib/performance-monitor';
import { Detection, literTModelManager } from '@/lib/tflite-loader';
import { warmupTTSAPI } from '@/lib/tts-warmup';

interface DataChannelMessage {
  type: 'query' | 'response';
  bus_number?: string;
  request_id?: string;
  timestamp?: number;
  result?: string;
  valid_bus_routes?: string[];
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
  const [currentRequestId, setCurrentRequestId] = useState<string>('');
  const [validBusRoutes, setValidBusRoutes] = useState<string[] | null>(null);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelStatus, setModelStatus] = useState('Not initialized');
  const [plateDetections, setPlateDetections] = useState<Detection[]>([]);
  const [ocrResults, setOcrResults] = useState<string[]>([]);
  const [detectedBuses, setDetectedBuses] = useState<Map<number, string>>(new Map());
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [frameRate, setFrameRate] = useState(0);
  const [showDebug, setShowDebug] = useState(true);

  // ---- Audio unlock state ----
  const [audioReady, setAudioReady] = useState(false);
  const [audioHint, setAudioHint] = useState<string>('');
  const audioCtxRef = useRef<AudioContext | any | null>(null);
  const primedAudioRef = useRef<HTMLAudioElement | null>(null);

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
  const validBusRoutesRef = useRef<string[]>([]);

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
  const OBJECT_COOLDOWN_MS = 5000;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const DETECTION_INTERVAL_MS = isMobile ? 150 : 100;
  const CLASS_NAMES = ['busnumber'];
  const ALLOWED = ['busnumber'];
  const INPUT_SIZE = 640;
  const YOLO_CONF = isMobile ? 0.15 : 0.2;
  const YOLO_IOU = 0.5;

  // --------------------------- LiveKit datachannel handler ---------------------------
  const { send } = useDataChannel((message) => {
    try {
      const data: DataChannelMessage = JSON.parse(new TextDecoder().decode(message.payload));
      console.log('Received data from backend:', data);

      if (data.type === 'query' && data.request_id) {
        if (Array.isArray(data.valid_bus_routes) && data.valid_bus_routes.length > 0) {
          setValidBusRoutes(data.valid_bus_routes);
          validBusRoutesRef.current = data.valid_bus_routes;
          console.log(
            `Received ${data.valid_bus_routes.length} valid bus routes from backend:`,
            data.valid_bus_routes
          );
        } else {
          console.error('No valid bus routes received from backend!');
          setValidBusRoutes([]);
          validBusRoutesRef.current = [];
        }
        console.log(
          `Opening camera for query: ${data.bus_number} (request_id: ${data.request_id})`
        );

        setCurrentRequestId(data.request_id);

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

        // Reset OCR processor for new query
        parallelOCRProcessor.reset();

        const normalizedTarget = normalizeBusNumber(data.bus_number);
        targetBusNumberRef.current = normalizedTarget || '';
        console.log(`Target bus number: ${data.bus_number} → Normalized: ${normalizedTarget}`);

        // Set up validation callback (runs in each thread independently)
        const validationCallback: ValidationCallback = (normalizedText, individualWords) => {
          return findClosestValidRoute(normalizedText, individualWords);
        };
        parallelOCRProcessor.setValidationCallback(validationCallback);

        // Set up match callback (runs in each thread independently, triggers TTS immediately)
        const matchCallback: MatchCallback = async (validatedBusNumber, objectId, ttsTrigger) => {
          const isMatch =
            !!targetBusNumberRef.current && validatedBusNumber === targetBusNumberRef.current;

          if (isMatch) {
            console.log('MATCH FOUND!');
            console.log(
              `   [Thread ${objectId}] Validated: "${validatedBusNumber}" === Target: "${targetBusNumberRef.current}"`
            );

            // Set match flag IMMEDIATELY (this stops other threads)
            matchFoundRef.current = true;

            // Call TTS trigger timing IMMEDIATELY
            await ttsTrigger();

            // Show popup and trigger TTS in PARALLEL for minimal latency
            const popupPromise = Promise.resolve(
              toastAlert({
                title: 'Bus Arrived!',
                description: `Bus ${validatedBusNumber} has arrived.`,
              })
            );

            // CRITICAL: Wait for TTS to FINISH PLAYING before any cleanup/abort
            // This ensures audio plays completely before state clearing
            console.log('Waiting for TTS to finish playing...');
            const ttsPromise = playTTSAnnouncementImmediate(validatedBusNumber).catch((err) => {
              console.error('TTS error:', err);
            });

            // WAIT for TTS to complete before proceeding
            await Promise.all([popupPromise, ttsPromise]);
            console.log('✅ TTS playback completed');

            // Stop detection loop AFTER TTS finishes
            stopLoop();

            // Abort all other threads AFTER TTS finishes
            parallelOCRProcessor.abortAll();

            // Log final timing statistics
            const stats = parallelOCRProcessor.getStats();
            console.log('FINAL TIMING STATISTICS:');
            console.log(
              `   Total threads: ${stats.totalThreads} (${stats.completedThreads} completed, ${stats.abortedThreads} aborted)`
            );
            console.log(`   Avg OCR time: ${(stats.avgOCRTime || 0).toFixed(2)}ms`);
            console.log(`   Avg validation time: ${(stats.avgValidationTime || 0).toFixed(2)}ms`);
            console.log(`   Avg total pipeline: ${(stats.avgTotalTime || 0).toFixed(2)}ms`);
            if ((stats.avgQueueWaitTime || 0) > 0) {
              console.log(`   Avg queue wait: ${(stats.avgQueueWaitTime || 0).toFixed(2)}ms`);
            }

            console.log(`   [Thread ${objectId}] TTS triggered, all other threads aborted`);
          }
        };
        parallelOCRProcessor.setMatchCallback(matchCallback);

        // Set up abort check callback
        parallelOCRProcessor.setShouldAbortCheck(() => matchFoundRef.current);

        if (data.bus_number) {
          sendResponse(`Camera started for bus number ${data.bus_number}...`, data.request_id);
        } else {
          sendResponse('Camera started successfully', data.request_id);
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
    (ocrTextRaw: string, individualWords?: string[]): string => {
      const busRoutes = validBusRoutesRef.current;
      if (!busRoutes || busRoutes.length === 0) {
        console.warn('No valid bus routes available for validation');
        return 'None';
      }

      const ocrText = normalizeBusNumber(ocrTextRaw);
      if (!ocrText || ocrText === 'NONE') return 'None';

      console.log(`Validating OCR result: "${ocrText}" against ${busRoutes.length} routes`);
      if (individualWords && individualWords.length > 0) {
        console.log(`Individual words: [${individualWords.map((w) => `"${w}"`).join(', ')}]`);
      }

      // Level 1: Check full text exact match
      if (busRoutes.includes(ocrText)) return ocrText;

      // Level 2: Check individual words for exact matches (most efficient for cases like "123" in mixed text)
      if (individualWords && individualWords.length > 0) {
        for (const word of individualWords) {
          const normalizedWord = normalizeBusNumber(word);
          if (normalizedWord && busRoutes.includes(normalizedWord)) {
            console.log(`Found exact match in individual word: "${word}" → "${normalizedWord}"`);
            return normalizedWord;
          }
        }
      }

      // Level 3: Check if full text contains a valid route
      for (const r of busRoutes)
        if (ocrText.includes(r) && r.length >= ocrText.length * 0.5) return r;

      // Level 4: Check if valid route contains the OCR text
      for (const r of busRoutes)
        if (r.includes(ocrText) && ocrText.length >= r.length * 0.6) return r;

      // Level 5: Fuzzy match with Levenshtein distance
      let best = 'None',
        bestD = Infinity;
      for (const r of busRoutes) {
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

          // Warm up OCR and TTS APIs in parallel to avoid cold start on first detection
          Promise.all([
            warmupOCRAPI().catch((err) => {
              console.warn('OCR warmup failed (non-critical):', err);
            }),
            warmupTTSAPI().catch((err) => {
              console.warn('TTS warmup failed (non-critical):', err);
            }),
          ]);
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
    (result: string, requestId?: string) => {
      if (!send) {
        console.error('Data channel send function not available');
        return;
      }
      const response: DataChannelMessage = {
        type: 'response',
        result,
        request_id: requestId || currentRequestId,
      };
      try {
        send(new TextEncoder().encode(JSON.stringify(response)), { reliable: true });
        console.log(`Sent response with request_id: ${requestId || currentRequestId}`);
      } catch (e) {
        console.error('Failed to send response:', e);
      }
    },
    [send, currentRequestId]
  );

  const clearAllStates = () => {
    console.log('Clearing all states…');

    // Abort any in-flight OCR requests and clear callbacks
    parallelOCRProcessor.abortAll();
    parallelOCRProcessor.setValidationCallback(null);
    parallelOCRProcessor.setMatchCallback(null);
    parallelOCRProcessor.setShouldAbortCheck(null);

    setPlateDetections([]);
    setOcrResults([]);
    setDetectedBuses(new Map());
    setLastQuery(null);
    setCurrentRequestId('');
    setDebugInfo('');
    frameCountRef.current = 0;
    processingIdsRef.current.clear();
    processedObjectsRef.current.clear();
    announcedBusesRef.current.clear();
    matchFoundRef.current = false;
    targetBusNumberRef.current = '';
    validBusRoutesRef.current = [];
    frameTimesRef.current = [];
    performanceScores.current = [];
    adaptiveFrameSkip.current = isMobile ? 3 : 2;
    setValidBusRoutes(null);
    const c = canvasRef.current;
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  };

  const unlockAudio = useCallback(async () => {
    try {
      // Prime an Audio element for iOS - CRITICAL for iOS Safari
      if (!primedAudioRef.current) {
        const audio = new Audio();
        audio.preload = 'none';
        (audio as any).playsInline = true;
        audio.muted = false;

        // Load a silent data URL to "prime" the audio element
        audio.src =
          'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4T0LnrfAAAAAAAAAAAAAAAAAAAAAP/7UGQAD/AAAGkAAAAIAAANIAAAAQAAAaQAAAAgAAA0gAAABExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

        // Play silence to unlock - this MUST happen during user gesture
        try {
          await audio.play();
          audio.pause();
          audio.currentTime = 0;
        } catch (e) {
          console.warn('[Audio] Play/pause during unlock failed:', e);
        }

        primedAudioRef.current = audio;
        console.log('[Audio] Primed audio element for iOS');
      }

      const Ctx =
        (window as any).AudioContext ||
        (window as any).webkitAudioContext ||
        (window as any).webkitaudioContext;

      if (Ctx) {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new Ctx();
        }
        const ctx = audioCtxRef.current as AudioContext;

        await ctx.resume();
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        console.log('[Audio] WebAudio context unlocked');
      }

      setAudioReady(true);
      setAudioHint('');
      console.log('[Audio] Unlocked successfully');
    } catch (e) {
      console.warn('[Audio] Unlock failed:', e);
      setAudioReady(true);
      setAudioHint("Tap again if you still can't hear audio.");
    }
  }, []);

  // Immediate TTS without popup (popup shown separately in parallel)
  const playTTSAnnouncementImmediate = async (busNumber: string): Promise<void> => {
    if (announcedBusesRef.current.has(busNumber)) {
      console.log(`Skipping TTS for ${busNumber} - already announced`);
      return;
    }
    try {
      const text = `Bus ${busNumber} has arrived.`;
      announcedBusesRef.current.add(busNumber);

      const ttsStartTime = performance.now();
      console.log(`[TTS] Starting TTS generation for "${text}"...`);

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

      const ttsGenerationTime = performance.now() - ttsStartTime;
      console.log(`[TTS] Audio generated in ${ttsGenerationTime.toFixed(2)}ms`);

      const audioBlob = await response.blob();
      const blobTime = performance.now() - ttsStartTime;
      console.log(
        `[TTS] Audio blob ready in ${blobTime.toFixed(2)}ms (${audioBlob.size} bytes)`
      );

      try {
        const hasWebAudio =
          typeof window !== 'undefined' &&
          !!(
            (window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown; webkitaudioContext?: unknown }).AudioContext ||
            (window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown; webkitaudioContext?: unknown }).webkitAudioContext ||
            (window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown; webkitaudioContext?: unknown }).webkitaudioContext
          );

        // Prefer WebAudio when unlocked (best on iOS)
        if (audioReady && hasWebAudio && audioCtxRef.current) {
          const ctx = audioCtxRef.current as AudioContext;

          await ctx.resume();
          const arrayBuf = await audioBlob.arrayBuffer();
          const audioBuf = await new Promise<AudioBuffer>((resolve, reject) => {
            ctx.decodeAudioData(arrayBuf, resolve, reject);
          });

          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(ctx.destination);

          const totalTime = performance.now() - ttsStartTime;
          console.log(`[TTS] Starting playback (total time: ${totalTime.toFixed(2)}ms)`);
          src.start(0);

          src.onended = () => {
            console.log('TTS playback finished (WebAudio)');
            setShowCamera(false);
            setTimeout(() => clearAllStates(), 300);
          };
        } else {
          // Use primed audio element for iOS - CRITICAL for iOS Safari
          const audio = primedAudioRef.current || new Audio();

          // Configure for iOS
          (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
          audio.muted = false;
          audio.preload = 'auto';

          // Create object URL and set as source
          const audioUrl = URL.createObjectURL(audioBlob);
          audio.src = audioUrl;

          // Load the audio
          await audio.load();

          const totalTime = performance.now() - ttsStartTime;
          console.log(`[TTS] Starting playback (total time: ${totalTime.toFixed(2)}ms)`);

          // Play - this should work because the audio element was primed during user gesture
          await audio.play();

          audio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            console.log('TTS playback finished (HTMLAudio)');
            setShowCamera(false);
            setTimeout(() => clearAllStates(), 300);
          };

          audio.onerror = (e) => {
            console.error('Audio playback error:', e);
            URL.revokeObjectURL(audioUrl);
            announcedBusesRef.current.delete(busNumber);
          };
        }
      } catch (err: unknown) {
        console.error('Error playing TTS:', err);
        const errorName = err instanceof Error ? err.name : String(err);
        if (errorName.includes('NotAllowedError')) {
          setAudioHint(
            'Tap "Enable sound" to allow audio, then I\'ll speak automatically next time.'
          );
        }
        announcedBusesRef.current.delete(busNumber);
      }
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
    pad = 0.3
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
    // Reduced quality from 0.95 to 0.75 for smaller payload and faster network transfer
    return c.toDataURL('image/jpeg', 0.75);
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

  // ------------------------------ Main detection pipeline with TRUE parallelism ---------------------------------
  const runDetection = useCallback(async () => {
    const video = webcamRef.current?.video as HTMLVideoElement | undefined;
    const model = modelRef.current;
    if (!video || !model || video.readyState !== 4) return;

    // Early exit if match already found
    if (matchFoundRef.current) return;

    frameCountRef.current++;

    if (frameCountRef.current % adaptiveFrameSkip.current !== 0) return;

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
      const preId = performanceMonitor.start(METRICS.PREPROCESSING);
      const {
        tensor: inputTensor,
        scale,
        padX,
        padY,
      } = await literTModelManager.preprocessImage(video, INPUT_SIZE);

      preprocessStateRef.current = { scale, padX, padY };

      performanceMonitor.end(preId);

      console.log(
        `[Preprocess] Video: ${video.videoWidth}x${video.videoHeight}, Scale: ${scale.toFixed(
          3
        )}, Pad: ${padX},${padY}`
      );

      const infId = performanceMonitor.start(METRICS.INFERENCE);
      const raw = await literTModelManager.runInference(model, inputTensor);
      performanceMonitor.end(infId);

      const postId = performanceMonitor.start(METRICS.POSTPROCESSING);
      const boxes = literTModelManager.processDetections(
        raw,
        video.videoWidth,
        video.videoHeight,
        scale,
        padX,
        padY,
        YOLO_CONF,
        YOLO_IOU,
        INPUT_SIZE,
        {
          classNames: CLASS_NAMES,
          allowedClassNames: ALLOWED,
          minBoxArea: isMobile ? 10 * 10 : 12 * 12,
          aspectRatioRange: [0.15, 6],
        }
      );
      performanceMonitor.end(postId);

      const pipelineTime = performanceMonitor.end(pipelineTimer);

      performanceScores.current.push(pipelineTime);
      if (performanceScores.current.length > 10) {
        performanceScores.current.shift();

        const avgTime =
          performanceScores.current.reduce((a, b) => a + b, 0) / performanceScores.current.length;

        if (avgTime > 250 && adaptiveFrameSkip.current < 5) {
          adaptiveFrameSkip.current++;
          console.log(
            `[Perf] Increasing frame skip to ${adaptiveFrameSkip.current} (avg: ${avgTime.toFixed(
              0
            )}ms)`
          );
        } else if (avgTime < 150 && adaptiveFrameSkip.current > 1) {
          adaptiveFrameSkip.current--;
          console.log(
            `[Perf] Decreasing frame skip to ${adaptiveFrameSkip.current} (avg: ${avgTime.toFixed(
              0
            )}ms)`
          );
        }
      }

      setPlateDetections(boxes);
      drawBoxes(boxes, video.videoWidth, video.videoHeight);

      if (!boxes.length) return;

      boxes.forEach((det, idx) => {
        const [x, y, w, h] = det.bbox;
        console.log(
          `[Det ${idx}] bbox=[${x.toFixed(0)}, ${y.toFixed(0)}, ${w.toFixed(
            0
          )}, ${h.toFixed(0)}] conf=${(det.confidence * 100).toFixed(1)}%`
        );
      });

      // ==================== PARALLEL PROCESSING ====================
      // Launch INDEPENDENT threads for each detection
      // Each thread runs: OCR → Validation → Match Check → TTS
      // First thread to match triggers TTS and aborts all others
      // No waiting, no batching, pure parallelism for minimum latency
      // ==================================================================

      console.log(`Launching ${boxes.length} independent parallel pipelines...`);

      const parallelPipelines = boxes.map(async (det, detectionIndex) => {
        // Early exit if match already found
        if (matchFoundRef.current) {
          console.log(`[Det ${detectionIndex}] Skipping - match already found`);
          return;
        }

        if (det.confidence < 0.2) {
          console.log(
            `[Det ${detectionIndex}] Skipping low confidence: ${(det.confidence * 100).toFixed(1)}%`
          );
          return;
        }

        const objectId = generateObjectId(det.bbox);
        const now = Date.now();

        // Check cooldown
        const lastProcessedTime = processedObjectsRef.current.get(objectId);
        if (lastProcessedTime && now - lastProcessedTime < OBJECT_COOLDOWN_MS) {
          console.log(`[Det ${detectionIndex}] Object ${objectId} in cooldown`);
          return;
        }

        // Check if already processing
        if (processingIdsRef.current.has(objectId)) {
          console.log(`[Det ${detectionIndex}] Object ${objectId} already processing`);
          return;
        }

        // Mark as processing
        processingIdsRef.current.add(objectId);

        try {
          // Crop image for this detection
          const crop = cropWithPadding(video, det.bbox, 0.4);

          // Create abort controller for this thread
          const abortController = new AbortController();

          // Record detection time for latency tracking
          const detectionTime = performance.now();

          // Run COMPLETE pipeline in this independent thread
          // Pipeline includes: OCR → Validation → Match Check → TTS
          const result = await parallelOCRProcessor.processPipeline({
            image: crop,
            objectId,
            detectionIndex,
            timestamp: Date.now(),
            detectionTime, // Track from detection to TTS
            abortController,
          });

          // Mark as processed
          processedObjectsRef.current.set(objectId, Date.now());

          // Update UI with detection if successful and not aborted
          if (result.success && !result.wasAborted && result.text !== 'None') {
            setDetectedBuses((prev) => new Map(prev).set(objectId, result.text));
            setOcrResults((prev) => [result.text, ...prev].slice(0, 5));
          }

          console.log(
            `[Det ${detectionIndex}] Pipeline finished: ${result.text} (${result.processingTime.toFixed(2)}ms)`
          );
        } catch (err) {
          console.error(`[Det ${detectionIndex}] Pipeline error:`, err);
        } finally {
          // Clean up
          processingIdsRef.current.delete(objectId);
        }
      });

      // Fire all pipelines in parallel - DO NOT WAITt
      // This ensures all detections start processing simultaneously
      // First one to match will trigger TTS and abort the rest
      Promise.allSettled(parallelPipelines).catch((err) => {
        console.error('❌ Parallel pipeline error:', err);
      });
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
    ALLOWED,
    CLASS_NAMES,
    YOLO_CONF,
    isMobile,
  ]);

  // ---------------------------------------- UI ----------------------------------------
  if (!showCamera) {
    return <div />;
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
            Loading...Please wait!
          </div>
        </div>
      )}

      {!audioReady && (
        <button
          onClick={unlockAudio}
          style={{
            marginBottom: 12,
            padding: '10px 16px',
            fontSize: '0.95rem',
            background: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
          }}
        >
          🔊 Enable sound
        </button>
      )}
      {audioHint && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8,
            fontSize: '.85rem',
            maxWidth: 600,
            textAlign: 'center',
          }}
        >
          {audioHint}
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
            width: { ideal: isMobile ? 1920 : 1920, max: 3840 },
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
