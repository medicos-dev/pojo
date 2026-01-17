import { CHUNK_SIZE, HIGH_WATER_MARK } from '../config';
import { sendData, waitForDrain } from '../webrtc/dataChannel';

export interface InternalTransferProgress {
    bytesSent: number;
    totalBytes: number;
    percent: number;
    speedBps: number;
}

type ProgressCallback = (p: InternalTransferProgress) => void;
type StatusCallback = (status: 'uploading' | 'complete' | 'error', error?: string) => void;

export class FileSender {
    private file: File;
    private onProgress: ProgressCallback;
    private onStatus: StatusCallback;
    private aborted = false;

    // Speed calc
    private paused = false;
    private totalBytesSent = 0;
    private lastSpeedUpdate = 0;
    private lastBytesForSpeed = 0;
    private lastUIUpdate = 0;
    private currentSpeed = 0;

    constructor(file: File, onProgress: ProgressCallback, onStatus: StatusCallback) {
        this.file = file;
        this.onProgress = onProgress;
        this.onStatus = onStatus;
    }

    abort() {
        this.aborted = true;
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    async start() {
        console.log(`📤 Starting sender: ${this.file.name}`);
        this.onStatus('uploading');

        this.totalBytesSent = 0;
        this.lastSpeedUpdate = Date.now();
        this.lastBytesForSpeed = 0;
        this.lastUIUpdate = 0;

        const totalChunks = Math.ceil(this.file.size / CHUNK_SIZE);

        try {
            // Wake lock in React component ideally, or global helper
            if ('wakeLock' in navigator) {
                try { await (navigator as any).wakeLock.request('screen'); } catch { }
            }

            for (let i = 0; i < totalChunks; i++) {
                if (this.aborted) throw new Error('Aborted');

                // Pause Check
                while (this.paused) {
                    if (this.aborted) throw new Error('Aborted');
                    await new Promise(r => setTimeout(r, 100));
                    // Reset speed calc during pause
                    this.lastSpeedUpdate = Date.now();
                    this.lastBytesForSpeed = this.totalBytesSent;
                    this.updateStats(); // To show 0 speed
                }

                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, this.file.size);

                // Slice and buffer
                const chunk = this.file.slice(start, end);
                const buffer = await chunk.arrayBuffer();

                // Create framed chunk
                const framed = new ArrayBuffer(4 + buffer.byteLength);
                new DataView(framed).setUint32(0, i, true); // Little endian
                new Uint8Array(framed, 4).set(new Uint8Array(buffer));

                // Backpressure: Wait BEFORE buffer overflows
                const dc = await import('../webrtc/dataChannel').then(m => m.getDataChannel());

                if (dc && dc.readyState === 'open') {
                    // Wait if buffer is getting full
                    while (dc.bufferedAmount > HIGH_WATER_MARK) {
                        await waitForDrain();
                        if (this.aborted) throw new Error('Aborted');
                    }
                } else if (dc && dc.readyState !== 'open') {
                    throw new Error('Data channel closed');
                }

                // Try to send with retry
                let sent = sendData(framed);
                if (!sent) {
                    // One retry after drain
                    await waitForDrain();
                    sent = sendData(framed);
                    if (!sent) {
                        throw new Error('Data channel closed or failed');
                    }
                }

                this.totalBytesSent += buffer.byteLength;

                this.updateStats();
            }

            console.log('✅ All chunks sent');
            this.updateStats(true); // Force 100%
            this.onStatus('complete');
        } catch (err: any) {
            console.error('Sender error:', err);
            this.onStatus('error', err.message);
        }
    }

    private updateStats(force = false) {
        const now = Date.now();
        if (force || now - this.lastUIUpdate > 100 || this.totalBytesSent >= this.file.size || this.paused) {
            this.lastUIUpdate = now;

            // Speed calc
            let speedBps = this.currentSpeed;
            const elapsed = (now - this.lastSpeedUpdate) / 1000;

            if (this.paused) {
                speedBps = 0;
                this.currentSpeed = 0;
            } else if (elapsed >= 0.5) { // Faster updates (0.5s)
                speedBps = (this.totalBytesSent - this.lastBytesForSpeed) / elapsed;
                this.currentSpeed = speedBps;
                this.lastSpeedUpdate = now;
                this.lastBytesForSpeed = this.totalBytesSent;
            } else {
                // Keep previous speed if interval too short
                // But if we just started, calculating early is better than 0
                if (this.lastBytesForSpeed === 0 && elapsed > 0.1) {
                    speedBps = this.totalBytesSent / elapsed;
                    this.currentSpeed = speedBps;
                }
            }

            this.onProgress({
                bytesSent: this.totalBytesSent,
                totalBytes: this.file.size,
                percent: (this.totalBytesSent / this.file.size) * 100,
                speedBps
            });
        }
    }
}
