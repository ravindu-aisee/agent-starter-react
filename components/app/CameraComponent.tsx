// src/components/app/CameraComponent.tsx

'use client';

import { useDataChannel } from '@livekit/components-react';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Webcam from 'react-webcam';

interface DataChannelMessage {
  type: 'query' | 'response';
  query?: string;
  bus_number?: string;
  timestamp?: number;
  result?: string;
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
  const [ocrResults, setOcrResults] = useState<string[]>([]);
  const webcamRef = useRef<Webcam>(null);
  const ocrIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Set up the data channel listener
  const { send } = useDataChannel((message) => {
    try {
      const data: DataChannelMessage = JSON.parse(new TextDecoder().decode(message.payload));
      console.log('📨 Received data from backend:', data);

      // Check if the backend is requesting camera access
      if (data.type === 'query') {
        console.log('🎥 Opening camera for query:', data.query);
        setShowCamera(true);
        setLastQuery(data); // Store the original query to send back with the response
      }
    } catch (error) {
      console.error('❌ Failed to parse data channel message', error);
    }
  });

  // Auto-start OCR when camera opens
  useEffect(() => {
    if (showCamera) {
      console.log('📷 Camera overlay opened');
      
      // Send camera started message to backend
      sendResponse('Camera started successfully. OCR is now running in the background.');
      
      // Wait a bit for camera to initialize, then start OCR
      setTimeout(() => {
        startContinuousOCR();
      }, 2000);
    } else {
      // Stop OCR when camera closes
      stopContinuousOCR();
    }

    return () => {
      stopContinuousOCR();
    };
  }, [showCamera]);

  const sendResponse = useCallback((result: string) => {
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
  }, [send]);

  const performOCR = useCallback(async () => {
    if (isProcessing) return;
    
    const imageSrc = webcamRef.current?.getScreenshot();
    if (!imageSrc) return;

    setIsProcessing(true);

    try {
      console.log('🔍 Running OCR on captured frame...');
      
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: imageSrc }),
      });

      if (!response.ok) {
        throw new Error(`OCR API error: ${response.statusText}`);
      }

      const result: OCRResult = await response.json();
      
      if (result.success && result.text) {
        console.log('✅ OCR detected text:', result.text);
        
        // Add to results array
        setOcrResults(prev => {
          const newResults = [...prev, result.text];
          // Keep only last 10 results
          return newResults.slice(-10);
        });

        // Check if detected text contains the bus number we're looking for
        const expectedBusNumber = lastQuery?.bus_number;
        if (expectedBusNumber && result.text.includes(expectedBusNumber)) {
          console.log(`🎯 Found bus number ${expectedBusNumber}!`);
          sendResponse(`Bus number ${expectedBusNumber} detected successfully! Full text: ${result.text}`);
          
          // Close camera after successful detection
          setTimeout(() => {
            setShowCamera(false);
          }, 2000);
        }
      } else {
        console.log('⚠️ No text detected in this frame');
      }
    } catch (error) {
      console.error('❌ OCR error:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [webcamRef, isProcessing, lastQuery, sendResponse]);

  const startContinuousOCR = useCallback(() => {
    console.log('🚀 Starting continuous OCR...');
    
    // Clear any existing interval
    if (ocrIntervalRef.current) {
      clearInterval(ocrIntervalRef.current);
    }

    // Run OCR every 2 seconds
    ocrIntervalRef.current = setInterval(() => {
      performOCR();
    }, 2000);
  }, [performOCR]);

  const stopContinuousOCR = useCallback(() => {
    console.log('🛑 Stopping continuous OCR...');
    
    if (ocrIntervalRef.current) {
      clearInterval(ocrIntervalRef.current);
      ocrIntervalRef.current = null;
    }
  }, []);

  if (!showCamera) {
    return null;
  }

  // This renders a full-screen overlay for the camera view
  return (
    <div style={{
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
    }}>
      <div style={{
        textAlign: 'center',
        marginBottom: '1.5rem',
      }}>
      </div>

      <div style={{
        width: '90%',
        maxWidth: '600px',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        border: isProcessing ? '3px solid #007bff' : '3px solid #28a745',
      }}>
        <Webcam
          audio={false}
          ref={webcamRef}
          screenshotFormat="image/jpeg"
          style={{ width: '100%', height: 'auto', display: 'block' }}
          videoConstraints={{ 
            facingMode: 'environment', // Use the rear camera on mobile
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          }}
        />
      </div>


      {lastQuery && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '8px',
          fontSize: '0.85rem',
          maxWidth: '600px',
          width: '90%',
        }}>
          <strong>Target Bus Number:</strong> {lastQuery.bus_number || 'N/A'}<br />
          <strong>Status:</strong> {isProcessing ? 'Scanning...' : 'Ready'}
        </div>
      )}
    </div>
  );
}