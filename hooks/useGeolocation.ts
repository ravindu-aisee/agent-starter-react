import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { toastAlert } from '@/components/livekit/alert-toast';
import { useDataChannelHandler } from './useDataChannelHandler';

interface GeolocationData {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

interface UseGeolocationOptions {
  enabled?: boolean;
  sendOnConnect?: boolean;
  watchPosition?: boolean;
}

/**
 * Custom hook to request user's location and send coordinates to LiveKit agent
 */
export function useGeolocation(options: UseGeolocationOptions = {}) {
  const { enabled = true, sendOnConnect = true, watchPosition = false } = options;
  const [location, setLocation] = useState<GeolocationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const room = useRoomContext();
  const { sendQuery, isAvailable } = useDataChannelHandler();
  const hasSentLocation = useRef(false);

  const sendLocationToAgent = useCallback(
    (locationData: GeolocationData, force = false) => {
      if (room.state !== 'connected') {
        console.warn('[Geolocation] Room not connected yet; will send after connect');
        return false;
      }

      if (!isAvailable) {
        console.warn('[Geolocation] Data channel not available yet');
        return false;
      }

      // Prevent duplicate sends unless forced
      if (!force && hasSentLocation.current) {
        console.log('[Geolocation] Location already sent, skipping duplicate send');
        return false;
      }

      const success = sendQuery('user_location', undefined, {
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        accuracy: locationData.accuracy,
        timestamp: locationData.timestamp,
      });

      if (success) {
        hasSentLocation.current = true;
        console.log('[Geolocation] Location sent to agent:', locationData);
        // toastAlert({
        //   title: 'Location Shared',
        //   description: `Coordinates sent to agent: ${locationData.latitude.toFixed(6)}, ${locationData.longitude.toFixed(6)}`,
        // });
      }

      return success;
    },
    [room.state, sendQuery, isAvailable]
  );

  const requestLocation = useCallback(() => {
    if (!enabled || !navigator.geolocation) {
      setError('Geolocation is not supported by this browser');
      return;
    }

    setIsLoading(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const locationData: GeolocationData = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        };

        setLocation(locationData);
        setIsLoading(false);

        console.log('[Geolocation] Location obtained:', locationData);
      },
      (error) => {
        setIsLoading(false);
        let errorMessage = 'Unable to retrieve your location';

        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location access denied by user';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location information is unavailable';
            break;
          case error.TIMEOUT:
            errorMessage = 'Location request timed out';
            break;
        }

        setError(errorMessage);
        console.error('[Geolocation] Error:', errorMessage, error);

        toastAlert({
          title: 'Location Error',
          description: errorMessage,
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  }, [enabled]);

  // Request location on mount if enabled
  useEffect(() => {
    if (enabled) {
      requestLocation();
    }
  }, [enabled, requestLocation]);

  // Send location to agent once when data channel becomes available
  useEffect(() => {
    if (
      sendOnConnect &&
      room.state === 'connected' &&
      isAvailable &&
      location &&
      !hasSentLocation.current
    ) {
      sendLocationToAgent(location);
    }
  }, [sendOnConnect, room.state, isAvailable, location, sendLocationToAgent]);

  // Watch position if enabled
  useEffect(() => {
    if (!enabled || !watchPosition || !navigator.geolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const locationData: GeolocationData = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        };

        setLocation(locationData);
        console.log('[Geolocation] Position updated:', locationData);

        // Send updated location to agent
        if (isAvailable) {
          sendLocationToAgent(locationData);
        }
      },
      (error) => {
        console.error('[Geolocation] Watch error:', error);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 27000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled, watchPosition, isAvailable, sendLocationToAgent]);

  return {
    location,
    error,
    isLoading,
    requestLocation,
    sendLocationToAgent,
  };
}
