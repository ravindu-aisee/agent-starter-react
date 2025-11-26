import { literTModelManager } from '@/lib/tflite-loader';

/**
 * ModelService - Handles ML model initialization and inference
 * Initializes on browser startup, independent of camera state
 */
export class ModelService {
  private model: any = null;
  private isInitialized = false;
  private isLoading = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the model on startup
   * Safe to call multiple times - will only initialize once
   */
  async initialize(modelPath: string = '/models/yolo_trained.tflite'): Promise<void> {
    // If already initialized, return immediately
    if (this.isInitialized && this.model) {
      console.log('[ModelService] Already initialized');
      return;
    }

    // If currently loading, wait for existing initialization
    if (this.isLoading && this.initPromise) {
      console.log('[ModelService] Waiting for existing initialization...');
      return this.initPromise;
    }

    // Start new initialization
    this.isLoading = true;
    this.initPromise = this._initializeModel(modelPath);

    try {
      await this.initPromise;
    } finally {
      this.isLoading = false;
    }
  }

  private async _initializeModel(modelPath: string): Promise<void> {
    try {
      console.log('[ModelService] Initializing LiteRT runtime...');
      await literTModelManager.initialize();

      console.log('[ModelService] Loading model:', modelPath);
      this.model = await literTModelManager.loadModel(modelPath);

      this.isInitialized = true;
      console.log('[ModelService] ✅ Model loaded successfully');
    } catch (error: any) {
      const errorMsg = `Model initialization failed: ${error?.message ?? error}`;
      console.error('[ModelService]', errorMsg, error);
      throw new Error(errorMsg);
    }
  }

  /**
   * Get the loaded model instance
   */
  getModel(): any {
    if (!this.isInitialized || !this.model) {
      throw new Error('[ModelService] Model not initialized. Call initialize() first.');
    }
    return this.model;
  }

  /**
   * Check if model is ready for inference
   */
  isReady(): boolean {
    return this.isInitialized && this.model !== null;
  }

  /**
   * Get initialization status
   */
  getStatus(): 'not-initialized' | 'loading' | 'ready' | 'error' {
    if (this.isInitialized) return 'ready';
    if (this.isLoading) return 'loading';
    return 'not-initialized';
  }

  /**
   * Reset the model (for cleanup)
   */
  reset(): void {
    this.model = null;
    this.isInitialized = false;
    this.isLoading = false;
    this.initPromise = null;
    console.log('[ModelService] Reset complete');
  }
}

// Singleton instance - initialized once per browser session
export const modelService = new ModelService();
