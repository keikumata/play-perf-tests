# PlayHT TTS Performance Tester

This tool measures the performance of PlayHT's Text-to-Speech API, collecting metrics like:

- Time to First Byte (TTFB)
- Total request time
- Audio size
- P50 and P95 statistics

## Setup

1. Copy the `.env.template` file to `.env` and add your PlayHT API credentials:

   ```
   cp .env.template .env
   ```

2. Edit the `.env` file with your actual API key and user ID from the PlayHT dashboard

3. Install dependencies:
   ```
   npm install
   ```

## Usage

Basic usage with default settings (10 iterations, no audio saving):

```
npm start
```

Run with custom parameters:

```
npm run build
node dist/run-tests.js [iterations] [save] [voiceId]
```

Example with 20 iterations and saving audio files:

```
npm run test
```

Or with custom voice ID:

```
node dist/run-tests.js 15 save "s3://voice-cloning-zero-shot/[your-voice-id]/manifest.json"
```

## Parameters

- `iterations`: Number of API calls to make (default: 10)
- `save`: Set to "save" to save audio files (default: don't save)
- `voiceId`: PlayHT voice ID to use (default: a sample voice)

## Output

Results are saved in the `output/[timestamp]` directory, including:

- JSON file with performance metrics
- MP3 audio files (if saving is enabled)
- Configuration details

The console will display P50/P95 statistics for TTFB and total time, plus averages.

## How It Works

The tester:

1. Makes multiple API calls to PlayHT's TTS endpoint
2. Measures TTFB using the onDownloadProgress callback
3. Captures total request time from start to finish
4. Calculates performance percentiles (P50, P95)
5. Saves results for analysis
