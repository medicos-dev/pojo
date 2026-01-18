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

        ws = new WebSocket(url);

        ws.onopen = () => {

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

            }
        };

        ws.onclose = (e) => {

            if (currentRoom && e.code !== 1000) {
                setTimeout(() => reconnectSocket(), RECONNECT_DELAY_MS);
            }
        };

        ws.onerror = (e) => {

            // Reject only if initial connect fails
            if (reconnectAttempts === 0) reject(e);
        };
    });
};

async function reconnectSocket() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {

        return;
    }
    reconnectAttempts++;

    try {
        await connectWebSocket();
    } catch (e) {

    }
}

export const sendSignal = (msg: SignalingMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {

    }
};

export const getSocket = () => ws;
