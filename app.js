// ============================================================================
// POJO FILES - PRODUCTION-GRADE P2P FILE TRANSFER
// ============================================================================
// Features:
// - Separate control + data channels (lifecycle safe)
// - Heartbeat ping (prevents idle timeout)
// - RAM buffer queue (non-blocking receive)
// - Background IndexedDB writer
// - Guarded send calls (crash-proof)
// - Wake Lock for background transfer
// ============================================================================

// WebRTC Configuration - TURN required for production reliability
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:free.expressturn.com:3478?transport=tcp",
        username: "000000002083986270",
        credential: "yaZXTjsDpaLSnBGYVnDxMZ+acj8="
    }
];

// ============================================================================
// TRANSFER CONFIGURATION
// ============================================================================
const CHUNK_SIZE = 256 * 1024;             // 256KB chunks (Recommended sweet spot)
const HIGH_WATER_MARK = 48 * 1024 * 1024;  // 48MB backpressure threshold (Deeper buffering)
const LOW_WATER_MARK = 8 * 1024 * 1024;    // 8MB low threshold for resume
const MAX_RAM_MB = 256;
const MAX_RAM_BYTES = MAX_RAM_MB * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 5000;

// ============================================================================
// WEBSOCKET URL CONFIGURATION
// ============================================================================
function getWebSocketURL() {
    // ... existing code ...
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');

    if (wsParam) {
        if (wsParam.startsWith('ws://') || wsParam.startsWith('wss://')) return wsParam;
        if (wsParam.includes('devtunnels.ms')) return `wss://${wsParam}`;
        return `ws://${wsParam}:${params.get('port') || '8080'}`;
    }

    const hostname = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (hostname.includes('onrender.com')) return `${protocol}//${hostname}`;
    return `${protocol}//${hostname}:${window.location.port || '8080'}`;
}

// ...

function createChannels() {
    console.log('📡 Creating dual channels');

    // CONTROL channel: ordered, reliable - ALWAYS ALIVE
    controlChannel = peerConnection.createDataChannel('control', {
        ordered: true
    });
    setupControlChannel(controlChannel);

    // DATA channel: unordered, RELIABLE (no maxPacketLifeTime) - DISPOSABLE
    // Optimization #5 & #6: ordered: false, let WebRTC handle reliability
    dataChannel = peerConnection.createDataChannel('data', {
        ordered: false
    });
    setupDataChannel(dataChannel);
}

function setupControlChannel(channel) {
    controlChannel = channel;
    // ... existing setup ... (keep as is, just showing context)
    controlChannelClosed = false;

    channel.onopen = () => {
        console.log('✅ Control channel opened');
        controlChannelClosed = false;
        updateConnectionStatus('connected', 'Ready');
        startHeartbeat();
    };

    channel.onclose = () => {
        console.warn('⚠️ Control channel closed - waiting for resume');
        controlChannelClosed = true;
        stopHeartbeat();
    };

    channel.onerror = (e) => console.error('Control channel error:', e);

    channel.onmessage = (e) => {
        try { handleControlMessage(JSON.parse(e.data)); }
        catch (err) { console.error('Control parse error:', err); }
    };
}

function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannelClosed = false;
    channel.binaryType = 'arraybuffer';

    // Optimization #1: Increase bufferedAmountLowThreshold
    // This fires onbufferedamountlow when buffer drains to this level
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    channel.onopen = () => {
        console.log('✅ Data channel opened');
        dataChannelClosed = false;
    };

    channel.onclose = () => {
        console.warn('⚠️ Data channel closed - waiting for resume');
        dataChannelClosed = true;
    };

    channel.onerror = (e) => console.error('Data channel error:', e);

    channel.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            handleBinaryChunk(e.data);
        }
    };
}

const WS_URL = getWebSocketURL();
console.log('WebSocket URL:', WS_URL);

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let ws = null;
let peerConnection = null;

// DUAL CHANNEL ARCHITECTURE (Critical for lifecycle safety)
let controlChannel = null;        // For: accept/reject/ping/progress - ALWAYS ALIVE
let dataChannel = null;           // For: file chunks only - DISPOSABLE
let controlChannelClosed = false; // Track state without nullifying
let dataChannelClosed = false;

let currentRoom = null;
let isInitiator = false;

// Heartbeat interval
let heartbeatInterval = null;

// File handling
let currentFile = null;
let fileQueue = [];
let isProcessingQueue = false;

// Transfer state
let transferActive = false;
let transferAborted = false;

// Sender state
let senderChunkIndex = 0;
let totalBytesSent = 0;

// Receiver state - RAM BUFFER
const RAM_QUEUE = [];
let ramBytes = 0;
let receivingFile = null;
let receivingFileSize = 0;
let receivingFileName = '';
let receivingMimeType = '';
let totalBytesReceived = 0;
let totalBytesWrittenToDisk = 0;
let expectedTotalChunks = 0;
let receivedChunkCount = 0;

// Speed calculation (NETWORK-BASED)
let speedStartTime = null;
let lastSpeedUpdate = null;
let lastBytesForSpeed = 0;

// Pending file requests
let pendingFileRequest = null;
let pendingFileRequestQueue = [];

// Mobile detection
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// Wake Lock
let wakeLock = null;

// ============================================================================
// GUARDED SEND - CRITICAL FIX #1 (prevents null crashes)
// ============================================================================

function sendControl(message) {
    if (!controlChannel || controlChannel.readyState !== 'open') {
        console.warn('⚠️ Control channel not ready, cannot send:', message.type);
        return false;
    }
    try {
        controlChannel.send(JSON.stringify(message));
        return true;
    } catch (e) {
        console.error('Control send error:', e);
        return false;
    }
}

function sendData(data) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.warn('⚠️ Data channel not ready');
        return false;
    }
    try {
        dataChannel.send(data);
        return true;
    } catch (e) {
        console.error('Data send error:', e);
        return false;
    }
}

// ============================================================================
// HEARTBEAT - CRITICAL FIX #3 (prevents idle timeout)
// ============================================================================

function startHeartbeat() {
    stopHeartbeat();
    console.log('💓 Starting heartbeat');
    heartbeatInterval = setInterval(() => {
        if (controlChannel && controlChannel.readyState === 'open') {
            controlChannel.send(JSON.stringify({ type: 'ping' }));
        }
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ============================================================================
// WAKE LOCK - CRITICAL FIX #5 (prevents background throttling)
// ============================================================================

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('🔒 Wake Lock acquired');

            wakeLock.addEventListener('release', () => {
                console.log('🔓 Wake Lock released');
            });
        }
    } catch (err) {
        console.warn('Wake Lock failed:', err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => { });
        wakeLock = null;
    }
}

// Re-acquire wake lock when tab becomes visible
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        console.log('📱 Tab visible');
        if (transferActive && !wakeLock) {
            await requestWakeLock();
        }
        // Check WebSocket
        if (ws && ws.readyState !== WebSocket.OPEN && currentRoom) {
            reconnectSocket().catch(console.error);
        }
    } else {
        console.log('📱 Tab hidden - connections kept alive');
        // Send keepalive
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }
});

// ============================================================================
// INDEXEDDB STORAGE
// ============================================================================

let db = null;
const DB_NAME = 'P2PFileTransferDB';
const DB_VERSION = 1;
const STORE_NAME = 'fileChunks';

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { db = request.result; resolve(db); };
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('fileName', 'fileName', { unique: false });
            }
        };
    });
}

function saveChunkToIndexedDB(fileName, chunkIndex, chunkData) {
    if (!db) return;
    const tx = db.transaction([STORE_NAME], 'readwrite');
    tx.objectStore(STORE_NAME).put({
        id: `${fileName}_${chunkIndex}`,
        fileName, chunkIndex, data: chunkData, timestamp: Date.now()
    });
}

async function getAllChunksFromIndexedDB(fileName) {
    if (!db) await initIndexedDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const request = tx.objectStore(STORE_NAME).index('fileName').getAll(fileName);
        request.onsuccess = () => {
            const chunks = request.result.sort((a, b) => a.chunkIndex - b.chunkIndex);
            resolve(chunks.map(c => c.data));
        };
        request.onerror = () => reject(request.error);
    });
}

async function deleteFileFromIndexedDB(fileName) {
    if (!db) return;
    return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.index('fileName').openKeyCursor(IDBKeyRange.only(fileName));
        request.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
            else resolve();
        };
        request.onerror = () => resolve();
    });
}

initIndexedDB().catch(console.error);

// ============================================================================
// BACKGROUND INDEXEDDB WRITER (NON-BLOCKING)
// ============================================================================

let diskWriterRunning = false;

async function diskWriterLoop() {
    if (diskWriterRunning) return;
    diskWriterRunning = true;
    console.log('💾 Disk writer started');

    while (transferActive || RAM_QUEUE.length > 0) {
        if (RAM_QUEUE.length === 0) {
            await sleep(5);
            continue;
        }
        const item = RAM_QUEUE.shift();
        ramBytes -= item.data.byteLength;
        saveChunkToIndexedDB(item.fileName, item.chunkIndex, item.data);
        totalBytesWrittenToDisk += item.data.byteLength;
    }

    diskWriterRunning = false;
    console.log('💾 Disk writer finished');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// UI HELPERS
// ============================================================================

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function updateProgress(percent) {
    const fill = document.getElementById('progressFill');
    const text = document.getElementById('progressPercent');
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${percent.toFixed(1)}%`;
}

function updateNetworkSpeed() {
    const now = Date.now();
    if (!lastSpeedUpdate) { lastSpeedUpdate = now; lastBytesForSpeed = totalBytesReceived; return; }

    const elapsed = (now - lastSpeedUpdate) / 1000;
    if (elapsed < 0.5) return;

    const speedBps = (totalBytesReceived - lastBytesForSpeed) / elapsed;
    const speedText = document.getElementById('transferSpeed');
    const timeRemaining = document.getElementById('timeRemaining');

    if (speedText) {
        speedText.textContent = speedBps > 1048576
            ? `${(speedBps / 1048576).toFixed(1)} MB/s`
            : `${(speedBps / 1024).toFixed(1)} KB/s`;
    }

    if (timeRemaining && receivingFileSize > 0 && speedBps > 0) {
        timeRemaining.textContent = formatTime((receivingFileSize - totalBytesReceived) / speedBps);
    }

    lastSpeedUpdate = now;
    lastBytesForSpeed = totalBytesReceived;
}

function updateConnectionStatus(status, text) {
    const indicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');
    if (indicator) {
        indicator.className = 'status-indicator';
        if (status === 'connected') indicator.classList.add('connected');
        else if (status === 'connecting') indicator.classList.add('connecting');
    }
    if (statusText) statusText.textContent = text;
}

function showTransferInfo(fileName, fileSize, label = 'Transferring...') {
    const transferInfo = document.getElementById('transferInfo');
    const dropZone = document.getElementById('dropZone');
    const transferSection = document.getElementById('transferSection');
    const progressLabel = document.getElementById('progressLabel');

    if (transferSection) transferSection.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (transferInfo) transferInfo.style.display = 'block';

    const fileNameEl = document.getElementById('fileName');
    const fileSizeEl = document.getElementById('fileSize');
    if (fileNameEl) fileNameEl.textContent = fileName;
    if (fileSizeEl) fileSizeEl.textContent = formatFileSize(fileSize);
    if (progressLabel) progressLabel.textContent = label;

    updateProgress(0);
}

// (hideTransferInfo moved to UI HELPERS section with fix)

function showSuccessMessage(text) {
    const el = document.getElementById('successMessage');
    const textEl = document.getElementById('successText');
    if (el) {
        el.style.display = 'flex';
        if (textEl) textEl.textContent = text;
        setTimeout(() => el.style.display = 'none', 5000);
    }
}

function showUserMessage(msg) {
    alert(msg);
}

// ============================================================================
// WEBSOCKET SINGLETON
// ============================================================================

let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 2000;

function getSocket() {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        ws = createWebSocket();
    }
    return ws;
}

async function ensureSocketConnected() {
    const socket = getSocket();
    if (socket.readyState === WebSocket.OPEN) return socket;
    if (socket.readyState === WebSocket.CONNECTING) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            socket.addEventListener('open', () => { clearTimeout(timeout); resolve(socket); }, { once: true });
            socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Failed')); }, { once: true });
        });
    }
    return reconnectSocket();
}

async function reconnectSocket() {
    if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        updateConnectionStatus('disconnected', 'Connection failed');
        return null;
    }
    wsReconnectAttempts++;
    console.log(`🔄 Reconnecting (${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    return new Promise((resolve, reject) => {
        ws = createWebSocket();
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            wsReconnectAttempts = 0;
            if (currentRoom) ws.send(JSON.stringify({ type: 'join', room: currentRoom }));
            resolve(ws);
        }, { once: true });
        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            setTimeout(() => reconnectSocket().then(resolve).catch(reject), RECONNECT_DELAY_MS);
        }, { once: true });
    });
}

function createWebSocket() {
    console.log(`📡 Connecting: ${WS_URL}`);
    updateConnectionStatus('connecting', 'Connecting...');
    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        wsReconnectAttempts = 0;
        if (currentRoom) socket.send(JSON.stringify({ type: 'join', room: currentRoom }));
    };

    socket.onmessage = (e) => {
        try { handleSignalingMessage(JSON.parse(e.data)); }
        catch (err) { console.error('Parse error:', err); }
    };

    socket.onerror = () => updateConnectionStatus('disconnected', 'Error');

    socket.onclose = (e) => {
        console.log(`WebSocket closed: ${e.code}`);
        if (currentRoom && e.code !== 1000) {
            updateConnectionStatus('disconnected', 'Reconnecting...');
            setTimeout(() => reconnectSocket().catch(console.error), RECONNECT_DELAY_MS);
        } else {
            updateConnectionStatus('disconnected', 'Disconnected');
        }
    };

    return socket;
}

function connectWebSocket() {
    ws = getSocket();
}

// ============================================================================
// SIGNALING MESSAGE HANDLERS
// ============================================================================

function handleSignalingMessage(msg) {
    switch (msg.type) {
        case 'joined':
            console.log(`✅ Joined: ${msg.room}`);
            if (msg.isInitiator !== undefined) isInitiator = msg.isInitiator;
            showRoomDisplay();
            updateConnectionStatus('connecting', 'Waiting for peer...');
            if (isInitiator) createPeerConnection();
            break;

        case 'room-state':
            console.log(`📊 Peers: ${msg.peerCount}`);
            if (msg.hasPeer) {
                updateConnectionStatus('connecting', 'Connecting to peer...');
                if (!peerConnection) createPeerConnection();
                if (isInitiator && !controlChannel) {
                    createChannels();
                    createOffer();
                }
            }
            break;

        case 'peer-joined':
            console.log('👤 Peer joined');
            if (!peerConnection) createPeerConnection();
            if (isInitiator) {
                createChannels();
                createOffer();
            }
            break;

        case 'peer-left':
            console.log('👋 Peer left');
            updateConnectionStatus('connecting', 'Peer disconnected');
            // DON'T nullify - mark as closed (FIX #4)
            controlChannelClosed = true;
            dataChannelClosed = true;
            break;

        case 'offer': handleOffer(msg.offer); break;
        case 'answer': handleAnswer(msg.answer); break;
        case 'ice-candidate': handleIceCandidate(msg.candidate); break;
        case 'pong': break;
        case 'error': console.error('Server error:', msg.message); showUserMessage(msg.message); break;
    }
}

// ============================================================================
// WEBRTC PEER CONNECTION
// ============================================================================

function createPeerConnection() {
    console.log('🔗 Creating peer connection');
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peerConnection.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate, room: currentRoom }));
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log(`🔗 State: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'connected') {
            updateConnectionStatus('connected', 'P2P Connected');
        } else if (peerConnection.connectionState === 'failed') {
            updateConnectionStatus('disconnected', 'Connection failed');
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
}

// ============================================================================
// DUAL CHANNEL CREATION - CRITICAL FIX #2
// ============================================================================

// (Duplicate DataChannel setup removed - using optimized versions defined above)

// ============================================================================
// CONTROL MESSAGE HANDLERS
// ============================================================================

function handleControlMessage(msg) {
    switch (msg.type) {
        case 'file-request': handleFileRequest(msg); break;
        case 'file-accept': handleFileAccepted(); break;
        case 'file-reject': handleFileRejected(); break;
        case 'ack': break;
        case 'file-complete': handleFileComplete(msg); break;
        case 'ping': sendControl({ type: 'pong' }); break;
        case 'pong': break;
    }
}

function handleFileRequest(req) {
    console.log(`📥 File request: ${req.name} (${formatFileSize(req.size)})`);
    pendingFileRequestQueue.push(req);
    if (pendingFileRequestQueue.length === 1) showFileRequestUI();
}

function showFileRequestUI() {
    if (pendingFileRequestQueue.length === 0) return;
    const req = pendingFileRequestQueue[0];
    pendingFileRequest = req;

    const transferSection = document.getElementById('transferSection');
    const dropZone = document.getElementById('dropZone');
    const fileRequest = document.getElementById('fileRequest');
    const requestFileName = document.getElementById('requestFileName');
    const requestFileSize = document.getElementById('requestFileSize');

    if (transferSection) transferSection.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (fileRequest) fileRequest.style.display = 'block';
    if (requestFileName) {
        requestFileName.textContent = pendingFileRequestQueue.length > 1
            ? `${req.name} (+${pendingFileRequestQueue.length - 1} more)` : req.name;
    }
    if (requestFileSize) {
        requestFileSize.textContent = formatFileSize(pendingFileRequestQueue.reduce((s, r) => s + r.size, 0));
    }
}

function handleAcceptFile() {
    if (!pendingFileRequest) return;

    // CRITICAL FIX #1: Guard before send
    if (!controlChannel || controlChannel.readyState !== 'open') {
        console.warn('⚠️ Control channel not ready, cannot accept');
        showUserMessage('Connection not ready. Please wait and try again.');
        return;
    }

    const req = pendingFileRequest;
    console.log(`✅ Accepting: ${req.name}`);

    // Request wake lock
    requestWakeLock();

    // Setup receiver state
    receivingFile = true;
    receivingFileName = req.name;
    receivingFileSize = req.size;
    receivingMimeType = req.mimeType || 'application/octet-stream';
    expectedTotalChunks = Math.ceil(req.size / CHUNK_SIZE);
    totalBytesReceived = 0;
    receivedChunkCount = 0;
    transferActive = true;

    // Send accept via CONTROL channel (not data channel)
    sendControl({ type: 'file-accept' });

    // Hide request UI, show progress
    const fileRequest = document.getElementById('fileRequest');
    if (fileRequest) fileRequest.style.display = 'none';
    showTransferInfo(req.name, req.size, 'Receiving...');

    // Clear queue
    pendingFileRequestQueue.shift();
    pendingFileRequest = null;
}

function handleRejectFile() {
    if (!pendingFileRequest) return;
    sendControl({ type: 'file-reject' });
    pendingFileRequestQueue = [];
    pendingFileRequest = null;

    const fileRequest = document.getElementById('fileRequest');
    const dropZone = document.getElementById('dropZone');
    if (fileRequest) fileRequest.style.display = 'none';
    if (dropZone) dropZone.style.display = 'flex';
}

function handleFileAccepted() {
    console.log('✅ File accepted, starting transfer');
    startSendingFile();
}

function handleFileRejected() {
    console.log('❌ File rejected');
    showUserMessage('Transfer rejected by receiver');
    currentFile = null;
    hideTransferInfo();
    processFileQueue();
}

function handleFileComplete(msg) {
    console.log(`✅ Transfer complete: ${msg.bytesReceived} bytes`);
    showSuccessMessage('File sent successfully!');
    currentFile = null;
    hideTransferInfo();
    releaseWakeLock();
    processFileQueue();
}

// ============================================================================
// BINARY CHUNK HANDLER (RAM BUFFER - NO AWAIT)
// ============================================================================

function handleBinaryChunk(buffer) {
    if (!receivingFile) return;

    const view = new DataView(buffer);
    const chunkIndex = view.getUint32(0, true);
    const payload = buffer.slice(4);

    // Update network stats IMMEDIATELY
    totalBytesReceived += payload.byteLength;
    receivedChunkCount++;
    updateNetworkSpeed();

    // Update progress from network bytes
    const percent = Math.min(99.9, (totalBytesReceived / receivingFileSize) * 100);
    updateProgress(percent);

    // Push to RAM queue (NON-BLOCKING)
    RAM_QUEUE.push({ fileName: receivingFileName, chunkIndex, data: payload });
    ramBytes += payload.byteLength;

    // Start disk writer
    if (!diskWriterRunning) diskWriterLoop();

    // ACK every 100 chunks
    if (receivedChunkCount % 100 === 0) {
        sendControl({ type: 'ack', chunkIndex, bytesReceived: totalBytesReceived });
    }

    // Check completion
    if (totalBytesReceived >= receivingFileSize) {
        completeReceive();
    }
}

async function completeReceive() {
    console.log('✅ All bytes received, finalizing...');
    transferActive = false;

    const progressLabel = document.getElementById('progressLabel');
    if (progressLabel) progressLabel.textContent = 'Finalizing...';

    // Wait for disk writer
    while (RAM_QUEUE.length > 0) await sleep(50);

    console.log('💾 Assembling file...');
    try {
        const chunks = await getAllChunksFromIndexedDB(receivingFileName);
        const blob = new Blob(chunks, { type: receivingMimeType });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receivingFileName;
        a.click();
        URL.revokeObjectURL(url);

        await deleteFileFromIndexedDB(receivingFileName);
        updateProgress(100);
        showSuccessMessage(`${receivingFileName} downloaded!`);

        sendControl({ type: 'file-complete', bytesReceived: totalBytesReceived });
    } catch (err) {
        console.error('Assembly error:', err);
        showUserMessage(`Download failed: ${err.message}`);
    }

    resetReceiverState();
    hideTransferInfo();
    releaseWakeLock();
}

function resetReceiverState() {
    receivingFile = null;
    receivingFileName = '';
    receivingFileSize = 0;
    receivingMimeType = '';
    totalBytesReceived = 0;
    totalBytesWrittenToDisk = 0;
    receivedChunkCount = 0;
    RAM_QUEUE.length = 0;
    ramBytes = 0;
    speedStartTime = null;
    lastSpeedUpdate = null;
    lastBytesForSpeed = 0;
}

// ============================================================================
// FILE SENDING
// ============================================================================

async function addFilesToQueue(files) {
    const socket = getSocket();
    if (socket.readyState !== WebSocket.OPEN) {
        try { await ensureSocketConnected(); }
        catch (e) { showUserMessage('Connection lost. Please wait.'); return; }
    }

    // CRITICAL FIX #1: Guard before proceeding
    if (!controlChannel || controlChannel.readyState !== 'open') {
        showUserMessage('Waiting for peer connection...');
        return;
    }

    for (const file of files) fileQueue.push(file);
    if (!isProcessingQueue) processFileQueue();
}

function processFileQueue() {
    if (fileQueue.length === 0) { isProcessingQueue = false; return; }

    isProcessingQueue = true;
    currentFile = fileQueue.shift();
    console.log(`📤 Sending request: ${currentFile.name}`);

    // Send via CONTROL channel
    sendControl({
        type: 'file-request',
        name: currentFile.name,
        size: currentFile.size,
        mimeType: currentFile.type || 'application/octet-stream'
    });

    showTransferInfo(currentFile.name, currentFile.size, 'Waiting for accept...');
}

async function startSendingFile() {
    if (!currentFile) return;

    // CRITICAL FIX #1: Guard data channel
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.warn('⚠️ Data channel not ready');
        showUserMessage('Connection not ready. Please try again.');
        return;
    }

    console.log(`📤 Starting: ${currentFile.name} (Chunk: ${CHUNK_SIZE / 1024}KB)`);
    transferActive = true;
    senderChunkIndex = 0;
    totalBytesSent = 0;
    speedStartTime = Date.now();
    lastSpeedUpdate = Date.now();
    lastBytesForSpeed = 0;

    const progressLabel = document.getElementById('progressLabel');
    if (progressLabel) progressLabel.textContent = 'Uploading...';

    await requestWakeLock();

    const file = currentFile;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Optimization #7: Avoid repeatedly converting buffers
    // Note: slice() creates a Blob, arrayBuffer() reads it. 
    // This is reasonably efficient but creates garbage. 
    // Streams would be better but slice is robust for now.

    try {
        for (let i = 0; i < totalChunks; i++) {
            if (transferAborted) throw new Error('Aborted');

            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const buffer = await chunk.arrayBuffer();

            // Create framed chunk
            const framed = new ArrayBuffer(4 + buffer.byteLength);
            new DataView(framed).setUint32(0, i, true);
            new Uint8Array(framed, 4).set(new Uint8Array(buffer));

            // Backpressure
            if (dataChannel.bufferedAmount > HIGH_WATER_MARK) {
                await waitForDrain();
            }

            // Optimization #4: Remove artificial sleeps, yield occasionally
            if (i % 4 === 0) {
                await Promise.resolve(); // Yield to main thread
            }

            // CRITICAL FIX #1: Guard before send
            // Optimization #7: send buffer directly
            if (!sendData(framed)) {
                throw new Error('Data channel closed during transfer');
            }

            totalBytesSent += buffer.byteLength;
            senderChunkIndex++;

            updateProgress((totalBytesSent / file.size) * 100);
            updateSenderSpeed();
        }

        console.log('✅ All chunks sent');
        updateProgress(100);
    } catch (err) {
        console.error('Send error:', err);
        showUserMessage(`Transfer failed: ${err.message}`);
        hideTransferInfo();
    }

    transferActive = false;
}

function waitForDrain() {
    return new Promise(resolve => {
        if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
            resolve();
        } else {
            // Optimization #1: Use onbufferedamountlow event
            const handler = () => {
                dataChannel.removeEventListener('bufferedamountlow', handler);
                resolve();
            };
            dataChannel.addEventListener('bufferedamountlow', handler);
        }
    });
}

function updateSenderSpeed() {
    const now = Date.now();
    const elapsed = (now - lastSpeedUpdate) / 1000;
    if (elapsed < 0.5) return;

    const speedBps = (totalBytesSent - lastBytesForSpeed) / elapsed;
    const speedText = document.getElementById('transferSpeed');
    const timeRemaining = document.getElementById('timeRemaining');

    if (speedText) {
        speedText.textContent = speedBps > 1048576
            ? `${(speedBps / 1048576).toFixed(1)} MB/s`
            : `${(speedBps / 1024).toFixed(1)} KB/s`;
    }

    if (timeRemaining && currentFile && speedBps > 0) {
        timeRemaining.textContent = formatTime((currentFile.size - totalBytesSent) / speedBps);
    }

    lastSpeedUpdate = now;
    lastBytesForSpeed = totalBytesSent;
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

function createRoom(e) {
    if (e) e.preventDefault();
    joinRoom(generateRoomId(), true);
}

function joinRoom(roomId = null, isCreator = false) {
    if (!roomId) {
        const input = document.getElementById('roomId');
        roomId = input ? input.value.trim() : '';
    }
    if (!roomId) { showUserMessage('Enter room ID'); return; }

    currentRoom = roomId;
    isInitiator = isCreator;
    connectWebSocket();
}

function leaveRoom() {
    transferAborted = true;
    stopHeartbeat();

    if (controlChannel) { controlChannel.close(); controlChannel = null; }
    if (dataChannel) { dataChannel.close(); dataChannel = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'leave', room: currentRoom }));
    }

    currentRoom = null;
    isInitiator = false;
    fileQueue = [];
    currentFile = null;

    hideRoomDisplay();
    hideTransferInfo();
    updateConnectionStatus('disconnected', 'Disconnected');
    releaseWakeLock();
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function showRoomDisplay() {
    const roomDisplay = document.getElementById('roomDisplay');
    const currentRoomSpan = document.getElementById('currentRoom');
    const transferSection = document.getElementById('transferSection');
    if (roomDisplay) roomDisplay.style.display = 'flex';
    if (currentRoomSpan) currentRoomSpan.textContent = currentRoom;
    if (transferSection) transferSection.style.display = 'block';
}

function hideRoomDisplay() {
    const roomDisplay = document.getElementById('roomDisplay');
    const transferSection = document.getElementById('transferSection');
    if (roomDisplay) roomDisplay.style.display = 'none';
    if (transferSection) transferSection.style.display = 'none';
}

// ============================================================================
// WEBRTC SIGNALING
// ============================================================================

// ============================================================================
// WEBRTC SIGNALING
// ============================================================================

const ignoreOffer = false; // Polite peer logic variable

async function createOffer() {
    if (!peerConnection) createPeerConnection();
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', offer, room: currentRoom }));
    } catch (e) {
        console.error('Error creating offer:', e);
    }
}

async function handleOffer(offer) {
    if (!peerConnection) createPeerConnection();

    // Collision handling (Polite Peer pattern simplified)
    const isStable = peerConnection.signalingState === 'stable' || peerConnection.signalingState === 'have-local-offer';

    // If we are initiator (impolite) and have a local offer (race condition), we might ignore, 
    // but for simplicity, we'll accept remote offer if we are not 'stable'.
    // Actually, the error reported is on ANSWER, not Offer. 
    // "Failed to set remote answer sdp: Called in wrong state: stable"
    // This implies we are the Offerer, we got an Answer, but we are already Stable.
    // This usually means we processed the answer twice or reset the connection.

    try {
        // If we are already processing an offer/answer, we might need to be careful.
        // Standard check:
        if (peerConnection.signalingState !== 'stable' && peerConnection.signalingState !== 'have-remote-offer') {
            // If we have a local offer (collision), we usually rollback if we are polite.
            // But let's just proceed for now or log warning.
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', answer, room: currentRoom }));
    } catch (e) {
        console.error('Error handling offer:', e);
    }
}

async function handleAnswer(answer) {
    if (!peerConnection) return;

    // FIX: Check state to prevent "Called in wrong state: stable"
    if (peerConnection.signalingState === 'stable') {
        console.warn('⚠️ Received answer but connection is already stable. Ignoring duplicate/late answer.');
        return;
    }

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
        console.error('Error handling answer:', e);
    }
}

async function handleIceCandidate(candidate) {
    if (peerConnection && candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding ICE candidate:', e);
        }
    }
}

// ============================================================================
// UI HELPERS (Fixing alignment issue)
// ============================================================================

function hideTransferInfo() {
    const transferInfo = document.getElementById('transferInfo');
    const dropZone = document.getElementById('dropZone');

    if (transferInfo) transferInfo.style.display = 'none';
    if (dropZone) {
        dropZone.style.display = 'flex';
        // FIX: Ensure centering is preserved
        dropZone.style.flexDirection = 'column';
        dropZone.style.justifyContent = 'center';
        dropZone.style.alignItems = 'center';
    }
}

// ============================================================================
// LEAVE CONFIRMATION
// ============================================================================

window.addEventListener('beforeunload', (e) => {
    if (currentRoom || transferActive) {
        e.preventDefault();
        e.returnValue = ''; // Trigger browser confirmation dialog
        return '';
    }
});

// ============================================================================
// FILE INPUT HANDLERS
// ============================================================================

function handleDragOver(e) {
    e.preventDefault();
    document.getElementById('dropZone')?.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    document.getElementById('dropZone')?.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    document.getElementById('dropZone')?.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) addFilesToQueue(Array.from(e.dataTransfer.files));
}

function handleFileSelect(e) {
    if (e.target.files.length > 0) addFilesToQueue(Array.from(e.target.files));
    e.target.value = '';
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
    console.log('🚀 POJO Files - Production-Grade P2P Transfer');
    console.log('📡 Dual channels: control (reliable) + data (fast)');
    console.log(`⚡ Chunk: ${CHUNK_SIZE / 1024}KB | HWM: ${HIGH_WATER_MARK / 1024 / 1024}MB | RAM: ${MAX_RAM_MB}MB`);
    console.log(`💓 Heartbeat: ${HEARTBEAT_INTERVAL_MS / 1000}s`);

    setupEventListeners();
    updateConnectionStatus('disconnected', 'Disconnected');
}

function setupEventListeners() {
    document.getElementById('createRoomBtn')?.addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn')?.addEventListener('click', () => joinRoom());
    document.getElementById('leaveRoomBtn')?.addEventListener('click', leaveRoom);
    document.getElementById('roomId')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); joinRoom(); }
    });

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    if (dropZone) {
        dropZone.addEventListener('click', () => fileInput?.click());
        dropZone.addEventListener('dragover', handleDragOver);
        dropZone.addEventListener('dragleave', handleDragLeave);
        dropZone.addEventListener('drop', handleDrop);
    }
    fileInput?.addEventListener('change', handleFileSelect);

    document.getElementById('acceptFileBtn')?.addEventListener('click', handleAcceptFile);
    document.getElementById('rejectFileBtn')?.addEventListener('click', handleRejectFile);

    // Modal handlers
    const donateBtn = document.getElementById('donateBtn');
    const donateModal = document.getElementById('donateModal');
    const closeModal = document.getElementById('closeModal');
    const developerAvatar = document.querySelector('.developer-avatar');
    const donationImage = document.querySelector('.donation-image');

    donateBtn?.addEventListener('click', () => {
        if (donateModal && donationImage) { donationImage.src = 'image.png'; donateModal.style.display = 'flex'; }
    });
    developerAvatar?.addEventListener('click', () => {
        if (donateModal && donationImage) { donationImage.src = 'aiks.jpg'; donateModal.style.display = 'flex'; }
    });
    closeModal?.addEventListener('click', () => { if (donateModal) donateModal.style.display = 'none'; });
    donateModal?.addEventListener('click', (e) => { if (e.target === donateModal) donateModal.style.display = 'none'; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && donateModal) donateModal.style.display = 'none'; });
}

init();