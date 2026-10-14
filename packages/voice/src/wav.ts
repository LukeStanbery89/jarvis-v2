/**
 * Minimal, dependency-free WAV codec (issue #121).
 *
 * The wake→command redesign is verified against a corpus of recorded
 * utterances, so the package needs to move audio in and out of WAV files
 * without pulling in an audio library (the package keeps zero mandatory
 * runtime dependencies). Two directions:
 *
 * - {@link encodeWav} — mono float PCM to a 16-bit PCM `RIFF/WAVE` byte
 *   string. Used by the web client's debug capture path to save an utterance
 *   for the replay harness.
 * - {@link decodeWav} — a `RIFF/WAVE` byte string to mono float PCM at its
 *   own sample rate. Used by tests and the harness to load fixtures.
 *
 * The decoder is deliberately permissive about the shapes real tools emit
 * (8/16/24/32-bit integers, 32-bit float, `WAVE_FORMAT_EXTENSIBLE`, and
 * multi-channel input downmixed to mono) and strict about anything it cannot
 * represent: a malformed header or unsupported encoding throws, because a
 * silently-garbled fixture would make a corpus result meaningless.
 *
 * Browser- and Node-safe: only `Uint8Array`/`DataView` are used, no `Buffer`,
 * no DOM, so the module is safe at import time in either runtime.
 */

/** Decoded WAV audio: mono float PCM normalized to `[-1, 1]`. */
export interface WavAudio {
    /** The decoded samples, downmixed to one channel. */
    readonly pcm: Float32Array;
    /** The file's sample rate in Hz. */
    readonly sampleRate: number;
}

/** The size of a canonical 16-bit mono PCM `RIFF/WAVE` header. */
const HEADER_BYTES = 44;

/** `WAVE_FORMAT_PCM` — integer samples. */
const FORMAT_PCM = 1;

/** `WAVE_FORMAT_IEEE_FLOAT` — 32-bit float samples. */
const FORMAT_FLOAT = 3;

/** `WAVE_FORMAT_EXTENSIBLE` — the real format lives in the extension GUID. */
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Encodes mono float PCM as a 16-bit PCM `RIFF/WAVE` byte string.
 *
 * Samples are clamped to `[-1, 1]` before quantization, so an out-of-range
 * float saturates rather than wrapping (a wrapped transient is far more
 * damaging to a decoder than a clipped one).
 *
 * @param pcm - Mono samples normalized to `[-1, 1]`.
 * @param sampleRate - The sample rate in Hz.
 * @returns The complete WAV file bytes.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error("encodeWav: sampleRate must be a positive number");
    }
    const dataBytes = pcm.length * 2;
    const out = new Uint8Array(HEADER_BYTES + dataBytes);
    const view = new DataView(out.buffer);
    writeAscii(out, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(out, 8, "WAVE");
    // fmt chunk.
    writeAscii(out, 12, "fmt ");
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, FORMAT_PCM, true);
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    // data chunk.
    writeAscii(out, 36, "data");
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < pcm.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, pcm[i]!));
        // Asymmetric scaling keeps -1 and +1 both representable without
        // overflowing int16 (32767 is the largest positive sample).
        const sample = Math.round(clamped * 32767);
        view.setInt16(HEADER_BYTES + i * 2, sample, true);
    }
    return out;
}

/**
 * Decodes a `RIFF/WAVE` byte string to mono float PCM.
 *
 * Handles the encodings listed in the module doc and downmixes any channel
 * count to mono by averaging. Chunks are walked rather than assumed to sit at
 * fixed offsets, so a `LIST`/`fact` chunk before `data` (common from
 * macOS/ffmpeg) does not break the parse.
 *
 * @param bytes - The complete WAV file bytes.
 * @returns The decoded samples and the file's sample rate.
 * @throws When the header is not `RIFF/WAVE`, the format is unsupported, or
 *   no `fmt `/`data` chunk is present.
 */
export function decodeWav(bytes: Uint8Array): WavAudio {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 12 || readAscii(bytes, 0, 4) !== "RIFF") {
        throw new Error("decodeWav: not a RIFF file");
    }
    if (readAscii(bytes, 8, 4) !== "WAVE") {
        throw new Error("decodeWav: not a WAVE file");
    }
    let format = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataLength = 0;
    // Walk the chunk list from after the RIFF/WAVE preamble. Each chunk is an
    // 8-byte id+size header followed by `size` bytes, padded to even length.
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
        const id = readAscii(bytes, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === "fmt ") {
            format = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bitsPerSample = view.getUint16(body + 14, true);
            if (format === FORMAT_EXTENSIBLE) {
                // The real WAVE format is the first two bytes of the
                // extension GUID; the rest is a fixed 0000-0010-8000-00aa…
                format = view.getUint16(body + 24, true);
            }
        } else if (id === "data") {
            dataOffset = body;
            // A streamed WAV may declare size 0 with the real length in the
            // file (or 0xFFFFFFFF); clamp to what is actually present.
            const available = bytes.byteLength - body;
            dataLength = size === 0 || size > available ? available : size;
        }
        offset = body + size + (size % 2);
    }
    if (dataOffset < 0 || channels < 1 || sampleRate < 1) {
        throw new Error("decodeWav: missing fmt or data chunk");
    }
    const pcm = decodeSamples({
        view,
        dataOffset,
        dataLength,
        format,
        channels,
        bitsPerSample,
    });
    return { pcm, sampleRate };
}

/** The `data` chunk plus its format, as {@link decodeSamples} needs it. */
interface SampleSource {
    readonly view: DataView;
    readonly dataOffset: number;
    readonly dataLength: number;
    readonly format: number;
    readonly channels: number;
    readonly bitsPerSample: number;
}

/**
 * Converts a `data` chunk into mono float PCM, dispatching on the encoding
 * and averaging channels.
 *
 * @param source - The parsed `data` chunk and its format.
 * @returns The mono samples normalized to `[-1, 1]`.
 * @throws When the encoding is not one of the supported ones.
 */
function decodeSamples(source: SampleSource): Float32Array {
    const { view, dataOffset, dataLength, format, channels, bitsPerSample } =
        source;
    const bytesPerSample = Math.floor(bitsPerSample / 8);
    if (bytesPerSample < 1) {
        throw new Error(`decodeWav: unsupported bit depth ${bitsPerSample}`);
    }
    if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
        throw new Error(`decodeWav: unsupported WAVE format ${format}`);
    }
    if (format === FORMAT_FLOAT && bitsPerSample !== 32) {
        throw new Error(
            `decodeWav: unsupported float bit depth ${bitsPerSample}`,
        );
    }
    const frameBytes = bytesPerSample * channels;
    const frames = Math.floor(dataLength / frameBytes);
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
            const at =
                dataOffset + frame * frameBytes + channel * bytesPerSample;
            sum += readSample(view, at, format, bitsPerSample);
        }
        out[frame] = sum / channels;
    }
    return out;
}

/**
 * Reads one sample as a float normalized to `[-1, 1]`.
 *
 * @param view - The file's view.
 * @param offset - The sample's byte offset.
 * @param format - The WAVE format (`PCM` or `FLOAT`).
 * @param bitsPerSample - The sample width in bits.
 * @returns The normalized sample.
 * @throws When the integer width is not 8, 16, 24, or 32.
 */
function readSample(
    view: DataView,
    offset: number,
    format: number,
    bitsPerSample: number,
): number {
    if (format === FORMAT_FLOAT) {
        return view.getFloat32(offset, true);
    }
    switch (bitsPerSample) {
        case 8:
            // 8-bit WAV is unsigned with a 128 bias.
            return (view.getUint8(offset) - 128) / 128;
        case 16:
            return view.getInt16(offset, true) / 32768;
        case 24: {
            // No 24-bit DataView accessor: assemble little-endian and
            // sign-extend from the top byte.
            const low = view.getUint16(offset, true);
            const high = view.getUint8(offset + 2);
            const raw = (high << 16) | low;
            const signed = raw >= 0x800000 ? raw - 0x1000000 : raw;
            return signed / 8388608;
        }
        case 32:
            return view.getInt32(offset, true) / 2147483648;
        default:
            throw new Error(
                `decodeWav: unsupported PCM bit depth ${bitsPerSample}`,
            );
    }
}

/**
 * Writes an ASCII tag (a chunk id) into the output at an offset.
 *
 * @param out - The target bytes.
 * @param offset - Where to write the tag.
 * @param tag - The four-character id.
 */
function writeAscii(out: Uint8Array, offset: number, tag: string): void {
    for (let i = 0; i < tag.length; i += 1) {
        out[offset + i] = tag.charCodeAt(i);
    }
}

/**
 * Reads an ASCII tag from a byte string.
 *
 * @param bytes - The source bytes.
 * @param offset - Where the tag starts.
 * @param length - How many characters to read.
 * @returns The decoded characters.
 */
function readAscii(bytes: Uint8Array, offset: number, length: number): string {
    let tag = "";
    for (let i = 0; i < length; i += 1) {
        tag += String.fromCharCode(bytes[offset + i]!);
    }
    return tag;
}
