/**
 * Parallel OCR Processing System with True Thread Independence
 *
 * Features:
 * - TRUE parallel processing - each detection runs independently
 * - Each thread: OCR → Validation → Match Check → TTS (all within same thread)
 * - First match wins - immediately triggers TTS and aborts all other threads
 * - Semaphore-based concurrency control (max 10 threads)
 * - Dynamic queue processing - threads start as soon as slot opens
 * - Detailed per-thread timing logs from detection to TTS
 * - Global abort mechanism when match is found
 */

interface OCRPipelineContext {
  image: string;
  objectId: number;
  detectionIndex: number;
  timestamp: number;
  detectionTime: number; // When object was detected
  abortController: AbortController;
}

interface OCRPipelineResult {
  objectId: number;
  text: string;
  individualWords: string[];
  success: boolean;
  processingTime: number;
  wasAborted: boolean;
  timingLog?: ThreadTimingLog;
}

interface QueuedPipeline {
  context: OCRPipelineContext;
  resolve: (result: OCRPipelineResult) => void;
  reject: (error: Error) => void;
  queuedAt: number;
}

interface ThreadTimingLog {
  objectId: number;
  detectionIndex: number;
  detectionTime: number;
  queuedTime?: number;
  queueWaitTime?: number;
  startTime: number;
  ocrStartTime?: number;
  ocrEndTime?: number;
  ocrDuration?: number;
  validationStartTime?: number;
  validationEndTime?: number;
  validationDuration?: number;
  matchCheckTime?: number;
  ttsTriggeredTime?: number;
  endTime: number;
  totalDuration: number;
  detectionToTTSDuration?: number; // Total time from detection to TTS
  wasAborted: boolean;
}

export interface ValidationCallback {
  (normalizedText: string, individualWords?: string[]): string; // Returns validated bus number or 'None'
}

export interface MatchCallback {
  (validatedBusNumber: string, objectId: number, ttsTrigger: () => Promise<void>): Promise<void>; // Checks match and provides TTS trigger
}

export interface ShouldAbortCheck {
  (): boolean; // Check if processing should be aborted
}

class ParallelOCRProcessor {
  private activeThreads = new Map<number, AbortController>();
  private shouldAbortAll = false;
  private validationCallback: ValidationCallback | null = null;
  private matchCallback: MatchCallback | null = null;
  private shouldAbortCheck: ShouldAbortCheck | null = null;
  private readonly maxConcurrentThreads: number;
  private queue: QueuedPipeline[] = [];
  private runningCount = 0;
  private threadTimingLogs: ThreadTimingLog[] = [];
  private requestedBusNumbers: Set<string> = new Set();

  constructor(maxConcurrentThreads: number = 10) {
    this.maxConcurrentThreads = maxConcurrentThreads;
    console.log(
      `ParallelOCRProcessor initialized with max ${maxConcurrentThreads} concurrent threads`
    );
  }

  /**
   * Set validation callback to validate and normalize OCR results
   */
  setValidationCallback(callback: ValidationCallback | null) {
    this.validationCallback = callback;
  }

  /**
   * Set match callback to trigger TTS immediately when match is found
   */
  setMatchCallback(callback: MatchCallback | null) {
    this.matchCallback = callback;
  }

  /**
   * Set abort check callback
   */
  setShouldAbortCheck(callback: ShouldAbortCheck | null) {
    this.shouldAbortCheck = callback;
  }

  /**
   * Set user-requested bus numbers for lookup during OCR processing
   */
  setRequestedBusNumbers(busNumbers: string[]) {
    this.requestedBusNumbers = new Set(busNumbers);
    console.log(`Requested bus numbers set: [${Array.from(this.requestedBusNumbers).join(', ')}]`);
  }

  /**
   * Abort all in-flight OCR threads and clear queue
   */
  abortAll() {
    console.log('🛑 Aborting all OCR threads...');
    this.shouldAbortAll = true;

    // Abort all active threads
    this.activeThreads.forEach((controller, objectId) => {
      try {
        console.log(`Aborting thread ${objectId}`);
        controller.abort();
      } catch (e) {
        console.warn(`Error aborting thread ${objectId}:`, e);
      }
    });

    this.activeThreads.clear();

    // Clear the queue - reject all queued items
    const queuedCount = this.queue.length;
    this.queue.forEach((item) => {
      item.resolve({
        objectId: item.context.objectId,
        text: 'None',
        individualWords: [],
        success: false,
        processingTime: 0,
        wasAborted: true,
      });
    });
    this.queue = [];
    this.runningCount = 0;

    console.log(`✅ All threads aborted (${queuedCount} queued items cleared)`);
  }

  /**
   * Reset abort flag for new detection cycle
   */
  reset() {
    this.shouldAbortAll = false;
    this.activeThreads.clear();
    this.queue = [];
    this.runningCount = 0;
    this.threadTimingLogs = [];
    this.requestedBusNumbers.clear();
    console.log('OCR processor reset for new detection cycle');
  }

  /**
   * Process COMPLETE pipeline for a single detection with concurrency control
   * Pipeline: OCR → Validation → Match Check → TTS (all in same thread)
   *
   * Uses semaphore to limit concurrent threads to maxConcurrentThreads
   * Queue processes dynamically - as soon as a thread finishes, next one starts
   */
  async processPipeline(context: OCRPipelineContext): Promise<OCRPipelineResult> {
    // Check if we can start immediately or need to queue
    if (this.runningCount >= this.maxConcurrentThreads) {
      const queuedAt = performance.now();
      console.log(
        `[Thread ${context.objectId}] Queue (${this.queue.length + 1}/${this.runningCount} running)`
      );

      // Add to queue and wait
      return new Promise<OCRPipelineResult>((resolve, reject) => {
        this.queue.push({
          context: { ...context, timestamp: queuedAt },
          resolve,
          reject,
          queuedAt,
        });
      });
    }

    // Acquire slot and run
    return this.runPipeline(context);
  }

  /**
   * Process next item from queue (called when a thread finishes)
   */
  private processQueue() {
    if (this.queue.length === 0) {
      return;
    }

    if (this.runningCount >= this.maxConcurrentThreads) {
      return;
    }

    // Get next item from queue
    const item = this.queue.shift();
    if (!item) return;

    const queueWaitTime = performance.now() - item.queuedAt;
    console.log(
      `[Thread ${item.context.objectId}] Starting from queue (waited ${queueWaitTime.toFixed(2)}ms)`
    );

    // Run pipeline and handle result
    this.runPipeline(item.context, queueWaitTime).then(item.resolve).catch(item.reject);
  }

  /**
   * Actually run the pipeline
   */
  private async runPipeline(
    context: OCRPipelineContext,
    queueWaitTime?: number
  ): Promise<OCRPipelineResult> {
    const { image, objectId, detectionIndex, detectionTime, abortController } = context;
    const startTime = performance.now();

    // Initialize timing log
    const timingLog: ThreadTimingLog = {
      objectId,
      detectionIndex,
      detectionTime,
      queuedTime: queueWaitTime !== undefined ? context.timestamp : undefined,
      queueWaitTime,
      startTime,
      endTime: 0,
      totalDuration: 0,
      wasAborted: false,
    };

    // Acquire semaphore slot
    this.runningCount++;
    this.activeThreads.set(objectId, abortController);

    console.log(
      `[Thread ${objectId}] Starting pipeline (detection #${detectionIndex}) [${this.runningCount}/${this.maxConcurrentThreads} slots]`
    );

    try {
      // STEP 1: Check if already aborted before starting
      if (this.shouldAbortAll || (this.shouldAbortCheck && this.shouldAbortCheck())) {
        console.log(`[Thread ${objectId}] Aborted before OCR - match already found`);
        timingLog.wasAborted = true;
        timingLog.endTime = performance.now();
        timingLog.totalDuration = timingLog.endTime - startTime;
        this.threadTimingLogs.push(timingLog);

        return {
          objectId,
          text: 'None',
          individualWords: [],
          success: false,
          processingTime: timingLog.totalDuration,
          wasAborted: true,
          timingLog,
        };
      }

      // STEP 2: Perform OCR (with abort signal)
      console.log(`[Thread ${objectId}] Starting OCR...`);
      timingLog.ocrStartTime = performance.now();

      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive',
        },
        body: JSON.stringify({ image }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`OCR API error: ${response.statusText}`);
      }

      // Check if aborted before parsing JSON (prevents JSON parse errors on aborted requests)
      if (this.shouldAbortAll || (this.shouldAbortCheck && this.shouldAbortCheck())) {
        throw new Error('AbortError'); // Will be caught and handled as abort
      }

      const data = await response.json();
      timingLog.ocrEndTime = performance.now();
      timingLog.ocrDuration = timingLog.ocrEndTime - timingLog.ocrStartTime;

      const normalizedText = data.text || 'None';
      const individualWords = data.individualWords || [];

      console.log(
        `[Thread ${objectId}] OCR completed in ${timingLog.ocrDuration.toFixed(2)}ms: "${normalizedText}"`
      );
      if (individualWords.length > 0) {
        console.log(
          `   [Thread ${objectId}] Individual words: [${individualWords.map((w: string) => `"${w}"`).join(', ')}]`
        );
      }

      // STEP 3: Check if aborted during OCR
      if (this.shouldAbortAll || (this.shouldAbortCheck && this.shouldAbortCheck())) {
        console.log(`[Thread ${objectId}] Aborted after OCR - match found in another thread`);
        timingLog.wasAborted = true;
        timingLog.endTime = performance.now();
        timingLog.totalDuration = timingLog.endTime - startTime;
        this.threadTimingLogs.push(timingLog);

        return {
          objectId,
          text: normalizedText,
          individualWords,
          success: data.success,
          processingTime: timingLog.totalDuration,
          wasAborted: true,
          timingLog,
        };
      }

      // STEP 4: Check individual words for matches FIRST using O(1) Set lookup
      // This allows any individual word match to trigger immediate abort + TTS
      let matchFoundInIndividualWords = false;
      let matchedWord = '';

      if (
        individualWords.length > 0 &&
        this.requestedBusNumbers.size > 0 &&
        this.matchCallback &&
        !this.shouldAbortAll &&
        (!this.shouldAbortCheck || !this.shouldAbortCheck())
      ) {
        console.log(`[Thread ${objectId}] Checking individual words against requested bus numbers`);

        // Check each individual word
        for (const word of individualWords) {
          if (!word || word === 'None') continue;

          // O(1) lookup: Check if this word is in requested bus numbers
          if (this.requestedBusNumbers.has(word)) {
            console.log(
              `[Thread ${objectId}]  Found requested bus number in individual words: "${word}"`
            );

            matchedWord = word;
            timingLog.matchCheckTime = performance.now();

            try {
              // Create timing trigger only (abort is handled by match callback)
              const ttsTrigger = async () => {
                timingLog.ttsTriggeredTime = performance.now();
                timingLog.detectionToTTSDuration = timingLog.ttsTriggeredTime - detectionTime;
                console.log(
                  `[Thread ${objectId}] TTS TRIGGER CALLED! Total latency (detection→TTS call): ${timingLog.detectionToTTSDuration.toFixed(2)}ms`
                );
              };

              // Fire match callback without waiting (it handles abort + TTS internally)
              // This ensures minimal latency - we don't block this thread
              this.matchCallback(word, objectId, ttsTrigger).catch((error) => {
                console.error(
                  `❌ [Thread ${objectId}] Match callback error for word "${word}":`,
                  error
                );
              });

              // Match found - mark for early return
              matchFoundInIndividualWords = true;
              break; // Stop checking other words
            } catch (error) {
              console.error(
                `❌ [Thread ${objectId}] Match callback error for word "${word}":`,
                error
              );
            }
          }
        }
      }

      // STEP 5: If match was found in individual words, return early
      if (matchFoundInIndividualWords) {
        timingLog.endTime = performance.now();
        timingLog.totalDuration = timingLog.endTime - startTime;
        this.threadTimingLogs.push(timingLog);

        console.log(
          `[Thread ${objectId}] Match found in individual words: "${matchedWord}" (${timingLog.totalDuration.toFixed(2)}ms)`
        );

        return {
          objectId,
          text: matchedWord,
          individualWords,
          success: data.success,
          processingTime: timingLog.totalDuration,
          wasAborted: false,
          timingLog,
        };
      }

      // STEP 6: Complete timing log and return for non-match cases
      timingLog.endTime = performance.now();
      timingLog.totalDuration = timingLog.endTime - startTime;
      this.threadTimingLogs.push(timingLog);

      return {
        objectId,
        text: individualWords.join(' '),
        individualWords,
        success: data.success,
        processingTime: timingLog.totalDuration,
        wasAborted: false,
        timingLog,
      };
    } catch (error) {
      timingLog.endTime = performance.now();
      timingLog.totalDuration = timingLog.endTime - startTime;

      // Check if this was an abort (multiple ways a fetch can be aborted)
      const isAbortError =
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.message === 'AbortError') ||
        (error instanceof Error && error.message.includes('aborted')) ||
        String(error).includes('aborted');

      if (isAbortError) {
        console.log(
          `[Thread ${objectId}] Pipeline aborted after ${timingLog.totalDuration.toFixed(2)}ms`
        );
        timingLog.wasAborted = true;
        this.threadTimingLogs.push(timingLog);

        return {
          objectId,
          text: 'None',
          individualWords: [],
          success: false,
          processingTime: timingLog.totalDuration,
          wasAborted: true,
          timingLog,
        };
      }

      // Check for JSON parsing errors (usually means request was aborted)
      if (error instanceof Error && error.message.includes('JSON')) {
        console.log(
          `[Thread ${objectId}] Request aborted (JSON parse error) after ${timingLog.totalDuration.toFixed(2)}ms`
        );
        timingLog.wasAborted = true;
        this.threadTimingLogs.push(timingLog);

        return {
          objectId,
          text: 'None',
          individualWords: [],
          success: false,
          processingTime: timingLog.totalDuration,
          wasAborted: true,
          timingLog,
        };
      }

      console.error(
        `❌ [Thread ${objectId}] Pipeline failed after ${timingLog.totalDuration.toFixed(2)}ms:`,
        error
      );
      this.threadTimingLogs.push(timingLog);

      return {
        objectId,
        text: 'None',
        individualWords: [],
        success: false,
        processingTime: timingLog.totalDuration,
        wasAborted: false,
        timingLog,
      };
    } finally {
      // Release semaphore slot
      this.runningCount--;
      this.activeThreads.delete(objectId);
      console.log(
        `[Thread ${objectId}] Thread cleaned up [${this.runningCount}/${this.maxConcurrentThreads} slots]`
      );

      // Process next item from queue if available
      this.processQueue();
    }
  }

  /**
   * Get active thread count
   */
  getActiveThreadCount(): number {
    return this.runningCount;
  }

  /**
   * Check if any threads are active
   */
  hasActiveThreads(): boolean {
    return this.runningCount > 0;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get all thread timing logs
   */
  getTimingLogs(): ThreadTimingLog[] {
    return [...this.threadTimingLogs];
  }

  /**
   * Get statistics about thread performance
   */
  getStats() {
    const logs = this.threadTimingLogs;
    if (logs.length === 0) {
      return {
        totalThreads: 0,
        activeThreads: this.runningCount,
        queueLength: this.queue.length,
      };
    }

    const completedLogs = logs.filter((log) => !log.wasAborted);
    const avgOCR =
      completedLogs.reduce((sum, log) => sum + (log.ocrDuration || 0), 0) /
      (completedLogs.length || 1);
    const avgValidation =
      completedLogs.reduce((sum, log) => sum + (log.validationDuration || 0), 0) /
      (completedLogs.length || 1);
    const avgTotal =
      completedLogs.reduce((sum, log) => sum + log.totalDuration, 0) / (completedLogs.length || 1);
    const avgQueueWait =
      logs
        .filter((log) => log.queueWaitTime !== undefined)
        .reduce((sum, log) => sum + (log.queueWaitTime || 0), 0) /
      (logs.filter((log) => log.queueWaitTime !== undefined).length || 1);

    const ttsLogs = logs.filter((log) => log.ttsTriggeredTime !== undefined);
    const fastestTTS =
      ttsLogs.length > 0
        ? Math.min(...ttsLogs.map((log) => log.detectionToTTSDuration || Infinity))
        : undefined;

    return {
      totalThreads: logs.length,
      completedThreads: completedLogs.length,
      abortedThreads: logs.filter((log) => log.wasAborted).length,
      activeThreads: this.runningCount,
      queueLength: this.queue.length,
      avgOCRTime: avgOCR,
      avgValidationTime: avgValidation,
      avgTotalTime: avgTotal,
      avgQueueWaitTime: avgQueueWait,
      ttsTriggers: ttsLogs.length,
      fastestDetectionToTTS: fastestTTS,
    };
  }

  /**
   * Clear timing logs
   */
  clearTimingLogs() {
    this.threadTimingLogs = [];
  }
}

// Singleton instance with max 10 concurrent threads
export const parallelOCRProcessor = new ParallelOCRProcessor(10);
