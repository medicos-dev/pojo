import { ICE_SERVERS } from '../config';
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

export const createPeerConnection = (room: string, isInitiator: boolean) => {
    console.log('🔗 Creating peer connection');
    currentRoom = room;

    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peerConnection.onicecandidate = (e) => {
        const ws = getSocket();
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            sendSignal({ type: 'ice-candidate', candidate: e.candidate, room });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log(`🔗 State: ${peerConnection?.connectionState}`);
        if (onStateChange && peerConnection) {
            onStateChange(peerConnection.connectionState);
        }
    };

    peerConnection.ondatachannel = (e) => {
        console.log(`📡 Received channel: ${e.channel.label}`);
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
    console.log('📡 Creating dual channels');

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
        console.log('⚠️ Cannot flush candidates: PC or RemoteDesc missing');
        return;
    }
    console.log(`🚿 Flushing ${candidateQueue.length} buffered candidates`);
    while (candidateQueue.length > 0) {
        const candidate = candidateQueue.shift();
        if (candidate) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('✅ Buffered candidate added');
            } catch (e) {
                console.error('Error flushing buffered candidate', e);
            }
        }
    }
}

export const handleOffer = async (offer: RTCSessionDescriptionInit) => {
    console.log('📩 Handling Offer...');
    if (!peerConnection) createPeerConnection(currentRoom!, false);
    if (!peerConnection) {
        console.error('❌ Failed to create PC for offer');
        return;
    }

    // Fix InvalidStateError: ONLY check if we are in a state where we can't accept offer.
    // 'stable' is actually the CORRECT state to accept a new offer.
    // unexpected states might be 'have-local-offer' (glare).
    if (peerConnection.signalingState !== 'stable' && peerConnection.signalingState !== 'have-remote-offer') {
        console.warn(`⚠️ Unexpected PC state for offer: ${peerConnection.signalingState}. Proceeding anyway to recover.`);
        // We usually proceed, or we might rollout 'rollback'.
        // For simplicity, let's just proceed. The previous check prohibited 'stable', which broke the flow.
    }

    try {
        console.log('🛠️ Setting Remote Description (Offer)...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        console.log('✅ Remote Description Set');

        await flushCandidateQueue();

        console.log('🛠️ Creating Answer...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('✅ Local Description Set (Answer)');

        sendSignal({ type: 'answer', answer, room: currentRoom! });
        console.log('📤 Answer Sent');
    } catch (e) {
        console.error('❌ Error handling offer:', e);
    }
};

export const handleAnswer = async (answer: RTCSessionDescriptionInit) => {
    console.log('📩 Handling Answer...');
    if (!peerConnection) return;
    if (peerConnection.signalingState === 'stable') {
        console.log('⚠️ PC stable, ignoring answer');
        return;
    }

    try {
        console.log('🛠️ Setting Remote Description (Answer)...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Remote Description Set (Answer)');
        await flushCandidateQueue();
    } catch (e) {
        console.error('❌ Error handling answer:', e);
    }
};

export const handleIceCandidate = async (candidate: RTCIceCandidateInit) => {
    if (!peerConnection) return;

    // Buffer if remote description is not ready
    if (!peerConnection.remoteDescription) {
        console.log('🧊 Buffering ICE candidate (remote description not set)');
        candidateQueue.push(candidate);
        return;
    }

    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('✅ ICE Candidate Added Direct');
    } catch (e) {
        console.error('Error adding received ice candidate', e);
    }
};

export const createOffer = async () => {
    if (!peerConnection) return;
    console.log('🛠️ Creating Offer...');
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('✅ Local Description Set (Offer)');
    sendSignal({ type: 'offer', offer, room: currentRoom! });
    console.log('📤 Offer Sent');
};
