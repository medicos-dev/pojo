export let CHUNK_SIZE = 250 * 1024; // 256KB - safe for most browsers
export const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB - safe browser buffer limit
export const LOW_WATER_MARK = 1 * 1024 * 1024; // 1MB - resume sending threshold
export const MAX_RAM_MB = 512;
export const MAX_RAM_BYTES = MAX_RAM_MB * 1024 * 1024;

export const updateChunkSize = (size: number) => {
    CHUNK_SIZE = size;

};

export const getWebSocketURL = (): string => {
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');

    if (wsParam) {
        if (wsParam.startsWith('ws://') || wsParam.startsWith('wss://')) return wsParam;
        if (wsParam.includes('devtunnels.ms')) return `wss://${wsParam}`;
        return `ws://${wsParam}:${params.get('port') || '8080'}`;
    }

    const hostname = window.location.hostname;
    // Vite dev server runs on 5173, backend on 8080 usually. 
    // If running in dev mode, we usually point to localhost:8080.
    // If production (same port), use window.location.port.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    // Render deployment detection (hostname check or simple fallback)
    if (hostname.includes('onrender.com')) return `${protocol}//${hostname}`;

    // Dev fallback
    return `${protocol}//${hostname}:${"8080"}`; // Hardcode 8080 for dev if port is 5173
};

export const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
];
