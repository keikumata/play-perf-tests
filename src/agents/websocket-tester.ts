import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import { encode } from './mulaw';

// Load environment variables from .env file
dotenv.config();

// Logging levels
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEBUG = LOG_LEVEL === 'debug';

function log(level: 'debug' | 'info' | 'error', message: string, conversationId?: number) {
  const timestamp = new Date().toISOString();
  const prefix = conversationId !== undefined ? `[Conv ${conversationId}]` : '';

  if (level === 'error' || level === 'info' || (level === 'debug' && DEBUG)) {
    console.log(`${timestamp} ${level.toUpperCase()} ${prefix} ${message}`);
  }
}

const AGENT_ID = 'Alfred-739ctG40qo4pc-ySWyMpp';

// Input format matches our mulaw encoding
const SETUP_MESSAGE_PARAMS = {
  inputEncoding: 'mulaw',
  inputSampleRate: 16000, // 16kHz for mulaw input
  outputFormat: 'wav', // Get 16-bit PCM WAV directly
  outputSampleRate: 16000, // Match input rate for consistency
  shouldSendLanguage: true,
};

const TEST_TIMEOUT_MS = 30000; // 30 second timeout
const RESPONSE_TIMEOUT_MS = 15000; // 15 second timeout after voiceActivityStart
const NEW_AUDIO_STREAM_TIMEOUT_MS = 5000; // 5 second timeout after newAudioStream if no audio chunks received

const NUM_PARALLEL_CONVERSATIONS = 1; // Number of parallel conversations to run
const TURNS_PER_CONVERSATION = 3; // Number of turns in each conversation

interface AudioChunkMetrics {
  inputEndTimestamp: number;
  firstChunkTimestamp: number | null;
  firstChunkLatency: number | null;
  turnLatencyMs: number | null;
  chunks: Array<{
    timestamp: number;
    data: string;
  }>;
  transcripts: {
    user: Array<string>;
    agent: Array<string>;
  };
  events: Array<{
    type: string;
    timestamp: number;
  }>;
  voiceActivityStartTime: number | null;
  newAudioStreamTime: number | null;
  responseAudioChunks: number;
  voiceActivityEndReceived: boolean;
  greetingGaps: Array<number>;
  responseGaps: Array<number>;
  turnLatencies: Array<number>;
  choppinessEvents: number;
  largestGaps: Array<number>;
}

interface TestResults {
  turnLatencies: Array<number>;
  greetingGaps: Array<number>; // Separate gaps for greeting
  responseGaps: Array<number>; // Separate gaps for response
  largeGaps: Array<{
    gap: number;
    turnIndex: number;
    timestamp: number;
    chunkSize: number;
    isGreeting: boolean; // Whether gap was in greeting or response
  }>;
}

interface AudioChunk {
  timestamp: number;
  data: Buffer;
  isInput: boolean;
}

interface ConversationMetrics {
  turnLatencies: Array<number>;
  chunkGaps: Array<number>;
  largeGaps: Array<{ gap: number; turnIndex: number }>;
  errors: Array<string>;
  audioChunks: Array<AudioChunk>;
  initialGreetingComplete: boolean;
  choppinessEvents: number;
  largestAudioGaps: Array<number>;
}

class AudioStreamTester {
  private ws!: WebSocket;
  private metrics: AudioChunkMetrics;
  private apiKey: string;
  private conversationId: number;
  private isInputComplete = false;
  private initialGreetingComplete = false;
  private responseComplete = false;
  private hasReceivedResponseAudio = false;
  private voiceActivityDetected = false;
  private newAudioStreamReceived = false;
  private conversationInitialized = false;
  private CHUNK_SIZE = 4096; // 4KB chunks
  private CHUNK_INTERVAL_MS = 50; // 50ms between chunks to simulate real-time
  private silenceInterval: NodeJS.Timeout | null = null;
  private allResults: TestResults;
  private currentTurn = 0;
  private currentTurnChunks: Array<AudioChunk> = [];
  private allConversationChunks: Array<AudioChunk> = []; // New array to store all chunks for the conversation
  private lastResponseChunkTimestamp: number | null = null; // New field to track last response chunk time

  constructor(apiKey: string, conversationId: number) {
    this.apiKey = apiKey;
    this.conversationId = conversationId;
    this.metrics = this.initializeMetrics();
    this.allResults = {
      turnLatencies: [],
      greetingGaps: [],
      responseGaps: [],
      largeGaps: [],
    };

    // Log constructor initialization
    log(
      'debug',
      `[Conv ${this.conversationId}] Tester initialized with metrics: ${JSON.stringify(this.metrics)}`,
      this.conversationId,
    );
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:4400/v1/talk/${AGENT_ID}`);

      this.ws.on('open', () => {
        log('debug', 'WebSocket connected', this.conversationId);
        const setupMsg = {
          type: 'setup',
          apiKey: this.apiKey,
          ...SETUP_MESSAGE_PARAMS,
        };
        this.ws.send(JSON.stringify(setupMsg));
      });

      this.ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);

        // Resolve the connection promise when we receive the init message
        if (message.type === 'init') {
          this.conversationInitialized = true;
          resolve();
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        console.log('WebSocket closed');
      });

      // Add timeout for init message
      setTimeout(() => {
        if (!this.conversationInitialized) {
          reject(new Error('Timeout waiting for init message'));
        }
      }, 5000); // 5 second timeout
    });
  }

  private handleMessage(message: any): void {
    const now = Date.now();

    this.metrics.events.push({
      type: message.type,
      timestamp: now,
    });

    switch (message.type) {
      case 'init':
        log('debug', 'Conversation initialized', this.conversationId);
        break;

      case 'audioStream':
        if (!this.responseComplete) {
          const audioData = Buffer.from(message.data, 'base64');
          let dataToStore: Buffer;

          // Check if this is the first audio chunk response for a turn (after initial greeting)
          // and if we haven't processed it yet
          if (this.isInputComplete && !this.hasReceivedResponseAudio && this.currentTurn >= 0) {
            log(
              'info',
              `[Conv ${this.conversationId}] First response audio chunk for turn ${this.currentTurn} received at ${now}, inputEnd=${this.metrics.inputEndTimestamp}`,
            );

            // This is the first audio chunk of the response
            this.hasReceivedResponseAudio = true;
            dataToStore = audioData.subarray(44);
            this.metrics.firstChunkTimestamp = now;

            // Calculate and log TTFB - with additional debugging
            if (this.metrics.inputEndTimestamp > 0) {
              const latency = now - this.metrics.inputEndTimestamp;

              log(
                'info',
                `[Conv ${this.conversationId}] Calculating TTFB: now=${now}, inputEndTimestamp=${this.metrics.inputEndTimestamp}, latency=${latency}ms`,
              );

              if (latency > 0 && latency < TEST_TIMEOUT_MS) {
                log('info', `[Conv ${this.conversationId}] Valid TTFB: ${latency}ms for turn ${this.currentTurn}`);

                // Store latency in all relevant places
                this.metrics.turnLatencyMs = latency;
                this.metrics.firstChunkLatency = latency;
                this.metrics.turnLatencies.push(latency);
                this.allResults.turnLatencies.push(latency);

                log(
                  'info',
                  `[Conv ${this.conversationId}] After storing TTFB: turnLatencyMs=${this.metrics.turnLatencyMs}, turnLatencies=${JSON.stringify(this.metrics.turnLatencies)}, allResults.turnLatencies=${JSON.stringify(this.allResults.turnLatencies)}`,
                );
              } else {
                log('info', `[Conv ${this.conversationId}] Invalid latency value: ${latency}ms`);
              }
            } else {
              log(
                'info',
                `[Conv ${this.conversationId}] Cannot calculate TTFB: inputEndTimestamp=${this.metrics.inputEndTimestamp}`,
              );
            }
          } else if (!this.hasReceivedResponseAudio && !this.isInputComplete) {
            // This is part of the initial greeting, mark as received but don't calculate latency
            log('info', `[Conv ${this.conversationId}] Initial greeting audio chunk received at ${now}`);
            this.hasReceivedResponseAudio = true;
            dataToStore = audioData.subarray(44);
          } else {
            dataToStore = audioData;
          }

          const chunk = {
            timestamp: Date.now(),
            data: dataToStore,
            isInput: false,
          };

          this.currentTurnChunks.push(chunk);
          this.allConversationChunks.push(chunk);

          // Log when adding to metrics.chunks for debugging choppiness analysis
          const chunkType = !this.initialGreetingComplete ? 'greeting' : this.isInputComplete ? 'response' : 'unknown';
          log(
            'debug',
            `[Conv ${this.conversationId}] Adding ${chunkType} audio chunk to metrics at ${now}`,
            this.conversationId,
          );

          this.metrics.chunks.push({
            timestamp: Date.now(),
            data: message.data,
          });
        }
        break;

      case 'voiceActivityStart':
        if (this.isInputComplete && !this.voiceActivityDetected) {
          log('debug', 'Voice activity detected for response', this.conversationId);
          this.voiceActivityDetected = true;
          this.metrics.voiceActivityStartTime = now;
        }
        break;

      case 'newAudioStream':
        if (this.isInputComplete && !this.newAudioStreamReceived) {
          log('debug', 'New audio stream for response', this.conversationId);
          this.newAudioStreamReceived = true;
          this.metrics.newAudioStreamTime = now;
        }
        break;

      case 'onAgentTranscript':
        if (this.metrics.transcripts.agent.length === 0 && this.conversationId < 3) {
          log('info', `Agent [Conv ${this.conversationId}]: "${message.message}"`);
        } else if (this.metrics.transcripts.agent.length > 0) {
          log('info', `Agent [Conv ${this.conversationId}]: "${message.message}"`);
        }
        this.metrics.transcripts.agent.push(message.message);
        break;

      case 'onUserTranscript':
        log('info', `User [Conv ${this.conversationId}]: "${message.message}"`);
        this.metrics.transcripts.user.push(message.message);
        break;

      case 'audioStreamEnd':
        if (!this.initialGreetingComplete) {
          log('info', 'Initial greeting complete', this.conversationId);
          this.initialGreetingComplete = true;
          this.lastResponseChunkTimestamp = null;
        } else if (this.isInputComplete && this.hasReceivedResponseAudio) {
          log('info', `[Conv ${this.conversationId}] Turn ${this.currentTurn} response complete`, this.conversationId);
          this.currentTurnChunks = [];
          this.responseComplete = true;
          this.lastResponseChunkTimestamp = null;
        }
        break;

      case 'voiceActivityEnd':
        if (this.isInputComplete && this.voiceActivityDetected) {
          log('debug', 'Voice activity ended', this.conversationId);
          this.metrics.voiceActivityEndReceived = true;
        }
        break;

      case 'error':
        log('error', `Error: ${JSON.stringify(message)}`, this.conversationId);
        break;

      default:
        if (message.type !== 'SYS_LOG') {
          log('debug', `Received message type: ${message.type}`, this.conversationId);
        }
    }

    // Check completion conditions
    if (!this.responseComplete) {
      if (message.type === 'audioStreamEnd' && this.isInputComplete && this.hasReceivedResponseAudio) {
        log('debug', 'Response complete via audioStreamEnd', this.conversationId);
        this.responseComplete = true;
      } else if (this.metrics.voiceActivityEndReceived && this.voiceActivityDetected) {
        log('debug', 'Response complete via voiceActivityEnd', this.conversationId);
        this.responseComplete = true;
      } else if (
        this.voiceActivityDetected &&
        this.metrics.voiceActivityStartTime &&
        now - this.metrics.voiceActivityStartTime > RESPONSE_TIMEOUT_MS
      ) {
        log('error', `Response timed out after ${RESPONSE_TIMEOUT_MS}ms`, this.conversationId);
        this.responseComplete = true;
      }
    }
  }

  private async streamAudioInput(): Promise<void> {
    // Reset state for this turn
    this.hasReceivedResponseAudio = false;
    this.responseComplete = false;
    this.voiceActivityDetected = false;
    this.newAudioStreamReceived = false;
    this.isInputComplete = false;

    const audioPath = path.join(__dirname, 'input_greeting.wav');
    const audioData = fs.readFileSync(audioPath);

    // Parse WAV header
    const sampleRate = audioData.readUInt32LE(24);
    const numChannels = audioData.readUInt16LE(22);
    const bitsPerSample = audioData.readUInt16LE(34);
    const dataStart = 44; // Standard WAV header size

    console.log(`WAV file info: ${sampleRate}Hz, ${numChannels} channels, ${bitsPerSample} bits per sample`);

    // Skip WAV header to get raw PCM data
    const pcmData = audioData.slice(dataStart);

    // Convert to 16-bit samples (2 bytes per sample)
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);

    // Calculate chunk sizes based on sample rate
    const TARGET_SAMPLE_RATE = 16000; // 16kHz target rate
    const samplesPerChunk = Math.floor((320 * sampleRate) / TARGET_SAMPLE_RATE); // Adjust chunk size for input sample rate
    const CHUNK_INTERVAL = 20; // Send every 20ms to match real-time

    console.log(`Using chunk size of ${samplesPerChunk} samples for ${sampleRate}Hz input`);
    console.log('Sending audio input...');

    // Simple downsampling: take every Nth sample where N = sampleRate/targetRate
    const downsampleRatio = Math.floor(sampleRate / TARGET_SAMPLE_RATE);

    for (let i = 0; i < samples.length; i += samplesPerChunk) {
      // Get a chunk of samples at original sample rate
      const originalChunk = samples.slice(i, Math.min(i + samplesPerChunk, samples.length));

      // Downsample the chunk
      const downsampledLength = Math.floor(originalChunk.length / downsampleRatio);
      const downsampledChunk = new Int16Array(downsampledLength);

      for (let j = 0; j < downsampledLength; j++) {
        downsampledChunk[j] = originalChunk[j * downsampleRatio];
      }

      // Store the downsampled chunk for recording
      const inputChunk = {
        timestamp: Date.now(),
        data: Buffer.from(downsampledChunk.buffer),
        isInput: true,
      };
      this.allConversationChunks.push(inputChunk);

      // Convert Int16Array to Float32Array for mulaw encoding
      const float32Data = new Float32Array(downsampledChunk.length);
      for (let j = 0; j < downsampledChunk.length; j++) {
        float32Data[j] = downsampledChunk[j] / 32768.0; // Convert 16-bit PCM to float
      }

      // Encode chunk using mulaw
      const mulawData = encode(float32Data);
      const base64MulawData = Buffer.from(mulawData).toString('base64');

      const audioMessage = {
        type: 'audioIn',
        data: base64MulawData,
      };

      // Handle WebSocket backpressure
      if (this.ws.readyState === WebSocket.OPEN) {
        const canSend = this.ws.bufferedAmount < 64 * 1024; // 64KB threshold
        if (!canSend) {
          console.log('WebSocket backpressure detected, waiting...');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.ws.send(JSON.stringify(audioMessage));

        // Adjust timing to maintain real-time playback
        await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL));
      } else {
        console.error('WebSocket not open, stopping audio stream');
        break;
      }
    }

    console.log('Finished sending audio chunks, starting silence');

    // Mark input as complete and record timestamp BEFORE starting silence
    this.isInputComplete = true;
    this.metrics.inputEndTimestamp = Date.now();
    log(
      'info',
      `[Conv ${this.conversationId}] Audio input complete. Setting inputEndTimestamp=${this.metrics.inputEndTimestamp}`,
      this.conversationId,
    );

    // Create a small buffer of silence (all zeros)
    const silenceSize = 320; // 20ms of silence at 16kHz
    const silenceFloat32 = new Float32Array(silenceSize); // Already zeros
    const mulawSilence = encode(silenceFloat32);
    const silenceBase64 = Buffer.from(mulawSilence).toString('base64');

    // Start streaming silence after the audio file is fully sent
    this.silenceInterval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        const silenceMessage = {
          type: 'audioIn',
          data: silenceBase64,
        };
        this.ws.send(JSON.stringify(silenceMessage));
      } else {
        if (this.silenceInterval) {
          clearInterval(this.silenceInterval);
          this.silenceInterval = null;
        }
      }
    }, CHUNK_INTERVAL);
  }

  async runTest(): Promise<void> {
    try {
      await this.connect();

      // Wait for initial greeting to complete (audioStreamEnd)
      await Promise.race([
        new Promise<void>((resolve) => {
          const checkGreeting = setInterval(() => {
            if (this.initialGreetingComplete) {
              clearInterval(checkGreeting);
              resolve();
            }
          }, 100);
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout waiting for initial greeting')), TEST_TIMEOUT_MS),
        ),
      ]);

      // Send audio input
      await this.streamAudioInput();

      // Wait for response to complete
      await Promise.race([
        new Promise<void>((resolve) => {
          const checkResponse = setInterval(() => {
            if (this.responseComplete) {
              // Stop streaming silence and send empty chunk to signal end
              if (this.silenceInterval) {
                clearInterval(this.silenceInterval);
                this.silenceInterval = null;
                const endMessage = {
                  type: 'audioIn',
                  data: '',
                };
                this.ws.send(JSON.stringify(endMessage));
              }
              clearInterval(checkResponse);
              resolve();
            }
          }, 100);
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => {
            console.log('\nTest timed out. Current event sequence:');
            this.metrics.events.forEach((event) => {
              const timeSinceStart = event.timestamp - this.metrics.events[0].timestamp;
              console.log(`+${timeSinceStart}ms - ${event.type}`);
            });
            reject(new Error('Timeout waiting for response'));
          }, TEST_TIMEOUT_MS),
        ),
      ]);

      this.ws.close();
      console.log('\nTest Results:');
      console.log('-------------');
      console.log(`Time to first response chunk: ${this.metrics.firstChunkLatency}ms`);
      console.log(`Total response chunks received: ${this.metrics.chunks.length}`);

      if (this.metrics.chunks.length > 1) {
        const gaps = this.metrics.chunks.slice(1).map((chunk, i) => {
          return chunk.timestamp - this.metrics.chunks[i].timestamp;
        });
        console.log(`Average gap between chunks: ${gaps.reduce((a, b) => a + b, 0) / gaps.length}ms`);
        console.log(`Max gap between chunks: ${Math.max(...gaps)}ms`);
      }

      console.log('\nTranscripts:');
      console.log('User:', this.metrics.transcripts.user);
      console.log('Agent:', this.metrics.transcripts.agent);

      console.log('\nEvent Sequence:');
      this.metrics.events.forEach((event) => {
        console.log(`${new Date(event.timestamp).toISOString()} - ${event.type}`);
      });
    } catch (error) {
      console.error('Test failed:', error);
      this.ws?.close();
    }
  }

  private initializeMetrics(): AudioChunkMetrics {
    return {
      inputEndTimestamp: 0,
      firstChunkTimestamp: null,
      firstChunkLatency: null,
      turnLatencyMs: null,
      chunks: [],
      transcripts: {
        user: [],
        agent: [],
      },
      events: [],
      voiceActivityStartTime: null,
      newAudioStreamTime: null,
      responseAudioChunks: 0,
      voiceActivityEndReceived: false,
      greetingGaps: [],
      responseGaps: [],
      turnLatencies: [],
      choppinessEvents: 0,
      largestGaps: [],
    };
  }

  private logResults() {
    const latencies = this.allResults.turnLatencies;
    const greetingGaps = this.allResults.greetingGaps;
    const responseGaps = this.allResults.responseGaps;

    console.log('\nTest Results:');
    console.log('-------------');
    console.log(`Total turns tested: ${this.currentTurn}`);

    if (latencies.length > 0) {
      console.log('\nTurn Latency Stats (ms):');
      console.log(`P50: ${this.calculatePercentile(latencies, 50)}`);
      console.log(`P95: ${this.calculatePercentile(latencies, 95)}`);
      console.log(`P99: ${this.calculatePercentile(latencies, 99)}`);
      console.log(`Min: ${Math.min(...latencies)}`);
      console.log(`Max: ${Math.max(...latencies)}`);
      console.log(`Average: ${latencies.reduce((a, b) => a + b, 0) / latencies.length}`);
    }

    if (greetingGaps.length > 0) {
      console.log('\nInitial Greeting Gap Stats (ms):');
      console.log(`P50: ${this.calculatePercentile(greetingGaps, 50)}`);
      console.log(`P95: ${this.calculatePercentile(greetingGaps, 95)}`);
      console.log(`P99: ${this.calculatePercentile(greetingGaps, 99)}`);
      console.log(`Min: ${Math.min(...greetingGaps)}`);
      console.log(`Max: ${Math.max(...greetingGaps)}`);
      console.log(`Average: ${greetingGaps.reduce((a, b) => a + b, 0) / greetingGaps.length}`);
    }

    if (responseGaps.length > 0) {
      console.log('\nAgent Response Gap Stats (ms):');
      console.log(`P50: ${this.calculatePercentile(responseGaps, 50)}`);
      console.log(`P95: ${this.calculatePercentile(responseGaps, 95)}`);
      console.log(`P99: ${this.calculatePercentile(responseGaps, 99)}`);
      console.log(`Min: ${Math.min(...responseGaps)}`);
      console.log(`Max: ${Math.max(...responseGaps)}`);
      console.log(`Average: ${responseGaps.reduce((a, b) => a + b, 0) / responseGaps.length}`);
    }

    if (this.allResults.largeGaps.length > 0) {
      console.log('\nLarge Gaps Detected (>100ms):');
      this.allResults.largeGaps.forEach(({ gap, turnIndex }) => {
        console.log(`Turn ${turnIndex}: ${gap}ms gap`);
      });
    }
  }

  private async startNextTurn() {
    this.metrics = this.initializeMetrics();
    this.isInputComplete = false;
    await this.streamAudioInput();
  }

  public async start(): Promise<ConversationMetrics> {
    const metrics: ConversationMetrics = {
      turnLatencies: [],
      chunkGaps: [],
      largeGaps: [],
      errors: [],
      audioChunks: [],
      initialGreetingComplete: false,
      choppinessEvents: 0,
      largestAudioGaps: [],
    };

    try {
      await this.connect();
      log('debug', 'Connected and starting conversation', this.conversationId);

      // Wait for initial greeting
      await this.waitForInitialGreeting();
      log('debug', 'Initial greeting completed', this.conversationId);
      metrics.initialGreetingComplete = true;

      // Run one turn and wait for response
      this.currentTurn = 0;
      await this.streamAudioInput();

      // Wait for response and collect metrics
      await new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.responseComplete) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);

        setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Timeout waiting for response'));
        }, TEST_TIMEOUT_MS);
      });

      // Analyze audio choppiness
      this.analyzeAudioChoppiness();

      // Log current state for debugging
      log(
        'info',
        `[Conv ${this.conversationId}] Final metrics state before return: inputEndTimestamp=${this.metrics.inputEndTimestamp}, turnLatencyMs=${this.metrics.turnLatencyMs}, turnLatencies=${JSON.stringify(this.metrics.turnLatencies)}, allResults.turnLatencies=${JSON.stringify(this.allResults.turnLatencies)}`,
      );

      // CRITICAL: Use the metrics from allResults which contain the aggregated TTFB measurements
      if (this.allResults.turnLatencies.length > 0) {
        metrics.turnLatencies = [...this.allResults.turnLatencies];
        log(
          'info',
          `[Conv ${this.conversationId}] Successfully copied ${metrics.turnLatencies.length} TTFB measurements to result metrics`,
        );
      } else if (this.metrics.turnLatencyMs) {
        // Fallback to turnLatencyMs if available
        metrics.turnLatencies.push(this.metrics.turnLatencyMs);
        log('info', `[Conv ${this.conversationId}] Using fallback turnLatencyMs=${this.metrics.turnLatencyMs}`);
      } else if (this.metrics.turnLatencies && this.metrics.turnLatencies.length > 0) {
        // Also try the turnLatencies array
        metrics.turnLatencies.push(...this.metrics.turnLatencies);
        log(
          'info',
          `[Conv ${this.conversationId}] Using fallback turnLatencies array with ${this.metrics.turnLatencies.length} items`,
        );
      } else {
        log('info', `[Conv ${this.conversationId}] No TTFB metrics found to return`);
      }

      // Copy choppiness metrics
      metrics.choppinessEvents = this.metrics.choppinessEvents;
      metrics.largestAudioGaps = this.metrics.largestGaps;

      // Save audio files
      this.saveConversationAudio();
      // Also save audio with real timing as MP3
      this.saveConversationAudioWithRealTiming();

      log('info', 'Conversation complete', this.conversationId);
    } catch (error) {
      log('error', `Failed: ${error}`, this.conversationId);
      metrics.errors.push(String(error));
    } finally {
      if (this.allConversationChunks.length > 0) {
        this.saveConversationAudio();
        // Also save audio with real timing as MP3 in case of failure
        this.saveConversationAudioWithRealTiming();
      }
      this.cleanup();
    }

    return metrics;
  }

  private async waitForResponse(): Promise<{
    latency: number | null;
    gaps: Array<number>;
    largeGaps: Array<{
      gap: number;
      turnIndex: number;
      timestamp: number;
      chunkSize: number;
    }>;
  }> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        // Only require one agent response and completion
        if (this.metrics.transcripts.agent.length > 0 && this.responseComplete) {
          clearInterval(checkInterval);
          const latency = this.metrics.turnLatencyMs || null;
          const gaps = this.metrics.greetingGaps.concat(this.metrics.responseGaps);
          const largeGaps = this.allResults.largeGaps;
          resolve({ latency, gaps, largeGaps });
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for response'));
      }, TEST_TIMEOUT_MS);
    });
  }

  private async waitForInitialGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (this.initialGreetingComplete) {
          clearInterval(checkInterval);

          // Reset audio reception flag after initial greeting
          log(
            'info',
            `[Conv ${this.conversationId}] Initial greeting complete, resetting audio state`,
            this.conversationId,
          );
          this.hasReceivedResponseAudio = false;
          this.responseComplete = false;

          // Clear any metrics chunks from the initial greeting
          log(
            'info',
            `[Conv ${this.conversationId}] Clearing ${this.metrics.chunks.length} initial greeting chunks from metrics`,
            this.conversationId,
          );
          this.metrics.chunks = [];

          resolve();
        }
      }, 100);

      // Add timeout
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for initial greeting'));
      }, TEST_TIMEOUT_MS);
    });
  }

  private cleanup() {
    if (this.silenceInterval) {
      clearInterval(this.silenceInterval);
      this.silenceInterval = null;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    console.log(`[Conv ${this.conversationId}] Cleanup complete`);
  }

  private saveConversationAudio(): void {
    try {
      console.log(`[Conv ${this.conversationId}] Processing ${this.allConversationChunks.length} audio chunks...`);

      if (this.allConversationChunks.length === 0) {
        log('debug', 'No audio chunks to save', this.conversationId);
        return;
      }

      // Sort chunks by timestamp
      const sortedChunks = [...this.allConversationChunks].sort((a, b) => a.timestamp - b.timestamp);

      // Calculate total size
      let totalDataSize = 0;
      for (const chunk of sortedChunks) {
        totalDataSize += chunk.data.length;
      }
      console.log(`[Conv ${this.conversationId}] Total audio data size: ${totalDataSize} bytes`);

      // WAV file settings
      const sampleRate = 16000;
      const channels = 1;
      const bitDepth = 16;

      // Create header for WAV file
      const headerSize = 44;
      const header = Buffer.alloc(headerSize);

      // RIFF chunk descriptor
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + totalDataSize, 4); // Chunk size (file size - 8)
      header.write('WAVE', 8);

      // fmt sub-chunk
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // Sub-chunk size (16 for PCM)
      header.writeUInt16LE(1, 20); // Audio format (1 for PCM)
      header.writeUInt16LE(channels, 22); // Number of channels
      header.writeUInt32LE(sampleRate, 24); // Sample rate
      header.writeUInt32LE((sampleRate * channels * bitDepth) / 8, 28); // Byte rate
      header.writeUInt16LE((channels * bitDepth) / 8, 32); // Block align
      header.writeUInt16LE(bitDepth, 34); // Bits per sample

      // data sub-chunk
      header.write('data', 36);
      header.writeUInt32LE(totalDataSize, 40); // Sub-chunk size (data size)

      // Create output file path
      const outputDir = path.join(process.cwd(), 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outputPath = path.join(outputDir, `conversation_${this.conversationId}.wav`);
      console.log(`[Conv ${this.conversationId}] Writing audio file to ${outputPath}`);

      // Create a write stream
      const writeStream = fs.createWriteStream(outputPath);

      // Write header
      writeStream.write(header);

      // Write all audio chunks sequentially
      for (const chunk of sortedChunks) {
        writeStream.write(chunk.data);
      }

      // Close the stream
      writeStream.end();

      log('info', `Successfully saved audio file: conversation_${this.conversationId}.wav`, this.conversationId);
    } catch (error) {
      log('error', `Failed to save audio: ${error}`, this.conversationId);
    }
  }

  private calculatePercentile(numbers: Array<number>, percentile: number): number {
    const sorted = [...numbers].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }

  private analyzeGaps(gaps: Array<number>, type: string): void {
    const gapThresholds = [50, 100, 200, 500, 1000];
    const gapCounts = gapThresholds.map((threshold) => ({
      threshold,
      count: gaps.filter((gap) => gap > threshold).length,
      percentage: (gaps.filter((gap) => gap > threshold).length / gaps.length) * 100,
    }));

    gapCounts.forEach(({ threshold, count, percentage }) => {
      if (count > 0) {
        log('info', `${type} gaps >${threshold}ms: ${count} (${percentage.toFixed(2)}%)`);
      }
    });
  }

  private analyzeAudioChoppiness(): void {
    if (this.metrics.chunks.length < 2) {
      log('info', `[Conv ${this.conversationId}] Not enough chunks to analyze choppiness`, this.conversationId);
      return;
    }

    // Sort chunks by timestamp
    const sortedChunks = [...this.metrics.chunks].sort((a, b) => a.timestamp - b.timestamp);

    // Only analyze chunks from the actual conversation, not the initial greeting
    // We can use inputEndTimestamp as our starting point, since that's when our turn began
    const conversationChunks = sortedChunks.filter((chunk) => {
      // Only include chunks that are from after the user's input ended
      return this.metrics.inputEndTimestamp > 0 && chunk.timestamp >= this.metrics.inputEndTimestamp;
    });

    if (conversationChunks.length < 2) {
      log(
        'info',
        `[Conv ${this.conversationId}] Not enough conversation chunks to analyze choppiness (filtered ${sortedChunks.length} down to ${conversationChunks.length})`,
        this.conversationId,
      );
      return;
    }

    log(
      'info',
      `[Conv ${this.conversationId}] Analyzing choppiness for ${conversationChunks.length} chunks (excluding initial greeting)`,
      this.conversationId,
    );

    // Calculate all gaps for debugging
    const allGaps: Array<{ index: number; gap: number; startTime: number; endTime: number }> = [];
    for (let i = 0; i < conversationChunks.length - 1; i++) {
      const currentChunk = conversationChunks[i];
      const nextChunk = conversationChunks[i + 1];
      const gap = nextChunk.timestamp - currentChunk.timestamp;

      if (gap > 50) {
        // Only log significant gaps
        allGaps.push({
          index: i,
          gap: gap,
          startTime: currentChunk.timestamp,
          endTime: nextChunk.timestamp,
        });
      }
    }

    // Log all significant gaps for verification
    if (allGaps.length > 0) {
      log('info', `[Conv ${this.conversationId}] All significant gaps (>50ms):`, this.conversationId);
      allGaps.sort((a, b) => b.gap - a.gap); // Sort by largest gap first

      // Convert timestamps to relative time from test start for better readability
      const firstTimestamp = conversationChunks[0].timestamp;
      allGaps.slice(0, 10).forEach((g) => {
        const relativeStart = g.startTime - firstTimestamp;
        const relativeEnd = g.endTime - firstTimestamp;
        log(
          'info',
          `  Gap of ${g.gap}ms between chunks ${g.index} and ${g.index + 1} (at ${relativeStart}ms to ${relativeEnd}ms into the conversation)`,
          this.conversationId,
        );
      });
    }

    // Set parameters for choppiness detection
    const typicalChunkDuration = 20; // ms - typical chunk duration
    const bufferSize = 60; // ms - simulated client buffer size
    let currentBufferLevel = 0; // ms of audio in buffer
    let starvedCount = 0;
    const gaps: Array<number> = [];
    const starvationDetails: Array<{ time: number; gap: number; bufferLevel: number }> = [];

    // Simulate real-time playback
    for (let i = 0; i < conversationChunks.length - 1; i++) {
      const currentChunk = conversationChunks[i];
      const nextChunk = conversationChunks[i + 1];

      // Time gap between chunks
      const gap = nextChunk.timestamp - currentChunk.timestamp;

      // Add typical chunk duration to buffer
      currentBufferLevel += typicalChunkDuration;

      // Debug log for large gaps
      if (gap > 200) {
        log(
          'debug',
          `[Conv ${this.conversationId}] Large gap of ${gap}ms before chunk ${i + 1}, buffer level before: ${currentBufferLevel}ms`,
          this.conversationId,
        );
      }

      // Simulate time passing until next chunk
      currentBufferLevel -= gap;

      // If buffer runs out before next chunk arrives, we have choppiness
      if (currentBufferLevel < 0) {
        // We've starved the buffer - user would hear a gap
        starvedCount++;
        gaps.push(gap);

        const relativeTime = currentChunk.timestamp - conversationChunks[0].timestamp;
        starvationDetails.push({
          time: relativeTime,
          gap: gap,
          bufferLevel: currentBufferLevel,
        });

        // Reset buffer (next chunk starts fresh)
        currentBufferLevel = 0;
      }

      // Cap buffer size
      currentBufferLevel = Math.min(currentBufferLevel, bufferSize);
    }

    // Report detailed starvation events
    if (starvationDetails.length > 0) {
      log('info', `[Conv ${this.conversationId}] Detailed buffer starvation events:`, this.conversationId);
      starvationDetails.forEach((event, index) => {
        log(
          'info',
          `  Event ${index + 1}: at ${event.time}ms into conversation, gap: ${event.gap}ms, buffer shortfall: ${Math.abs(event.bufferLevel)}ms`,
          this.conversationId,
        );
      });
    }

    // Report choppiness metrics
    const totalPlayTime = conversationChunks[conversationChunks.length - 1].timestamp - conversationChunks[0].timestamp;
    log('info', `[Conv ${this.conversationId}] Choppiness analysis:`, this.conversationId);
    log(
      'info',
      `  - First chunk timestamp: ${new Date(conversationChunks[0].timestamp).toISOString()}`,
      this.conversationId,
    );
    log(
      'info',
      `  - Last chunk timestamp: ${new Date(conversationChunks[conversationChunks.length - 1].timestamp).toISOString()}`,
      this.conversationId,
    );
    log('info', `  - Total conversation time span: ${totalPlayTime}ms`, this.conversationId);
    log('info', `  - Conversation chunk count: ${conversationChunks.length}`, this.conversationId);
    log('info', `  - Buffer starvation events: ${starvedCount}`, this.conversationId);
    log(
      'info',
      `  - Percentage of time with potential choppiness: ${(((starvedCount * 20) / totalPlayTime) * 100).toFixed(1)}%`,
      this.conversationId,
    );

    // Log the largest gaps
    if (gaps.length > 0) {
      gaps.sort((a, b) => b - a);
      const topGaps = gaps.slice(0, Math.min(5, gaps.length));
      log(
        'info',
        `  - Largest gaps causing buffer starvation: ${topGaps.map((g) => `${g}ms`).join(', ')}`,
        this.conversationId,
      );
    }

    // Store metrics for reporting
    this.metrics.choppinessEvents = starvedCount;
    this.metrics.largestGaps = gaps.slice(0, Math.min(5, gaps.length));
  }

  public static async analyzeResults(
    results: Array<ConversationMetrics>,
    startTime: number,
    endTime: number,
  ): Promise<void> {
    // More detailed logging to debug what metrics we're receiving
    console.log('Raw metrics data:', results.map((r, i) => `Conv ${i}: ${JSON.stringify(r.turnLatencies)}`).join('\n'));

    // Aggregate metrics with better filtering
    const allLatencies = results.flatMap((r, i) => {
      const validLatencies = r.turnLatencies.filter(
        (l) => l !== null && l !== undefined && !isNaN(l) && l > 0 && l < TEST_TIMEOUT_MS,
      );
      if (validLatencies.length !== r.turnLatencies.length) {
        log('info', `Conv ${i}: Filtered out ${r.turnLatencies.length - validLatencies.length} invalid latencies`);
      }
      return validLatencies;
    });

    log('info', `Total latency measurements collected: ${allLatencies.length}`);
    if (allLatencies.length > 0) {
      log('info', `TTFB values: ${allLatencies.join(', ')}`);
    }

    // Aggregate choppiness metrics
    const totalChoppinessEvents = results.reduce((sum, r) => sum + (r.choppinessEvents || 0), 0);
    const allGaps = results.flatMap((r) => r.largestAudioGaps || []);
    allGaps.sort((a, b) => b - a);
    const topGaps = allGaps.slice(0, Math.min(10, allGaps.length));

    // Print results
    log('info', '\nTest Summary:');
    log('info', '-------------');
    log('info', `Conversations started: ${NUM_PARALLEL_CONVERSATIONS}`);
    log('info', `Conversations completed: ${results.length}`);
    log('info', `Success rate: ${((results.length / NUM_PARALLEL_CONVERSATIONS) * 100).toFixed(1)}%`);
    log('info', `Total turns with valid TTFB: ${allLatencies.length}`);
    log('info', `Total duration: ${((endTime - startTime) / 1000).toFixed(1)}s`);

    if (allLatencies.length > 0) {
      const tester = new AudioStreamTester('dummy', -1);
      log('info', '\nTime To First Byte (TTFB) Statistics:');
      log('info', `P50: ${Math.round(tester.calculatePercentile(allLatencies, 50))}ms`);
      log('info', `P75: ${Math.round(tester.calculatePercentile(allLatencies, 75))}ms`);
      log('info', `P90: ${Math.round(tester.calculatePercentile(allLatencies, 90))}ms`);
      log('info', `Min: ${Math.min(...allLatencies)}ms`);
      log('info', `Max: ${Math.max(...allLatencies)}ms`);
      log('info', `Avg: ${Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)}ms`);
    } else {
      log('error', '\nNo valid latency measurements collected');
    }

    // Report on audio choppiness
    log('info', '\nAudio Choppiness Analysis:');
    log('info', `Total buffer starvation events: ${totalChoppinessEvents}`);
    log('info', `Avg events per conversation: ${(totalChoppinessEvents / results.length).toFixed(1)}`);

    if (topGaps.length > 0) {
      log('info', `Largest gaps between audio chunks: ${topGaps.map((g) => `${g}ms`).join(', ')}`);
    } else {
      log('info', 'No significant gaps detected in audio streaming');
    }

    const errors = results.flatMap((r) => r.errors);
    if (errors.length > 0) {
      log('error', '\nErrors:');
      errors.forEach((error, index) => {
        log('error', `Conv ${index}: ${error}`);
      });
    }
  }

  private saveConversationAudioWithRealTiming(): void {
    try {
      // Force debug-level logs to be displayed for this important function
      console.log(`[Conv ${this.conversationId}] Starting to create audio file with real timing...`);
      console.log(`[Conv ${this.conversationId}] Found ${this.allConversationChunks.length} audio chunks to process`);

      if (this.allConversationChunks.length < 2) {
        console.log(
          `[Conv ${this.conversationId}] Not enough audio chunks to create file with timing (need at least 2)`,
        );
        return;
      }

      // Sort chunks by timestamp
      const sortedChunks = [...this.allConversationChunks].sort((a, b) => a.timestamp - b.timestamp);
      console.log(
        `[Conv ${this.conversationId}] First chunk timestamp: ${new Date(sortedChunks[0].timestamp).toISOString()}`,
      );
      console.log(
        `[Conv ${this.conversationId}] Last chunk timestamp: ${new Date(sortedChunks[sortedChunks.length - 1].timestamp).toISOString()}`,
      );

      // Create output directory
      const outputDir = path.join(process.cwd(), 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`[Conv ${this.conversationId}] Created output directory: ${outputDir}`);
      }

      // Create a temporary WAV file with real timing first
      const tempWavPath = path.join(outputDir, `temp_${this.conversationId}.wav`);
      const finalMp3Path = path.join(outputDir, `conversation_${this.conversationId}_real_timing.mp3`);

      console.log(`[Conv ${this.conversationId}] Will save WAV to: ${tempWavPath}`);
      console.log(`[Conv ${this.conversationId}] Will save MP3 to: ${finalMp3Path}`);

      // WAV file settings
      const sampleRate = 16000;
      const channels = 1;
      const bitDepth = 16;
      const bytesPerSample = bitDepth / 8;

      // Calculate the total duration with gaps included
      const startTime = sortedChunks[0].timestamp;
      const endTime = sortedChunks[sortedChunks.length - 1].timestamp;
      const totalDurationMs = endTime - startTime;
      const totalSamples = Math.ceil((totalDurationMs * sampleRate) / 1000);
      const totalDataSize = totalSamples * channels * bytesPerSample;

      console.log(`[Conv ${this.conversationId}] Creating audio with real timing:`);
      console.log(`  - Total duration: ${totalDurationMs}ms (${totalDurationMs / 1000} seconds)`);
      console.log(`  - Total samples: ${totalSamples}`);
      console.log(`  - Buffer size: ${totalDataSize} bytes`);

      // Create a buffer large enough to hold the entire audio with silences
      const audioBuffer = Buffer.alloc(totalDataSize, 0); // Initialize with zeros (silence)
      console.log(`[Conv ${this.conversationId}] Created audio buffer of size ${audioBuffer.length} bytes`);

      // Filter out input chunks (user audio) if we want only agent audio
      const agentChunks = sortedChunks.filter((chunk) => !chunk.isInput);
      console.log(
        `[Conv ${this.conversationId}] Using ${agentChunks.length} agent audio chunks (filtered out user audio)`,
      );

      // Place each audio chunk at the correct position in the buffer
      for (let i = 0; i < agentChunks.length; i++) {
        const chunk = agentChunks[i];
        const relativePositionMs = chunk.timestamp - startTime;

        // Calculate sample position, ensuring it's even (for 16-bit samples)
        const samplePosition = Math.floor((relativePositionMs * sampleRate) / 1000);
        const bytePosition = samplePosition * channels * bytesPerSample;

        if (i < 5 || i > agentChunks.length - 5) {
          console.log(
            `  - Chunk ${i}: placing ${chunk.data.length} bytes at position ${bytePosition} (${relativePositionMs}ms)`,
          );
        } else if (i === 5) {
          console.log(`  - ... ${agentChunks.length - 10} more chunks ...`);
        }

        // Check if the chunk data is properly aligned for 16-bit samples
        let dataToWrite = chunk.data;
        if (chunk.data.length % 2 !== 0) {
          // Ensure even length for 16-bit samples
          dataToWrite = chunk.data.slice(0, chunk.data.length - 1);
          console.log(`  - Fixed odd-sized chunk (${chunk.data.length} → ${dataToWrite.length} bytes)`);
        }

        // Add the chunk data to the buffer, ensuring we don't exceed buffer bounds
        if (bytePosition + dataToWrite.length <= audioBuffer.length) {
          dataToWrite.copy(audioBuffer, bytePosition);
        } else {
          console.log(
            `[Conv ${this.conversationId}] Warning: Chunk at ${relativePositionMs}ms exceeds buffer size, truncating`,
          );
          const bytesToCopy = Math.min(dataToWrite.length, audioBuffer.length - bytePosition);
          if (bytesToCopy > 0) {
            dataToWrite.copy(audioBuffer, bytePosition, 0, bytesToCopy);
          }
        }
      }

      // Create WAV header
      const headerSize = 44;
      const header = Buffer.alloc(headerSize);

      // RIFF chunk descriptor
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + totalDataSize, 4); // Chunk size (file size - 8)
      header.write('WAVE', 8);

      // fmt sub-chunk
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // Sub-chunk size (16 for PCM)
      header.writeUInt16LE(1, 20); // Audio format (1 for PCM)
      header.writeUInt16LE(channels, 22); // Number of channels
      header.writeUInt32LE(sampleRate, 24); // Sample rate
      header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // Byte rate
      header.writeUInt16LE(channels * bytesPerSample, 32); // Block align
      header.writeUInt16LE(bitDepth, 34); // Bits per sample

      // data sub-chunk
      header.write('data', 36);
      header.writeUInt32LE(totalDataSize, 40); // Sub-chunk size (data size)

      console.log(`[Conv ${this.conversationId}] Writing WAV file to ${tempWavPath}`);

      // Write the WAV file
      try {
        const file = fs.openSync(tempWavPath, 'w');
        fs.writeSync(file, header);
        fs.writeSync(file, audioBuffer);
        fs.closeSync(file);
        console.log(`[Conv ${this.conversationId}] Successfully wrote WAV file: ${tempWavPath}`);
      } catch (fileError) {
        console.error(`[Conv ${this.conversationId}] Error writing WAV file: ${fileError}`);
        return;
      }

      // Check if the file was actually created and contains data
      try {
        const stats = fs.statSync(tempWavPath);
        console.log(`[Conv ${this.conversationId}] WAV file size: ${stats.size} bytes`);
        if (stats.size < header.length + 1000) {
          console.log(`[Conv ${this.conversationId}] Warning: WAV file is suspiciously small`);
        }
      } catch (statError) {
        console.error(`[Conv ${this.conversationId}] Cannot stat WAV file: ${statError}`);
      }

      // Convert to MP3 using ffmpeg
      console.log(`[Conv ${this.conversationId}] Converting WAV to MP3 with ffmpeg...`);

      try {
        // Check if ffmpeg is available in the path
        const { spawnSync } = require('child_process');

        // Check current working directory
        const cwd = process.cwd();
        console.log(`[Conv ${this.conversationId}] Current working directory: ${cwd}`);

        // Try to find ffmpeg executable
        const whichCommand = process.platform === 'win32' ? 'where' : 'which';
        const ffmpegCheck = spawnSync(whichCommand, ['ffmpeg']);

        if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
          console.log(`[Conv ${this.conversationId}] ffmpeg not found in PATH`);
          console.log(`[Conv ${this.conversationId}] Using WAV file as final output: ${tempWavPath}`);
          return;
        }

        console.log(`[Conv ${this.conversationId}] Found ffmpeg at: ${ffmpegCheck.stdout.toString().trim()}`);

        // Set up the ffmpeg command with noise reduction options
        const ffmpegCommand = [
          '-i',
          tempWavPath,
          '-codec:a',
          'libmp3lame',
          '-qscale:a',
          '2',
          // Add noise filtering options
          '-af',
          'highpass=f=200,lowpass=f=3000',
          finalMp3Path,
          '-y',
        ];

        console.log(`[Conv ${this.conversationId}] Running ffmpeg command: ffmpeg ${ffmpegCommand.join(' ')}`);

        // Run ffmpeg
        const ffmpegProc = spawnSync('ffmpeg', ffmpegCommand, {
          encoding: 'utf8',
          stdio: 'pipe', // Capture stdout and stderr
        });

        if (ffmpegProc.error) {
          console.error(`[Conv ${this.conversationId}] FFmpeg error: ${ffmpegProc.error}`);
          console.log(`[Conv ${this.conversationId}] Using WAV file as final output: ${tempWavPath}`);
        } else if (ffmpegProc.status !== 0) {
          console.error(`[Conv ${this.conversationId}] FFmpeg exited with code ${ffmpegProc.status}`);
          console.error(`[Conv ${this.conversationId}] FFmpeg stdout: ${ffmpegProc.stdout}`);
          console.error(`[Conv ${this.conversationId}] FFmpeg stderr: ${ffmpegProc.stderr}`);
          console.log(`[Conv ${this.conversationId}] Using WAV file as final output: ${tempWavPath}`);
        } else {
          console.log(`[Conv ${this.conversationId}] FFmpeg conversion successful`);

          // Verify MP3 file exists
          if (fs.existsSync(finalMp3Path)) {
            const mp3Stats = fs.statSync(finalMp3Path);
            console.log(`[Conv ${this.conversationId}] MP3 file size: ${mp3Stats.size} bytes`);
            console.log(`[Conv ${this.conversationId}] Successfully created MP3 with real timing: ${finalMp3Path}`);

            // Remove temporary WAV file
            fs.unlinkSync(tempWavPath);
            console.log(`[Conv ${this.conversationId}] Removed temporary WAV file`);
          } else {
            console.error(`[Conv ${this.conversationId}] MP3 file not created despite ffmpeg success`);
            console.log(`[Conv ${this.conversationId}] Using WAV file as final output: ${tempWavPath}`);
          }
        }
      } catch (e) {
        console.error(`[Conv ${this.conversationId}] Error during ffmpeg conversion: ${e}`);
        console.log(`[Conv ${this.conversationId}] Using WAV file as final output: ${tempWavPath}`);
      }
    } catch (error: unknown) {
      console.error(`[Conv ${this.conversationId}] Failed to save audio with real timing: ${error}`);
      if (error instanceof Error) {
        console.error(error.stack);
      }
    }
  }
}

/**
 * Main entry point - Run the parallel conversations
 */
async function runParallelConversations(): Promise<void> {
  const startTime = Date.now();
  const results: Array<ConversationMetrics> = [];

  log('info', `Starting ${NUM_PARALLEL_CONVERSATIONS} parallel conversations...`);

  // Create and run testers in parallel
  const testerPromises = Array.from({ length: NUM_PARALLEL_CONVERSATIONS }, (_, i) => {
    const tester = new AudioStreamTester(process.env.PLAY_API_KEY!, i);
    return tester.start().then((metrics) => {
      results.push(metrics);
      return metrics;
    });
  });

  // Wait for all conversations to complete
  await Promise.all(testerPromises);
  const endTime = Date.now();

  // Analyze and log results
  await AudioStreamTester.analyzeResults(results, startTime, endTime);
}

// Run the test
runParallelConversations().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
