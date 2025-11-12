import { useCallback } from 'react';
import { useDataChannel } from '@livekit/components-react';

interface DataChannelMessage {
  type: 'query' | 'response';
  query?: string;
  bus_number?: string;
  timestamp?: number;
  result?: string;
}

interface DataChannelHandlerOptions {
  onQuery?: (message: DataChannelMessage) => void;
  onResponse?: (message: DataChannelMessage) => void;
  onError?: (error: Error) => void;
}

/**
 * Custom hook to handle data channel communication with the LiveKit AI Agent backend
 * Provides utilities for sending and receiving messages via data channel
 */
export function useDataChannelHandler(options: DataChannelHandlerOptions = {}) {
  const { onQuery, onResponse, onError } = options;

  // Set up the data channel with message handling
  const { send } = useDataChannel((message) => {
    try {
      const decoder = new TextDecoder();
      const data: DataChannelMessage = JSON.parse(decoder.decode(message.payload));
      
      console.log('📨 [DataChannel] Received message:', data);

      // Route message based on type
      switch (data.type) {
        case 'query':
          onQuery?.(data);
          break;
        case 'response':
          onResponse?.(data);
          break;
        default:
          console.warn('⚠️ [DataChannel] Unknown message type:', data);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('❌ [DataChannel] Failed to parse message:', err);
      onError?.(err);
    }
  });

  /**
   * Send a response back to the AI agent
   */
  const sendResponse = useCallback(
    (result: string, additionalData?: Partial<DataChannelMessage>) => {
      if (!send) {
        console.error('❌ [DataChannel] Send function not available');
        return false;
      }

      const response: DataChannelMessage = {
        type: 'response',
        result,
        timestamp: Date.now(),
        ...additionalData,
      };

      console.log('📤 [DataChannel] Sending response:', response);

      try {
        const encoder = new TextEncoder();
        const payload = encoder.encode(JSON.stringify(response));
        send(payload, { reliable: true });
        console.log('✅ [DataChannel] Response sent successfully');
        return true;
      } catch (error) {
        console.error('❌ [DataChannel] Failed to send response:', error);
        onError?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    [send, onError]
  );

  /**
   * Send a query to the AI agent (if needed for frontend-initiated communication)
   */
  const sendQuery = useCallback(
    (query: string, bus_number?: string, additionalData?: Partial<DataChannelMessage>) => {
      if (!send) {
        console.error('❌ [DataChannel] Send function not available');
        return false;
      }

      const message: DataChannelMessage = {
        type: 'query',
        query,
        bus_number,
        timestamp: Date.now(),
        ...additionalData,
      };

      console.log('📤 [DataChannel] Sending query:', message);

      try {
        const encoder = new TextEncoder();
        const payload = encoder.encode(JSON.stringify(message));
        send(payload, { reliable: true });
        console.log('✅ [DataChannel] Query sent successfully');
        return true;
      } catch (error) {
        console.error('❌ [DataChannel] Failed to send query:', error);
        onError?.(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    [send, onError]
  );

  return {
    sendResponse,
    sendQuery,
    isAvailable: !!send,
  };
}
