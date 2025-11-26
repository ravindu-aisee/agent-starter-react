/**
 * OCRService - Handles OCR API warmup and processing
 * Initializes on browser startup to avoid cold starts
 */
export class OCRService {
  private isWarmedUp = false;
  private warmupPromise: Promise<void> | null = null;

  /**
   * Warm up the OCR API on startup
   * Safe to call multiple times - will only warm up once
   */
  async warmup(): Promise<void> {
    if (this.isWarmedUp) {
      console.log('[OCRService] Already warmed up');
      return;
    }

    if (this.warmupPromise) {
      console.log('[OCRService] Waiting for existing warmup...');
      return this.warmupPromise;
    }

    this.warmupPromise = this._performWarmup();

    try {
      await this.warmupPromise;
      this.isWarmedUp = true;
    } catch (error) {
      console.warn('[OCRService] Warmup failed (non-critical):', error);
      // Don't throw - warmup failure is non-critical
    }
  }

  private async _performWarmup(): Promise<void> {
    console.log('[OCRService] Warming up OCR API...');

    const testImage =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    try {
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: testImage }),
      });

      if (response.ok) {
        await response.json();
        console.log('[OCRService] ✅ OCR API warmed up successfully');
      } else {
        console.warn('[OCRService] Warmup request failed:', response.statusText);
      }
    } catch (error) {
      console.warn('[OCRService] Warmup error:', error);
      throw error;
    }
  }

  // /**
  //  * Create a small test image for warmup
  //  */
  // private _createTestImage(): string {
  //   const canvas = document.createElement('canvas');
  //   canvas.width = 100;
  //   canvas.height = 50;
  //   const ctx = canvas.getContext('2d');
  //   if (ctx) {
  //     ctx.fillStyle = '#fff';
  //     ctx.fillRect(0, 0, 100, 50);
  //     ctx.fillStyle = '#000';
  //     ctx.font = '20px Arial';
  //     ctx.fillText('123', 10, 30);
  //   }
  //   return canvas.toDataURL('image/jpeg', 0.8);
  // }

  // /**
  //  * Process OCR on an image
  //  */
  // async processImage(imageDataUrl: string): Promise<OCRResult> {
  //   const startTime = performance.now();

  //   try {
  //     const response = await fetch('/api/ocr', {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify({ image: imageDataUrl }),
  //     });

  //     if (!response.ok) {
  //       throw new Error(`OCR API error: ${response.statusText}`);
  //     }

  //     const result: OCRResult = await response.json();
  //     const processingTime = performance.now() - startTime;

  //     console.log(`[OCRService] OCR completed in ${processingTime.toFixed(2)}ms`);

  //     return result;
  //   } catch (error: any) {
  //     console.error('[OCRService] OCR processing error:', error);
  //     return {
  //       success: false,
  //       text: '',
  //       detections: [],
  //       message: error.message,
  //     };
  //   }
  // }

  /**
   * Check if warmed up
   */
  isReady(): boolean {
    return this.isWarmedUp;
  }

  /**
   * Reset warmup state
   */
  reset(): void {
    this.isWarmedUp = false;
    this.warmupPromise = null;
    console.log('[OCRService] Reset complete');
  }
}

export interface OCRResult {
  success: boolean;
  text: string;
  detections: Array<{ text: string; bounds: any }>;
  wordCount?: number;
  message?: string;
}

// Singleton instance
export const ocrService = new OCRService();
