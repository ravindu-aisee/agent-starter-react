/**
 * Central export point for all browser-side services
 * These services are initialized on component mount (browser startup)
 * and provide ready-to-use functionality for the camera component
 */

export { modelService, ModelService } from './model-service';
export { ocrService, OCRService, type OCRResult } from './ocr-service';
export { ttsService, TTSService } from './tts-service';
export { audioService, AudioService } from './audio-service';
