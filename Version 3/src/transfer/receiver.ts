import { pushToRamQueue, RAM_QUEUE } from '../storage/indexedDb';
import { sendControl } from '../webrtc/dataChannel';
import { getAllChunks, deleteFileChunks } from '../storage/indexedDb';

export interface InternalReceiverProgress {
    bytesReceived: number;
    totalBytes: number;
    percent: number;
    speedBps: number;
}

type ProgressCallback = (p: InternalReceiverProgress) => void;
type StatusCallback = (status: 'receiving' | 'complete' | 'error', data?: any) => void;

export class FileReceiver {
    private metadata: { name: string, size: number, mimeType: string };
    private onProgress: ProgressCallback;
    private onStatus: StatusCallback;

    private totalBytesReceived = 0;
    private receivedChunkCount = 0;

    // Speed calc
    private lastSpeedUpdate = 0;
    private lastBytesForSpeed = 0;
    private lastUIUpdate = 0;
    private currentSpeed = 0;

    constructor(
        metadata: { name: string, size: number, mimeType: string },
        onProgress: ProgressCallback,
        onStatus: StatusCallback
    ) {
        this.metadata = metadata;
        this.onProgress = onProgress;
        this.onStatus = onStatus;
        this.lastSpeedUpdate = Date.now();
    }

    handleChunk(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        const chunkIndex = view.getUint32(0, true);
        const payload = buffer.slice(4);

        this.totalBytesReceived += payload.byteLength;
        this.receivedChunkCount++;

        this.updateStats();

        // Push to RAM queue
        pushToRamQueue({
            fileName: this.metadata.name,
            chunkIndex,
            data: payload
        });

        // ACK every 40 chunks
        if (this.receivedChunkCount % 40 === 0) {
            sendControl({
                type: 'ack',
                chunkIndex,
                bytesReceived: this.totalBytesReceived
            });
        }

        // Completion check
        if (this.totalBytesReceived >= this.metadata.size) {
            this.finalize();
        }
    }

    private updateStats() {
        const now = Date.now();
        if (now - this.lastUIUpdate > 100 || this.totalBytesReceived >= this.metadata.size) {
            this.lastUIUpdate = now;

            // Speed calc
            let speedBps = this.currentSpeed;
            const elapsed = (now - this.lastSpeedUpdate) / 1000;

            if (elapsed >= 0.5) { // Update every 0.5s
                speedBps = (this.totalBytesReceived - this.lastBytesForSpeed) / elapsed;
                this.currentSpeed = speedBps;
                this.lastSpeedUpdate = now;
                this.lastBytesForSpeed = this.totalBytesReceived;
            } else {
                // Keep previous speed if interval too short
                if (this.lastBytesForSpeed === 0 && elapsed > 0.1) {
                    speedBps = this.totalBytesReceived / elapsed;
                    this.currentSpeed = speedBps;
                }
            }

            this.onProgress({
                bytesReceived: this.totalBytesReceived,
                totalBytes: this.metadata.size,
                percent: (this.totalBytesReceived / this.metadata.size) * 100,
                speedBps
            });
        }
    }

    private async finalize() {

        this.onStatus('receiving', 'finalizing'); // Update UI status

        // Wait for buffer drain
        while (RAM_QUEUE.length > 0) {
            await new Promise(r => setTimeout(r, 50));
        }


        try {
            const chunks = await getAllChunks(this.metadata.name);
            const blob = new Blob(chunks, { type: this.metadata.mimeType });

            // Clean up IDB
            await deleteFileChunks(this.metadata.name);

            // Notify complete with Blob
            this.onStatus('complete', blob);

            sendControl({
                type: 'file-complete',
                bytesReceived: this.totalBytesReceived
            });

        } catch (e: any) {

            this.onStatus('error', e.message);
        }
    }
}
