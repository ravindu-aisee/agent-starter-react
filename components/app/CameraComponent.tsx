'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { useDataChannel } from '@livekit/components-react';
import { toastAlert } from '@/components/livekit/alert-toast';
import { MatchCallback, ValidationCallback, parallelOCRProcessor } from '@/lib/parallel-ocr';
import { METRICS, performanceMonitor } from '@/lib/performance-monitor';
import { audioService } from '@/lib/services/audio-service';
import { modelService } from '@/lib/services/model-service';
import { ocrService } from '@/lib/services/ocr-service';
import { ttsService } from '@/lib/services/tts-service';
import { Detection, literTModelManager } from '@/lib/tflite-loader';

interface DataChannelMessage {
  type: 'query' | 'response';
  bus_numbers?: string[];
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
  const [modelStatus, setModelStatus] = useState('Initializing...');
  const [plateDetections, setPlateDetections] = useState<Detection[]>([]);
  const [ocrResults, setOcrResults] = useState<string[]>([]);
  const [detectedBuses, setDetectedBuses] = useState<Map<number, string>>(new Map());
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [frameRate, setFrameRate] = useState(0);
  const [showDebug, setShowDebug] = useState(true);

  // ---- Audio unlock state ----
  const [audioReady, setAudioReady] = useState(false);
  const [audioHint, setAudioHint] = useState<string>('');

  // ---- refs / infra ----
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null); // Reusable canvas for cropping

  // processing guards
  const processingIdsRef = useRef<Set<number>>(new Set());
  const processedObjectsRef = useRef<Map<number, number>>(new Map());
  const announcedBusesRef = useRef<Set<string>>(new Set());
  const frameCountRef = useRef(0);
  const matchFoundRef = useRef(false);
  const targetBusNumberRef = useRef<string[]>([]);
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
          `Opening camera for bus numbers: [${data.bus_numbers?.join(', ')}] (request_id: ${data.request_id})`
        );
        console.log('Bus numbers data type and value:', typeof data.bus_numbers, data.bus_numbers);

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

        console.log('Raw bus_numbers from backend:', data.bus_numbers);
        console.log('Is array?', Array.isArray(data.bus_numbers));

        const normalizedTargets = (data.bus_numbers || [])
          .map((bus) => {
            const normalized = normalizeBusNumber(bus);
            console.log(`Normalizing: "${bus}" → "${normalized}"`);
            return normalized;
          })
          .filter(Boolean);

        targetBusNumberRef.current = normalizedTargets;
        console.log(
          `Target bus numbers: [${data.bus_numbers?.join(', ')}] → Normalized: [${normalizedTargets.join(', ')}]`
        );
        console.log('targetBusNumberRef.current set to:', targetBusNumberRef.current);

        // Set requested bus numbers in OCR processor for O(1) lookup
        parallelOCRProcessor.setRequestedBusNumbers(normalizedTargets);

        // Set up match callback (runs in each thread independently, triggers TTS immediately)
        const matchCallback: MatchCallback = async (validatedBusNumber, objectId, ttsTrigger) => {
          console.log(
            `[Match Check] Thread ${objectId}: Checking "${validatedBusNumber}" against targets: [${targetBusNumberRef.current.join(', ')}]`
          );

          const isMatch =
            targetBusNumberRef.current.length > 0 &&
            targetBusNumberRef.current.includes(validatedBusNumber);

          console.log(`[Match Check] Thread ${objectId}: Result = ${isMatch}`);

          if (isMatch) {
            console.log('MATCH FOUND!');
            console.log(
              `   [Thread ${objectId}] Validated: "${validatedBusNumber}" matches one of targets: [${targetBusNumberRef.current.join(', ')}]`
            );

            // Set match flag IMMEDIATELY (this stops other threads from starting)
            matchFoundRef.current = true;

            // Call TTS trigger timing IMMEDIATELY
            await ttsTrigger();

            // CRITICAL: Abort other threads IMMEDIATELY to stop wasting resources
            // This happens BEFORE TTS to minimize unnecessary OCR processing
            console.log('[Match] Aborting other threads immediately...');
            parallelOCRProcessor.abortAll();

            // Stop detection loop immediately
            stopLoop();

            // Show popup and trigger TTS in PARALLEL for minimal latency
            const popupPromise = Promise.resolve(
              toastAlert({
                title: 'Bus Arrived!',
                description: `Bus ${validatedBusNumber} has arrived.`,
              })
            );

            // CRITICAL: Wait for TTS to FINISH PLAYING
            console.log('[Match] Waiting for TTS to finish playing...');
            const ttsPromise = playTTSAnnouncementImmediate(validatedBusNumber).catch((err) => {
              console.error('TTS error:', err);
            });

            // WAIT for TTS to complete before proceeding
            await Promise.all([popupPromise, ttsPromise]);
            console.log('✅ TTS playback completed');

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

        console.log('Checking bus_numbers for response:', {
          bus_numbers: data.bus_numbers,
          isArray: Array.isArray(data.bus_numbers),
          length: data.bus_numbers?.length,
          condition:
            data.bus_numbers && Array.isArray(data.bus_numbers) && data.bus_numbers.length > 0,
        });

        if (data.bus_numbers && Array.isArray(data.bus_numbers) && data.bus_numbers.length > 0) {
          let message = '';
          if (data.bus_numbers.length === 1) {
            message = `Camera started for bus number ${data.bus_numbers[0]}. `;
          } else {
            message = `Camera started for bus numbers ${data.bus_numbers.join(' and ')}. `;
          }
          console.log('Sending response:', message);
          sendResponse(message, data.request_id);
        } else {
          console.log('Sending default response (bus_numbers was empty or invalid)');
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

  // ---------------------------------- Initialize services on component mount -----------------------------------------
  // This runs ONCE when the component mounts (browser startup)
  // Independent of camera state - ready before user needs them
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setModelStatus('Initializing services...');

        // Initialize all services in parallel for fastest startup
        await Promise.all([
          modelService.initialize('/models/yolo_trained.tflite'),
          ocrService.warmup(),
          ttsService.warmup(),
        ]);

        if (mounted) {
          setModelLoaded(true);
          setModelStatus('Ready - services initialized');
          console.log('[CameraComponent] ✅ All services initialized successfully');
        }
      } catch (e: any) {
        const errorMsg = `Service initialization error: ${e?.message ?? e}`;
        if (mounted) {
          setModelStatus(errorMsg);
        }
        console.error('[CameraComponent] Service initialization error:', errorMsg, e);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []); // Run once on mount

  // ----------------------------------- detection loop lifecycle -----------------------------------
  useEffect(() => {
    if (showCamera && modelLoaded && modelService.isReady()) {
      console.log('Starting detection loop…');
      startLoop();
      return () => {
        console.log('Stopping detection loop…');
        stopLoop();
      };
    } else {
      stopLoop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCamera, modelLoaded]);

  const startLoop = useCallback(() => {
    stopLoop();
    detectionIntervalRef.current = setInterval(runDetection, DETECTION_INTERVAL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Reset service states
    ttsService.resetAnnouncements();
    audioService.reset();

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
    targetBusNumberRef.current = [];
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
      await audioService.unlock();
      setAudioReady(audioService.isReady());
      setAudioHint(audioService.getHintMessage());
    } catch (e) {
      console.warn('[CameraComponent] Audio unlock error:', e);
      setAudioReady(true);
      setAudioHint(audioService.getHintMessage());
    }
  }, []);

  // Immediate TTS without popup (popup shown separately in parallel)
  const playTTSAnnouncementImmediate = async (busNumber: string): Promise<void> => {
    if (ttsService.hasAnnounced(busNumber)) {
      console.log(`Skipping TTS for ${busNumber} - already announced`);
      return;
    }

    try {
      const text = `Bus ${busNumber} has arrived.`;
      const ttsStartTime = performance.now();

      console.log(`[TTS] Starting TTS generation for "${text}"...`);

      // Generate audio using TTS service
      const audioBlob = await ttsService.generateAudio(text);

      try {
        // Play audio using audio service
        console.log(`[TTS] Starting playback...`);
        await audioService.playAudio(audioBlob);

        const totalTime = performance.now() - ttsStartTime;
        console.log(`[TTS] ✅ Playback completed (total time: ${totalTime.toFixed(2)}ms)`);

        // Close camera after TTS finishes
        setShowCamera(false);
        setTimeout(() => clearAllStates(), 300);
      } catch (err: unknown) {
        console.error('Error playing TTS:', err);
        const errorName = err instanceof Error ? err.name : String(err);
        if (errorName.includes('NotAllowedError')) {
          setAudioHint(audioService.getHintMessage());
        }
      }
    } catch (error) {
      console.error('TTS generation error:', error);
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

    // Reuse canvas instead of creating new one for each crop (reduces GC pressure)
    if (!cropCanvasRef.current) {
      cropCanvasRef.current = document.createElement('canvas');
    }
    const c = cropCanvasRef.current;
    c.width = vw;
    c.height = vh;
    const g = c.getContext('2d');
    if (!g) return '';
    g.drawImage(video, vx, vy, vw, vh, 0, 0, vw, vh);

    return c.toDataURL('image/jpeg', 0.75);
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

    if (!video || video.readyState !== 4 || !modelService.isReady()) return;

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
      const raw = await literTModelManager.runInference(modelService.getModel(), inputTensor);
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

        if (det.confidence < 0.25) {
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

          // Update UI with detection if successful and not aborted and no match found yet
          if (
            result.success &&
            !result.wasAborted &&
            result.text !== 'None' &&
            !matchFoundRef.current
          ) {
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
      // First one to match will trigger TTS and abort the rest
      Promise.allSettled(parallelPipelines).catch((err) => {
        console.error('❌ Parallel pipeline error:', err);
      });
    } catch (e) {
      console.error('❌ Detection pipeline error:', e);
    } finally {
      performanceMonitor.end(pipelineTimer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    generateObjectId,
    sendResponse,
    stopLoop,
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
          {/* <div>{modelStatus}</div> */}
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
        <strong>Number plate Detection:</strong>{' '}
        {plateDetections.length ? ` ${plateDetections.length} plate(s)` : 'Scanning…'}
        <br />
        <strong>OCR Detections:</strong>{' '}
        {detectedBuses.size ? Array.from(detectedBuses.values()).join(', ') : 'None yet'}
        <br />
        {lastQuery?.bus_numbers &&
          Array.isArray(lastQuery.bus_numbers) &&
          lastQuery.bus_numbers.length > 0 && (
            <>
              <strong>Target Bus Numbers:</strong> [
              {lastQuery.bus_numbers.map((b) => normalizeBusNumber(b)).join(', ')}]
            </>
          )}
      </div>

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
