/**
 * A simple script to analyze audio chunk delivery patterns for choppiness.
 * This helps identify when audio delivery would cause audible gaps in client playback.
 */

import * as fs from 'fs';

// Configuration
const BUFFER_SIZE = 60; // ms - typical client buffer size
const CHUNK_DURATION = 20; // ms - typical chunk contains 20ms of audio
const MIN_GAP_TO_LOG = 50; // ms - only log gaps larger than this

interface AudioChunk {
  timestamp: number;
  size: number; // bytes
}

class ChoppinessAnalyzer {
  static analyzeFile(filepath: string) {
    console.log(`Analyzing audio chunks in: ${filepath}`);

    try {
      // Read the log file
      const logContent = fs.readFileSync(filepath, 'utf-8');
      const lines = logContent.split('\n');

      // Extract timestamps of audio chunks
      const chunks: Array<AudioChunk> = [];

      lines.forEach((line) => {
        // Look for audio chunks by searching for several patterns
        if (
          (line.includes('audioStream') && !line.includes('audioStreamEnd')) ||
          (line.includes('Adding') && line.includes('audio chunk')) ||
          line.includes('First response audio chunk')
        ) {
          // Extract timestamp from the log line
          const timestampMatch = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(line);
          if (timestampMatch) {
            const timestamp = new Date(timestampMatch[1]).getTime();
            // Estimate size based on line length
            const size = line.length;
            chunks.push({ timestamp, size });
          }
        }
      });

      // Let's also check if there are any specific timestamps
      const timestampPattern = /timestamp=(\d+)/g;
      const allTimestamps: Array<number> = [];

      let match;
      logContent.split('\n').forEach((line) => {
        const regex = /timestamp=(\d+)/g;
        while ((match = regex.exec(line)) !== null) {
          allTimestamps.push(parseInt(match[1], 10));
        }
      });

      if (allTimestamps.length > 0) {
        console.log(`Found ${allTimestamps.length} explicit timestamps in logs`);
        // Use these timestamps if we didn't find enough chunks
        if (chunks.length < 2 && allTimestamps.length >= 2) {
          allTimestamps.sort((a, b) => a - b);
          chunks.length = 0; // Clear existing
          allTimestamps.forEach((ts) => {
            chunks.push({ timestamp: ts, size: 320 }); // Assume typical size
          });
          console.log(`Using ${chunks.length} timestamps from log`);
        }
      }

      if (chunks.length < 2) {
        console.log('Not enough audio chunks found to analyze');
        return;
      }

      // Sort chunks by timestamp
      chunks.sort((a, b) => a.timestamp - b.timestamp);
      console.log(
        `Found ${chunks.length} audio chunks spanning ${chunks[chunks.length - 1].timestamp - chunks[0].timestamp}ms`,
      );

      // Analyze gaps
      const gaps: Array<{ index: number; gap: number }> = [];
      for (let i = 0; i < chunks.length - 1; i++) {
        const currentChunk = chunks[i];
        const nextChunk = chunks[i + 1];
        const gap = nextChunk.timestamp - currentChunk.timestamp;

        if (gap > MIN_GAP_TO_LOG) {
          gaps.push({ index: i, gap });
        }
      }

      // Display significant gaps
      if (gaps.length > 0) {
        console.log(`\nFound ${gaps.length} significant gaps (>${MIN_GAP_TO_LOG}ms):`);
        gaps.sort((a, b) => b.gap - a.gap); // Sort by largest gap

        gaps.slice(0, 10).forEach((g) => {
          const relativeTime = chunks[g.index].timestamp - chunks[0].timestamp;
          console.log(`  Gap of ${g.gap}ms after chunk ${g.index} (at ${relativeTime}ms into recording)`);
        });
      } else {
        console.log('No significant gaps found in audio chunk delivery');
      }

      // Simulate buffer behavior
      let bufferLevel = 0;
      let starvedCount = 0;
      const starvationEvents: Array<{ time: number; gap: number }> = [];

      for (let i = 0; i < chunks.length - 1; i++) {
        const currentChunk = chunks[i];
        const nextChunk = chunks[i + 1];
        const gap = nextChunk.timestamp - currentChunk.timestamp;

        // Add audio to buffer
        bufferLevel += CHUNK_DURATION;

        // Subtract time between chunks
        bufferLevel -= gap;

        // Check if buffer ran out
        if (bufferLevel < 0) {
          starvedCount++;
          const relativeTime = currentChunk.timestamp - chunks[0].timestamp;
          starvationEvents.push({ time: relativeTime, gap });
          bufferLevel = 0; // Reset buffer
        }

        // Cap buffer size
        bufferLevel = Math.min(bufferLevel, BUFFER_SIZE);
      }

      // Report buffer starvation
      console.log(`\nBuffer Analysis (${BUFFER_SIZE}ms buffer, ${CHUNK_DURATION}ms chunks):`);
      console.log(`  Buffer starvation events: ${starvedCount}`);

      if (starvationEvents.length > 0) {
        console.log('  Buffer starvation details:');
        starvationEvents.forEach((event, i) => {
          console.log(`    Event ${i + 1}: at ${event.time}ms, gap: ${event.gap}ms`);
        });

        // Calculate percentage of time with choppy audio
        const totalTime = chunks[chunks.length - 1].timestamp - chunks[0].timestamp;
        const choppyPercentage = (((starvedCount * CHUNK_DURATION) / totalTime) * 100).toFixed(1);
        console.log(`  Estimated percentage of playback affected by choppiness: ${choppyPercentage}%`);
      }
    } catch (error) {
      console.error('Error analyzing file:', error);
    }
  }
}

// Allow running directly
if (require.main === module) {
  // Check for command line arguments
  const logFilePath = process.argv[2];

  if (!logFilePath) {
    console.log('Usage: tsx src/agents/choppiness-analyzer.ts <log-file-path>');
    process.exit(1);
  }

  ChoppinessAnalyzer.analyzeFile(logFilePath);
}

export default ChoppinessAnalyzer;
