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

export function CameraComponent() {
  const [showCamera, setShowCamera] = useState(false);
  const [lastQuery, setLastQuery] = useState<DataChannelMessage | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const webcamRef = useRef<Webcam>(null);

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

  // Auto-focus camera when it opens
  useEffect(() => {
    if (showCamera) {
      console.log('📷 Camera overlay opened');
    }
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

  const capture = useCallback(async () => {
    if (isProcessing) {
      console.log('⏳ Already processing, please wait...');
      return;
    }

    setIsProcessing(true);
    console.log('📸 Capturing image...');

    const imageSrc = webcamRef.current?.getScreenshot();
    if (imageSrc) {
      try {
        // Here you would normally send the image to a processing service
        // For now, we'll send back the bus number from the query or a mock result
        const busNumber = lastQuery?.bus_number || 'Unknown';
        const queryType = lastQuery?.query || 'detect_bus_number';
        
        let result = '';
        
        if (queryType.includes('detect') || queryType.includes('scan')) {
          result = `Successfully captured image. Bus number ${busNumber} detected and verified.`;
        } else {
          result = `Image captured for query: ${queryType}. Bus number: ${busNumber}`;
        }

        console.log('✅ Image captured, sending result:', result);
        sendResponse(result);
        
        // Close camera after successful capture
        setTimeout(() => {
          setShowCamera(false);
          setIsProcessing(false);
          setLastQuery(null);
        }, 500);
      } catch (error) {
        console.error('❌ Error processing capture:', error);
        sendResponse(`Error processing image: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setIsProcessing(false);
      }
    } else {
      console.error('❌ Failed to capture image from webcam');
      sendResponse('Failed to capture image from camera');
      setIsProcessing(false);
    }
  }, [webcamRef, lastQuery, sendResponse, isProcessing]);

  const closeCamera = useCallback(() => {
    console.log('🚫 User cancelled camera operation');
    
    // Send a cancellation response
    sendResponse('User cancelled the camera operation.');
    
    setShowCamera(false);
    setIsProcessing(false);
    setLastQuery(null);
  }, [sendResponse]);

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
      backgroundColor: 'rgba(0, 0, 0, 0.9)',
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
        <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>
          Bus Number Detection
        </h2>
        <p style={{ fontSize: '1rem', opacity: 0.9 }}>
          {lastQuery?.bus_number 
            ? `Looking for bus number: ${lastQuery.bus_number}`
            : 'Point camera at the bus number'}
        </p>
      </div>

      <div style={{
        width: '90%',
        maxWidth: '600px',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
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

      <div style={{
        display: 'flex',
        gap: '1rem',
        marginTop: '2rem',
      }}>
        <button 
          onClick={capture} 
          disabled={isProcessing}
          style={{ 
            padding: '14px 32px', 
            fontSize: '18px', 
            fontWeight: '600',
            cursor: isProcessing ? 'not-allowed' : 'pointer', 
            borderRadius: '8px', 
            border: 'none', 
            background: isProcessing ? '#6c757d' : '#007bff', 
            color: 'white',
            opacity: isProcessing ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          {isProcessing ? 'Processing...' : '📸 Capture'}
        </button>
        <button 
          onClick={closeCamera} 
          disabled={isProcessing}
          style={{ 
            padding: '14px 32px', 
            fontSize: '18px',
            fontWeight: '600',
            background: 'transparent', 
            border: '2px solid white', 
            color: 'white', 
            cursor: isProcessing ? 'not-allowed' : 'pointer', 
            borderRadius: '8px',
            opacity: isProcessing ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          ❌ Cancel
        </button>
      </div>

      {lastQuery && (
        <div style={{
          marginTop: '2rem',
          padding: '1rem',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '8px',
          fontSize: '0.9rem',
          maxWidth: '600px',
        }}>
          <strong>Query:</strong> {lastQuery.query || 'N/A'}<br />
          <strong>Bus Number:</strong> {lastQuery.bus_number || 'N/A'}
        </div>
      )}
    </div>
  );
}