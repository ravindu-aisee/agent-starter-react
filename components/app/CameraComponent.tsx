// src/components/app/CameraComponent.tsx

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import * as ort from 'onnxruntime-web';
import { useDataChannel } from '@livekit/components-react';

// src/components/app/CameraComponent.tsx

// src/components/app/CameraComponent.tsx

// src/components/app/CameraComponent.tsx

// src/components/app/CameraComponent.tsx

// src/components/app/CameraComponent.tsx

interface DataChannelMessage {
  type: 'query' | 'response';
  bus_number?: string;
  timestamp?: number;
  result?: string;
}

interface Detection {
  bbox: [number, number, number, number]; // [x, y, width, height]
  confidence: number;
  class_id: number;
}

interface OCRResult {
  success: boolean;
  text: string;
  detections: Array<{
    text: string;
    bounds: any;
  }>;
  wordCount?: number;
  message?: string;
}

export function CameraComponent() {
  const [showCamera, setShowCamera] = useState(false);
  const [lastQuery, setLastQuery] = useState<DataChannelMessage | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [plateDetections, setPlateDetections] = useState<Detection[]>([]);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelStatus, setModelStatus] = useState('Initializing...');
  const [ocrResults, setOcrResults] = useState<string[]>([]);
  const [detectedBuses, setDetectedBuses] = useState<Map<number, string>>(new Map());

  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const modelRef = useRef<ort.InferenceSession | null>(null);
  const frameCountRef = useRef(0);
  const processingIdsRef = useRef<Set<number>>(new Set());
  const announcedBusesRef = useRef<Set<string>>(new Set()); // Track announced buses to prevent duplicate TTS

  // Detect if running on mobile device
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );

  // Configuration - Optimized for mobile performance
  const PROCESS_EVERY_N_FRAMES = isMobileDevice ? 4 : 2; // Skip more frames on mobile
  const YOLO_CONF = 0.25; // YOLO confidence threshold
  const YOLO_IOU = 0.45; // YOLO IOU threshold for NMS
  const DETECTION_INTERVAL_MS = isMobileDevice ? 250 : 150; // Slower interval on mobile

  // Valid bus route numbers for Sri Lanka
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
    '136',
    '272',
    '27A',
    '34A',
  ];

  const { send } = useDataChannel((message) => {
    try {
      const data: DataChannelMessage = JSON.parse(new TextDecoder().decode(message.payload));
      console.log('📨 Received data from backend:', data);

      if (data.type === 'query') {
        console.log('🎥 Opening camera for query:', data.bus_number);
        setShowCamera(true);
        setLastQuery(data);

        // Reset state for new query
        setDetectedBuses(new Map());
        setOcrResults([]);
        processingIdsRef.current.clear();
        announcedBusesRef.current.clear(); // Clear announced buses for new query
        frameCountRef.current = 0;
      }
    } catch (error) {
      console.error('❌ Failed to parse data channel message', error);
    }
  });

  useEffect(() => {
    console.log('🚀 CameraComponent mounted - starting model load...');
    loadModel();
  }, []);

  const loadModel = async () => {
    try {
      setModelStatus('Initializing ONNX Runtime...');
      console.log('🔄 Initializing ONNX Runtime Web...');

      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = '/onnx-wasm/';
      ort.env.logLevel = 'error'; // Suppress warnings

      setModelStatus('Loading YOLO model...');
      console.log('🔄 Loading ONNX YOLO model from /models/best3.onnx...');

      const session = await ort.InferenceSession.create('/models/best3.onnx', {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3, // 0=Verbose, 1=Info, 2=Warning, 3=Error, 4=Fatal
      });

      modelRef.current = session;

      console.log('📋 Model inputs:', session.inputNames);
      console.log('📋 Model outputs:', session.outputNames);

      setModelLoaded(true);
      setModelStatus('Model ready - detecting bus number plates');
      console.log('✅ ONNX YOLO model loaded successfully!');
    } catch (error) {
      console.error('❌ Failed to load ONNX model:', error);
      setModelStatus(
        `Error loading model: ${error instanceof Error ? error.message : 'Failed to load model'}`
      );
    }
  };

  useEffect(() => {
    if (showCamera && modelLoaded) {
      const targetBusNumber = lastQuery?.bus_number;
      console.log('Camera overlay opened - starting bus plate detection');
      console.log(`🎯 Target bus number: ${targetBusNumber || 'Not specified'}`);

      if (targetBusNumber) {
        sendResponse(`Camera started - scanning for bus number ${targetBusNumber}...`);
      } else {
        sendResponse('Camera started successfully');
      }

      setTimeout(() => {
        startContinuousDetection();
      }, 1000);
    } else {
      stopContinuousDetection();
    }

    return () => {
      stopContinuousDetection();
    };
  }, [showCamera, modelLoaded, lastQuery]);

  const sendResponse = useCallback(
    (result: string) => {
      if (!send) {
        console.error('❌ Data channel send function not available');
        return;
      }

      const response: DataChannelMessage = {
        type: 'response',
        result: result,
      };

      console.log('📤 Sending response to backend:', response);

      try {
        const encoder = new TextEncoder();
        const payload = encoder.encode(JSON.stringify(response));
        send(payload, { reliable: true });
        console.log('✅ Response sent successfully');
      } catch (error) {
        console.error('❌ Failed to send response:', error);
      }
    },
    [send]
  );

  const preprocessImage = (videoElement: HTMLVideoElement): Float32Array => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');

    if (!ctx) throw new Error('Failed to get canvas context');

    ctx.drawImage(videoElement, 0, 0, 640, 640);

    const imageData = ctx.getImageData(0, 0, 640, 640);
    const pixels = imageData.data;

    // Convert to Float32Array and normalize [0, 255] -> [0, 1]
    // CHW format: [1, 3, 640, 640]
    const float32Data = new Float32Array(3 * 640 * 640);

    for (let i = 0; i < 640 * 640; i++) {
      float32Data[i] = pixels[i * 4] / 255.0; // R
      float32Data[640 * 640 + i] = pixels[i * 4 + 1] / 255.0; // G
      float32Data[640 * 640 * 2 + i] = pixels[i * 4 + 2] / 255.0; // B
    }

    return float32Data;
  };

  const processBusPlateDetections = (
    output: Float32Array,
    outputShape: number[],
    imgWidth: number,
    imgHeight: number
  ): Detection[] => {
    console.log('📊 Processing detections. Output shape:', outputShape);

    const detections: Detection[] = [];

    // Handle YOLO output format: [1, 5, 8400] or [1, 8400, 5]
    let numBoxes: number;
    let numAttributes: number;
    let isTransposed = false;

    if (outputShape.length === 3) {
      if (outputShape[1] === 5 || outputShape[1] === 6) {
        // [1, 5, 8400] format
        numAttributes = outputShape[1];
        numBoxes = outputShape[2];
        isTransposed = false;
      } else {
        // [1, 8400, 5] format
        numBoxes = outputShape[1];
        numAttributes = outputShape[2];
        isTransposed = true;
      }
    } else {
      console.error('Unexpected output shape:', outputShape);
      return [];
    }

    console.log(
      `📦 Format: ${isTransposed ? 'Transposed' : 'Normal'}, Boxes: ${numBoxes}, Attributes: ${numAttributes}`
    );

    for (let i = 0; i < numBoxes; i++) {
      let centerX, centerY, width, height, confidence, classId;

      if (isTransposed) {
        // [1, 8400, 5] or [1, 8400, 6]
        const offset = i * numAttributes;
        centerX = output[offset];
        centerY = output[offset + 1];
        width = output[offset + 2];
        height = output[offset + 3];
        confidence = output[offset + 4];
        classId = numAttributes > 5 ? output[offset + 5] : 0;
      } else {
        // [1, 5, 8400] or [1, 6, 8400]
        centerX = output[0 * numBoxes + i];
        centerY = output[1 * numBoxes + i];
        width = output[2 * numBoxes + i];
        height = output[3 * numBoxes + i];
        confidence = output[4 * numBoxes + i];
        classId = numAttributes > 5 ? output[5 * numBoxes + i] : 0;
      }

      if (confidence > YOLO_CONF) {
        // Convert from center format to corner format
        // Scale from 640 to actual image size
        const x = ((centerX - width / 2) * imgWidth) / 640;
        const y = ((centerY - height / 2) * imgHeight) / 640;
        const w = (width * imgWidth) / 640;
        const h = (height * imgHeight) / 640;

        // Clamp to image bounds
        const clampedX = Math.max(0, x);
        const clampedY = Math.max(0, y);
        const clampedW = Math.min(imgWidth - clampedX, w);
        const clampedH = Math.min(imgHeight - clampedY, h);

        if (clampedW > 0 && clampedH > 0) {
          detections.push({
            bbox: [clampedX, clampedY, clampedW, clampedH],
            confidence: confidence,
            class_id: Math.round(classId),
          });

          if (detections.length <= 5) {
            console.log(
              `🎯 Detection ${detections.length}: conf=${confidence.toFixed(3)}, bbox=[${clampedX.toFixed(1)}, ${clampedY.toFixed(1)}, ${clampedW.toFixed(1)}, ${clampedH.toFixed(1)}]`
            );
          }
        }
      }
    }

    console.log(`✅ Found ${detections.length} detections above threshold ${YOLO_CONF}`);

    if (detections.length > 0) {
      const nmsDetections = applyNMS(detections, YOLO_IOU);
      console.log(`🔍 After NMS: ${nmsDetections.length} detections`);
      return nmsDetections;
    }

    return detections;
  };

  const applyNMS = (detections: Detection[], iouThreshold: number): Detection[] => {
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
    const keep: Detection[] = [];

    for (const detection of sorted) {
      let shouldKeep = true;

      for (const kept of keep) {
        const iou = calculateIoU(detection.bbox, kept.bbox);
        if (iou > iouThreshold) {
          shouldKeep = false;
          break;
        }
      }

      if (shouldKeep) {
        keep.push(detection);
      }
    }

    return keep;
  };

  const calculateIoU = (box1: number[], box2: number[]): number => {
    const [x1, y1, w1, h1] = box1;
    const [x2, y2, w2, h2] = box2;

    const x1_max = x1 + w1;
    const y1_max = y1 + h1;
    const x2_max = x2 + w2;
    const y2_max = y2 + h2;

    const intersectX = Math.max(0, Math.min(x1_max, x2_max) - Math.max(x1, x2));
    const intersectY = Math.max(0, Math.min(y1_max, y2_max) - Math.max(y1, y2));
    const intersectArea = intersectX * intersectY;

    const box1Area = w1 * h1;
    const box2Area = w2 * h2;
    const unionArea = box1Area + box2Area - intersectArea;

    return intersectArea / unionArea;
  };

  const captureFullFrame = (videoElement: HTMLVideoElement): string => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const videoWidth = videoElement.videoWidth;
    const videoHeight = videoElement.videoHeight;

    // Capture the full frame at high resolution
    canvas.width = videoWidth;
    canvas.height = videoHeight;

    try {
      ctx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
      console.log(`� Captured full frame: ${videoWidth}x${videoHeight}`);
      return canvas.toDataURL('image/jpeg', 0.95);
    } catch (error) {
      console.error('❌ Error capturing frame:', error);
      return '';
    }
  };

  const cropDetectedPlate = (
    videoElement: HTMLVideoElement,
    bbox: [number, number, number, number],
    padding: number = 0.2
  ): string => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const [x, y, w, h] = bbox;
    const videoWidth = videoElement.videoWidth;
    const videoHeight = videoElement.videoHeight;

    // Add padding around the detection (20% on each side by default)
    const paddingX = w * padding;
    const paddingY = h * padding;

    // Calculate cropped region with padding
    const cropX = Math.max(0, x - paddingX);
    const cropY = Math.max(0, y - paddingY);
    const cropW = Math.min(videoWidth - cropX, w + paddingX * 2);
    const cropH = Math.min(videoHeight - cropY, h + paddingY * 2);

    // Set canvas to cropped size
    canvas.width = cropW;
    canvas.height = cropH;

    try {
      // Draw only the cropped region
      ctx.drawImage(
        videoElement,
        cropX,
        cropY,
        cropW,
        cropH, // Source rectangle
        0,
        0,
        cropW,
        cropH // Destination rectangle
      );

      console.log(
        `✂️ Cropped plate region: ${cropW.toFixed(0)}x${cropH.toFixed(0)} (from ${x.toFixed(0)},${y.toFixed(0)},${w.toFixed(0)},${h.toFixed(0)} with ${padding * 100}% padding)`
      );
      return canvas.toDataURL('image/jpeg', 0.95);
    } catch (error) {
      console.error('❌ Error cropping plate:', error);
      return '';
    }
  };

  const runOCRAndGetText = async (croppedImage: string): Promise<string> => {
    try {
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: croppedImage }),
      });

      if (!response.ok) {
        console.error(`OCR API error: ${response.statusText}`);
        return 'None';
      }

      const result: OCRResult = await response.json();

      if (result.success && result.text) {
        // Normalize: uppercase, alphanumeric only
        const normalized = result.text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

        // Find the closest valid bus route
        const closestMatch = findClosestValidRoute(normalized);
        return closestMatch;
      }

      return 'None';
    } catch (error) {
      console.error('❌ OCR error:', error);
      return 'None';
    }
  };

  // Find closest matching valid bus route using fuzzy matching
  const findClosestValidRoute = (ocrText: string): string => {
    if (!ocrText || ocrText === 'None') return 'None';

    console.log(`🔍 Validating OCR result: "${ocrText}"`);

    // Reject very short results (likely noise)
    if (ocrText.length < 2) {
      console.log(`❌ OCR text too short (${ocrText.length} chars): "${ocrText}" - rejecting`);
      return 'None';
    }

    // First, check for exact match
    if (VALID_BUS_ROUTES.includes(ocrText)) {
      console.log(`✅ Exact match found: ${ocrText}`);
      return ocrText;
    }

    // Check if any valid route is contained in the OCR text
    // This handles cases where OCR returns extra characters
    // Only accept if the route is at least 50% of the OCR text length
    for (const route of VALID_BUS_ROUTES) {
      if (ocrText.includes(route) && route.length >= ocrText.length * 0.5) {
        console.log(`✅ Found valid route in OCR text: ${route} (from "${ocrText}")`);
        return route;
      }
    }

    // Check if OCR text is contained in any valid route
    // This handles cases where OCR returns partial matches
    // Require minimum 2 characters and at least 60% match
    for (const route of VALID_BUS_ROUTES) {
      if (route.includes(ocrText) && ocrText.length >= 2 && ocrText.length >= route.length * 0.6) {
        console.log(`✅ OCR text matches part of route: ${route} (from "${ocrText}")`);
        return route;
      }
    }

    // Calculate Levenshtein distance for fuzzy matching (only for very close matches)
    let bestMatch = 'None';
    let bestDistance = Infinity;

    for (const route of VALID_BUS_ROUTES) {
      const distance = levenshteinDistance(ocrText, route);
      // Only accept if distance is 1 (allows for 1 character difference only)
      // AND the lengths are similar (within 1 character)
      const lengthDiff = Math.abs(ocrText.length - route.length);
      if (distance <= 1 && lengthDiff <= 1 && distance < bestDistance) {
        bestDistance = distance;
        bestMatch = route;
      }
    }

    if (bestMatch !== 'None') {
      console.log(
        `✅ Close match found: ${bestMatch} (from "${ocrText}", distance: ${bestDistance})`
      );
      return bestMatch;
    }

    // If no valid match found, return 'None' instead of the OCR text
    // This prevents showing random letters/characters
    console.log(`❌ No valid route match for: "${ocrText}" - rejecting result`);
    return 'None';
  };

  // Levenshtein distance algorithm for fuzzy string matching
  const levenshteinDistance = (str1: string, str2: string): number => {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix: number[][] = [];

    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    return matrix[len1][len2];
  };

  const saveImageAsync = (imageData: string, filename: string) => {
    // Fire and forget - save asynchronously without blocking
    fetch('/api/save-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: imageData, filename }),
    })
      .then((response) => {
        if (response.ok) {
          return response.json();
        } else {
          throw new Error(`Failed to save image: ${response.statusText}`);
        }
      })
      .then((result) => {
        console.log(`💾 Image saved: ${result.path}`);
      })
      .catch((error) => {
        console.error(`❌ Error saving image ${filename}:`, error);
      });
  };

  const annotateAndSaveImage = (
    imageData: string,
    text: string,
    confidence: number,
    filename: string
  ) => {
    // Create a new canvas to add text annotation
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');

      if (ctx) {
        // Draw the original image
        ctx.drawImage(img, 0, 0);

        // Add text annotation at the top
        const fontSize = Math.max(20, Math.floor(img.height / 10));
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.fillStyle = 'rgba(0, 255, 0, 0.9)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 3;

        const label = `${text} (${(confidence * 100).toFixed(1)}%)`;
        const textMetrics = ctx.measureText(label);
        const padding = 10;

        // Background for text
        ctx.fillRect(0, 0, textMetrics.width + padding * 2, fontSize + padding * 2);

        // Draw text with outline
        ctx.strokeText(label, padding, fontSize + padding / 2);
        ctx.fillStyle = '#000000';
        ctx.fillText(label, padding, fontSize + padding / 2);

        // Save the annotated image
        const annotatedImageData = canvas.toDataURL('image/jpeg', 0.95);
        saveImageAsync(annotatedImageData, filename);
      }
    };
    img.src = imageData;
  };

  // Text-to-Speech using Google Cloud TTS API
  // Function to clear all states and reset for next query
  const clearAllStates = () => {
    console.log('🧹 Clearing all states for fresh start...');

    // Clear state variables
    setPlateDetections([]);
    setOcrResults([]);
    setDetectedBuses(new Map());
    setIsProcessing(false);
    setLastQuery(null);

    // Clear refs
    frameCountRef.current = 0;
    processingIdsRef.current.clear();
    announcedBusesRef.current.clear();

    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    console.log('✅ All states cleared - ready for next query');
  };

  const playTTSAnnouncement = async (busNumber: string) => {
    // Check if this bus number has already been announced
    if (announcedBusesRef.current.has(busNumber)) {
      console.log(`🔇 Skipping TTS for ${busNumber} - already announced`);
      return;
    }

    try {
      const text = `Bus ${busNumber} has arrived.`;
      console.log(`🔊 Playing TTS: "${text}"`);

      // Mark as announced BEFORE making the API call to prevent race conditions
      announcedBusesRef.current.add(busNumber);

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        console.error(`TTS API error: ${response.statusText}`);
        // Remove from announced set on failure so it can be retried
        announcedBusesRef.current.delete(busNumber);
        return;
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio
        .play()
        .then(() => {
          console.log('✅ TTS played successfully');
        })
        .catch((error) => {
          console.error('❌ Error playing TTS:', error);
          // Remove from announced set on playback failure
          announcedBusesRef.current.delete(busNumber);
        });

      // Clean up the URL and clear states after playing
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        console.log('🎵 TTS playback finished');
        // Clear all states after TTS completes
        setTimeout(() => {
          clearAllStates();
        }, 500); // Small delay to ensure cleanup happens smoothly
      };
    } catch (error) {
      console.error('❌ TTS error:', error);
      // Remove from announced set on error
      announcedBusesRef.current.delete(busNumber);
    }
  };

  const runDetection = useCallback(async () => {
    if (isProcessing || !modelRef.current || !webcamRef.current?.video) return;

    const video = webcamRef.current.video;
    if (video.readyState !== 4) return;

    frameCountRef.current++;

    // Only process every Nth frame (match Python)
    if (frameCountRef.current % PROCESS_EVERY_N_FRAMES !== 0) {
      return;
    }

    setIsProcessing(true);

    try {
      const imgData = preprocessImage(video);
      const inputTensor = new ort.Tensor('float32', imgData, [1, 3, 640, 640]);
      const inputName = modelRef.current.inputNames[0];

      console.log('🔮 Running ONNX model inference...');
      const startTime = performance.now();

      const feeds: Record<string, ort.Tensor> = {};
      feeds[inputName] = inputTensor;

      const outputs = await modelRef.current.run(feeds);

      const inferenceTime = performance.now() - startTime;
      console.log(`⚡ Inference completed in ${inferenceTime.toFixed(2)}ms`);

      const outputName = modelRef.current.outputNames[0];
      const outputTensor = outputs[outputName];
      const outputData = outputTensor.data as Float32Array;
      const outputShape = outputTensor.dims as number[];

      const detections = processBusPlateDetections(
        outputData,
        outputShape,
        video.videoWidth,
        video.videoHeight
      );

      setPlateDetections(detections);

      if (detections.length > 0) {
        console.log(`🚌 Found ${detections.length} bus plate(s)`);
        drawDetections(detections, video.videoWidth, video.videoHeight);

        const expectedBusNumber = lastQuery?.bus_number;
        const timestamp = Date.now();

        // Capture full frame once for saving/annotation purposes
        const fullFrame = captureFullFrame(video);

        if (!fullFrame) {
          console.error('❌ Failed to capture full frame');
          return;
        }

        // Save full frame asynchronously (fire and forget) for reference
        const frameFilename = `full_frame_${timestamp}.jpg`;
        saveImageAsync(fullFrame, frameFilename);
        console.log(`💾 Saving full frame: ${frameFilename}`);

        // Process each detection with immediate OCR (in parallel)
        const ocrPromises = detections.map(async (detection, index) => {
          // Create a pseudo track_id based on bbox position
          const trackId = Math.round(detection.bbox[0] * 100 + detection.bbox[1] * 100);

          // Skip if already detected this bus
          if (detectedBuses.has(trackId)) {
            return null;
          }

          // Skip if currently processing
          if (processingIdsRef.current.has(trackId)) {
            return null;
          }

          // Mark as processing
          processingIdsRef.current.add(trackId);

          console.log(
            `🔍 Processing detection ${index + 1}/${detections.length} (ID: ${trackId})...`
          );

          // Crop only the detected plate region with padding for OCR
          const croppedPlate = cropDetectedPlate(video, detection.bbox, 0.2);

          if (!croppedPlate) {
            console.error('❌ Failed to crop plate region');
            processingIdsRef.current.delete(trackId);
            return null;
          }

          // Save the cropped plate for verification (before OCR)
          const croppedFilename = `cropped_plate_${trackId}_${timestamp}.jpg`;
          saveImageAsync(croppedPlate, croppedFilename);
          console.log(`💾 Saving cropped plate: ${croppedFilename}`);

          // Run OCR on the CROPPED plate image instead of full frame
          const ocrStartTime = performance.now();
          const ocrResult = await runOCRAndGetText(fullFrame);
          const ocrTime = performance.now() - ocrStartTime;

          console.log(`⚡ OCR completed in ${ocrTime.toFixed(2)}ms: "${ocrResult}"`);
          console.log(`📸 OCR was performed on CROPPED plate image, not full frame`);

          // Remove from processing
          processingIdsRef.current.delete(trackId);

          if (ocrResult && ocrResult !== 'None') {
            console.log(`✅ Detected bus number: ${ocrResult} (ID ${trackId})`);
            setDetectedBuses((prev) => new Map(prev).set(trackId, ocrResult));
            setOcrResults((prev) => [...prev, ocrResult].slice(-5));

            // Save the CROPPED plate image with annotation
            const annotatedFilename = `bus_${ocrResult}_${trackId}_${timestamp}.jpg`;
            annotateAndSaveImage(fullFrame, ocrResult, detection.confidence, annotatedFilename);
            console.log(`💾 Saving annotated cropped plate: ${annotatedFilename}`);

            // Check if this matches the target
            if (expectedBusNumber && ocrResult === expectedBusNumber.toUpperCase()) {
              console.log(`🎯 TARGET FOUND: ${ocrResult}`);
              sendResponse(`Bus number ${expectedBusNumber} detected successfully!`);

              // Play TTS announcement
              playTTSAnnouncement(ocrResult);

              // Close camera after TTS finishes (clearAllStates will be called in TTS onended)
              setTimeout(() => {
                setShowCamera(false);
              }, 3500); // Give time for TTS to play and cleanup to complete
            } else {
              sendResponse(`Detected bus: ${ocrResult}`);
            }

            return ocrResult;
          }

          return null;
        });

        // Run all OCR operations in parallel (non-blocking)
        Promise.all(ocrPromises)
          .then((results) => {
            const validResults = results.filter((r) => r !== null);
            if (validResults.length > 0) {
              console.log(`✅ OCR completed for ${validResults.length} detection(s)`);
            }
          })
          .catch((error) => {
            console.error('❌ Error in parallel OCR:', error);
          });
      } else {
        // Clear canvas
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        }
      }
    } catch (error) {
      console.error('❌ Detection error:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, lastQuery, sendResponse, detectedBuses]);

  const drawDetections = (detections: Detection[], videoWidth: number, videoHeight: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = videoWidth;
    canvas.height = videoHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    detections.forEach((detection, index) => {
      const [x, y, w, h] = detection.bbox;

      // Green box
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);

      // Draw corners
      const cornerLength = Math.min(w, h) * 0.15;
      ctx.lineWidth = 4;

      // Top-left
      ctx.beginPath();
      ctx.moveTo(x, y + cornerLength);
      ctx.lineTo(x, y);
      ctx.lineTo(x + cornerLength, y);
      ctx.stroke();

      // Top-right
      ctx.beginPath();
      ctx.moveTo(x + w - cornerLength, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + cornerLength);
      ctx.stroke();

      // Bottom-left
      ctx.beginPath();
      ctx.moveTo(x, y + h - cornerLength);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + cornerLength, y + h);
      ctx.stroke();

      // Bottom-right
      ctx.beginPath();
      ctx.moveTo(x + w - cornerLength, y + h);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w, y + h - cornerLength);
      ctx.stroke();

      // Label
      const label = `Bus Plate ${(detection.confidence * 100).toFixed(1)}%`;
      ctx.font = 'bold 16px Arial';
      const textMetrics = ctx.measureText(label);
      const textWidth = textMetrics.width;
      const textHeight = 20;

      ctx.fillStyle = 'rgba(0, 255, 0, 0.9)';
      ctx.fillRect(x, y - textHeight - 8, textWidth + 16, textHeight + 8);

      ctx.fillStyle = '#000000';
      ctx.fillText(label, x + 8, y - 8);
    });
  };

  const startContinuousDetection = useCallback(() => {
    console.log('🚀 Starting continuous bus plate detection...');
    console.log(`📱 Device type: ${isMobileDevice ? 'Mobile' : 'Desktop'}`);
    console.log(
      `⚙️ Detection interval: ${DETECTION_INTERVAL_MS}ms, Frame skip: every ${PROCESS_EVERY_N_FRAMES} frames`
    );

    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
    }

    // Run detection with optimized interval based on device type
    detectionIntervalRef.current = setInterval(() => {
      runDetection();
    }, DETECTION_INTERVAL_MS);
  }, [runDetection, isMobileDevice, DETECTION_INTERVAL_MS, PROCESS_EVERY_N_FRAMES]);

  const stopContinuousDetection = useCallback(() => {
    console.log('🛑 Stopping continuous detection...');

    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, []);

  if (!showCamera) {
    return (
      <div
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          padding: '12px 20px',
          backgroundColor: modelLoaded ? 'rgba(0, 255, 0, 0.2)' : 'rgba(255, 165, 0, 0.2)',
          border: modelLoaded ? '2px solid #00ff00' : '2px solid #ffa500',
          borderRadius: '8px',
          color: 'white',
          fontSize: '0.85rem',
          zIndex: 999,
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
        }}
      >
        <strong>🤖 YOLO Model:</strong> {modelLoaded ? '✅ Ready' : '⏳ Loading...'}
        {!modelLoaded && (
          <div style={{ fontSize: '0.75rem', marginTop: '4px', opacity: 0.8 }}>{modelStatus}</div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
      }}
    >
      {!modelLoaded && (
        <div style={{ marginBottom: '1rem', fontSize: '1.2rem' }}>{modelStatus}</div>
      )}

      <div
        style={{
          position: 'relative',
          width: '90%',
          maxWidth: '600px',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          border: plateDetections.length > 0 ? '3px solid #00ff00' : '3px solid #666',
        }}
      >
        <Webcam
          audio={false}
          ref={webcamRef}
          screenshotFormat="image/jpeg"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          videoConstraints={{
            facingMode: 'environment',
            // Reduce resolution on mobile for better performance
            width: { ideal: isMobileDevice ? 1280 : 1920, max: 1920 },
            height: { ideal: isMobileDevice ? 720 : 1080, max: 1080 },
            frameRate: { ideal: isMobileDevice ? 24 : 30, max: 30 },
          }}
        />

        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
      </div>

      <div
        style={{
          marginTop: '1rem',
          padding: '1rem',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '8px',
          fontSize: '0.85rem',
          maxWidth: '600px',
          width: '90%',
        }}
      >
        <strong>Model:</strong> {modelLoaded ? '✅ Ready' : '⏳ Loading...'}
        <br />
        <strong>Detection:</strong>{' '}
        {plateDetections.length > 0
          ? `🎯 ${plateDetections.length} Bus Plate(s)`
          : '🔍 Scanning...'}
        <br />
        <strong>Detected Buses:</strong>{' '}
        {detectedBuses.size > 0 ? Array.from(detectedBuses.values()).join(', ') : 'None yet'}
        {lastQuery?.bus_number && (
          <>
            <br />
            <strong>Target Bus:</strong> {lastQuery.bus_number}
          </>
        )}
      </div>

      {ocrResults.length > 0 && (
        <div
          style={{
            marginTop: '0.5rem',
            padding: '0.75rem',
            background: 'rgba(0,255,0,0.15)',
            borderRadius: '8px',
            fontSize: '0.8rem',
            maxWidth: '600px',
            width: '90%',
            maxHeight: '100px',
            overflowY: 'auto',
          }}
        >
          <strong>Recent Detections:</strong>
          {ocrResults.map((text, idx) => (
            <div key={idx} style={{ marginTop: '0.25rem' }}>
              {idx + 1}. {text}
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => {
          setShowCamera(false);
          clearAllStates(); // Clear all states when manually closing camera
        }}
        style={{
          marginTop: '1rem',
          padding: '0.75rem 2rem',
          fontSize: '1rem',
          backgroundColor: '#dc3545',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
        }}
      >
        Close Camera
      </button>
    </div>
  );
}
