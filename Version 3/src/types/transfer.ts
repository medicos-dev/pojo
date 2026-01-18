export interface FileMetadata {
    name: string;
    size: number;
    mimeType: string;
}

export interface TransferProgress {
    bytesTransferred: number;
    totalBytes: number;
    percent: number;
    speed: string; // "12.5 MB/s"
    timeLeft: string; // "2m 30s"
}

export type TransferStatus = 'idle' | 'waiting' | 'transferring' | 'complete' | 'error' | 'rejected' | 'finalizing';

export interface ChunkData {
    chunkIndex: number;
    data: ArrayBuffer;
}
