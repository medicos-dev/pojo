export let CHUNK_SIZE = 256 * 1024; // 256KB default (high compatibility); may be increased safely at runtime
export const HIGH_WATER_MARK = 32 * 1024 * 1024; // 32MB - higher throughput, still safe
export const LOW_WATER_MARK = 8 * 1024 * 1024; // 8MB - resume sending threshold
export const MAX_RAM_MB = 512;
export const MAX_RAM_BYTES = MAX_RAM_MB * 1024 * 1024;

export const updateChunkSize = (size: number) => {
    // Clamp to reasonable bounds: min 64KB, max 512KB (safe across browsers / networks)
    const next = Math.max(64 * 1024, Math.min(size, 512 * 1024));
    CHUNK_SIZE = next;

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

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
];

let cachedIceServers: RTCIceServer[] | null = null;
let inflight: Promise<RTCIceServer[]> | null = null;

async function fetchWithTimeout(url: string, timeoutMs: number) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(t);
    }
}

export async function getIceServers(): Promise<RTCIceServer[]> {
    if (cachedIceServers) return cachedIceServers;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const url = new URL(window.location.href);
            const direct = url.searchParams.get('direct');
            const iceUrl = direct === '1' || direct === 'true' ? '/ice?direct=1' : '/ice';
            const res = await fetchWithTimeout(iceUrl, 2000);
            if (!res.ok) return DEFAULT_ICE_SERVERS;
            const data = await res.json();
            if (!data || !Array.isArray(data.iceServers) || data.iceServers.length === 0) {
                return DEFAULT_ICE_SERVERS;
            }
            cachedIceServers = data.iceServers as RTCIceServer[];
            return cachedIceServers ?? DEFAULT_ICE_SERVERS;
        } catch {
            return DEFAULT_ICE_SERVERS;
        } finally {
            inflight = null;
        }
    })();

    return inflight ?? DEFAULT_ICE_SERVERS;
}
