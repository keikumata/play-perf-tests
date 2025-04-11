import { performance } from 'perf_hooks';

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
  batchId?: number;
}

class GroqTTSTester {
  private apiKey: string;
  private batchId?: number;
  private verboseLogging: boolean;
  private baseUrl = 'https://api.groq.com/openai/v1/audio/speech';

  constructor(options: {
    apiKey: string;
    batchId?: number;
    verboseLogging?: boolean;
  }) {
    this.apiKey = options.apiKey;
    this.batchId = options.batchId;
    this.verboseLogging = options.verboseLogging !== undefined ? options.verboseLogging : true;

    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] API Key: ${this.apiKey.substring(0, 5)}...`);
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

  private async runSingleTest(text: string, testId: number): Promise<TTSMetrics> {
    if (this.verboseLogging) {
      console.log(`[${this.getPrefix()}] Running test #${testId} with text: "${text.substring(0, 30)}..."`);
    }

    let ttfb = 0;
    let totalSize = 0;

    try {
      const startTime = performance.now();

      // Create a promise that will be resolved when we get the response
      // or rejected if there's an error or timeout
      const ttfbPromise = new Promise<{ ttfb: number; size: number }>(async (resolve, reject) => {
        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for response'));
        }, 30000);

        try {
          const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'playai-tts',
              input: text,
              voice: 'Arista-PlayAI',
              response_format: 'wav'
            })
          });

          if (!response.ok) {
            clearTimeout(timeout);
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          // Get the response as an array buffer
          const buffer = await response.arrayBuffer();
          
          clearTimeout(timeout);
          ttfb = performance.now() - startTime;
          totalSize = buffer.byteLength;
          
          resolve({ ttfb, size: totalSize });
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // Wait for the response or an error
      const result = await ttfbPromise;
      ttfb = result.ttfb;
      totalSize = result.size;

      if (this.verboseLogging) {
        console.log(
          `[${this.getPrefix()}] ↳ Time to response: ${ttfb.toFixed(2)}ms (bytes: ${totalSize})`,
        );
      }

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

      console.error(error);

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
    iterations: number;
  }): Promise<TestResults> {
    const { iterations } = options;
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

        const result = await this.runSingleTest(text, i + 1);

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
    console.log(`\n--- Groq TTS Performance Test Results ${this.batchId ? `(Batch ${this.batchId})` : ''} ---`);
    console.log(`Total successful tests: ${results.metrics.length}`);
    console.log(`Model: playai-tts`);
    console.log(`Voice: Arista-PlayAI`);
    console.log(`Output Format: wav`);
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
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

  if (!GROQ_API_KEY) {
    console.error('Error: Groq API Key must be provided as environment variable');
    process.exit(1);
  }

  const tester = new GroqTTSTester({
    apiKey: GROQ_API_KEY,
  });

  // Test texts (vary in length)
  const testTexts = [
    'Welcome to our Groq performance test.',
    "This is a medium length sentence that we'll use to test the Groq TTS API performance metrics.",
    "Here is a longer sentence that will generate more audio data. We want to measure how the API performs with different text lengths and see if there's any correlation between text length and performance metrics like TTFB or total processing time.",
  ];

  // Run tests
  const results = await tester.runTests({
    text: testTexts,
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
export { GroqTTSTester };
export type { TTSMetrics, TestResults }; 