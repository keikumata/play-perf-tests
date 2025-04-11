// Base on https://github.com/rochars/alawmulaw/blob/master/lib/mulaw.js

/*
 * alawmulaw: A-Law and mu-Law codecs in JavaScript.
 * https://github.com/rochars/alawmulaw
 *
 * Copyright (c) 2018-2019 Rafael da Silva Rocha.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 */

const BIAS = 0x84;
const CLIP = 32635;
const encodeTable: Array<number> = [
  0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
];
const decodeTable: Array<number> = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

/**
 * Encode a 16-bit linear PCM sample as 8-bit mu-Law.
 * @param {number} sample A 16-bit PCM sample
 * @return {number}
 */
export function encodeSample(sample: number): number {
  /** get the sample into sign-magnitude **/
  const sign = (sample >> 8) & 0x80;
  if (sign != 0) sample = -sample;
  /** convert from 16 bit linear to ulaw **/
  sample = sample + BIAS;
  if (sample > CLIP) sample = CLIP;
  const exponent = encodeTable[(sample >> 7) & 0xff]!;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const muLawSample = ~(sign | (exponent << 4) | mantissa);
  /** return the result **/
  return muLawSample;
}

/**
 * Decode a 8-bit mu-Law sample as 16-bit PCM.
 * @param {number} muLawSample The 8-bit mu-Law sample
 * @return {number}
 */
export function decodeSample(muLawSample: number): number {
  /** @type {number} */
  let sign: number;
  /** @type {number} */
  let exponent: number;
  /** @type {number} */
  let mantissa: number;
  /** @type {number} */
  let sample: number;
  muLawSample = ~muLawSample;
  sign = muLawSample & 0x80;
  exponent = (muLawSample >> 4) & 0x07;
  mantissa = muLawSample & 0x0f;
  sample = decodeTable[exponent]! + (mantissa << (exponent + 3));
  if (sign != 0) sample = -sample;
  // convert to float
  sample = sample / 32768;
  return sample;
}

/**
 * Encode 16-bit linear PCM samples into 8-bit mu-Law samples.
 * @param {!Float32Array} samples A array of 16-bit PCM samples.
 * @return {!Uint8Array}
 */
export function encode(samples: Float32Array): Uint8Array {
  /** @type {!Uint8Array} */
  const muLawSamples: Uint8Array = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sampleInt16 = Math.min(1, samples[i] ?? 0) * 0x7fff;
    muLawSamples[i] = encodeSample(sampleInt16);
  }
  return muLawSamples;
}

/**
 * Decode 8-bit mu-Law samples into 16-bit PCM samples.
 * @param {!Uint8Array} samples A array of 8-bit mu-Law samples.
 * @return {!Float32Array}
 */
export function decode(samples: Uint8Array): Float32Array {
  const pcmSamples: Float32Array = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcmSamples[i] = decodeSample(samples[i]!);
  }
  return pcmSamples;
}
