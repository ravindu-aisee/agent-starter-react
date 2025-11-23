/**
 * TTS API Warmup Utility
 *
 * Pre-warms the TTS API route to avoid cold start latency on first real request.
 * This creates a minimal dummy request to trigger Next.js compilation and
 * Google Cloud TTS client initialization.
 */

let warmupComplete = false;
let warmupPromise: Promise<void> | null = null;

export async function warmupTTSAPI(): Promise<void> {
  // Return immediately if already warmed up
  if (warmupComplete) {
    console.log('TTS API already warmed up');
    return;
  }

  // Return existing promise if warmup is in progress
  if (warmupPromise) {
    console.log('TTS API warmup already in progress...');
    return warmupPromise;
  }

  console.log('Warming up TTS API...');

  warmupPromise = (async () => {
    try {
      // Create a minimal text payload for warmup
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'warmup' }),
      });

      if (response.ok) {
        warmupComplete = true;
        console.log('TTS API warmed up successfully');
      } else {
        console.warn('TTS API warmup returned non-OK status:', response.status);
      }
    } catch (error) {
      console.error('TTS API warmup failed:', error);
      // Don't set warmupComplete to true on error, allow retry
    } finally {
      warmupPromise = null;
    }
  })();

  return warmupPromise;
}

export function isTTSAPIWarmedUp(): boolean {
  return warmupComplete;
}
