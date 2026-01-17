import { getWebSocketURL } from '../config';
import { SignalingMessage } from '../types/signaling';

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 2000;
let currentRoom: string | null = null;

// export const setRoom = (room: string) => { currentRoom = room; }; // Deprecated
export const joinRoom = (room: string) => {
    currentRoom = room;
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Force join if connection is already open
        console.log('📡 Sending Join Signal:', room);
        sendSignal({ type: 'join', room });
    }
};

// Event listeners
type SignalCallback = (msg: SignalingMessage) => void;
let signalHandler: SignalCallback | null = null;

export const onSignal = (cb: SignalCallback) => { signalHandler = cb; };

export const connectWebSocket = (): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            resolve(ws);
            return;
        }

        const url = getWebSocketURL();
        console.log(`📡 Connecting: ${url}`);
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('✅ WebSocket connected');
            reconnectAttempts = 0;
            if (currentRoom) {
                sendSignal({ type: 'join', room: currentRoom });
            }
            resolve(ws!);
        };

        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (signalHandler) signalHandler(msg);
            } catch (err) {
                console.error('Parse error:', err);
            }
        };

        ws.onclose = (e) => {
            console.log(`WebSocket closed: ${e.code}`);
            if (currentRoom && e.code !== 1000) {
                setTimeout(() => reconnectSocket(), RECONNECT_DELAY_MS);
            }
        };

        ws.onerror = (e) => {
            console.error('WebSocket Error:', e);
            // Reject only if initial connect fails
            if (reconnectAttempts === 0) reject(e);
        };
    });
};

async function reconnectSocket() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('Max reconnect attempts reached');
        return;
    }
    reconnectAttempts++;
    console.log(`🔄 Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    try {
        await connectWebSocket();
    } catch (e) {
        console.error('Reconnect failed', e);
    }
}

export const sendSignal = (msg: SignalingMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        console.warn('WebSocket not open, cannot send signal', msg);
    }
};

export const getSocket = () => ws;
