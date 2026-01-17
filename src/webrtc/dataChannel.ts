import { LOW_WATER_MARK } from '../config';
import { ControlMessage } from '../types/signaling';

let controlChannel: RTCDataChannel | null = null;
let dataChannel: RTCDataChannel | null = null;

// Callbacks
type ControlCallback = (msg: ControlMessage) => void;
type BinaryCallback = (data: ArrayBuffer) => void;
type ChannelStateCallback = (type: 'control' | 'data', open: boolean) => void;

let onControlMsg: ControlCallback | null = null;
let onBinaryMsg: BinaryCallback | null = null;
let onChannelState: ChannelStateCallback | null = null;

// Heartbeat
let heartbeatInterval: any = null;
const HEARTBEAT_INTERVAL_MS = 5000;

export const registerDataHandlers = (
    controlCb: ControlCallback,
    binaryCb: BinaryCallback,
    stateCb: ChannelStateCallback
) => {
    onControlMsg = controlCb;
    onBinaryMsg = binaryCb;
    onChannelState = stateCb;
};

export const getControlChannel = () => controlChannel;
export const getDataChannel = () => dataChannel;

export const sendControl = (msg: ControlMessage): boolean => {
    if (controlChannel && controlChannel.readyState === 'open') {
        console.log('📤 Sending Control:', msg.type);
        controlChannel.send(JSON.stringify(msg));
        return true;
    } else {
        console.warn('❌ Control channel not open, cannot send:', msg.type);
        return false;
    }
};

export const sendData = (data: ArrayBuffer): boolean => {
    if (dataChannel && dataChannel.readyState === 'open') {
        try {
            dataChannel.send(data);
            return true;
        } catch (e) {
            console.error('Send error:', e);
            return false;
        }
    }
    return false;
};

export const setupControlChannel = (channel: RTCDataChannel) => {
    controlChannel = channel;

    channel.onopen = () => {
        console.log('✅ Control channel opened');
        if (onChannelState) onChannelState('control', true);
        startHeartbeat();
    };

    channel.onclose = () => {
        console.warn('⚠️ Control channel closed');
        stopHeartbeat();
        if (onChannelState) onChannelState('control', false);
    };

    channel.onerror = (e) => console.error('Control error:', e);

    channel.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (onControlMsg) onControlMsg(msg);

            // Auto-respond to ping
            if (msg.type === 'ping') sendControl({ type: 'pong' });
        } catch (err) {
            console.error('Control parse error:', err);
        }
    };
};

export const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    // CRITICAL: Set bufferedAmountLowThreshold to LOW_WATER_MARK for proper backpressure
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    channel.onopen = () => {
        console.log('✅ Data channel opened');
        if (onChannelState) onChannelState('data', true);
    };

    channel.onclose = () => {
        console.warn('⚠️ Data channel closed');
        if (onChannelState) onChannelState('data', false);
    };

    channel.onerror = (e) => console.error('Data error:', e);

    channel.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            if (onBinaryMsg) onBinaryMsg(e.data);
        }
    };
};

// Heartbeat Helpers
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        if (controlChannel && controlChannel.readyState === 'open') {
            sendControl({ type: 'ping' });
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

export const waitForDrain = (): Promise<void> => {
    return new Promise(resolve => {
        if (!dataChannel || dataChannel.readyState !== 'open') {
            resolve();
            return;
        }

        // Already below threshold
        if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
            resolve();
            return;
        }

        const handler = () => {
            if (dataChannel) {
                dataChannel.removeEventListener('bufferedamountlow', handler);
            }
            resolve();
        };
        dataChannel.addEventListener('bufferedamountlow', handler);

        // Fallback timeout to prevent hanging
        setTimeout(() => {
            if (dataChannel) {
                dataChannel.removeEventListener('bufferedamountlow', handler);
            }
            resolve();
        }, 500);
    });
};
