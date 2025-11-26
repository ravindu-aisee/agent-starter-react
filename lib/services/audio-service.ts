/**
 * AudioService - Handles browser audio unlocking and playback
 * Manages AudioContext and HTML5 Audio elements for cross-browser compatibility
 */
export class AudioService {
  private audioContext: AudioContext | null = null;
  private primedAudio: HTMLAudioElement | null = null;
  private isUnlocked = false;
  private hintMessage = '';

  /**
   * Unlock audio on user gesture (required for iOS and some browsers)
   * Must be called during a user interaction (click, tap, etc.)
   */
  async unlock(): Promise<void> {
    if (this.isUnlocked) {
      console.log('[AudioService] Already unlocked');
      return;
    }

    try {
      // Prime an Audio element for iOS - CRITICAL for iOS Safari
      if (!this.primedAudio) {
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
          console.warn('[AudioService] Play/pause during unlock failed:', e);
        }

        this.primedAudio = audio;
        console.log('[AudioService] Primed audio element for iOS');
      }

      // Initialize AudioContext
      const AudioContextClass =
        (window as any).AudioContext ||
        (window as any).webkitAudioContext ||
        (window as any).webkitaudioContext;

      if (AudioContextClass) {
        if (!this.audioContext) {
          this.audioContext = new AudioContextClass();
        }

        const ctx = this.audioContext;
        if (ctx) {
          await ctx.resume();
          const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          console.log('[AudioService] WebAudio context unlocked');
        }
      }

      this.isUnlocked = true;
      this.hintMessage = '';
      console.log('[AudioService] ✅ Audio unlocked successfully');
    } catch (e) {
      console.warn('[AudioService] Unlock failed:', e);
      this.isUnlocked = true; // Mark as attempted
      this.hintMessage = "Tap again if you still can't hear audio.";
    }
  }

  /**
   * Play audio blob using the most appropriate method
   */
  async playAudio(audioBlob: Blob): Promise<void> {
    const hasWebAudio =
      typeof window !== 'undefined' &&
      !!((window as any).AudioContext || (window as any).webkitAudioContext);

    return new Promise((resolve, reject) => {
      // Prefer WebAudio when unlocked (best on iOS)
      if (this.isUnlocked && hasWebAudio && this.audioContext) {
        this._playWithWebAudio(audioBlob)
          .then(resolve)
          .catch((err) => {
            console.warn('[AudioService] WebAudio playback failed, falling back to HTML5', err);
            this._playWithHTMLAudio(audioBlob).then(resolve).catch(reject);
          });
      } else {
        // Fallback to HTML5 Audio
        this._playWithHTMLAudio(audioBlob).then(resolve).catch(reject);
      }
    });
  }

  /**
   * Play audio using Web Audio API (preferred for iOS)
   */
  private async _playWithWebAudio(audioBlob: Blob): Promise<void> {
    if (!this.audioContext) {
      throw new Error('[AudioService] AudioContext not available');
    }

    return new Promise(async (resolve, reject) => {
      try {
        await this.audioContext!.resume();
        const arrayBuf = await audioBlob.arrayBuffer();
        const audioBuf = await new Promise<AudioBuffer>((res, rej) => {
          this.audioContext!.decodeAudioData(arrayBuf, res, rej);
        });

        const src = this.audioContext!.createBufferSource();
        src.buffer = audioBuf;
        src.connect(this.audioContext!.destination);

        src.onended = () => {
          console.log('[AudioService] WebAudio playback finished');
          resolve();
        };

        src.start(0);
        console.log('[AudioService] Playing with WebAudio');
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Play audio using HTML5 Audio element (fallback)
   */
  private async _playWithHTMLAudio(audioBlob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = this.primedAudio || new Audio();

      // Configure for iOS
      (audio as any).playsInline = true;
      audio.muted = false;
      audio.preload = 'auto';

      // Create object URL and set as source
      const audioUrl = URL.createObjectURL(audioBlob);
      audio.src = audioUrl;

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        console.log('[AudioService] HTML5 Audio playback finished');
        resolve();
      };

      audio.onerror = (e) => {
        console.error('[AudioService] HTML5 Audio playback error:', e);
        URL.revokeObjectURL(audioUrl);
        reject(e);
      };

      // Load and play
      audio.load();
      audio
        .play()
        .then(() => {
          console.log('[AudioService] Playing with HTML5 Audio');
        })
        .catch((err: any) => {
          const errorName = err instanceof Error ? err.name : String(err);
          if (errorName.includes('NotAllowedError')) {
            this.hintMessage =
              'Tap "Enable sound" to allow audio, then I\'ll speak automatically next time.';
          }
          reject(err);
        });
    });
  }

  /**
   * Check if audio is unlocked
   */
  isReady(): boolean {
    return this.isUnlocked;
  }

  /**
   * Get hint message (for UI display)
   */
  getHintMessage(): string {
    return this.hintMessage;
  }

  /**
   * Clear hint message
   */
  clearHint(): void {
    this.hintMessage = '';
  }

  /**
   * Reset audio service
   */
  reset(): void {
    // Don't reset unlocked state or audio context - they should persist
    this.hintMessage = '';
    console.log('[AudioService] Hint cleared');
  }
}

// Singleton instance
export const audioService = new AudioService();
