import dotenv from 'dotenv';
import { type VoiceEngine } from 'playht';
import { PlayHTTester, type OutputFormat, type TestResults } from './playht-tester';
import { GroqTTSTester } from './groq-tester';

// Load environment variables from .env file
dotenv.config();

// Type for TTS service selection
type TTSService = 'playht' | 'groq';

async function runParallelTests() {
  // Required environment variables
  const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY || '';
  const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID || '';
  const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

  // Parse command line arguments
  const args = process.argv.slice(2);

  // Accept arguments in any order by checking for special keywords
  let iterations = 5; // Default to 5 iterations per test
  let parallelTests = 3; // Default to 3 parallel tests
  let outputFormat: OutputFormat = 'mp3'; // Default format
  let verbose = false; // Default to less verbose output for parallel tests
  let service: TTSService = 'playht'; // Default to PlayHT

  for (const arg of args) {
    if (arg.startsWith('parallel=')) {
      const num = parseInt(arg.split('=')[1]);
      if (!isNaN(num)) {
        parallelTests = num;
      }
      continue;
    }

    if (arg.startsWith('iter=')) {
      const num = parseInt(arg.split('=')[1]);
      if (!isNaN(num)) {
        iterations = num;
      }
      continue;
    }

    if (arg === 'verbose' || arg === 'v') {
      verbose = true;
      continue;
    }

    if (arg === 'playht' || arg === 'groq') {
      service = arg as TTSService;
      continue;
    }

    // Check if argument is a format
    if (arg === 'mp3' || arg === 'wav' || arg === 'flac' || arg === 'pcm') {
      outputFormat = arg as OutputFormat;
    }
  }

  // Validate environment variables based on selected service
  if (service === 'playht' && (!PLAYHT_API_KEY || !PLAYHT_USER_ID)) {
    console.error('Error: PLAYHT_API_KEY and PLAYHT_USER_ID environment variables must be set for PlayHT');
    console.error('Create a .env file in the root directory with these values');
    process.exit(1);
  } else if (service === 'groq' && !GROQ_API_KEY) {
    console.error('Error: GROQ_API_KEY environment variable must be set for Groq');
    console.error('Create a .env file in the root directory with this value');
    process.exit(1);
  }

  // Create timestamp for this test run
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');

  // Voice ID to test with (only for PlayHT)
  const voiceId = 's3://voice-cloning-zero-shot/42c41808-0ddb-4674-8965-024a52ad6c8e/original/manifest.json';
  const voiceEngine = 'PlayDialog';

  console.log(`Running ${service.toUpperCase()} TTS parallel performance tests with the following configuration:`);
  console.log(`- Service: ${service}`);
  console.log(`- Parallel Tests: ${parallelTests}`);
  console.log(`- Iterations per Test: ${iterations}`);
  console.log(`- Output Format: ${outputFormat}`);
  if (service === 'playht') {
    console.log(`- Voice ID: ${voiceId}`);
    console.log(`- Voice Engine: ${voiceEngine}`);
  } else {
    console.log(`- Voice: Arista-PlayAI`);
    console.log(`- Model: playai-tts`);
  }
  console.log(`- Verbose Logging: ${verbose}`);

  // Test texts (vary in length)
  const testTexts = [
    "Here is a longer sentence that will generate more audio data. We want to measure how the API performs with different text lengths and see if there's any correlation between text length and performance metrics like TTFB or total processing time.",
  ];

  // Start the parallel tests
  console.log(`Starting parallel tests at ${new Date().toISOString()}`);

  // Create an array of test promises
  const testPromises = Array(parallelTests)
    .fill(0)
    .map((_, index) => {
      const batchId = index + 1;
      if (service === 'playht') {
        return runSinglePlayHTTestBatch({
          batchId,
          apiKey: PLAYHT_API_KEY,
          userId: PLAYHT_USER_ID,
          outputFormat,
          voiceId,
          voiceEngine: voiceEngine as VoiceEngine,
          texts: testTexts,
          iterations,
          verbose,
        });
      } else {
        return runSingleGroqTestBatch({
          batchId,
          apiKey: GROQ_API_KEY,
          texts: testTexts,
          iterations,
          verbose,
        });
      }
    });

  // Wait for all tests to complete
  const results = await Promise.all(testPromises);

  // Aggregate results
  const aggregatedResults = aggregateResults(results);

  // Print aggregated results
  printAggregatedResults(aggregatedResults, outputFormat, service);

  console.log(`\nAll tests completed at ${new Date().toISOString()}`);
}

// Function to run a single batch of PlayHT tests
async function runSinglePlayHTTestBatch(options: {
  batchId: number;
  apiKey: string;
  userId: string;
  outputFormat: OutputFormat;
  voiceId: string;
  voiceEngine: VoiceEngine;
  texts: Array<string>;
  iterations: number;
  verbose: boolean;
}): Promise<TestResults> {
  const { batchId, apiKey, userId, outputFormat, voiceId, voiceEngine, texts, iterations, verbose } = options;

  const tester = new PlayHTTester({
    apiKey,
    userId,
    outputFormat,
    batchId,
    verboseLogging: verbose,
  });

  const results = await tester.runTests({
    text: texts,
    voiceId,
    voiceEngine: voiceEngine as 'PlayDialog',
    iterations,
  });
  return results;
}

// Function to run a single batch of Groq tests
async function runSingleGroqTestBatch(options: {
  batchId: number;
  apiKey: string;
  texts: Array<string>;
  iterations: number;
  verbose: boolean;
}): Promise<TestResults> {
  const { batchId, apiKey, texts, iterations, verbose } = options;

  const tester = new GroqTTSTester({
    apiKey,
    batchId,
    verboseLogging: verbose,
  });

  const results = await tester.runTests({
    text: texts,
    iterations,
  });
  return results;
}

// Function to aggregate results from multiple test batches
function aggregateResults(results: Array<TestResults>): any {
  // Combine all metrics
  const allMetrics = results.flatMap((r) => r.metrics);

  // Calculate aggregated percentiles and averages
  const ttfbValues = allMetrics.map((m) => m.ttfb);
  const audioSizeValues = allMetrics.map((m) => m.audioSize);

  // Sort values for percentile calculations
  const sortedTtfb = [...ttfbValues].sort((a, b) => a - b);

  // Calculate percentiles
  const p50Index = Math.floor(sortedTtfb.length * 0.5);
  const p95Index = Math.floor(sortedTtfb.length * 0.95);

  // Calculate averages
  const avgTtfb = ttfbValues.reduce((sum, val) => sum + val, 0) / ttfbValues.length || 0;
  const avgAudioSize = audioSizeValues.reduce((sum, val) => sum + val, 0) / audioSizeValues.length || 0;

  return {
    totalTests: results.reduce((sum, r) => sum + r.metrics.length, 0),
    aggregatedMetrics: {
      p50: {
        ttfb: sortedTtfb[p50Index] || 0,
      },
      p95: {
        ttfb: sortedTtfb[p95Index] || 0,
      },
      averages: {
        ttfb: avgTtfb,
        audioSize: avgAudioSize,
      },
    },
    individualBatches: results.map((r, i) => ({
      batchId: r.batchId || i + 1,
      successfulTests: r.metrics.length,
      averages: {
        ttfb: r.metrics.reduce((sum, m) => sum + m.ttfb, 0) / r.metrics.length || 0,
        audioSize: r.metrics.reduce((sum, m) => sum + m.audioSize, 0) / r.metrics.length || 0,
      },
    })),
  };
}

// Function to print aggregated results
function printAggregatedResults(results: any, outputFormat: string, service: TTSService): void {
  console.log(`\n--- ${service.toUpperCase()} TTS Parallel Performance Test Results ---`);
  console.log(`Total successful tests: ${results.totalTests}`);
  if (service === 'groq') {
    console.log(`Model: playai-tts`);
    console.log(`Voice: Arista-PlayAI`);
  }
  console.log(`Output Format: ${outputFormat}`);

  const agg = results.aggregatedMetrics;

  console.log('\nLatency Metrics (ms):');
  console.log(`P50 TTFB: ${agg.p50.ttfb.toFixed(2)}`);
  console.log(`P95 TTFB: ${agg.p95.ttfb.toFixed(2)}`);
  console.log(`Average TTFB: ${agg.averages.ttfb.toFixed(2)}`);

  console.log('\nAudio Metrics:');
  console.log(`Average Audio Size: ${(agg.averages.audioSize / 1024).toFixed(2)} KB`);
}

// Run the tests if this file is executed directly
if (require.main === module) {
  runParallelTests().catch(console.error);
}

export { runParallelTests };
