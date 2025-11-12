/**
 * Parallel OCR Processing System
 *
 * Features:
 * - Request batching for efficiency
 * - Parallel processing with concurrency control
 * - Request deduplication
 * - Performance monitoring
 */

interface OCRRequest {
  id: string;
  image: string;
  timestamp: number;
}

interface OCRResult {
  id: string;
  text: string;
  success: boolean;
  processingTime: number;
}

interface OCRQueueItem {
  request: OCRRequest;
  resolve: (result: OCRResult) => void;
  reject: (error: Error) => void;
}

class ParallelOCRProcessor {
  private queue: OCRQueueItem[] = [];
  private processing = new Set<string>();
  private maxConcurrentRequests: number;
  private batchSize: number;
  private batchTimeout: number;
  private batchTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, OCRResult>();
  private cacheTimeout = 5000; // 5 seconds cache

  constructor(maxConcurrentRequests: number = 3, batchSize: number = 1, batchTimeout: number = 50) {
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.batchSize = batchSize;
    this.batchTimeout = batchTimeout;
  }

  /**
   * Process OCR request with automatic batching and parallelization
   */
  async processOCR(image: string): Promise<string> {
    const requestId = this.generateRequestId(image);

    // Check cache first
    const cached = this.cache.get(requestId);
    if (cached && Date.now() - cached.processingTime < this.cacheTimeout) {
      console.log(`✅ Using cached OCR result for request ${requestId}`);
      return cached.text;
    }

    // Check if already processing
    if (this.processing.has(requestId)) {
      console.log(`⏳ Request ${requestId} already in progress, waiting...`);
      return new Promise<string>((resolve, reject) => {
        this.queue.push({
          request: { id: requestId, image, timestamp: Date.now() },
          resolve: (result) => resolve(result.text),
          reject,
        });
      });
    }

    return new Promise<string>((resolve, reject) => {
      const request: OCRRequest = {
        id: requestId,
        image,
        timestamp: Date.now(),
      };

      this.queue.push({
        request,
        resolve: (result) => resolve(result.text),
        reject,
      });
      this.processBatch();
    });
  }

  /**
   * Process batch of OCR requests
   */
  private async processBatch() {
    // Clear existing timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Check if we have capacity
    const availableSlots = this.maxConcurrentRequests - this.processing.size;
    if (availableSlots <= 0) {
      console.log('⏸️ Max concurrent requests reached, queuing...');
      return;
    }

    // Get items to process
    const itemsToProcess = this.queue.splice(0, Math.min(availableSlots, this.batchSize));

    if (itemsToProcess.length === 0) {
      return;
    }

    console.log(`🚀 Processing batch of ${itemsToProcess.length} OCR requests`);

    // Process items in parallel
    const promises = itemsToProcess.map((item) => this.processRequest(item));

    // Wait for all to complete
    await Promise.allSettled(promises);

    // Process next batch if queue is not empty
    if (this.queue.length > 0) {
      this.processBatch();
    }
  }

  /**
   * Process single OCR request
   */
  private async processRequest(item: OCRQueueItem): Promise<void> {
    const { request, resolve, reject } = item;
    const startTime = performance.now();

    try {
      this.processing.add(request.id);
      console.log(`🔍 Processing OCR request ${request.id}...`);

      // Make API call
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: request.image }),
      });

      if (!response.ok) {
        throw new Error(`OCR API error: ${response.statusText}`);
      }

      const data = await response.json();
      const processingTime = performance.now() - startTime;

      console.log(`✅ OCR completed in ${processingTime.toFixed(2)}ms: "${data.text}"`);

      const result: OCRResult = {
        id: request.id,
        text: data.text || 'None',
        success: data.success,
        processingTime,
      };

      // Cache result
      this.cache.set(request.id, result);

      resolve(result);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      console.error(
        `❌ OCR request ${request.id} failed after ${processingTime.toFixed(2)}ms:`,
        error
      );

      const result: OCRResult = {
        id: request.id,
        text: 'None',
        success: false,
        processingTime,
      };

      reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.processing.delete(request.id);
    }
  }

  /**
   * Generate request ID from image data (for deduplication)
   */
  private generateRequestId(image: string): string {
    // Use a simple hash of the image data
    // In production, you might want to use a proper hash function
    return image.substring(0, 100); // Use first 100 chars as simple ID
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      processingCount: this.processing.size,
      cacheSize: this.cache.size,
    };
  }
}

// Singleton instance
export const parallelOCRProcessor = new ParallelOCRProcessor(3, 1, 50);
