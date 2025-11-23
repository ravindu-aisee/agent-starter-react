/**
 * Performance Monitoring System
 *
 * Tracks and reports performance metrics for the entire detection pipeline
 */

interface PerformanceMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

interface PerformanceStats {
  count: number;
  total: number;
  average: number;
  min: number;
  max: number;
  latest: number;
}

class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetric[]> = new Map();
  private activeTimers: Map<string, number> = new Map();
  private maxMetricsPerType = 100; // Keep last 100 metrics per type

  /**
   * Start timing a metric
   */
  start(metricName: string, metadata?: Record<string, unknown>): string {
    const id = `${metricName}_${Date.now()}_${Math.random()}`;
    const startTime = performance.now();

    this.activeTimers.set(id, startTime);

    const metric: PerformanceMetric = {
      name: metricName,
      startTime,
      metadata,
    };

    if (!this.metrics.has(metricName)) {
      this.metrics.set(metricName, []);
    }

    const metrics = this.metrics.get(metricName)!;
    metrics.push(metric);

    // Keep only recent metrics
    if (metrics.length > this.maxMetricsPerType) {
      metrics.shift();
    }

    return id;
  }

  /**
   * End timing a metric
   */
  end(id: string): number {
    const startTime = this.activeTimers.get(id);
    if (!startTime) {
      console.warn(`No active timer found for ID: ${id}`);
      return 0;
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    this.activeTimers.delete(id);

    // Find and update the metric
    for (const [metricName, metrics] of this.metrics) {
      const metric = metrics.find((m) => !m.endTime && Math.abs(m.startTime - startTime) < 1);
      if (metric) {
        metric.endTime = endTime;
        metric.duration = duration;
        break;
      }
    }

    return duration;
  }

  /**
   * Record an instant metric
   */
  record(metricName: string, value: number, metadata?: Record<string, unknown>) {
    const metric: PerformanceMetric = {
      name: metricName,
      startTime: performance.now(),
      endTime: performance.now(),
      duration: value,
      metadata,
    };

    if (!this.metrics.has(metricName)) {
      this.metrics.set(metricName, []);
    }

    const metrics = this.metrics.get(metricName)!;
    metrics.push(metric);

    // Keep only recent metrics
    if (metrics.length > this.maxMetricsPerType) {
      metrics.shift();
    }
  }

  /**
   * Get statistics for a metric
   */
  getStats(metricName: string): PerformanceStats | null {
    const metrics = this.metrics.get(metricName);
    if (!metrics || metrics.length === 0) {
      return null;
    }

    const durations = metrics.filter((m) => m.duration !== undefined).map((m) => m.duration!);

    if (durations.length === 0) {
      return null;
    }

    const total = durations.reduce((sum, d) => sum + d, 0);
    const average = total / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const latest = durations[durations.length - 1];

    return {
      count: durations.length,
      total,
      average,
      min,
      max,
      latest,
    };
  }

  /**
   * Get all statistics
   */
  getAllStats(): Record<string, PerformanceStats> {
    const stats: Record<string, PerformanceStats> = {};

    for (const metricName of this.metrics.keys()) {
      const metricStats = this.getStats(metricName);
      if (metricStats) {
        stats[metricName] = metricStats;
      }
    }

    return stats;
  }

  /**
   * Log performance summary
   */
  logSummary() {
    console.log('Performance Summary:');
    console.log('━'.repeat(80));

    const allStats = this.getAllStats();

    for (const [metricName, stats] of Object.entries(allStats)) {
      console.log(
        `${metricName.padEnd(30)} | Avg: ${stats.average.toFixed(2)}ms | Min: ${stats.min.toFixed(2)}ms | Max: ${stats.max.toFixed(2)}ms | Count: ${stats.count}`
      );
    }

    console.log('━'.repeat(80));
  }

  /**
   * Clear all metrics
   */
  clear() {
    this.metrics.clear();
    this.activeTimers.clear();
  }

  /**
   * Clear specific metric
   */
  clearMetric(metricName: string) {
    this.metrics.delete(metricName);
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

// Metric names constants
export const METRICS = {
  INFERENCE: 'inference',
  PREPROCESSING: 'preprocessing',
  POSTPROCESSING: 'postprocessing',
  OCR: 'ocr',
  OCR_API: 'ocr_api',
  FRAME_CAPTURE: 'frame_capture',
  IMAGE_CROP: 'image_crop',
  IMAGE_SAVE: 'image_save',
  DETECTION_PIPELINE: 'detection_pipeline',
  END_TO_END: 'end_to_end',
  NMS: 'nms',
} as const;
