import { getIceServers, updateChunkSize } from '../config';
import { sendSignal, getSocket } from './signaling';
import { setupControlChannel, setupDataChannel } from './dataChannel';

let peerConnection: RTCPeerConnection | null = null;
let currentRoom: string | null = null;

// State callback
type PCStateCallback = (state: RTCPeerConnectionState) => void;
let onStateChange: PCStateCallback | null = null;

export const registerPCStateCallback = (cb: PCStateCallback) => {
    onStateChange = cb;
};

let iceRestartAttempts = 0;
const MAX_ICE_RESTARTS = 2;
const CONNECTING_WATCHDOG_MS = 25000;

export const createPeerConnection = async (room: string, isInitiator: boolean) => {

    if (peerConnection) {
        peerConnection.close();
    }

    currentRoom = room;

    iceRestartAttempts = 0;
    const iceServers = await getIceServers();
    peerConnection = new RTCPeerConnection({ iceServers });

    // Throughput safety: clamp chunk size to SCTP maxMessageSize when available.
    // (maxMessageSize is in bytes; we reserve 4 bytes for our chunk index header.)
    const sctpMax = peerConnection.sctp?.maxMessageSize;
    if (typeof sctpMax === 'number' && Number.isFinite(sctpMax) && sctpMax > 4096) {
        updateChunkSize(Math.floor(sctpMax - 4));
    }

    peerConnection.onicecandidate = (e) => {
        const ws = getSocket();
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            sendSignal({ type: 'ice-candidate', candidate: e.candidate, room });
        }
    };

    // Watchdog: prevent infinite "connecting..." hangs on strict NAT/CGNAT.
    const startConnectingWatchdog = () => {
        const pc = peerConnection;
        if (!pc) return;

        setTimeout(async () => {
            // If pc was replaced, ignore
            if (peerConnection !== pc) return;
            if (pc.connectionState === 'connected' || pc.connectionState === 'closed') return;
            if (pc.connectionState !== 'connecting') return;
            if (iceRestartAttempts >= MAX_ICE_RESTARTS) return;

            iceRestartAttempts++;
            try {
                if (typeof pc.restartIce === 'function') {
                    pc.restartIce();
                }
            } catch { }

            // Only initiator can reliably kick renegotiation.
            if (isInitiator && currentRoom) {
                try {
                    const offer = await pc.createOffer({ iceRestart: true });
                    await pc.setLocalDescription(offer);
                    sendSignal({ type: 'offer', offer, room: currentRoom });
                } catch { }
            }
        }, CONNECTING_WATCHDOG_MS);
    };

    peerConnection.onconnectionstatechange = () => {

        if (onStateChange && peerConnection) {
            onStateChange(peerConnection.connectionState);
        }

        if (peerConnection?.connectionState === 'connecting') {
            startConnectingWatchdog();
        }
    };

    peerConnection.ondatachannel = (e) => {

        if (e.channel.label === 'control') {
            setupControlChannel(e.channel);
        } else if (e.channel.label === 'data') {
            setupDataChannel(e.channel);
        }
    };

    if (isInitiator) {
        createChannels(peerConnection);
    }

    return peerConnection;
};

function createChannels(pc: RTCPeerConnection) {


    // CONTROL channel: ordered, reliable - for signaling
    const controlChannel = pc.createDataChannel('control', {
        ordered: true
    });
    setupControlChannel(controlChannel);

    // DATA channel: ORDERED for reliability - ensures no packet loss on large files
    const dataChannel = pc.createDataChannel('data', {
        ordered: true  // Reliable delivery - critical for large files
    });
    setupDataChannel(dataChannel);
}

export const getPeerConnection = () => peerConnection;

// ICE Candidate Buffering
let candidateQueue: RTCIceCandidateInit[] = [];

async function flushCandidateQueue() {
    if (!peerConnection || !peerConnection.remoteDescription) {

        return;
    }

    while (candidateQueue.length > 0) {
        const candidate = candidateQueue.shift();
        if (candidate) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));

            } catch (e) {

            }
        }
    }
}

export const handleOffer = async (offer: RTCSessionDescriptionInit) => {

    if (!peerConnection) await createPeerConnection(currentRoom!, false);
    if (!peerConnection) {

        return;
    }

    // Fix InvalidStateError: ONLY check if we are in a state where we can't accept offer.
    // 'stable' is actually the CORRECT state to accept a new offer.
    // unexpected states might be 'have-local-offer' (glare).
    if (peerConnection.signalingState !== 'stable' && peerConnection.signalingState !== 'have-remote-offer') {

        // We usually proceed, or we might rollout 'rollback'.
        // For simplicity, let's just proceed. The previous check prohibited 'stable', which broke the flow.
    }

    try {

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));


        await flushCandidateQueue();


        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);


        sendSignal({ type: 'answer', answer, room: currentRoom! });

    } catch (e) {

    }
};

export const handleAnswer = async (answer: RTCSessionDescriptionInit) => {

    if (!peerConnection) return;
    if (peerConnection.signalingState === 'stable') {

        return;
    }

    try {

        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

        await flushCandidateQueue();
    } catch (e) {

    }
};

export const handleIceCandidate = async (candidate: RTCIceCandidateInit) => {
    if (!peerConnection) return;

    // Buffer if remote description is not ready
    if (!peerConnection.remoteDescription) {

        candidateQueue.push(candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));

    } catch (e) {

    }
};

export const createOffer = async () => {
    if (!peerConnection) return;

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    sendSignal({ type: 'offer', offer, room: currentRoom! });

};
