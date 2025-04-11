import { performance } from 'perf_hooks';
import * as PlayHT from 'playht';
import { PlayRequestConfig } from 'playht';

// PlayHT output format type
type OutputFormat = 'mp3' | 'wav' | 'flac' | 'pcm';
type SupportedVoiceEngine = 'PlayDialog' | 'Play3.0-mini';

// Types for our metrics
interface TTSMetrics {
  ttfb: number; // Time to First Byte in ms
  audioSize: number; // Size of the audio in bytes
  testId?: number; // Added for parallel testing
  batchId?: number; // Added for parallel testing
}

interface TestResults {
  metrics: Array<TTSMetrics>;
  p50: {
    ttfb: number;
  };
  p95: {
    ttfb: number;
  };
  averages: {
    ttfb: number;
    audioSize: number;
  };
  batchId?: number; // Added for parallel testing
}

class PlayHTTester {
  private apiKey: string;
  private userId: string;
  private outputFormat: OutputFormat;
  private initialized = false;
  private batchId?: number;
  private verboseLogging: boolean;

  constructor(options: {
    apiKey: string;
    userId: string;
    outputFormat?: OutputFormat;
    batchId?: number;
    verboseLogging?: boolean;
  }) {
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.outputFormat = options.outputFormat || 'mp3';
    this.batchId = options.batchId;
    this.verboseLogging = options.verboseLogging !== undefined ? options.verboseLogging : true;

    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] API Key: ${this.apiKey.substring(0, 5)}...`);
      console.log(`[${this.getPrefix()}] User ID: ${this.userId.substring(0, 5)}...`);
      console.log(`[${this.getPrefix()}] Output Format: ${this.outputFormat}`);
    }

    // Initialize PlayHT SDK
    try {
      if (this.verboseLogging) {
        console.log(`[${this.getPrefix()}] Initializing PlayHT SDK...`);
      }

      PlayHT.init({
        apiKey: this.apiKey,
        userId: this.userId,
      });

      this.initialized = true;

      if (this.verboseLogging) {
        console.log(`[${this.getPrefix()}] PlayHT SDK initialized successfully`);
      }
    } catch (error) {
      console.error(`[${this.getPrefix()}] Failed to initialize PlayHT SDK:`, error);
    }
  }

  private getPrefix(): string {
    return this.batchId ? `Batch ${this.batchId}` : 'Main';
  }

  private calculatePercentile(values: Array<number>, percentile: number): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private async runSingleTest(
    text: string,
    voiceId: string,
    voiceEngine: SupportedVoiceEngine,
    testId: number,
  ): Promise<TTSMetrics> {
    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] Running test #${testId} with text: "${text.substring(0, 30)}..."`);
    }

    let ttfb = 0;
    let totalSize = 0;

    try {
      if (!this.initialized) {
        throw new Error('PlayHT SDK not initialized');
      }

      if (this.verboseLogging) {
        console.log(`[${this.getPrefix()}] Starting test with ${this.outputFormat} format`);
      }

      if (this.verboseLogging) {
        console.log(`[${this.getPrefix()}] Calling PlayHT.stream()...`);
      }

      // Set up a promise that will be resolved when we get the first data event
      // or rejected if there's an error or timeout
      const ttfbPromise = new Promise<number>((resolve, reject) => {
        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for first byte'));
        }, 30000);

        const startTime = performance.now();

        const perRequestConfig: PlayRequestConfig = {
          settings: {
            userId: this.userId,
            experimental: {
              defaultPlayDialogToPlayDialogTurbo: true,
            },
          },
        };

        // Start the stream
        PlayHT.stream(text, {
            voiceEngine,
            voiceId,
            speed: 1,
            outputFormat: this.outputFormat,
          },
          // @ts-expect-error per-request config is hidden from the public API
          perRequestConfig,
        )
          .then((stream) => {
            // Set up event listeners
            stream.once('data', (chunk: Buffer) => {
              clearTimeout(timeout);
              ttfb = performance.now() - startTime;
              totalSize = chunk.length;

              if (this.verboseLogging) {
                console.log(
                  `[${this.getPrefix()}] ↳ Time to first byte: ${ttfb.toFixed(2)}ms (bytes: ${chunk.length})`,
                );
              }

              // We got what we needed, resolve with the TTFB
              resolve(ttfb);

              // End listening and let the stream complete naturally
              stream.removeAllListeners();
            });

            stream.once('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });

      // Wait for the first byte or an error
      ttfb = await ttfbPromise;

      return {
        ttfb,
        audioSize: totalSize,
        batchId: this.batchId,
        testId,
      };
    } catch (error: any) {
      console.error(`[${this.getPrefix()}] Error in test #${testId}:`, error.message);

      if (error.response) {
        console.error(`[${this.getPrefix()}] API Response Error:`, error.response.status);
      }

      return {
        ttfb: -1,
        audioSize: 0,
        batchId: this.batchId,
        testId,
      };
    }
  }

  async runTests(options: {
    text: string | Array<string>;
    voiceId: string;
    voiceEngine: SupportedVoiceEngine;
    iterations: number;
  }): Promise<TestResults> {
    const { voiceId, voiceEngine, iterations } = options;
    const texts = Array.isArray(options.text) ? options.text : [options.text];

    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] Running tests with ${iterations} iterations`);
    }

    const metrics: Array<TTSMetrics> = [];

    for (let i = 0; i < iterations; i++) {
      // Select a text randomly if there are multiple
      const textIndex = Math.floor(Math.random() * texts.length);
      const text = texts[textIndex];

      if (text !== undefined) {
        if (this.verboseLogging) {
          console.log(`[${this.getPrefix()}] Test ${i + 1}/${iterations} starting...`);
        }

        const result = await this.runSingleTest(text, voiceId, voiceEngine, i + 1);

        if (this.verboseLogging) {
          console.log(
            `[${this.getPrefix()}] Test ${i + 1}/${iterations} completed with TTFB: ${result.ttfb.toFixed(2)}ms`,
          );
        }

        // Only add successful tests to metrics
        if (result.ttfb > 0) {
          metrics.push(result);
        } else {
          if (this.verboseLogging) {
            console.warn(`[${this.getPrefix()}] Test ${i + 1} skipped due to negative TTFB`);
          }
        }
      }
    }

    // Calculate percentiles and averages
    const ttfbValues = metrics.map((m) => m.ttfb);

    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] Successful tests: ${metrics.length}/${iterations}`);
    }

    const results: TestResults = {
      metrics,
      p50: {
        ttfb: this.calculatePercentile(ttfbValues, 50),
      },
      p95: {
        ttfb: this.calculatePercentile(ttfbValues, 95),
      },
      averages: {
        ttfb: ttfbValues.reduce((sum, val) => sum + val, 0) / metrics.length || 0,
        audioSize: metrics.reduce((sum, m) => sum + m.audioSize, 0) / metrics.length || 0,
      },
      batchId: this.batchId,
    };

    return results;
  }

  printResults(results: TestResults): void {
    console.log(`\n--- PlayHT TTS Performance Test Results ${this.batchId ? `(Batch ${this.batchId})` : ''} ---`);
    console.log(`Total successful tests: ${results.metrics.length}`);
    console.log(`Output Format: ${this.outputFormat}`);
    console.log('\nLatency Metrics (ms):');
    console.log(`P50 TTFB: ${results.p50.ttfb.toFixed(2)}`);
    console.log(`P95 TTFB: ${results.p95.ttfb.toFixed(2)}`);
    console.log(`Average TTFB: ${results.averages.ttfb.toFixed(2)}`);

    console.log('\nAudio Metrics:');
    console.log(`Average Audio Size: ${(results.averages.audioSize / 1024).toFixed(2)} KB`);
  }
}

// Example usage
async function main() {
  // Load environment variables
  const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY || '';
  const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID || '';

  if (!PLAYHT_API_KEY || !PLAYHT_USER_ID) {
    console.error('Error: PlayHT API Key and User ID must be provided as environment variables');
    process.exit(1);
  }

  const tester = new PlayHTTester({
    apiKey: PLAYHT_API_KEY,
    userId: PLAYHT_USER_ID,
  });

  // Test texts (vary in length)
  const testTexts = [
    'Welcome to our PlayHT performance test.',
    "This is a medium length sentence that we'll use to test the PlayHT TTS API performance metrics.",
    "Here is a longer sentence that will generate more audio data. We want to measure how the API performs with different text lengths and see if there's any correlation between text length and performance metrics like TTFB or total processing time.",
  ];

  // Voice ID for PlayHT
  const voiceId = 's3://voice-cloning-zero-shot/42c41808-0ddb-4674-8965-024a52ad6c8e/original/manifest.json';

  // Run tests
  const results = await tester.runTests({
    text: testTexts,
    voiceId,
    voiceEngine: 'PlayDialog',
    iterations: 10, // Number of test iterations
  });

  // Print results
  tester.printResults(results);
}

// Run the main function if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

// Use export type for interfaces
export { PlayHTTester };
export type { TTSMetrics, TestResults, OutputFormat };
