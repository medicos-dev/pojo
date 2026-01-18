export type ControlMessageType =
    | 'file-request'
    | 'file-accept'
    | 'file-reject'
    | 'ack'
    | 'ping'
    | 'pong'
    | 'file-complete'
    | 'progress'
    | 'cancel';

export interface FileRequestPayload {
    name: string;
    size: number;
    mimeType: string;
}

export interface FileAcceptPayload {
    fileId?: string; // Optional for now as per current logic
}

export interface AckPayload {
    chunkIndex: number;
    bytesReceived: number;
}

export interface ProgressPayload {
    bytesLoaded: number;
    total: number;
    percent: number;
}

export interface FileCompletePayload {
    bytesReceived: number;
}

export interface ControlMessage {
    type: ControlMessageType;
    name?: string;       // Legacy: for file-request
    size?: number;       // Legacy: for file-request
    mimeType?: string;   // Legacy: for file-request
    chunkIndex?: number; // Legacy: for ack
    bytesReceived?: number; // Legacy: for ack/complete
    percent?: number;    // Legacy: for progress
}

export interface SignalingMessage {
    type: 'joined' | 'room-state' | 'peer-joined' | 'peer-left' | 'offer' | 'answer' | 'ice-candidate' | 'error' | 'join';
    room?: string;
    isInitiator?: boolean;
    peerCount?: number;
    hasPeer?: boolean;
    offer?: RTCSessionDescriptionInit;
    answer?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    message?: string;
}
