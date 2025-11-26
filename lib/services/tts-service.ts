/**
 * TTSService - Handles Text-to-Speech API warmup and audio playback
 * Initializes on browser startup to avoid cold starts
 */
export class TTSService {
  private isWarmedUp = false;
  private warmupPromise: Promise<void> | null = null;
  private announcedBuses = new Set<string>();

  /**
   * Warm up the TTS API on startup
   * Safe to call multiple times - will only warm up once
   */
  async warmup(): Promise<void> {
    if (this.isWarmedUp) {
      console.log('[TTSService] Already warmed up');
      return;
    }

    if (this.warmupPromise) {
      console.log('[TTSService] Waiting for existing warmup...');
      return this.warmupPromise;
    }

    this.warmupPromise = this._performWarmup();

    try {
      await this.warmupPromise;
      this.isWarmedUp = true;
    } catch (error) {
      console.warn('[TTSService] Warmup failed (non-critical):', error);
      // Don't throw - warmup failure is non-critical
    }
  }

  private async _performWarmup(): Promise<void> {
    console.log('[TTSService] Warming up TTS API...');

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Test' }),
      });

      if (response.ok) {
        await response.blob(); // Consume the response
        console.log('[TTSService] ✅ TTS API warmed up successfully');
      } else {
        console.warn('[TTSService] Warmup request failed:', response.statusText);
      }
    } catch (error) {
      console.warn('[TTSService] Warmup error:', error);
      throw error;
    }
  }

  /**
   * Generate TTS audio and return blob
   */
  async generateAudio(text: string): Promise<Blob> {
    const startTime = performance.now();

    try {
      console.log(`[TTSService] Generating TTS for: "${text}"`);

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        throw new Error(`TTS API error: ${response.statusText}`);
      }

      const audioBlob = await response.blob();
      const generationTime = performance.now() - startTime;

      console.log(
        `[TTSService] Audio generated in ${generationTime.toFixed(2)}ms (${audioBlob.size} bytes)`
      );

      return audioBlob;
    } catch (error: any) {
      console.error('[TTSService] TTS generation error:', error);
      throw error;
    }
  }

  /**
   * Announce a bus number (with deduplication)
   */
  async announceBus(busNumber: string, audioService: any): Promise<void> {
    if (this.announcedBuses.has(busNumber)) {
      console.log(`[TTSService] Skipping TTS for ${busNumber} - already announced`);
      return;
    }

    try {
      const text = `Bus ${busNumber} has arrived.`;
      this.announcedBuses.add(busNumber);

      const audioBlob = await this.generateAudio(text);
      await audioService.playAudio(audioBlob);

      console.log(`[TTSService] ✅ Successfully announced bus ${busNumber}`);
    } catch (error) {
      console.error('[TTSService] Announcement error:', error);
      this.announcedBuses.delete(busNumber); // Allow retry on error
      throw error;
    }
  }

  /**
   * Check if warmed up
   */
  isReady(): boolean {
    return this.isWarmedUp;
  }

  /**
   * Check if bus has been announced
   */
  hasAnnounced(busNumber: string): boolean {
    return this.announcedBuses.has(busNumber);
  }

  /**
   * Reset announcement tracking
   */
  resetAnnouncements(): void {
    this.announcedBuses.clear();
    console.log('[TTSService] Announcements reset');
  }

  /**
   * Reset warmup state
   */
  reset(): void {
    this.isWarmedUp = false;
    this.warmupPromise = null;
    this.announcedBuses.clear();
    console.log('[TTSService] Reset complete');
  }
}

// Singleton instance
export const ttsService = new TTSService();
