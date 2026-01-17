// ============================================================================
// POJO FILES - OPTIMIZED DATACHANNEL TRANSFER
// ============================================================================
// High-speed P2P file transfer with:
// - RAM buffer queue (non-blocking receive)
// - Background IndexedDB writer
// - Unordered DataChannel for max speed
// - Network-based speed calculation
// ============================================================================

// WebRTC Configuration - TURN required for production reliability
// TURN handles: CGNAT, mobile networks, firewalls, long-running transfers
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    {
        urls: "turn:free.expressturn.com:3478?transport=tcp",
        username: "000000002083986270",
        credential: "yaZXTjsDpaLSnBGYVnDxMZ+acj8="
    }
];

// ============================================================================
// TRANSFER CONFIGURATION - OPTIMIZED FOR SPEED
// ============================================================================
const CHUNK_SIZE = 64 * 1024;              // 64KB chunks
const HIGH_WATER_MARK = 16 * 1024 * 1024;  // 16MB buffer before backpressure
const MAX_RAM_MB = 256;                     // Max RAM buffer size
const MAX_RAM_BYTES = MAX_RAM_MB * 1024 * 1024;

// ============================================================================
// WEBSOCKET URL CONFIGURATION
// ============================================================================
function getWebSocketURL() {
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');

    if (wsParam) {
        if (wsParam.startsWith('ws://') || wsParam.startsWith('wss://')) {
            return wsParam;
        }
        if (wsParam.includes('devtunnels.ms')) {
            return `wss://${wsParam}`;
        }
        const protocol = 'ws:';
        const port = params.get('port') || '8080';
        return `${protocol}//${wsParam}:${port}`;
    }

    const hostname = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    if (hostname.includes('onrender.com')) {
        return `${protocol}//${hostname}`;
    }

    const port = window.location.port || '8080';
    return `${protocol}//${hostname}:${port}`;
}

const WS_URL = getWebSocketURL();
console.log('WebSocket URL:', WS_URL);

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let ws = null;
let peerConnection = null;
let dataChannel = null;
let currentRoom = null;
let isInitiator = false;

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

// Receiver state - RAM BUFFER (KEY OPTIMIZATION)
const RAM_QUEUE = [];
let ramBytes = 0;
let receivingFile = null;
let receivingFileSize = 0;
let receivingFileName = '';
let receivingMimeType = '';
let totalBytesReceived = 0;       // Network bytes (for speed calc)
let totalBytesWrittenToDisk = 0;  // Disk bytes (for progress)
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

// Wake Lock for mobile
let wakeLock = null;

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

        request.onerror = () => {
            console.error('❌ IndexedDB open failed:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            db = request.result;
            console.log('✅ IndexedDB initialized');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('fileName', 'fileName', { unique: false });
                console.log('✅ IndexedDB store created');
            }
        };
    });
}

// NON-BLOCKING chunk save (no await in caller)
function saveChunkToIndexedDB(fileName, chunkIndex, chunkData) {
    if (!db) return;

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    store.put({
        id: `${fileName}_${chunkIndex}`,
        fileName: fileName,
        chunkIndex: chunkIndex,
        data: chunkData,
        timestamp: Date.now()
    });

    // No await, fire and forget
}

async function getAllChunksFromIndexedDB(fileName) {
    if (!db) await initIndexedDB();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('fileName');
        const request = index.getAll(fileName);

        request.onsuccess = () => {
            const chunks = request.result;
            chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
            resolve(chunks.map(c => c.data));
        };

        request.onerror = () => reject(request.error);
    });
}

async function deleteFileFromIndexedDB(fileName) {
    if (!db) return;

    return new Promise((resolve) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('fileName');
        const request = index.openKeyCursor(IDBKeyRange.only(fileName));

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                store.delete(cursor.primaryKey);
                cursor.continue();
            } else {
                resolve();
            }
        };

        request.onerror = () => resolve();
    });
}

// Initialize IndexedDB on load
initIndexedDB().catch(console.error);

// ============================================================================
// BACKGROUND INDEXEDDB WRITER (NON-BLOCKING) - KEY OPTIMIZATION
// ============================================================================
let diskWriterRunning = false;

async function diskWriterLoop() {
    if (diskWriterRunning) return;
    diskWriterRunning = true;

    console.log('💾 Background disk writer started');

    while (transferActive || RAM_QUEUE.length > 0) {
        if (RAM_QUEUE.length === 0) {
            await sleep(5);
            continue;
        }

        const item = RAM_QUEUE.shift();
        ramBytes -= item.data.byteLength;

        // NO await - fire and forget to IndexedDB
        saveChunkToIndexedDB(item.fileName, item.chunkIndex, item.data);
        totalBytesWrittenToDisk += item.data.byteLength;

        // Update disk progress occasionally
        if (RAM_QUEUE.length % 100 === 0) {
            updateDiskProgress();
        }
    }

    diskWriterRunning = false;
    console.log('💾 Background disk writer finished');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function updateDiskProgress() {
    if (receivingFileSize > 0) {
        const diskPercent = (totalBytesWrittenToDisk / receivingFileSize) * 100;
        // Could show separate disk progress if needed
    }
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
    if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

function updateProgress(percent) {
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');

    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressPercent) progressPercent.textContent = `${percent.toFixed(1)}%`;
}

// NETWORK-BASED speed calculation (inside onmessage context)
function updateNetworkSpeed() {
    const now = Date.now();
    if (!lastSpeedUpdate) {
        lastSpeedUpdate = now;
        lastBytesForSpeed = totalBytesReceived;
        return;
    }

    const elapsed = (now - lastSpeedUpdate) / 1000;
    if (elapsed < 0.5) return; // Update every 500ms

    const bytesDelta = totalBytesReceived - lastBytesForSpeed;
    const speedBps = bytesDelta / elapsed;

    const speedText = document.getElementById('transferSpeed');
    const timeRemaining = document.getElementById('timeRemaining');

    if (speedText) {
        if (speedBps > 1024 * 1024) {
            speedText.textContent = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`;
        } else if (speedBps > 1024) {
            speedText.textContent = `${(speedBps / 1024).toFixed(1)} KB/s`;
        } else {
            speedText.textContent = `${speedBps.toFixed(0)} B/s`;
        }
    }

    if (timeRemaining && receivingFileSize > 0) {
        const remaining = receivingFileSize - totalBytesReceived;
        if (speedBps > 0) {
            timeRemaining.textContent = formatTime(remaining / speedBps);
        }
    }

    lastSpeedUpdate = now;
    lastBytesForSpeed = totalBytesReceived;
}

function updateConnectionStatus(status, text) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');

    if (statusIndicator) {
        statusIndicator.className = 'status-indicator';
        if (status === 'connected') statusIndicator.classList.add('connected');
        else if (status === 'connecting') statusIndicator.classList.add('connecting');
    }
    if (statusText) statusText.textContent = text;
}

function showTransferInfo(fileName, fileSize, label = 'Transferring...') {
    const transferInfo = document.getElementById('transferInfo');
    const fileNameEl = document.getElementById('fileName');
    const fileSizeEl = document.getElementById('fileSize');
    const dropZone = document.getElementById('dropZone');
    const transferSection = document.getElementById('transferSection');
    const progressLabel = document.getElementById('progressLabel');

    if (transferSection) transferSection.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (transferInfo) transferInfo.style.display = 'block';
    if (fileNameEl) fileNameEl.textContent = fileName;
    if (fileSizeEl) fileSizeEl.textContent = formatFileSize(fileSize);
    if (progressLabel) progressLabel.textContent = label;

    updateProgress(0);
}

function hideTransferInfo() {
    const transferInfo = document.getElementById('transferInfo');
    const dropZone = document.getElementById('dropZone');

    if (transferInfo) transferInfo.style.display = 'none';
    if (dropZone) dropZone.style.display = 'flex';
}

function showSuccessMessage(text) {
    const successMessage = document.getElementById('successMessage');
    const successText = document.getElementById('successText');

    if (successMessage) {
        successMessage.style.display = 'flex';
        if (successText) successText.textContent = text;
        setTimeout(() => successMessage.style.display = 'none', 5000);
    }
}

function showUserMessage(message) {
    alert(message);
}

// ============================================================================
// WAKE LOCK
// ============================================================================

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('📱 Wake Lock active');
        }
    } catch (err) {
        console.warn('Wake Lock not available:', err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => { });
        wakeLock = null;
    }
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
            if (currentRoom) {
                ws.send(JSON.stringify({ type: 'join', room: currentRoom }));
            }
            resolve(ws);
        }, { once: true });

        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            setTimeout(() => reconnectSocket().then(resolve).catch(reject), RECONNECT_DELAY_MS);
        }, { once: true });
    });
}

function createWebSocket() {
    console.log(`📡 Connecting to: ${WS_URL}`);
    updateConnectionStatus('connecting', 'Connecting...');

    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        wsReconnectAttempts = 0;
        if (currentRoom) {
            socket.send(JSON.stringify({ type: 'join', room: currentRoom }));
        }
    };

    socket.onmessage = (event) => {
        try {
            handleSignalingMessage(JSON.parse(event.data));
        } catch (e) {
            console.error('Parse error:', e);
        }
    };

    socket.onerror = (e) => {
        console.error('WebSocket error:', e);
        updateConnectionStatus('disconnected', 'Error');
    };

    socket.onclose = (event) => {
        console.log(`WebSocket closed: ${event.code}`);
        if (currentRoom && event.code !== 1000) {
            updateConnectionStatus('disconnected', 'Reconnecting...');
            setTimeout(() => reconnectSocket().catch(console.error), RECONNECT_DELAY_MS);
        } else {
            updateConnectionStatus('disconnected', 'Disconnected');
        }
    };

    return socket;
}

// Keep connection alive on visibility change
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    } else {
        if (ws && ws.readyState !== WebSocket.OPEN && currentRoom) {
            reconnectSocket().catch(console.error);
        }
    }
});

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
                if (isInitiator && !dataChannel) {
                    createDataChannel();
                    createOffer();
                }
            }
            break;

        case 'peer-joined':
            console.log('👤 Peer joined');
            if (!peerConnection) createPeerConnection();
            if (isInitiator) {
                createDataChannel();
                createOffer();
            }
            break;

        case 'peer-left':
            console.log('👋 Peer left');
            updateConnectionStatus('connecting', 'Peer disconnected');
            if (dataChannel) { dataChannel.close(); dataChannel = null; }
            if (peerConnection) { peerConnection.close(); peerConnection = null; }
            break;

        case 'offer':
            handleOffer(msg.offer);
            break;

        case 'answer':
            handleAnswer(msg.answer);
            break;

        case 'ice-candidate':
            handleIceCandidate(msg.candidate);
            break;

        case 'pong':
            break;

        case 'error':
            console.error('Server error:', msg.message);
            showUserMessage(msg.message);
            break;
    }
}

// ============================================================================
// WEBRTC
// ============================================================================

function createPeerConnection() {
    console.log('🔗 Creating peer connection');
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peerConnection.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: e.candidate,
                room: currentRoom
            }));
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
        console.log('📡 Received DataChannel');
        setupDataChannel(e.channel);
    };
}

// OPTIMIZED DataChannel: unordered for max speed
function createDataChannel() {
    console.log('📡 Creating DataChannel (unordered, maxPacketLifeTime: 300)');

    dataChannel = peerConnection.createDataChannel('file', {
        ordered: false,           // Unordered for speed
        maxPacketLifeTime: 300    // 300ms max lifetime
    });

    setupDataChannel(dataChannel);
}

function setupDataChannel(channel) {
    dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
        console.log('✅ DataChannel opened');
        updateConnectionStatus('connected', 'Ready to transfer');
    };

    channel.onclose = () => {
        console.log('📡 DataChannel closed');
        updateConnectionStatus('disconnected', 'Channel closed');
    };

    channel.onerror = (e) => console.error('DataChannel error:', e);

    // CRITICAL: Non-blocking message handler
    channel.onmessage = (event) => {
        const data = event.data;

        if (typeof data === 'string') {
            handleControlMessage(JSON.parse(data));
        } else {
            // Binary chunk - push to RAM queue (NO await)
            handleBinaryChunk(data);
        }
    };
}

// ============================================================================
// BINARY CHUNK HANDLER (RAM BUFFER - NO AWAIT)
// ============================================================================

function handleBinaryChunk(buffer) {
    if (!receivingFile) return;

    // Extract chunk index from header (first 4 bytes)
    const view = new DataView(buffer);
    const chunkIndex = view.getUint32(0, true);
    const payload = buffer.slice(4);

    // Update network stats IMMEDIATELY (for speed calc)
    totalBytesReceived += payload.byteLength;
    receivedChunkCount++;

    // Update speed from network bytes
    updateNetworkSpeed();

    // Update progress from network bytes
    const percent = (totalBytesReceived / receivingFileSize) * 100;
    updateProgress(Math.min(99.9, percent));

    // Push to RAM queue (NON-BLOCKING)
    RAM_QUEUE.push({
        fileName: receivingFileName,
        chunkIndex: chunkIndex,
        data: payload
    });
    ramBytes += payload.byteLength;

    // Check RAM limit
    if (ramBytes > MAX_RAM_BYTES) {
        console.warn(`⚠️ RAM buffer full: ${(ramBytes / 1024 / 1024).toFixed(0)}MB`);
        // Writer will catch up
    }

    // Start background writer if not running
    if (!diskWriterRunning) {
        diskWriterLoop();
    }

    // ACK every 100 chunks for flow control
    if (receivedChunkCount % 100 === 0) {
        sendAck(chunkIndex);
    }

    // Check completion
    if (totalBytesReceived >= receivingFileSize) {
        completeReceive();
    }
}

function sendAck(chunkIndex) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({
            type: 'ack',
            chunkIndex: chunkIndex,
            bytesReceived: totalBytesReceived
        }));
    }
}

async function completeReceive() {
    console.log('✅ All bytes received, finalizing...');
    transferActive = false;

    // Update UI to show finalizing
    const progressLabel = document.getElementById('progressLabel');
    if (progressLabel) progressLabel.textContent = 'Finalizing file...';

    // Wait for disk writer to finish
    while (RAM_QUEUE.length > 0) {
        await sleep(50);
    }

    console.log('💾 Assembling file from IndexedDB...');

    try {
        // Get all chunks from IndexedDB
        const chunks = await getAllChunksFromIndexedDB(receivingFileName);

        // Create blob
        const blob = new Blob(chunks, { type: receivingMimeType });

        // Trigger download
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receivingFileName;
        a.click();
        URL.revokeObjectURL(url);

        // Cleanup
        await deleteFileFromIndexedDB(receivingFileName);

        updateProgress(100);
        showSuccessMessage(`${receivingFileName} downloaded!`);

        // Send completion to sender
        if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify({
                type: 'file-complete',
                bytesReceived: totalBytesReceived
            }));
        }

    } catch (error) {
        console.error('Error assembling file:', error);
        showUserMessage(`Download failed: ${error.message}`);
    }

    // Reset state
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
// CONTROL MESSAGE HANDLERS
// ============================================================================

function handleControlMessage(msg) {
    switch (msg.type) {
        case 'file-request':
            handleFileRequest(msg);
            break;

        case 'file-accept':
            handleFileAccepted();
            break;

        case 'file-reject':
            handleFileRejected();
            break;

        case 'ack':
            handleAck(msg);
            break;

        case 'file-complete':
            handleFileComplete(msg);
            break;

        case 'ping':
            dataChannel.send(JSON.stringify({ type: 'pong' }));
            break;

        case 'pong':
            break;
    }
}

function handleFileRequest(request) {
    console.log(`📥 File request: ${request.name} (${formatFileSize(request.size)})`);

    pendingFileRequestQueue.push(request);

    if (pendingFileRequestQueue.length === 1) {
        showFileRequestUI();
    }
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
            ? `${req.name} (+${pendingFileRequestQueue.length - 1} more)`
            : req.name;
    }

    if (requestFileSize) {
        const total = pendingFileRequestQueue.reduce((s, r) => s + r.size, 0);
        requestFileSize.textContent = formatFileSize(total);
    }
}

function handleAcceptFile() {
    if (!pendingFileRequest) return;

    const req = pendingFileRequest;
    console.log(`✅ Accepting: ${req.name}`);

    // Setup receiver state
    receivingFile = true;
    receivingFileName = req.name;
    receivingFileSize = req.size;
    receivingMimeType = req.mimeType || 'application/octet-stream';
    expectedTotalChunks = Math.ceil(req.size / CHUNK_SIZE);
    totalBytesReceived = 0;
    receivedChunkCount = 0;
    transferActive = true;

    // Send accept
    dataChannel.send(JSON.stringify({ type: 'file-accept' }));

    // Hide request UI, show progress
    const fileRequest = document.getElementById('fileRequest');
    if (fileRequest) fileRequest.style.display = 'none';

    showTransferInfo(req.name, req.size, 'Receiving...');
    requestWakeLock();

    // Clear queue
    pendingFileRequestQueue.shift();
    pendingFileRequest = null;
}

function handleRejectFile() {
    if (!pendingFileRequest) return;

    dataChannel.send(JSON.stringify({ type: 'file-reject' }));

    pendingFileRequestQueue = [];
    pendingFileRequest = null;

    const fileRequest = document.getElementById('fileRequest');
    if (fileRequest) fileRequest.style.display = 'none';

    const dropZone = document.getElementById('dropZone');
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

function handleAck(msg) {
    // Could use for flow control if needed
}

function handleFileComplete(msg) {
    console.log(`✅ Transfer complete: ${msg.bytesReceived} bytes received`);
    showSuccessMessage('File sent successfully!');
    currentFile = null;
    hideTransferInfo();
    releaseWakeLock();
    processFileQueue();
}

// ============================================================================
// FILE SENDING
// ============================================================================

async function addFilesToQueue(files) {
    const socket = getSocket();
    if (socket.readyState !== WebSocket.OPEN) {
        try {
            await ensureSocketConnected();
        } catch (e) {
            showUserMessage('Connection lost. Please wait.');
            return;
        }
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
        showUserMessage('Waiting for peer connection...');
        return;
    }

    for (const file of files) {
        fileQueue.push(file);
    }

    if (!isProcessingQueue) {
        processFileQueue();
    }
}

function processFileQueue() {
    if (fileQueue.length === 0) {
        isProcessingQueue = false;
        return;
    }

    isProcessingQueue = true;
    currentFile = fileQueue.shift();

    console.log(`📤 Sending request: ${currentFile.name}`);

    // Send file request
    dataChannel.send(JSON.stringify({
        type: 'file-request',
        name: currentFile.name,
        size: currentFile.size,
        mimeType: currentFile.type || 'application/octet-stream'
    }));

    showTransferInfo(currentFile.name, currentFile.size, 'Waiting for accept...');
}

async function startSendingFile() {
    if (!currentFile) return;

    console.log(`📤 Starting: ${currentFile.name}`);

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

    try {
        for (let i = 0; i < totalChunks; i++) {
            if (transferAborted) throw new Error('Aborted');

            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const buffer = await chunk.arrayBuffer();

            // Create framed chunk: [4 bytes index][payload]
            const framed = new ArrayBuffer(4 + buffer.byteLength);
            const view = new DataView(framed);
            view.setUint32(0, i, true);
            new Uint8Array(framed, 4).set(new Uint8Array(buffer));

            // Backpressure check
            while (dataChannel.bufferedAmount > HIGH_WATER_MARK) {
                await waitForDrain();
            }

            dataChannel.send(framed);

            totalBytesSent += buffer.byteLength;
            senderChunkIndex++;

            // Update progress
            const percent = (totalBytesSent / file.size) * 100;
            updateProgress(percent);
            updateSenderSpeed();
        }

        console.log('✅ All chunks sent');
        updateProgress(100);

    } catch (error) {
        console.error('Send error:', error);
        showUserMessage(`Transfer failed: ${error.message}`);
        hideTransferInfo();
    }

    transferActive = false;
}

function waitForDrain() {
    return new Promise(resolve => {
        const check = () => {
            if (dataChannel.bufferedAmount <= HIGH_WATER_MARK / 2) {
                resolve();
            } else {
                setTimeout(check, 10);
            }
        };
        check();
    });
}

function updateSenderSpeed() {
    const now = Date.now();
    const elapsed = (now - lastSpeedUpdate) / 1000;
    if (elapsed < 0.5) return;

    const bytesDelta = totalBytesSent - lastBytesForSpeed;
    const speedBps = bytesDelta / elapsed;

    const speedText = document.getElementById('transferSpeed');
    const timeRemaining = document.getElementById('timeRemaining');

    if (speedText) {
        if (speedBps > 1024 * 1024) {
            speedText.textContent = `${(speedBps / (1024 * 1024)).toFixed(1)} MB/s`;
        } else {
            speedText.textContent = `${(speedBps / 1024).toFixed(1)} KB/s`;
        }
    }

    if (timeRemaining && currentFile) {
        const remaining = currentFile.size - totalBytesSent;
        if (speedBps > 0) {
            timeRemaining.textContent = formatTime(remaining / speedBps);
        }
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

    if (!roomId) {
        showUserMessage('Enter room ID');
        return;
    }

    currentRoom = roomId;
    isInitiator = isCreator;
    connectWebSocket();
}

function leaveRoom() {
    transferAborted = true;

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

async function createOffer() {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', offer, room: currentRoom }));
}

async function handleOffer(offer) {
    if (!peerConnection) createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', answer, room: currentRoom }));
}

async function handleAnswer(answer) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleIceCandidate(candidate) {
    if (peerConnection && candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

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
    if (e.dataTransfer.files.length > 0) {
        addFilesToQueue(Array.from(e.dataTransfer.files));
    }
}

function handleFileSelect(e) {
    if (e.target.files.length > 0) {
        addFilesToQueue(Array.from(e.target.files));
    }
    e.target.value = '';
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
    console.log('🚀 POJO Files - Optimized DataChannel Transfer');
    console.log(`📦 Chunk: ${CHUNK_SIZE / 1024}KB | RAM: ${MAX_RAM_MB}MB | HWM: ${HIGH_WATER_MARK / 1024 / 1024}MB`);

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
        if (donateModal && donationImage) {
            donationImage.src = 'image.png';
            donateModal.style.display = 'flex';
        }
    });

    developerAvatar?.addEventListener('click', () => {
        if (donateModal && donationImage) {
            donationImage.src = 'aiks.jpg';
            donateModal.style.display = 'flex';
        }
    });

    closeModal?.addEventListener('click', () => {
        if (donateModal) donateModal.style.display = 'none';
    });

    donateModal?.addEventListener('click', (e) => {
        if (e.target === donateModal) donateModal.style.display = 'none';
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && donateModal) donateModal.style.display = 'none';
    });
}

init();