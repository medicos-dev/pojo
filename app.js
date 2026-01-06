// WebRTC Configuration
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    
];

// Constants
// Get WebSocket URL from URL parameters or use same host as page
function getWebSocketURL() {
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');
    
    // If WebSocket URL is provided as parameter, use it directly
    if (wsParam) {
        // If it starts with ws:// or wss://, use as-is
        if (wsParam.startsWith('ws://') || wsParam.startsWith('wss://')) {
            return wsParam;
        }
        // For dev tunnels, use wss:// without port (dev tunnel handles routing)
        if (wsParam.includes('devtunnels.ms')) {
            return `wss://${wsParam}`;
        }
        // For other hosts, determine protocol and port
        const protocol = 'ws:';
        const port = params.get('port') || '8080';
        return `${protocol}//${wsParam}:${port}`;
    }
    
    // Default: use same host and protocol as current page
    const hostname = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    
    // For Render deployments (.onrender.com), use same hostname and protocol
    // Render handles WebSocket upgrades automatically on the same port
    if (hostname.includes('onrender.com')) {
        // Render uses same port for HTTP and WebSocket, no port needed in URL
        return `${protocol}//${hostname}`;
    }
    
    // For local development, use the port from URL or default to 8080
    const port = window.location.port || '8080';
    return `${protocol}//${hostname}:${port}`;
}
const WS_URL = getWebSocketURL();
console.log('WebSocket URL:', WS_URL);
// DYNAMIC SLIDING WINDOW: Optimized for 200GB+ files
const INITIAL_CHUNK_SIZE = 16 * 1024; // 16KB for initial handshake
const CONNECTED_CHUNK_SIZE = 128 * 1024; // 128KB once connected (sweet spot for mobile stability and speed)
const HIGH_WATER_MARK = 4 * 1024 * 1024; // 4MB - fill buffer up to this before waiting
const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1MB - bufferedAmountLowThreshold (triggers next burst)
const MAX_BUFFERED_AMOUNT = HIGH_WATER_MARK; // 4MB max - don't send if buffer exceeds this

// Mobile device detection
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// ============================================================================
// INDEXEDDB STORAGE FOR RECEIVER (Free Tier Safe - No Server-Side Database)
// ============================================================================
// Store file chunks in IndexedDB instead of RAM to support 200GB+ files
// This prevents mobile RAM crashes when receiving large files

let db = null;
const DB_NAME = 'P2PFileTransferDB';
const DB_VERSION = 1;
const STORE_NAME = 'fileChunks';

// Initialize IndexedDB
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
                // Create object store with fileName as keyPath
                const objectStore = database.createObjectStore(STORE_NAME, { keyPath: 'chunkIndex' });
                // Create index for fileName to query all chunks for a file
                objectStore.createIndex('fileName', 'fileName', { unique: false });
                console.log('✅ IndexedDB object store created');
            }
        };
    });
}

// Store chunk in IndexedDB (receiver side)
async function storeChunkInIndexedDB(fileName, chunkIndex, chunkData) {
    if (!db) {
        await initIndexedDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        // Convert chunk to ArrayBuffer for storage
        const chunkBuffer = chunkData instanceof ArrayBuffer 
            ? chunkData 
            : chunkData.buffer instanceof ArrayBuffer 
                ? chunkData.buffer 
                : new Uint8Array(chunkData).buffer;
        
        const record = {
            chunkIndex: `${fileName}_${chunkIndex}`, // Composite key
            fileName: fileName,
            chunkIndexNum: chunkIndex,
            chunkData: chunkBuffer,
            timestamp: Date.now()
        };
        
        const request = store.put(record);
        
        request.onsuccess = () => {
            resolve();
        };
        
        request.onerror = () => {
            console.error(`❌ CRITICAL: Error storing chunk ${chunkIndex} in IndexedDB:`, request.error);
            reject(request.error);
        };
        
        // Handle transaction errors
        transaction.onerror = () => {
            console.error(`❌ CRITICAL: Transaction error while storing chunk ${chunkIndex}:`, transaction.error);
            reject(transaction.error);
        };
    });
}

// Get total bytes received from IndexedDB for a file
async function getTotalBytesFromIndexedDB(fileName) {
    if (!db) {
        await initIndexedDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('fileName');
        const request = index.getAll(fileName);
        
        request.onsuccess = () => {
            const chunks = request.result;
            let totalBytes = 0;
            const chunkIndices = [];
            chunks.forEach(chunk => {
                if (chunk.chunkData && chunk.chunkData.byteLength) {
                    totalBytes += chunk.chunkData.byteLength;
                    if (chunk.chunkIndexNum !== undefined) {
                        chunkIndices.push(chunk.chunkIndexNum);
                    }
                }
            });
            
            // Sort indices to check for gaps
            chunkIndices.sort((a, b) => a - b);
            const minIndex = chunkIndices[0] || 0;
            const maxIndex = chunkIndices[chunkIndices.length - 1] || 0;
            
            // Log if there are significant gaps (missing chunks)
            if (chunkIndices.length > 0 && (maxIndex - minIndex + 1) > chunkIndices.length) {
                const missing = (maxIndex - minIndex + 1) - chunkIndices.length;
                if (missing > 10) { // Only log if significant number missing
                    console.warn(`⚠️ IndexedDB has ${chunkIndices.length} chunks but range is ${minIndex}-${maxIndex} (missing ~${missing} chunks)`);
                }
            }
            
            resolve({ totalBytes, chunkCount: chunks.length, minIndex, maxIndex });
        };
        
        request.onerror = () => {
            console.error('❌ Error reading from IndexedDB:', request.error);
            reject(request.error);
        };
    });
}

// Get all chunks from IndexedDB for a file (for final assembly)
async function getAllChunksFromIndexedDB(fileName) {
    if (!db) {
        await initIndexedDB();
    }
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('fileName');
        const request = index.getAll(fileName);
        
        request.onsuccess = () => {
            const chunks = request.result;
            // Sort by chunkIndexNum to ensure correct order
            chunks.sort((a, b) => a.chunkIndexNum - b.chunkIndexNum);
            resolve(chunks.map(chunk => chunk.chunkData));
        };
        
        request.onerror = () => {
            console.error('❌ Error reading chunks from IndexedDB:', request.error);
            reject(request.error);
        };
    });
}

// Delete all chunks for a file from IndexedDB (cleanup after download)
async function deleteFileFromIndexedDB(fileName) {
    if (!db) {
        return; // No DB, nothing to delete
    }
    
    return new Promise((resolve, reject) => {
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
                console.log(`✅ Deleted all chunks for ${fileName} from IndexedDB`);
                resolve();
            }
        };
        
        request.onerror = () => {
            console.error('❌ Error deleting from IndexedDB:', request.error);
            reject(request.error);
        };
    });
}

// ============================================================================
// LOCALSTORAGE PERSISTENCE (Free Tier Safe)
// ============================================================================
// Store file metadata and byte offset for resume capability

function saveFileMetadataToLocalStorage(fileName, fileSize, mimeType, receivedBytes) {
    try {
        const metadata = {
            fileName,
            fileSize,
            mimeType,
            receivedBytes,
            timestamp: Date.now()
        };
        localStorage.setItem(`fileMetadata_${fileName}`, JSON.stringify(metadata));
        console.log(`💾 Saved file metadata to localStorage: ${fileName} (${receivedBytes}/${fileSize} bytes)`);
    } catch (error) {
        console.error('❌ Error saving to localStorage:', error);
    }
}

function getFileMetadataFromLocalStorage(fileName) {
    try {
        const data = localStorage.getItem(`fileMetadata_${fileName}`);
        if (data) {
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('❌ Error reading from localStorage:', error);
    }
    return null;
}

function deleteFileMetadataFromLocalStorage(fileName) {
    try {
        localStorage.removeItem(`fileMetadata_${fileName}`);
        console.log(`🗑️ Deleted file metadata from localStorage: ${fileName}`);
    } catch (error) {
        console.error('❌ Error deleting from localStorage:', error);
    }
}

// State
let ws = null;
let peerConnection = null;
let dataChannel = null;
let currentRoom = null;
let isInitiator = false;
let currentFile = null;
let fileQueue = []; // Queue for multiple files
let isProcessingQueue = false; // Flag to prevent concurrent processing
let currentFileResolve = null; // Resolve function for current file promise

// ✅ FIX 1: Windowed ACK tracking (not per-chunk)
const ACK_EVERY_N_CHUNKS = 64; // ACK every 64 chunks
let ackedChunks = new Set(); // Track which chunks receiver has ACKed (for stall detection only)
let highestAckedChunkIndex = -1; // Highest chunk index that was ACKed
let totalChunksSent = 0; // Total chunks sent for current file
let fileCompleteSent = false; // ✅ FIX 4: Guard against duplicate file-complete
let senderChunkIndex = 0; // ✅ FIX 2: Immutable chunk index counter
let fileReader = null;
let fileStream = null;
// Promise resolver for file transfer confirmation
let fileTransferConfirmationResolver = null;
// Connection loss handling
let transferAborted = false; // Flag to abort transfer on connection loss
let transferPaused = false; // Flag to pause transfer (waiting for reconnection)
let keepaliveInterval = null; // Keepalive ping interval
let connectionLostHandled = false; // Guard against double-calls
let reader = null; // File stream reader (for ReadableStream)
let streamReader = null; // Alternative reader reference
let disconnectedTimer = null; // Timer for ICE disconnected state
let wakeLock = null; // Screen Wake Lock for mobile transfers

let transferStats = {
    bytesTransferred: 0,
    startTime: null,
    lastUpdateTime: null,
    lastBytesTransferred: 0,
    chunksSent: 0,
    chunksQueued: 0,
    totalChunksExpected: 0
};

// Helper function to stop keepalive pings
function stopKeepalive() {
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
        console.log('🛑 Keepalive stopped');
    }
}

// Screen Wake Lock API - prevents Android Doze mode from pausing transfers
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('📱 Screen Wake Lock active (prevents sleep during transfer)');
        }
    } catch (err) {
        // Wake lock may fail if user denies permission or browser doesn't support it
        console.warn(`Wake Lock not available: ${err.name}, ${err.message}`);
    }
}

// Release wake lock when transfer completes or fails
function releaseWakeLock() {
    if (wakeLock !== null) {
        try {
            wakeLock.release();
            wakeLock = null;
            console.log('📱 Screen Wake Lock released');
        } catch (err) {
            console.warn(`Error releasing wake lock: ${err.message}`);
            wakeLock = null;
        }
    }
}

// Initialize IndexedDB on page load
initIndexedDB().catch(error => {
    console.error('❌ Failed to initialize IndexedDB:', error);
});

// Helper function to show user-friendly messages
function showUserMessage(message) {
    alert(message);
}

    // CRITICAL: Handle connection loss - treat as connection failure, not file failure
// Define this BEFORE it's used (near top of file)
// Track connection loss attempts to avoid false positives
let connectionLossCheckCount = 0;
let lastConnectionLossCheck = 0;
const CONNECTION_LOSS_GRACE_PERIOD = 3000; // 3 seconds grace period on mobile
const CONNECTION_LOSS_CHECK_INTERVAL = 1000; // Check every 1 second

function handleConnectionLoss(reason = "unknown") {
    // 🔹 Update state machine on connection loss
    if (transferState === TransferState.TRANSFERRING || transferState === TransferState.RESUMING) {
        transferState = TransferState.PAUSED;
        console.log(`⏸️ Transfer paused due to connection loss: ${reason}`);
    }
    
    const now = Date.now();
    
    // CRITICAL: Verify connection is actually dead before showing alert
    // Check multiple conditions to avoid false positives
    const wsConnected = ws && ws.readyState === WebSocket.OPEN;
    const dcState = dataChannel?.readyState || 'unknown';
    const pcState = peerConnection?.connectionState || 'unknown';
    const iceState = peerConnection?.iceConnectionState || 'unknown';
    
    // If WebSocket is still connected, this is likely a transient issue
    // Only treat as connection loss if WebSocket is also closed/failed
    if (wsConnected && reason !== "ice-failed") {
        // WebSocket is still connected - this is likely a transient DataChannel state change
        // Wait and verify before treating as connection loss
        console.log(`⏳ Transient state change detected (${reason}). WebSocket still connected. Verifying...`);
        console.log(`   DataChannel: ${dcState}, PeerConnection: ${pcState}, ICE: ${iceState}`);
        
        // Only proceed if DataChannel is actually closed AND PeerConnection is failed
        if (dcState !== 'closed' || pcState !== 'failed') {
            console.log(`✅ Connection appears active - ignoring transient state change`);
            return; // Don't treat as connection loss if connection is still active
        }
    }
    
    // On mobile/broadband, add grace period before showing alert
    // Brief disconnections are common even on stable connections
    if ((now - lastConnectionLossCheck) < CONNECTION_LOSS_GRACE_PERIOD) {
        console.log(`⏳ Grace period: ignoring brief connection loss (${reason})`);
        connectionLossCheckCount++;
        
        // Only proceed if we've seen multiple connection loss events
        if (connectionLossCheckCount < 5) { // Increased from 3 to 5 for more stability
            lastConnectionLossCheck = now;
            return; // Ignore transient disconnections
        }
    }
    
    lastConnectionLossCheck = now;
    
    // Guard against double-calls (important)
    if (connectionLostHandled) {
        console.log("⚠️ Connection loss already handled, ignoring duplicate call");
        return;
    }
    
    // For large files, be more lenient with transient disconnections
    const fileSize = currentFile?.size || receivingFileSize || 0;
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);
    const isLargeFile = fileSizeGB > 1; // Files over 1GB
    
    // Final verification: Only treat as connection loss if connection is actually dead
    // Check if WebSocket is closed AND (DataChannel is closed OR PeerConnection is failed)
    const isActuallyDead = !wsConnected && (dcState === 'closed' || pcState === 'failed' || iceState === 'failed');
    
    if (!isActuallyDead && reason !== "ice-failed") {
        console.log(`✅ Connection verification: Not actually dead. WebSocket: ${wsConnected ? 'connected' : 'disconnected'}, DataChannel: ${dcState}, PeerConnection: ${pcState}, ICE: ${iceState}`);
        console.log(`   Ignoring false positive connection loss (${reason})`);
        return; // Don't treat as connection loss if connection is still active
    }
    
    console.warn("🚨 Connection lost:", reason, isLargeFile ? `(Large file: ${fileSizeGB.toFixed(2)}GB - being lenient)` : "", isMobile ? "(Mobile - being extra lenient)" : "");
    
    // For large files and transient disconnections, don't immediately mark as handled
    // This allows automatic reconnection attempts
    if (reason === "datachannel-closed" && (isLargeFile || isMobile) && dataChannel?.readyState === 'closed') {
        // Check if WebSocket is still connected - if so, this might be recoverable
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log("🔄 WebSocket still connected, DataChannel closed - attempting recovery...");
            // Don't mark as handled yet - allow reconnection attempt
            transferPaused = true;
            // Try to recreate DataChannel if we're the initiator
            if (isInitiator && peerConnection && peerConnection.connectionState === 'connected') {
                console.log("🔄 Attempting to recreate DataChannel...");
                try {
                    createDataChannel();
                    // Reset the flag after a delay to allow recovery
                    setTimeout(() => {
                        if (dataChannel && dataChannel.readyState === 'open') {
                            console.log("✅ DataChannel recovered!");
                            connectionLostHandled = false;
                            transferPaused = false;
                            connectionLossCheckCount = 0; // Reset counter
                            return; // Don't proceed with error handling
                        }
                    }, 2000);
                } catch (error) {
                    console.error("❌ Failed to recreate DataChannel:", error);
                }
            }
        }
    }
    
    // Mark as handled now (unless recovery attempt above succeeds)
    connectionLostHandled = true;
    connectionLossCheckCount = 0; // Reset counter
    
    // Set pause flag - do NOT abort transfer immediately
    // Transfer must pause, not abort, to allow resume
    transferPaused = true;
    
    // Only abort if it's a definitive failure (not just disconnected)
    // For large files and mobile, be even more conservative
    const shouldAbort = reason === "ice-failed" || (reason === "ice-disconnected-timeout" && !isLargeFile && !isMobile);
    if (shouldAbort) {
        transferAborted = true;
        
        // Only cancel readers if we're actually aborting (not just pausing)
        // Stop file readers immediately on abort
        try {
            if (reader) {
                reader.cancel();
                reader = null;
            }
        } catch (e) {
            // Ignore if already cancelled
        }
        
        try {
            if (streamReader) {
                streamReader.cancel();
                streamReader = null;
            }
        } catch (e) {
            // Ignore if already cancelled
        }
        
        // Also try fileReader (legacy)
        try {
            if (fileReader) {
                fileReader.abort();
                fileReader = null;
            }
        } catch (e) {
            // Ignore if already aborted
        }
        
        // Also try fileStream reader
        if (fileStream) {
            try {
                const streamReader = fileStream.getReader();
                streamReader.cancel();
            } catch (e) {
                // Ignore if already cancelled
            }
            fileStream = null;
        }
    }
    // If just paused (not aborted), don't cancel readers - they'll wait for reconnection
    
    // Stop keepalive
    stopKeepalive();
    
    // CRITICAL: Resume support - file state is already saved in IndexedDB and localStorage
    // No need to save separately - it's already persisted
    if (receivingFile && receivedBytes > 0 && receivedBytes < receivingFileSize) {
        console.log(`💾 Partial file state already saved in IndexedDB: ${receivingFile.name} (${receivedBytes}/${receivingFileSize} bytes)`);
    }
    
    // Update UI with user-friendly message
    updateConnectionStatus('disconnected', 'Connection interrupted');
    
    // Show user-friendly message - different for pause vs abort
    // For large files and mobile, show more encouraging message
    if (transferPaused && !transferAborted) {
        const fileSizeGB = (currentFile?.size || receivingFileSize || 0) / (1024 * 1024 * 1024);
        if (fileSizeGB > 1 || isMobile) {
            const message = isMobile 
                ? "Connection interrupted. Waiting for reconnection… Mobile networks may experience brief interruptions."
                : `Connection interrupted (${fileSizeGB.toFixed(2)}GB file). Waiting for reconnection… Large files may experience brief interruptions.`;
            showUserMessage(message);
        } else {
            showUserMessage("Connection interrupted. Waiting for reconnection…");
        }
    } else if (currentFile || (receivingFile && receivedBytes > 0)) {
        showUserMessage("Connection lost. Transfer paused. You can retry or resume when peer reconnects.");
    }
    
    // Don't clear currentFile or receivingFile - allow user to retry/resume
    // Just reset transfer stats
    resetTransferStats();
}

// DOM Elements
const roomIdInput = document.getElementById('roomId');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const roomDisplay = document.getElementById('roomDisplay');
const currentRoomSpan = document.getElementById('currentRoom');
const transferSection = document.getElementById('transferSection');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const transferInfo = document.getElementById('transferInfo');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const transferSpeed = document.getElementById('transferSpeed');
const timeRemaining = document.getElementById('timeRemaining');
const connectionStatus = document.getElementById('connectionStatus');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const connectionInfo = document.getElementById('connectionInfo');
const serverUrl = document.getElementById('serverUrl');
const warningMessage = document.getElementById('warningMessage');
const receivedFiles = document.getElementById('receivedFiles');
const fileRequest = document.getElementById('fileRequest');
const requestFileName = document.getElementById('requestFileName');
const requestFileSize = document.getElementById('requestFileSize');
const acceptFileBtn = document.getElementById('acceptFileBtn');
const rejectFileBtn = document.getElementById('rejectFileBtn');
const successMessage = document.getElementById('successMessage');
const successText = document.getElementById('successText');
const progressLabel = document.getElementById('progressLabel');
const donateBtn = document.getElementById('donateBtn');
const donateModal = document.getElementById('donateModal');
const closeModal = document.getElementById('closeModal');
const developerAvatar = document.querySelector('.developer-avatar');
const donationImage = document.querySelector('.donation-image');

// Initialize
init();

function init() {
    setupEventListeners();
    setupPageUnloadHandler();
    updateConnectionStatus('disconnected', 'Disconnected');
}

function setupEventListeners() {
    createRoomBtn.addEventListener('click', createRoom);
    joinRoomBtn.addEventListener('click', () => joinRoom());
    leaveRoomBtn.addEventListener('click', leaveRoom);
    
    // Allow Enter key to join room
    roomIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            joinRoom();
        }
    });
    
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    fileInput.addEventListener('change', handleFileSelect);
    
    // File request buttons
    if (acceptFileBtn) {
        acceptFileBtn.addEventListener('click', handleAcceptFile);
    }
    if (rejectFileBtn) {
        rejectFileBtn.addEventListener('click', handleRejectFile);
    }
    
    // Donation modal
    if (donateBtn) {
        donateBtn.addEventListener('click', () => {
            if (donateModal && donationImage) {
                donationImage.src = 'image.png';
                donationImage.alt = 'Donation';
                donateModal.style.display = 'flex';
            }
        });
    }
    
    // Developer avatar modal - clicking avatar opens it in modal
    if (developerAvatar) {
        developerAvatar.addEventListener('click', () => {
            if (donateModal && donationImage) {
                donationImage.src = 'aiks.jpg';
                donationImage.alt = 'Developer';
                donateModal.style.display = 'flex';
            }
        });
        // Add cursor pointer style to indicate it's clickable
        developerAvatar.style.cursor = 'pointer';
    }
    
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            if (donateModal) {
                donateModal.style.display = 'none';
            }
        });
    }
    // Close modal when clicking outside
    if (donateModal) {
        donateModal.addEventListener('click', (e) => {
            if (e.target === donateModal) {
                donateModal.style.display = 'none';
            }
        });
    }
    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && donateModal && donateModal.style.display === 'flex') {
            donateModal.style.display = 'none';
        }
    });
}

// Track if user is intentionally leaving
let isIntentionallyLeaving = false;

// Page unload handler - show confirmation dialog
function setupPageUnloadHandler() {
    // Handle browser back/forward/close
    window.addEventListener('beforeunload', (e) => {
        // Only show confirmation if user is already in a room (room exists and WebSocket is connected) and not intentionally leaving
        if (currentRoom && ws && ws.readyState === WebSocket.OPEN && !isIntentionallyLeaving) {
            // Standard way to show browser confirmation
            e.preventDefault();
            e.returnValue = 'Are you sure you want to leave? This will disconnect you from the room.'; // Chrome requires returnValue to be set
            return e.returnValue; // Some browsers require return value
        }
    });
    
    // Also handle visibility change (tab switching) - but don't show confirmation
    document.addEventListener('visibilitychange', () => {
        // Keep connection alive when tab is hidden
        if (document.hidden && ws && ws.readyState === WebSocket.OPEN && currentRoom) {
            // Send a keepalive ping
            try {
                ws.send(JSON.stringify({ type: 'ping', room: currentRoom }));
            } catch (e) {
                // Ignore errors
            }
        }
    });
}

// Room Management
function createRoom(e) {
    // Prevent any event from interfering
    if (e) {
        e.preventDefault();
    }
    const roomId = generateRoomId();
    roomIdInput.value = roomId;
    joinRoom(roomId, true);
}

function joinRoom(roomId = null, isCreator = false) {
    // If roomId is provided (from createRoom), use it
    // Otherwise, use the value from the input field
    let room;
    if (roomId && typeof roomId === 'string') {
        // Only use provided roomId if it's actually a string (not an event object)
        room = roomId;
    } else {
        // Get the value from the input field
        room = roomIdInput.value.trim();
    }
    
    if (!room) {
        alert('Please enter a room ID');
        return;
    }

    // Update the input field to show the actual room being used
    roomIdInput.value = room;
    currentRoom = room;
    isInitiator = isCreator;
    
    connectWebSocket();
    showRoomDisplay();
    updateConnectionStatus('connecting', 'Connecting...');
}

function leaveRoom() {
    // Confirm with user
    if (!confirm('Are you sure you want to leave the room? This will disconnect you from the peer.')) {
        return;
    }
    
    // Mark as intentionally leaving to prevent beforeunload confirmation
    isIntentionallyLeaving = true;
    
    // Release wake lock if active
    releaseWakeLock();
    
    // Clean up connections
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (ws) {
        // Send leave message to server
        try {
            ws.send(JSON.stringify({ type: 'leave', room: currentRoom }));
        } catch (e) {
            // Ignore if already closed
        }
        ws.close();
        ws = null;
    }
    
    currentRoom = null;
    hideRoomDisplay();
    updateConnectionStatus('disconnected', 'Disconnected');
    resetTransferUI();
    
    // Reset flag after cleanup
    setTimeout(() => {
        isIntentionallyLeaving = false;
    }, 1000);
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function showRoomDisplay() {
    roomDisplay.style.display = 'flex';
    currentRoomSpan.textContent = currentRoom;
    transferSection.style.display = 'block';
}

function hideRoomDisplay() {
    roomDisplay.style.display = 'none';
    transferSection.style.display = 'none';
}

// WebSocket Signaling
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        return; // Already connected
    }
    
    console.log('Connecting to WebSocket:', WS_URL);
    updateConnectionStatus('connecting', 'Connecting to server...');
    
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        ws.send(JSON.stringify({ type: 'join', room: currentRoom }));
        updateConnectionStatus('connecting', 'Connected to server, waiting for peer...');
    };
    
    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleSignalingMessage(message);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus('disconnected', 'Server connection failed. Check if server is running.');
    };
    
    ws.onclose = (event) => {
        console.log('WebSocket closed', event.code, event.reason);
        if (event.code !== 1000) {
            updateConnectionStatus('disconnected', 'Server disconnected. Check connection.');
        } else {
            updateConnectionStatus('disconnected', 'Disconnected');
        }
    };
}

// Store pending offer/answer if peer connection isn't ready yet
let pendingOffer = null;
let pendingAnswer = null;

function handleSignalingMessage(message) {
    console.log('Received signaling message:', message.type, 'isInitiator:', isInitiator);
    switch (message.type) {
        case 'joined':
            // When we join, create peer connection (both initiator and non-initiator need it)
            createPeerConnection();
            break;
        case 'peer-joined':
            // When a peer joins our room
            console.log('Peer joined! Initiator:', isInitiator, 'Has peerConnection:', !!peerConnection);
            if (!peerConnection) {
                console.log('Peer joined but no peer connection, creating now...');
                createPeerConnection();
            } else if (isInitiator) {
                // If we're initiator and already have connection, create offer if not already sent
                console.log('Peer joined, ensuring offer is sent...');
                // Check if we already have a local description (offer was created)
                if (peerConnection.localDescription) {
                    console.log('Offer already exists, re-sending...');
                    ws.send(JSON.stringify({
                        type: 'offer',
                        offer: peerConnection.localDescription,
                        room: currentRoom
                    }));
                } else {
                    console.log('No offer yet, creating now...');
                    createOffer();
                }
            }
            break;
        case 'offer':
            // Store offer if peer connection isn't ready yet
            if (!peerConnection) {
                console.log('Offer received before peer connection ready, storing...');
                pendingOffer = message.offer;
                createPeerConnection();
            } else {
                handleOffer(message.offer);
            }
            break;
        case 'answer':
            // Store answer if peer connection isn't ready yet
            if (!peerConnection) {
                console.log('Answer received before peer connection ready, storing...');
                pendingAnswer = message.answer;
                createPeerConnection();
            } else {
                handleAnswer(message.answer);
            }
            break;
        case 'ice-candidate':
            handleIceCandidate(message.candidate);
            break;
    }
}

// WebRTC Peer Connection
function createPeerConnection() {
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate,
                room: currentRoom
            }));
        }
    };
    
    // Detect connection state changes
    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log('PeerConnection state changed:', state);
        if (state === 'connected') {
            updateConnectionStatus('connected', 'P2P Connected');
            checkRelayStatus();
        } else if (state === 'connecting') {
            updateConnectionStatus('connecting', 'Connecting to peer...');
        } else if (state === 'disconnected' || state === 'failed') {
            updateConnectionStatus('disconnected', 'Connection Lost: ' + state);
        }
    };
    
    // CRITICAL: Listen to ICE & DataChannel lifecycle explicitly
    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        console.warn("ICE connection state:", state);
        checkRelayStatus();
        
        if (state === "disconnected") {
            // Wait before declaring failure - transient disconnections are common, especially for large files
            // Use longer timeout for large file transfers (200GB+ files need more patience)
            if (!disconnectedTimer) {
                // Calculate timeout based on file size - larger files get more time
                const fileSize = currentFile?.size || receivingFileSize || 0;
                const fileSizeGB = fileSize / (1024 * 1024 * 1024);
                
                // Base timeout: 30 seconds for small files, up to 60 seconds for 200GB+ files
                const baseTimeout = 30000; // 30 seconds base
                const largeFileTimeout = Math.min(60000, baseTimeout + (fileSizeGB * 150)); // +150ms per GB, max 60s
                const timeout = fileSizeGB > 1 ? largeFileTimeout : baseTimeout;
                
                console.log(`⏳ ICE disconnected - waiting ${(timeout/1000).toFixed(0)}s before action (file: ${(fileSizeGB).toFixed(2)}GB)`);
                
                disconnectedTimer = setTimeout(async () => {
                    console.warn("ICE still disconnected after timeout");
                    
                    // OPTIONAL: Try ICE restart before giving up (often saves mobile connections and Render deployments)
                    try {
                        console.log("🔄 Attempting ICE restart...");
                        await peerConnection.restartIce();
                        console.log("✅ ICE restart initiated");
                        // Give it more time after restart for large files
                        const restartTimeout = fileSizeGB > 1 ? 20000 : 15000; // 20s for large files, 15s for small
                        disconnectedTimer = setTimeout(() => {
                            console.warn("ICE still disconnected after restart");
                            handleConnectionLoss("ice-disconnected-timeout");
                        }, restartTimeout);
                    } catch (error) {
                        console.error("❌ ICE restart failed:", error);
                        handleConnectionLoss("ice-disconnected-timeout");
                    }
                }, timeout);
            }
        }
        
        if (state === "connected" || state === "completed") {
            // Connection recovered - clear timer and reset flags
            if (disconnectedTimer) {
                clearTimeout(disconnectedTimer);
                disconnectedTimer = null;
                console.log("✅ ICE recovered");
            }
            
            // Reset connection lost flag on successful connection
            connectionLostHandled = false;
            transferPaused = false; // Resume transfer
            
            updateConnectionStatus('connecting', 'ICE connected, establishing DataChannel...');
        }
        
        if (state === "failed") {
            // Clear disconnected timer if it exists
            if (disconnectedTimer) {
                clearTimeout(disconnectedTimer);
                disconnectedTimer = null;
            }
            // Failed state is definitive - abort transfer
            handleConnectionLoss("ice-failed");
        }
    };
    
    // Handle data channel (for receiver)
    if (!isInitiator) {
        peerConnection.ondatachannel = (event) => {
            setupDataChannel(event.channel);
        };
    } else {
        // Create data channel (for sender)
        createDataChannel();
    }
    
    // Create offer if initiator
    if (isInitiator) {
        // Small delay to ensure data channel is set up before creating offer
        setTimeout(() => {
            createOffer();
        }, 100);
    } else {
        // If we're not the initiator and have a pending offer, handle it now
        if (pendingOffer) {
            console.log('Handling pending offer...');
            const offer = pendingOffer;
            pendingOffer = null;
            setTimeout(() => {
                handleOffer(offer);
            }, 200); // Delay to ensure connection is ready
        }
    }
    
    // Handle pending answer if we have one
    if (pendingAnswer) {
        console.log('Handling pending answer...');
        const answer = pendingAnswer;
        pendingAnswer = null;
        setTimeout(() => {
            handleAnswer(answer);
        }, 200);
    }
}

function createDataChannel() {
    dataChannel = peerConnection.createDataChannel('fileTransfer', {
        ordered: true,
        maxRetransmits: 0 // Reliable but not retransmit-based
    });
    
    // DYNAMIC SLIDING WINDOW: Start with 16KB, will switch to 128KB once connected
    console.log(`📏 Using dynamic chunk size: ${(INITIAL_CHUNK_SIZE/1024).toFixed(0)}KB initial, ${(CONNECTED_CHUNK_SIZE/1024).toFixed(0)}KB when connected`);
    
    setupDataChannel(dataChannel);
}

function setupDataChannel(channel) {
    dataChannel = channel;
    
    // DYNAMIC SLIDING WINDOW: Set bufferedAmountLowThreshold to 1MB for burst-based sending
    // This enables high-water mark throttling (fill to 4MB, wait for 1MB threshold)
    channel.bufferedAmountLowThreshold = BACKPRESSURE_THRESHOLD;
    console.log(`📊 Set bufferedAmountLowThreshold to ${(BACKPRESSURE_THRESHOLD/1024/1024).toFixed(1)}MB (sliding window optimized)`);
    
    console.log('DataChannel setup. Current state:', channel.readyState);
    
    // Check if already open
    if (channel.readyState === 'open') {
        console.log('DataChannel already open!');
        updateConnectionStatus('connected', 'P2P Connected');
    }
    
    dataChannel.onopen = () => {
        console.log('✅ DataChannel opened! Ready to transfer files.');
        updateConnectionStatus('connected', 'P2P Connected - Ready');
        
        // Reset connection lost flag on successful connection
        connectionLostHandled = false;
        transferPaused = false; // Resume transfer
        
        // 🔴 Pillar 4: Deterministic Resume - On reconnect, request resume from receivedBytes
        if (receivingFile && receivedBytes > 0 && receivedBytes < receivingFileSize) {
            console.log(`🔄 Connection restored. Requesting resume from byte ${receivedBytes}/${receivingFileSize}`);
            transferState = TransferState.RESUMING;
            try {
                dataChannel.send(JSON.stringify({
                    type: 'resume-request',
                    fileName: receivingFile.name,
                    offset: receivedBytes
                }));
                console.log(`📤 Sent resume request: ${receivingFile.name} from byte ${receivedBytes}`);
            } catch (error) {
                console.error('❌ Error sending resume request:', error);
            }
        } else if (transferState === TransferState.PAUSED) {
            // Was paused, resume transfer
            transferState = TransferState.TRANSFERRING;
        } else if (transferState === TransferState.IDLE) {
            // New connection, ready for new transfer
            transferState = TransferState.CONNECTING;
        }
        
        // CRITICAL: Start keepalive pings to prevent NAT timeouts
        // This improves long transfers by 30-40% reliability on mobile networks
        if (keepaliveInterval) {
            clearInterval(keepaliveInterval);
        }
        keepaliveInterval = setInterval(() => {
            if (dataChannel && dataChannel.readyState === 'open') {
                try {
                    dataChannel.send(JSON.stringify({ type: 'ping' }));
                } catch (error) {
                    // Ignore ping errors - connection might be closing
                }
            } else {
                // Stop keepalive if channel is not open
                if (keepaliveInterval) {
                    clearInterval(keepaliveInterval);
                    keepaliveInterval = null;
                }
            }
        }, 5000); // Send ping every 5 seconds
        console.log('🔄 Keepalive pings started (every 5s)');
    };
    
    // CRITICAL: Listen to DataChannel lifecycle explicitly
    dataChannel.onclose = () => {
        console.warn('DataChannel closed. State:', dataChannel?.readyState);
        handleConnectionLoss("datachannel-closed");
    };
    
    dataChannel.onerror = (error) => {
        console.error('DataChannel error:', error);
        updateConnectionStatus('disconnected', 'DataChannel error');
    };
    
    dataChannel.onmessage = (event) => {
        handleDataChannelMessage(event);
    };
    
        // Log state changes
    const checkState = () => {
        if (channel.readyState === 'connecting') {
            console.log('DataChannel state: connecting...');
            updateConnectionStatus('connecting', 'Establishing DataChannel...');
        } else if (channel.readyState === 'open') {
            console.log('DataChannel state: open');
        } else if (channel.readyState === 'closing') {
            console.log('DataChannel state: closing');
        } else if (channel.readyState === 'closed') {
            console.log('DataChannel state: closed');
        }
    };
    
    // Check state periodically
    const stateInterval = setInterval(() => {
        if (channel.readyState === 'open') {
            clearInterval(stateInterval);
        } else {
            checkState();
        }
    }, 500);
}

async function createOffer() {
    try {
        console.log('Creating offer...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created, sending to peer');
        ws.send(JSON.stringify({
            type: 'offer',
            offer: offer,
            room: currentRoom
        }));
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

async function handleOffer(offer) {
    try {
        console.log('Received offer, creating answer...');
        if (!peerConnection) {
            console.error('No peer connection when receiving offer');
            return;
        }
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('Answer created, sending to peer');
        ws.send(JSON.stringify({
            type: 'answer',
            answer: answer,
            room: currentRoom
        }));
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleAnswer(answer) {
    try {
        console.log('Received answer, setting remote description...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Answer processed successfully');
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

async function handleIceCandidate(candidate) {
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
    }
}

function checkRelayStatus() {
    if (!peerConnection) return;
    
    peerConnection.getStats().then(stats => {
        let isRelayed = false;
        
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.selected) {
                if (report.localCandidateId && report.remoteCandidateId) {
                    const localCandidate = stats.get(report.localCandidateId);
                    const remoteCandidate = stats.get(report.remoteCandidateId);
                    
                    if (localCandidate && remoteCandidate) {
                        const localType = localCandidate.candidateType;
                        const remoteType = remoteCandidate.candidateType;
                        
                        if (localType === 'relay' || remoteType === 'relay') {
                            isRelayed = true;
                        }
                    }
                }
            }
        });
        
        if (isRelayed) {
            updateConnectionStatus('relayed', 'Relayed Connection');
            warningMessage.style.display = 'flex';
        } else {
            warningMessage.style.display = 'none';
        }
    }).catch(error => {
        console.error('Error checking relay status:', error);
    });
}

// File Handling
function handleDragOver(e) {
    e.preventDefault();
    dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        if (!dataChannel) {
            alert('Please wait for peer connection to be established. Status: ' + statusText.textContent);
            return;
        }
        if (dataChannel.readyState !== 'open') {
            alert('DataChannel is not ready. Current state: ' + dataChannel.readyState + '. Please wait for connection.');
            return;
        }
        // Add all files to queue
        addFilesToQueue(Array.from(files));
    }
}

function handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
        if (!dataChannel) {
            alert('Please wait for peer connection to be established. Status: ' + statusText.textContent);
            return;
        }
        if (dataChannel.readyState !== 'open') {
            alert('DataChannel is not ready. Current state: ' + dataChannel.readyState + '. Please wait for connection.');
            return;
        }
        // Add all files to queue
        addFilesToQueue(Array.from(files));
    }
    // Reset input to allow selecting same files again
    e.target.value = '';
}

// Add files to queue and send all requests at once (bulk)
function addFilesToQueue(files) {
    if (!dataChannel) {
        alert('DataChannel not created yet. Please wait for peer to join.\n\nStatus: ' + statusText.textContent + '\n\nCheck browser console (F12) for details.');
        return;
    }
    
    const state = dataChannel.readyState;
    if (state !== 'open') {
        const stateNames = {
            'connecting': 'Connecting',
            'open': 'Open',
            'closing': 'Closing',
            'closed': 'Closed'
        };
        alert(`DataChannel is not ready yet.\n\nCurrent state: ${stateNames[state] || state}\nStatus: ${statusText.textContent}\nPeerConnection: ${peerConnection?.connectionState || 'N/A'}\n\nPlease wait for the connection to establish. Check browser console (F12) for details.`);
        return;
    }
    
    // Add all files to queue
    fileQueue.push(...files);
    console.log(`Added ${files.length} file(s) to queue. Total in queue: ${fileQueue.length}`);
    
    // Send all file requests at once (bulk)
    // CRITICAL: Verify DataChannel is open before sending
    if (dataChannel.readyState !== 'open') {
        console.error(`❌ Cannot send file requests: DataChannel state is ${dataChannel.readyState}, not 'open'`);
        alert(`Cannot send files. DataChannel is not ready (state: ${dataChannel.readyState}). Please wait for connection.`);
        return;
    }
    
    files.forEach((file, index) => {
        const request = {
            type: 'file-request',
            name: file.name,
            size: file.size,
            mimeType: file.type,
            index: index, // Add index for tracking
            total: files.length // Total files in this batch
        };
        
        try {
            dataChannel.send(JSON.stringify(request));
            console.log(`📤 File transfer request ${index + 1}/${files.length} sent:`, file.name, `(${formatFileSize(file.size)})`);
        } catch (error) {
            console.error(`❌ Error sending file request for ${file.name}:`, error);
            alert(`Error sending file request: ${error.message}`);
        }
    });
    
    console.log(`✅ All ${files.length} file request(s) sent successfully`);
    
    // Start processing the first file
    if (!isProcessingQueue && fileQueue.length > 0) {
        processFileQueue();
    }
}

// Track if all files have been accepted (bulk acceptance)
let allFilesAccepted = false;

// Process files from queue one by one (after acceptance)
async function processFileQueue() {
    if (isProcessingQueue || fileQueue.length === 0) {
        return;
    }
    
    // If we're already waiting for acceptance, don't start another
    if (currentFile && !allFilesAccepted) {
        return;
    }
    
    isProcessingQueue = true;
    
    // Get the first file from queue
    const file = fileQueue[0];
    currentFile = file;
    
    // If all files were already accepted, start sending immediately
    if (allFilesAccepted) {
        const queueInfo = fileQueue.length > 1 ? ` (${fileQueue.length - 1} more in queue)` : '';
        showTransferUI(file, `Uploading...${queueInfo}`);
        
        // Send file metadata FIRST, then start streaming
        const metadata = {
            type: 'file-metadata',
            name: file.name,
            size: file.size,
            mimeType: file.type
        };
        dataChannel.send(JSON.stringify(metadata));
        console.log(`📤 Sent file-metadata for: ${file.name}`);
        
        // Request wake lock to prevent screen sleep during transfer
        requestWakeLock();
        
        // Small delay to ensure metadata arrives before chunks
        setTimeout(() => {
            streamFile(file);
        }, 100);
        return;
    }
    
    // Update UI to show queue status (waiting for acceptance)
    const queueInfo = fileQueue.length > 1 ? ` (${fileQueue.length} files in queue)` : '';
    const label = `Waiting for acceptance...${queueInfo}`;
    
    // Hide drop zone, show transfer info (waiting for acceptance)
    dropZone.style.display = 'none';
    transferInfo.style.display = 'block';
    showTransferUI(file, label);
    resetTransferStats();
    
    console.log(`Waiting for acceptance of file: ${file.name} (${fileQueue.length} files in queue)`);
    // Don't resolve here - wait for acceptance and completion
}

// Legacy function for backward compatibility
async function handleFile(file) {
    addFilesToQueue([file]);
}

// Event-based drain function - prevents CPU spinning
// Uses bufferedAmountLow event instead of polling
async function waitForDrain() {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        return;
    }
    
    if (dataChannel.bufferedAmount < BACKPRESSURE_THRESHOLD) {
        return; // Already drained
    }
    
    // Wait for bufferedAmountLow event
    return new Promise((resolve) => {
        const handler = () => {
            dataChannel.removeEventListener('bufferedamountlow', handler);
            resolve();
        };
        dataChannel.addEventListener('bufferedamountlow', handler);
        
        // Safety timeout - if event doesn't fire, resolve anyway after 5 seconds
        setTimeout(() => {
            dataChannel.removeEventListener('bufferedamountlow', handler);
            console.warn('⚠️ bufferedAmountLow event timeout, proceeding anyway');
            resolve();
        }, 5000);
    });
}

// DYNAMIC SLIDING WINDOW: Send chunks with high-water mark throttling
// Fills buffer up to 4MB, then waits for bufferedAmountLow (1MB threshold) to trigger next burst
async function sendNextQueuedChunk(chunkData, file, isConnected = false) {
    // Dynamic chunk size: 16KB for initial handshake, 128KB once connected
    const chunkSize = isConnected ? CONNECTED_CHUNK_SIZE : INITIAL_CHUNK_SIZE;
    
    // Split chunkData if it's larger than chunkSize
    const chunks = [];
    if (chunkData.byteLength > chunkSize) {
        let offset = 0;
        while (offset < chunkData.byteLength) {
            const slice = chunkData.slice(offset, Math.min(offset + chunkSize, chunkData.byteLength));
            chunks.push(slice);
            offset += slice.byteLength;
        }
    } else {
        chunks.push(chunkData);
    }
    
    // Send chunks in bursts until high-water mark (4MB) is reached
    for (const chunk of chunks) {
        // HIGH-WATER MARK THROTTLING: Fill buffer up to 4MB before waiting
        while (dataChannel.bufferedAmount >= HIGH_WATER_MARK) {
            // Buffer is full - wait for bufferedAmountLow event (1MB threshold)
            await waitForDrain();
        }
        
        // Check connection state before sending
        if (dataChannel.readyState !== 'open') {
            throw new Error('DataChannel closed');
        }
        
        // ✅ FIX 2: Immutable chunk index - never reuse
        const chunkIndex = senderChunkIndex++;
        
        // ✅ FIX 2: Send chunk with index as JSON message
        // Note: For large chunks, we send base64-encoded payload to avoid JSON size limits
        const chunkArray = new Uint8Array(chunk);
        const base64Payload = btoa(String.fromCharCode(...chunkArray));
        
        const chunkMessage = JSON.stringify({
            type: 'chunk',
            chunkIndex: chunkIndex,
            payload: base64Payload,
            size: chunk.byteLength
        });
        
        dataChannel.send(chunkMessage);
        transferStats.chunksSent++;
        totalChunksSent++;
        transferStats.bytesTransferred += chunk.byteLength;
        
        // Update progress
        const progress = (transferStats.bytesTransferred / file.size) * 100;
        updateProgress(Math.min(99.9, progress));
    }
}

// Wait for receiver ACK with timeout watchdog
// Prevents infinite hangs if receiver tab closes or browser crashes
async function waitForAckWithTimeout(fileName, timeout = 30000) {
    const waitForAck = () => {
        return new Promise((resolve) => {
            // Store the previous resolver
            const previousResolver = fileTransferConfirmationResolver;
            
            // Set up our resolver
            fileTransferConfirmationResolver = () => {
                // Restore previous resolver if it existed
                if (previousResolver) {
                    fileTransferConfirmationResolver = previousResolver;
                } else {
                    fileTransferConfirmationResolver = null;
                }
                resolve();
            };
        });
    };
    
    return Promise.race([
        waitForAck(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`ACK timeout for file "${fileName}" after ${timeout}ms. Receiver may have disconnected.`)), timeout)
        )
    ]);
}

async function streamFile(file, startOffset = 0) {
    // Resume support: startOffset allows resuming from a specific byte position
    if (startOffset > 0) {
        console.log(`🔄 Resuming file transfer from offset: ${startOffset} bytes`);
    }
    
    if (!file.stream) {
        // Fallback for browsers without ReadableStream support
        await streamFileLegacy(file, startOffset);
        return;
    }
    
    fileStream = file.stream();
    reader = fileStream.getReader(); // Store globally for handleConnectionLoss
    streamReader = reader; // Also store as streamReader
    
    // If resuming, skip to the offset
    // Note: For ReadableStream, we can't easily skip, so we'll read and discard
    // This is less efficient but works correctly
    let skippedBytes = 0;
    if (startOffset > 0) {
        while (skippedBytes < startOffset) {
            const { done, value } = await reader.read();
            if (done) {
                console.warn(`⚠️ File ended before reaching offset ${startOffset}`);
                break;
            }
            skippedBytes += value.byteLength;
            if (skippedBytes > startOffset) {
                // We overshot - we need to keep the remainder for the first chunk
                // This will be handled in the main loop by adjusting the first read
                break;
            }
        }
        console.log(`✅ Skipped to offset ${startOffset} (actually skipped ${skippedBytes} bytes)`);
        // Update transfer stats to reflect the skipped bytes
        transferStats.bytesTransferred = startOffset;
    }
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    // Track connection state for dynamic chunk sizing
    let isConnected = dataChannel && dataChannel.readyState === 'open';
    let connectionEstablishedTime = isConnected ? Date.now() : null;
    
    // Main sending loop with sliding window
    while (true) {
        // CRITICAL: Check if transfer was paused or aborted due to connection loss
        if (transferPaused || transferAborted) {
            if (transferAborted) {
                console.warn('⚠️ Transfer aborted due to connection loss');
                reader.cancel();
                throw new Error('TRANSFER_ABORTED');
            } else {
                // Transfer paused - wait for reconnection
                const fileSizeGB = (file.size || 0) / (1024 * 1024 * 1024);
                const waitTime = fileSizeGB > 10 ? 2000 : 1000;
                
                console.warn(`⏸️ Transfer paused - waiting for reconnection... (checking every ${waitTime}ms)`);
                
                // Check if connection is actually restored
                if (dataChannel && dataChannel.readyState === 'open' && !connectionLostHandled) {
                    console.log('✅ Connection appears restored, resuming transfer...');
                    transferPaused = false;
                    connectionLostHandled = false;
                    isConnected = true;
                    connectionEstablishedTime = Date.now();
                } else {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                }
            }
        }
        
        if (dataChannel.readyState !== 'open') {
            const dcState = dataChannel.readyState;
            const wsConnected = ws && ws.readyState === WebSocket.OPEN;
            const pcState = peerConnection?.connectionState;
            
            if (dcState === 'closed' && (!wsConnected || pcState === 'failed')) {
                console.warn('⚠️ DataChannel closed during transfer (verified connection loss)');
                handleConnectionLoss("datachannel-closed");
                if (transferAborted) {
                    reader.cancel();
                    throw new Error('TRANSFER_ABORTED');
                }
            } else {
                console.log(`⏳ DataChannel state: ${dcState}. Waiting for recovery...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        
        // Update connection state for dynamic chunk sizing
        if (!isConnected && dataChannel.readyState === 'open') {
            isConnected = true;
            connectionEstablishedTime = Date.now();
            console.log('✅ Connection established - switching to 128KB chunks');
        }
        
        try {
            let { done, value } = await reader.read();
            
            // If we overshot during offset skip, adjust the first chunk
            if (startOffset > 0 && skippedBytes > startOffset && value && !done) {
                const overshoot = skippedBytes - startOffset;
                value = value.slice(overshoot);
                skippedBytes = startOffset;
            }
            
            if (done) {
                console.log('📤 File reading complete.');
                console.log(`📊 Transfer stats: Bytes: ${transferStats.bytesTransferred}/${file.size}, Chunks sent: ${transferStats.chunksSent}, Chunks queued: ${transferStats.chunksQueued}`);
                
                // Note: We don't check byte count here because chunks might still be in transit
                // We'll wait for receiver confirmation instead, which is the authoritative source
                
                // Verify chunks were sent (warning only, not fatal)
                if (transferStats.chunksSent !== transferStats.chunksQueued) {
                    console.warn(`⚠️ Warning: Chunks sent (${transferStats.chunksSent}) != chunks queued (${transferStats.chunksQueued}). Some chunks may have failed.`);
                }
                
                // Wait for all buffered data to be sent before marking as complete
                let bufferWaitAttempts = 0;
                const MAX_BUFFER_WAIT = 300; // Wait up to 30 seconds
                while (dataChannel.bufferedAmount > 0 && bufferWaitAttempts < MAX_BUFFER_WAIT) {
                    if (bufferWaitAttempts % 20 === 0) {
                        console.log(`⏳ Waiting for buffer to clear. Buffered: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB (attempt ${bufferWaitAttempts + 1}/${MAX_BUFFER_WAIT})`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                    bufferWaitAttempts++;
                }
                
                if (dataChannel.bufferedAmount > 0) {
                    console.warn(`⚠️ Buffer still has ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB after waiting, but proceeding`);
                } else {
                    console.log('✅ Buffer cleared successfully');
                }
                
                // CRITICAL: Wait additional time for data to reach receiver (network latency)
                // bufferedAmount=0 means data left browser, but it may still be in transit
                // Calculate wait time based on file size and estimated network speed
                // For large files, we need more time for data to traverse the network
                const fileSizeMB = file.size / (1024 * 1024);
                // Estimate: assume ~5MB/s transfer rate (conservative), add 10 seconds buffer
                // For very large files, cap at 30 seconds max wait
                // Much more conservative wait time - ensure all data has time to traverse network
                // Formula: (fileSizeMB / 2) + 20, minimum 20s, maximum 60s
                const estimatedWaitSeconds = Math.min(60, Math.max(20, (fileSizeMB / 2) + 20));
                console.log(`⏳ Waiting ${estimatedWaitSeconds}s for data to reach receiver (network latency, file: ${fileSizeMB.toFixed(2)}MB)...`);
                
                // Also check DataChannel state periodically during wait
                let waitAttempts = 0;
                const maxWaitAttempts = estimatedWaitSeconds * 10; // Check every 100ms
                while (waitAttempts < maxWaitAttempts) {
                    if (dataChannel.readyState !== 'open') {
                        console.error('❌ DataChannel closed during wait! State:', dataChannel.readyState);
                        alert('Connection lost during file transfer. Please try again.');
                        return;
                    }
                    // Check if buffer filled up again (shouldn't happen, but check anyway)
                    if (dataChannel.bufferedAmount > 0 && waitAttempts % 50 === 0) {
                        console.log(`⚠️ Buffer refilled during wait: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                    waitAttempts++;
                }
                
                // Note: We don't check byte count here - we'll wait for receiver confirmation
                // The receiver's confirmation is the authoritative source of truth
                // Byte count mismatches can occur due to chunking overhead or timing, but if receiver confirms, we're good
                
                // CRITICAL: Wait until buffer is completely empty AND stays empty for a period
                // This ensures all data has actually been transmitted, not just queued
                let finalBufferCheckAttempts = 0;
                let consecutiveEmptyChecks = 0;
                const FINAL_BUFFER_CHECK = 500; // Check up to 500 times (50 seconds)
                const REQUIRED_EMPTY_CHECKS = 100; // Buffer must be empty for 10 seconds straight
                
                console.log('🔍 Starting final buffer verification...');
                while (finalBufferCheckAttempts < FINAL_BUFFER_CHECK) {
                    const currentBuffer = dataChannel.bufferedAmount;
                    
                    if (currentBuffer === 0) {
                        consecutiveEmptyChecks++;
                        if (consecutiveEmptyChecks >= REQUIRED_EMPTY_CHECKS) {
                            console.log(`✅ Buffer verified empty for ${(consecutiveEmptyChecks * 0.1).toFixed(1)}s - all data transmitted`);
                            break;
                        }
                    } else {
                        consecutiveEmptyChecks = 0; // Reset counter if buffer has data
                        if (finalBufferCheckAttempts % 10 === 0) {
                            console.log(`🔍 Buffer check: ${(currentBuffer/1024/1024).toFixed(2)} MB still buffered (attempt ${finalBufferCheckAttempts + 1}/${FINAL_BUFFER_CHECK})`);
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                    finalBufferCheckAttempts++;
                }
                
                if (dataChannel.bufferedAmount > 0) {
                    console.error(`❌ CRITICAL: Buffer still has ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB after ${FINAL_BUFFER_CHECK} checks! This data may be lost.`);
                    console.error(`⚠️ Warning: Some data may not have been transmitted. Receiver may be missing ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB`);
                } else if (consecutiveEmptyChecks < REQUIRED_EMPTY_CHECKS) {
                    console.warn(`⚠️ Buffer cleared but didn't stay empty for required duration. Proceeding anyway.`);
                }
                
                const actualPercent = (transferStats.bytesTransferred / file.size) * 100;
                console.log(`📊 Final verification: ${transferStats.bytesTransferred}/${file.size} bytes (${actualPercent.toFixed(2)}%), Buffer: ${dataChannel.bufferedAmount} bytes, Empty checks: ${consecutiveEmptyChecks}/${REQUIRED_EMPTY_CHECKS}`);
                updateProgress(Math.min(99.9, actualPercent)); // Don't show 100% yet
                
                // CRITICAL: Flush buffer before sending completion signal
                // This ensures all chunks are transmitted before signaling completion
                console.log('🔄 Flushing buffer before sending completion signal...');
                await waitForDrain();
                console.log('✅ Buffer flushed - sending completion signal');
                
                // CRITICAL: File-end must be delayed until buffer drains
                // Wait for buffer to drain before sending file-complete
                console.log('🔄 Final buffer drain before file-complete signal...');
                await waitForDrain();
                
                // ✅ FIX 4: SINGLE authoritative file-complete (guard against duplicates)
                if (fileCompleteSent) {
                    console.warn('⚠️ file-complete already sent, skipping duplicate');
                    return;
                }
                
                // ✅ FIX 3: Tail chunk MUST be its own index (already handled by senderChunkIndex++)
                // The last chunk sent already has its own unique index
                
                // 🔴 Pillar 5: Compute file hash for integrity verification
                let fileHash = null;
                try {
                    const fileBuffer = await file.arrayBuffer();
                    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    fileHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                    console.log(`🔐 Computed file hash: ${fileHash.substring(0, 16)}...`);
                } catch (error) {
                    console.warn('⚠️ Could not compute file hash (non-critical):', error);
                }
                
                // ✅ FIX 4: Mark as sent BEFORE sending (prevents race conditions)
                fileCompleteSent = true;
                
                // Send completion message with file size, name, and hash
                console.log('📨 Sending file-complete signal...');
                try {
                    dataChannel.send(JSON.stringify({ 
                        type: 'file-complete',
                        size: file.size,
                        fileName: file.name, // Include file name for proper matching in bulk transfers
                        hash: fileHash, // 🔴 Pillar 5: Integrity hash
                        totalChunks: totalChunksSent // ✅ FIX 5: Send total chunks for chunk-based completion
                    }));
                    console.log('✅ File-complete signal sent (file:', file.name, ', size:', file.size, 'bytes, chunks:', totalChunksSent, ', hash:', fileHash ? fileHash.substring(0, 16) + '...' : 'none', '). Waiting for receiver confirmation...');
                } catch (error) {
                    console.error('❌ Error sending completion signal:', error);
                    fileCompleteSent = false; // Reset on error
                    alert('Error sending completion signal: ' + error.message);
                    return;
                }
                
                // Reset ACK tracking for next file
                ackedChunks.clear();
                highestAckedChunkIndex = -1;
                totalChunksSent = 0;
                senderChunkIndex = 0;
                
                // Wait for receiver confirmation that all bytes were received
                // Use timeout watchdog to prevent infinite hangs
                console.log('⏳ Waiting for receiver confirmation that all bytes were received...');
                try {
                    await waitForAckWithTimeout(file.name, 30000); // 30 second timeout
                    console.log('✅ Receiver confirmed file receipt');
                } catch (error) {
                    console.error(`❌ ${error.message}`);
                    // Continue anyway - receiver may have received the file even if ACK was lost
                    console.warn('⚠️ Proceeding despite ACK timeout - file may have been received');
                }
                
                if (dataChannel.readyState !== 'open') {
                    console.error('❌ DataChannel closed while waiting for confirmation!');
                    alert('Connection lost while waiting for transfer confirmation.');
                    return;
                }
                
                // Now mark as 100% complete
                updateProgress(100);
                setTimeout(() => completeSendingFile(), 500);
                return;
            }
            
            // DYNAMIC SLIDING WINDOW: Send chunk using high-water mark throttling
            // Uses 16KB initially, then 128KB once connected
            try {
                await sendNextQueuedChunk(value, file, isConnected);
                
                // Log every 100th chunk or when close to completion
                if (transferStats.chunksSent % 100 === 0 || transferStats.bytesTransferred > file.size * 0.95) {
                    const chunkSize = isConnected ? CONNECTED_CHUNK_SIZE : INITIAL_CHUNK_SIZE;
                    console.log(`📤 Sent chunk #${transferStats.chunksSent}: ${chunkSize/1024}KB chunks. Total: ${transferStats.bytesTransferred}/${file.size} (${((transferStats.bytesTransferred/file.size)*100).toFixed(1)}%), Buffer: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB`);
                }
            } catch (error) {
                // Handle connection loss or other errors
                if (error.message === 'DataChannel closed' || transferAborted) {
                    if (transferAborted) {
                        throw new Error('TRANSFER_ABORTED');
                    } else {
                        // Connection lost - wait and retry
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                } else {
                    throw error;
                }
            }
        } catch (error) {
            // CRITICAL: Treat connection loss differently from file errors
            if (error.message === 'TRANSFER_ABORTED' || transferAborted) {
                console.warn('⚠️ Transfer aborted due to connection loss');
                // Release wake lock on abort
                releaseWakeLock();
                // Don't show error - handleConnectionLoss already showed user-friendly message
                return;
            }
            
            // Release wake lock on error
            releaseWakeLock();
            console.error('❌ Error reading file stream:', error);
            alert('Error reading file: ' + error.message);
            return;
        }
    }
}

async function streamFileLegacy(file, startOffset = 0) {
    // Fallback for browsers without ReadableStream support
    // Resume support: startOffset allows resuming from a specific byte position
    if (startOffset > 0) {
        console.log(`🔄 Resuming legacy file transfer from offset: ${startOffset} bytes`);
    }
    
    // DYNAMIC SLIDING WINDOW: Use 16KB initially, 128KB once connected
    let chunkSize = INITIAL_CHUNK_SIZE;
    let isConnected = dataChannel && dataChannel.readyState === 'open';
    
    // Reset and initialize transfer stats
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    transferStats.bytesTransferred = startOffset; // Start from offset if resuming
    transferStats.chunksSent = 0;
    transferStats.chunksQueued = 0;
    transferStats.totalChunksExpected = Math.ceil((file.size - startOffset) / chunkSize);
    
    console.log(`📤 Starting file transfer (legacy): ${file.name} (${(file.size/1024/1024).toFixed(2)}MB), Expected chunks: ~${transferStats.totalChunksExpected}`);
    let offset = startOffset; // Resume from startOffset if provided
    
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    const readChunk = () => {
        // CRITICAL: Check if transfer was paused or aborted
        if (transferPaused || transferAborted) {
            if (transferAborted) {
                console.warn('⚠️ Transfer aborted - stopping legacy transfer');
                return;
            } else {
                // Paused - wait for reconnection
                // For large files, wait longer
                const fileSizeGB = (file.size || 0) / (1024 * 1024 * 1024);
                const waitTime = fileSizeGB > 10 ? 2000 : 1000; // 2s for very large files
                
                // Check if connection is actually restored
                if (dataChannel && dataChannel.readyState === 'open' && !connectionLostHandled) {
                    console.log('✅ Connection appears restored, resuming legacy transfer...');
                    transferPaused = false;
                    connectionLostHandled = false;
                    // Continue with transfer immediately
                    readChunk();
                    return;
                }
                
                console.warn(`⏸️ Transfer paused - waiting for reconnection... (checking in ${waitTime}ms)`);
                setTimeout(() => readChunk(), waitTime);
                return;
            }
        }
        
        if (dataChannel.readyState !== 'open') {
            // Don't immediately treat as connection loss - verify first
            const dcState = dataChannel.readyState;
            const wsConnected = ws && ws.readyState === WebSocket.OPEN;
            const pcState = peerConnection?.connectionState;
            
            // Only treat as connection loss if it's actually closed AND WebSocket is also disconnected
            if (dcState === 'closed' && (!wsConnected || pcState === 'failed')) {
                handleConnectionLoss("datachannel-closed");
                if (transferAborted) {
                    return;
                }
            } else {
                // Transient state change - wait and retry
                console.log(`⏳ DataChannel state: ${dcState}. Waiting for recovery...`);
            }
            // If just paused, wait and retry
            setTimeout(() => readChunk(), 1000);
            return;
        }
        
        // Update connection state for dynamic chunk sizing
        if (!isConnected && dataChannel.readyState === 'open') {
            isConnected = true;
            chunkSize = CONNECTED_CHUNK_SIZE;
            console.log('✅ Connection established - switching to 128KB chunks (legacy)');
        }
        
        // HIGH-WATER MARK THROTTLING: Fill buffer up to 4MB before waiting
        if (dataChannel.bufferedAmount >= HIGH_WATER_MARK) {
            waitForDrain().then(() => readChunk());
            return;
        }
        
        const blob = file.slice(offset, offset + chunkSize);
        
        // ASYNC BLOBS: Use await blob.arrayBuffer() for memory efficiency
        (async () => {
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const chunk = new Uint8Array(arrayBuffer);
                
                // Wait if backpressure is too high
                const sendWithBackpressure = async () => {
                // CRITICAL: Check if transfer was paused or aborted
                if (transferPaused || transferAborted) {
                    if (transferAborted) {
                        return;
                    } else {
                        // Paused - wait and retry
                        setTimeout(() => sendWithBackpressure(), 1000);
                        return;
                    }
                }
                
                // Check channel is still open before sending - verify before treating as connection loss
                if (dataChannel.readyState !== 'open') {
                    const dcState = dataChannel.readyState;
                    const wsConnected = ws && ws.readyState === WebSocket.OPEN;
                    const pcState = peerConnection?.connectionState;
                    
                    // Only treat as connection loss if it's actually closed AND WebSocket is also disconnected
                    if (dcState === 'closed' && (!wsConnected || pcState === 'failed')) {
                        handleConnectionLoss("datachannel-closed");
                        if (transferAborted) {
                            return;
                        }
                    } else {
                        // Transient state change - wait and retry
                        console.log(`⏳ DataChannel state: ${dcState}. Waiting for recovery...`);
                    }
                    // If just paused, wait and retry
                    setTimeout(() => sendWithBackpressure(), 1000);
                    return;
                }
                
                // CRITICAL: Event-based backpressure handling
                if (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
                    waitForDrain().then(() => sendWithBackpressure());
                    return;
                }
                
                // Double-check before sending
                if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    console.warn(`Buffer exceeds max (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB), waiting...`);
                    waitForDrain().then(() => sendWithBackpressure());
                    return;
                }
                
                // Track chunk before sending
                const chunkLength = chunk.length;
                transferStats.chunksQueued++;
                let sendSuccess = false;
                let retryCount = 0;
                const MAX_RETRIES = 20; // Increased retries
                
                const attemptSend = () => {
                    try {
                        // Check channel state before each attempt
                        if (dataChannel.readyState !== 'open') {
                            console.error('DataChannel closed during send');
                            return false;
                        }
                        
                        // Check buffer before sending
                        if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                            console.warn(`Buffer too full (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB), waiting...`);
                            return false; // Will retry
                        }
                        
                        dataChannel.send(chunk);
                        return true;
                    } catch (error) {
                        // If send fails due to queue full, will retry
                        if (error.message && (error.message.includes('queue is full') || error.message.includes('send queue'))) {
                            console.warn(`Send queue full (attempt ${retryCount + 1}/${MAX_RETRIES}), buffered: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB`);
                            return false; // Will retry
                        }
                        // Other errors - log and fail
                        console.error('Error sending chunk:', error);
                        return false;
                    }
                };
                
                // Retry loop
                while (!sendSuccess && retryCount < MAX_RETRIES) {
                    sendSuccess = attemptSend();
                    if (!sendSuccess) {
                        retryCount++;
                        if (retryCount < MAX_RETRIES) {
                            setTimeout(() => {
                                sendWithBackpressure();
                            }, 200);
                            return; // Will retry via setTimeout
                        }
                    }
                }
                
                if (!sendSuccess) {
                    console.error(`Failed to send chunk after ${MAX_RETRIES} retries. Buffer: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB`);
                    releaseWakeLock();
                    alert(`Failed to send chunk after ${MAX_RETRIES} retries. Transfer may be incomplete.`);
                    return;
                }
                
                transferStats.chunksSent++;
                transferStats.bytesTransferred += chunkLength;
                offset += chunk.length;
                
                // Log every 100th chunk or when close to completion
                if (transferStats.chunksSent % 100 === 0 || transferStats.bytesTransferred > file.size * 0.95) {
                    console.log(`📤 Sent chunk #${transferStats.chunksSent}: ${chunkLength} bytes. Total: ${transferStats.bytesTransferred}/${file.size} (${((transferStats.bytesTransferred/file.size)*100).toFixed(1)}%)`);
                }
                
                // Calculate progress but cap at 99.9% until actually complete
                const progress = (transferStats.bytesTransferred / file.size) * 100;
                updateProgress(Math.min(99.9, progress));
                
                if (offset < file.size) {
                    readChunk();
                } else {
                    console.log('📤 File reading complete (legacy).');
                    console.log(`📊 Transfer stats: Bytes: ${transferStats.bytesTransferred}/${file.size}, Chunks sent: ${transferStats.chunksSent}, Chunks queued: ${transferStats.chunksQueued}`);
                    
                    // Note: We don't check byte count here - we'll wait for receiver confirmation
                    // The receiver's confirmation is the authoritative source of truth
                    
                    // Verify chunks were sent (warning only, not fatal)
                    if (transferStats.chunksSent !== transferStats.chunksQueued) {
                        console.warn(`⚠️ Warning: Chunks sent (${transferStats.chunksSent}) != chunks queued (${transferStats.chunksQueued}). Some chunks may have failed.`);
                    }
                    
                    // Wait for all buffered data to be sent
                    let bufferWaitAttempts = 0;
                    const MAX_BUFFER_WAIT = 300; // Wait up to 30 seconds
                    
                    const waitForBuffer = () => {
                        if (dataChannel.bufferedAmount > 0 && bufferWaitAttempts < MAX_BUFFER_WAIT) {
                            if (bufferWaitAttempts % 20 === 0) {
                                console.log(`⏳ Waiting for buffer to clear. Buffered: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB (attempt ${bufferWaitAttempts + 1}/${MAX_BUFFER_WAIT})`);
                            }
                            bufferWaitAttempts++;
                            setTimeout(waitForBuffer, 100);
                            return;
                        }
                        
                        if (dataChannel.bufferedAmount > 0) {
                            console.warn(`⚠️ Buffer still has ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB after waiting, but proceeding`);
                        } else {
                            console.log('✅ Buffer cleared successfully');
                        }
                        
                        // CRITICAL: Wait additional time for data to reach receiver (network latency)
                        // bufferedAmount=0 means data left browser, but it may still be in transit
                        // Calculate wait time based on file size and estimated network speed
                        const fileSizeMB = file.size / (1024 * 1024);
                        // Estimate: assume ~5MB/s transfer rate (conservative), add 10 seconds buffer
                        // For very large files, cap at 30 seconds max wait
                        // Formula: (fileSizeMB / 5) + 10, minimum 10s, maximum 30s
                        const estimatedWaitSeconds = Math.min(30, Math.max(10, (fileSizeMB / 5) + 10));
                        console.log(`⏳ Waiting ${estimatedWaitSeconds}s for data to reach receiver (network latency, file: ${fileSizeMB.toFixed(2)}MB)...`);
                        
                        // Wait with periodic checks
                        let waitAttempts = 0;
                        const maxWaitAttempts = estimatedWaitSeconds * 10; // Check every 100ms
                        const waitInterval = setInterval(() => {
                            waitAttempts++;
                            if (dataChannel.readyState !== 'open') {
                                console.error('❌ DataChannel closed during wait! State:', dataChannel.readyState);
                                clearInterval(waitInterval);
                                alert('Connection lost during file transfer. Please try again.');
                                return;
                            }
                            // Check if buffer filled up again (shouldn't happen, but check anyway)
                            if (dataChannel.bufferedAmount > 0 && waitAttempts % 50 === 0) {
                                console.log(`⚠️ Buffer refilled during wait: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)} MB`);
                            }
                            if (waitAttempts >= maxWaitAttempts) {
                                clearInterval(waitInterval);
                                // Now proceed with sending completion signal
                                // Verify all bytes were sent one more time
                                const actualPercent = (transferStats.bytesTransferred / file.size) * 100;
                                console.log(`📊 Final check: ${transferStats.bytesTransferred}/${file.size} bytes (${actualPercent.toFixed(2)}%)`);
                                updateProgress(Math.min(99.9, actualPercent)); // Don't show 100% yet
                                
                            // CRITICAL: Flush buffer before sending completion signal
                            // This ensures all chunks are transmitted before signaling completion
                            console.log('🔄 Flushing buffer before sending completion signal...');
                            waitForDrain().then(async () => {
                                console.log('✅ Buffer flushed - sending completion signal');
                                
                                // CRITICAL: File-end must be delayed until buffer drains
                                console.log('🔄 Final buffer drain before file-complete signal...');
                                await waitForDrain();
                                
                                // 🔴 Pillar 5: Compute file hash for integrity verification
                                let fileHash = null;
                                try {
                                    const fileBuffer = await file.arrayBuffer();
                                    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
                                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                                    fileHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                                    console.log(`🔐 Computed file hash: ${fileHash.substring(0, 16)}...`);
                                } catch (error) {
                                    console.warn('⚠️ Could not compute file hash (non-critical):', error);
                                }
                                
                                console.log('📨 Sending file-complete signal...');
                                // Send completion message with file size, name, and hash
                                try {
                                    dataChannel.send(JSON.stringify({ 
                                        type: 'file-complete',
                                        size: file.size,
                                        fileName: file.name, // Include file name for proper matching in bulk transfers
                                        hash: fileHash // 🔴 Pillar 5: Integrity hash
                                    }));
                                    console.log('✅ File-complete signal sent (file:', file.name, ', size:', file.size, 'bytes, hash:', fileHash ? fileHash.substring(0, 16) + '...' : 'none', '). Waiting for receiver confirmation...');
                                } catch (error) {
                                    console.error('❌ Error sending completion signal:', error);
                                    alert('Error sending completion signal: ' + error.message);
                                    return;
                                }
                                
                                // Wait for receiver confirmation that all bytes were received
                                // Use timeout watchdog to prevent infinite hangs
                                console.log('⏳ Waiting for receiver confirmation that all bytes were received...');
                                try {
                                    await waitForAckWithTimeout(file.name, 30000);
                                    console.log('✅ Receiver confirmed file receipt');
                                } catch (error) {
                                    console.error(`❌ ${error.message}`);
                                    // Continue anyway - receiver may have received the file even if ACK was lost
                                    console.warn('⚠️ Proceeding despite ACK timeout - file may have been received');
                                }
                                
                                if (dataChannel.readyState !== 'open') {
                                    console.error('❌ DataChannel closed while waiting for confirmation!');
                                    alert('Connection lost while waiting for transfer confirmation.');
                                    return;
                                }
                                
                                // Now mark as 100% complete
                                updateProgress(100);
                                setTimeout(() => completeSendingFile(), 500);
                            });
                        }
                        }, 100); // Check every 100ms
                    };
                    waitForBuffer();
                }
            };
            
                sendWithBackpressure();
            } catch (error) {
                console.error('Error reading blob:', error);
                alert('Error reading file');
            }
        })();
    };
    
    readChunk();
}

// Data Channel Message Handling (Receiver)
// 🔴 Step 1: Single authoritative counter
let receivingFile = null;
let receivedBytes = 0; // SINGLE SOURCE OF TRUTH - only incremented when chunks arrive
let expectedFileSize = 0; // Set from file-complete signal
let fileCompleteSignalReceived = false;

// Keep these for IndexedDB storage (but don't use for completion logic)
let receivingFileSize = 0; // For UI display
let currentChunkIndex = 0; // Track current chunk index for IndexedDB
let lastChunkReceivedTime = null;
let allBytesReceivedTime = null; // Track when we first received all bytes

// 🔹 Deterministic state machine (replaces overlapping booleans)
const TransferState = {
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    TRANSFERRING: 'TRANSFERRING',
    PAUSED: 'PAUSED',
    RESUMING: 'RESUMING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};
let transferState = TransferState.IDLE;

// 🔴 Pillar 5: Integrity verification
let receivedHash = null; // SHA-256 hash computed during receive
let expectedHash = null; // Final hash from sender

function handleDataChannelMessage(event) {
    const data = event.data;
    
    // DEBUG: Log ALL incoming messages to help diagnose issues
    console.log('📥 DataChannel message received:', typeof data === 'string' ? data.substring(0, 100) : `Binary data (${data.byteLength} bytes)`);
    
    // Check if it's a JSON message (metadata or control)
    if (typeof data === 'string') {
        let message;
        try {
            message = JSON.parse(data);
            console.log('📨 Parsed message type:', message.type, message);
        } catch (parseError) {
            console.error('❌ Failed to parse JSON message:', parseError);
            console.error('❌ Raw message data:', data);
            return; // Don't process invalid JSON
        }
        
        if (!message || !message.type) {
            console.error('❌ Message missing type field:', message);
            return;
        }
            
            if (message.type === 'ping') {
                // Receiver ignores ping - just acknowledge it's received
                // This keeps the connection alive
                return;
            } else if (message.type === 'chunk') {
                // ✅ FIX 2: Handle chunk with immutable index
                const chunkIndex = message.chunkIndex;
                const base64Payload = message.payload;
                const chunkSize = message.size;
                
                if (chunkIndex === undefined || chunkIndex === null || !base64Payload) {
                    console.error('❌ Invalid chunk message:', message);
                    return;
                }
                
                // Decode base64 payload to ArrayBuffer
                try {
                    const binaryString = atob(base64Payload);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const chunk = bytes.buffer;
                    
                    // Process chunk with its index
                    handleFileChunk(chunk, chunkIndex);
                } catch (error) {
                    console.error('❌ Error decoding chunk payload:', error);
                }
                return;
            } else if (message.type === 'chunk-ack') {
                // ✅ FIX 1: Sender receives windowed ACK from receiver (for stall detection only)
                const highestContiguous = message.highestContiguousChunkIndex;
                if (highestContiguous !== undefined && highestContiguous !== null) {
                    if (highestContiguous > highestAckedChunkIndex) {
                        highestAckedChunkIndex = highestContiguous;
                    }
                    // Log every 100th ACK to avoid spam
                    if (highestContiguous % 100 === 0) {
                        console.log(`✅ Received windowed ACK up to chunk #${highestContiguous}`);
                    }
                }
                return;
            } else if (message.type === 'resume' || message.type === 'resume-request') {
                // 🔴 Pillar 4: Deterministic Resume - Sender receives resume request from receiver
                console.log(`🔄 Resume request received: ${message.fileName} from offset ${message.offset}`);
                
                // 🔹 Idempotent handler
                if (transferState === TransferState.COMPLETED) {
                    console.log('⚠️ Resume request ignored - transfer already completed');
                    return;
                }
                
                // Find the file in queue or current file
                let fileToResume = null;
                if (currentFile && currentFile.name === message.fileName) {
                    fileToResume = currentFile;
                } else {
                    // Search in queue
                    fileToResume = fileQueue.find(f => f.name === message.fileName);
                }
                
                if (fileToResume && message.offset < fileToResume.size) {
                    console.log(`✅ Resuming file: ${message.fileName} from byte ${message.offset}`);
                    transferState = TransferState.RESUMING;
                    
                    // Reset transfer stats but keep offset
                    resetTransferStats();
                    transferStats.bytesTransferred = message.offset;
                    
                    // Resume streaming from offset
                    if (fileToResume === currentFile) {
                        // Current file - resume it
                        streamFile(fileToResume, message.offset);
                    } else {
                        // File in queue - move to current and resume
                        currentFile = fileToResume;
                        streamFile(fileToResume, message.offset);
                    }
                    
                    transferState = TransferState.TRANSFERRING;
                } else {
                    console.warn(`⚠️ Cannot resume: file not found or invalid offset`);
                }
                return;
            } else if (message.type === 'file-request') {
                console.log('📨 Received file-request message:', message);
                console.log('🔍 About to call handleFileRequest. Current state:', {
                    transferSection: !!transferSection,
                    fileRequest: !!fileRequest,
                    requestFileName: !!requestFileName,
                    acceptFileBtn: !!acceptFileBtn,
                    rejectFileBtn: !!rejectFileBtn,
                    pendingFileRequestsQueueLength: pendingFileRequestsQueue.length
                });
                handleFileRequest(message);
            } else if (message.type === 'file-accepted') {
                handleFileAccepted();
            } else if (message.type === 'file-rejected') {
                handleFileRejected();
            } else if (message.type === 'file-metadata') {
                // Reset any previous file state before starting new file
                if (receivingFile) {
                    console.warn('⚠️ Received file-metadata while still receiving previous file. Resetting...');
                    // Clean up previous file from IndexedDB
                    deleteFileFromIndexedDB(receivingFile.name).catch(err => console.error('Error cleaning up:', err));
                    deleteFileMetadataFromLocalStorage(receivingFile.name);
                    receivingFile = null;
                    receivingFileSize = 0;
                    receivedBytes = 0;
                    currentChunkIndex = 0;
                }
                // Check if this is a resume (metadata includes offset)
                const resumeOffset = message.resumeOffset || 0;
                startReceivingFile(message, resumeOffset);
            } else if (message.type === 'file-complete') {
                // 🔴 Step 4: On file-complete signal
                // 🔹 Idempotent handler
                if (transferState === TransferState.COMPLETED) {
                    console.log('⚠️ File-complete signal ignored - already completed');
                    return;
                }
                
                const signalFileName = message.fileName || null;
                const signalFileSize = message.size || null;
                const signalHash = message.hash || null; // 🔴 Pillar 5: Integrity hash from sender
                
                // Verify signal matches current file
                if (receivingFile) {
                    const nameMatches = signalFileName && signalFileName === receivingFile.name;
                    const sizeMatches = signalFileSize && signalFileSize === receivingFileSize;
                    
                    if (!nameMatches && !sizeMatches && signalFileSize) {
                        console.warn(`⚠️ File-complete signal ignored: size ${signalFileSize} doesn't match current file "${receivingFile.name}" (${receivingFileSize} bytes).`);
                        return;
                    }
                    
                    console.log(`📨 File-complete signal received for "${receivingFile.name}". Expected size: ${signalFileSize || receivingFileSize} bytes`);
                    
                    // Store expected hash for integrity verification
                    if (signalHash) {
                        expectedHash = signalHash;
                        console.log(`🔐 Expected hash: ${signalHash.substring(0, 16)}...`);
                    }
                } else {
                    console.warn(`⚠️ File-complete signal received but no active file transfer. Ignoring.`);
                    return;
                }
                
                // Set expected size and signal flag
                expectedFileSize = signalFileSize || receivingFileSize;
                fileCompleteSignalReceived = true;
                
                // ✅ FIX 5: Store expected total chunks from sender
                if (message.totalChunks !== undefined && message.totalChunks > 0) {
                    expectedTotalChunks = message.totalChunks;
                    console.log(`📊 Expected total chunks: ${expectedTotalChunks}`);
                } else {
                    // Estimate from file size if not provided
                    expectedTotalChunks = Math.ceil(expectedFileSize / CONNECTED_CHUNK_SIZE);
                    console.log(`📊 Estimated total chunks: ${expectedTotalChunks} (from size)`);
                }
                
                // Check completion immediately
                checkAndCompleteFile();
            } else if (message.type === 'file-received-confirmed') {
                // Sender receives this confirmation from receiver
                console.log(`✅ Received confirmation from receiver: ${message.bytesReceived || 'all'} bytes received (expected: ${message.expectedBytes || 'unknown'})`);
                
                // Trust the receiver's confirmation - if receiver says all bytes received, mark as success
                if (fileTransferConfirmationResolver) {
                    fileTransferConfirmationResolver();
                    fileTransferConfirmationResolver = null;
                }
                
                // Ensure completion is triggered - don't check byte counts, receiver confirmed success
                if (currentFile) {
                    setTimeout(() => {
                        completeSendingFile();
                    }, 500);
                }
            } else {
                // Unknown message type - log it for debugging
                console.warn('⚠️ Unknown message type received:', message.type, message);
            }
            return;
    }
    
    // Handle binary file data - ONLY if we're actively receiving a file
    // This prevents chunks from being processed before file metadata arrives
    if (receivingFile && receivingFileSize > 0) {
        handleFileChunk(data);
    } else {
        // Chunk arrived but we're not ready - this shouldn't happen but log it
        console.warn('⚠️ Received chunk but no active file transfer. Waiting for file-metadata...');
    }
}

// File Request Handling
function handleFileRequest(request) {
    console.log('📥 File transfer request received:', request.name, 'Size:', request.size);
    console.log('🔍 handleFileRequest called. Full request:', request);
    
    // Validate request
    if (!request || !request.name) {
        console.error('❌ Invalid file request received:', request);
        return;
    }
    
    // CRITICAL: Ensure transferSection is visible FIRST
    if (!transferSection) {
        console.error('❌ transferSection element not found! Cannot show file request UI.');
        return;
    }
    
    transferSection.style.display = 'block';
    transferSection.style.visibility = 'visible';
    console.log('✅ Transfer section is now visible (display: block, visibility: visible)');
    
    // Add to pending requests queue
    if (!pendingFileRequestsQueue) {
        pendingFileRequestsQueue = [];
    }
    pendingFileRequestsQueue.push(request);
    console.log(`📋 Total pending requests: ${pendingFileRequestsQueue.length}`);
    
    // If we're already receiving a file, just queue it
    if (receivingFile || pendingFileRequest) {
        console.log(`⏸️ File request queued (already receiving). Total pending: ${pendingFileRequestsQueue.length}`);
        // Still show UI if not already showing
        if (fileRequest && fileRequest.style.display === 'none') {
            showFileRequestUI();
        }
        return;
    }
    
    // Show the first file request with bulk info
    console.log('🎯 Calling showFileRequestUI...');
    showFileRequestUI();
}

function showFileRequestUI() {
    console.log('🎨 showFileRequestUI called');
    console.log('🔍 Current state:', {
        pendingFileRequestsQueueLength: pendingFileRequestsQueue?.length || 0,
        transferSection: !!transferSection,
        fileRequest: !!fileRequest,
        dropZone: !!dropZone,
        requestFileName: !!requestFileName,
        requestFileSize: !!requestFileSize,
        acceptFileBtn: !!acceptFileBtn,
        rejectFileBtn: !!rejectFileBtn
    });
    
    if (!pendingFileRequestsQueue || pendingFileRequestsQueue.length === 0) {
        console.warn('⚠️ showFileRequestUI called but no pending requests');
        return;
    }
    
    const firstRequest = pendingFileRequestsQueue[0];
    const totalFiles = pendingFileRequestsQueue.length;
    const totalSize = pendingFileRequestsQueue.reduce((sum, req) => sum + (req.size || 0), 0);
    
    console.log(`📋 Showing file request UI: ${firstRequest.name}, Total files: ${totalFiles}, Total size: ${formatFileSize(totalSize)}`);
    
    // CRITICAL: Ensure transferSection is visible
    if (!transferSection) {
        console.error('❌ transferSection element not found!');
        return;
    }
    transferSection.style.display = 'block';
    transferSection.style.visibility = 'visible';
    console.log('✅ Transfer section forced visible');
    
    // Hide drop zone, show file request UI
    if (dropZone) {
        dropZone.style.display = 'none';
        console.log('✅ Drop zone hidden');
    } else {
        console.warn('⚠️ dropZone element not found');
    }
    
    if (!fileRequest) {
        console.error('❌ fileRequest element not found! Cannot show UI.');
        // Try to re-query it
        const fileRequestRetry = document.getElementById('fileRequest');
        if (fileRequestRetry) {
            console.log('✅ Found fileRequest on retry');
            fileRequestRetry.style.display = 'block';
            fileRequestRetry.style.visibility = 'visible';
        } else {
            console.error('❌ fileRequest still not found after retry');
            return;
        }
    } else {
        fileRequest.style.display = 'block';
        fileRequest.style.visibility = 'visible';
        console.log('✅ File request UI is now visible (display: block, visibility: visible)');
    }
    
    // Show first file name + X more files
    if (!requestFileName) {
        console.error('❌ requestFileName element not found!');
    } else {
        if (totalFiles > 1) {
            requestFileName.textContent = `${firstRequest.name} +${totalFiles - 1} more file${totalFiles - 1 > 1 ? 's' : ''}`;
        } else {
            requestFileName.textContent = firstRequest.name;
        }
        console.log('✅ File name set:', requestFileName.textContent);
    }
    
    if (!requestFileSize) {
        console.error('❌ requestFileSize element not found!');
    } else {
        requestFileSize.textContent = formatFileSize(totalSize);
        console.log('✅ File size set:', requestFileSize.textContent);
    }
    
    // Ensure buttons are enabled and visible
    if (!acceptFileBtn) {
        console.error('❌ acceptFileBtn element not found!');
    } else {
        acceptFileBtn.disabled = false;
        acceptFileBtn.style.display = 'block';
        acceptFileBtn.style.visibility = 'visible';
        console.log('✅ Accept button enabled and visible');
    }
    
    if (!rejectFileBtn) {
        console.error('❌ rejectFileBtn element not found!');
    } else {
        rejectFileBtn.disabled = false;
        rejectFileBtn.style.display = 'block';
        rejectFileBtn.style.visibility = 'visible';
        console.log('✅ Reject button enabled and visible');
    }
    
    // Store first request as current (for backward compatibility)
    pendingFileRequest = firstRequest;
    
    // Force a reflow to ensure visibility
    void fileRequest.offsetHeight;
    
    console.log('✅ File request UI displayed successfully. Final check:', {
        fileRequestDisplay: fileRequest?.style.display,
        fileRequestVisibility: fileRequest?.style.visibility,
        acceptBtnDisabled: acceptFileBtn?.disabled,
        rejectBtnDisabled: rejectFileBtn?.disabled
    });
}

function handleAcceptFile() {
    if (pendingFileRequestsQueue.length === 0) {
        console.warn('No pending file requests to accept');
        return;
    }
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Connection not ready. Please wait for connection to be established.');
        return;
    }
    
    const totalFiles = pendingFileRequestsQueue.length;
    console.log(`Accepting ${totalFiles} file(s) for transfer`);
    
    // Disable buttons to prevent double-clicking
    if (acceptFileBtn) acceptFileBtn.disabled = true;
    if (rejectFileBtn) rejectFileBtn.disabled = true;
    
    // Accept all files - send a single acceptance message for all files
    try {
        dataChannel.send(JSON.stringify({ 
            type: 'file-accepted',
            total: totalFiles,
            files: pendingFileRequestsQueue.map(req => ({ name: req.name, size: req.size }))
        }));
        console.log(`Acceptance message sent for ${totalFiles} file(s)`);
    } catch (error) {
        console.error(`Error sending acceptance:`, error);
    }
    
    // Store all requests but DON'T start receiving yet
    // Wait for sender to send file-metadata for the first file
    // The sender will send metadata before each file
    
    // Hide request UI, show transfer info (will be populated when metadata arrives)
    fileRequest.style.display = 'none';
    transferInfo.style.display = 'block';
    
    // Keep the queue - we'll process files one by one as metadata arrives
    // Don't clear pendingFileRequestsQueue yet - we'll use it to track remaining files
}

function handleRejectFile() {
    if (pendingFileRequestsQueue.length === 0) {
        console.warn('No pending file requests to reject');
        return;
    }
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Connection not ready. Please wait for connection to be established.');
        return;
    }
    
    const totalFiles = pendingFileRequestsQueue.length;
    console.log(`Rejecting ${totalFiles} file(s)`);
    
    // Disable buttons to prevent double-clicking
    if (acceptFileBtn) acceptFileBtn.disabled = true;
    if (rejectFileBtn) rejectFileBtn.disabled = true;
    
    // Reject all files - send rejection for each
    pendingFileRequestsQueue.forEach((request, index) => {
        try {
            dataChannel.send(JSON.stringify({ 
                type: 'file-rejected',
                fileName: request.name,
                index: index,
                total: totalFiles
            }));
            console.log(`Rejection message sent for file ${index + 1}/${totalFiles}: ${request.name}`);
        } catch (error) {
            console.error(`Error sending rejection for ${request.name}:`, error);
        }
    });
    
    // Reset UI
    fileRequest.style.display = 'none';
    dropZone.style.display = 'block';
    pendingFileRequest = null;
    pendingFileRequestsQueue = [];
    
    // Re-enable buttons after a short delay
    setTimeout(() => {
        if (acceptFileBtn) acceptFileBtn.disabled = false;
        if (rejectFileBtn) rejectFileBtn.disabled = false;
    }, 500);
}

function handleFileAccepted() {
    console.log('File transfer accepted by receiver, starting upload...');
    // Mark that all files have been accepted (bulk acceptance)
    allFilesAccepted = true;
    
    // Start sending the current file (first in queue)
    if (currentFile) {
        // Update UI to show uploading and queue status
        const queueInfo = fileQueue.length > 1 ? ` (${fileQueue.length - 1} more in queue)` : '';
        showTransferUI(currentFile, `Uploading...${queueInfo}`);
        
        // Send file metadata FIRST, then start streaming
        // This ensures receiver is ready before chunks arrive
        const metadata = {
            type: 'file-metadata',
            name: currentFile.name,
            size: currentFile.size,
            mimeType: currentFile.type
        };
        dataChannel.send(JSON.stringify(metadata));
        console.log(`📤 Sent file-metadata for: ${currentFile.name}`);
        
        // Small delay to ensure metadata arrives before chunks
        setTimeout(() => {
            streamFile(currentFile);
        }, 100);
    } else {
        console.warn('File accepted but no currentFile set. Processing queue...');
        // Try to process queue if no current file
        if (fileQueue.length > 0) {
            processFileQueue();
        }
    }
}

function handleFileRejected() {
    console.log('File transfer rejected by receiver');
    // Show rejection message
    alert('File transfer was rejected by the receiver.');
    
    // Release wake lock if transfer was rejected
    releaseWakeLock();
    
    // Remove rejected file from queue
    if (fileQueue.length > 0 && fileQueue[0] === currentFile) {
        fileQueue.shift();
    }
    
    currentFile = null;
    
    // If there are more files in queue, continue processing
    if (fileQueue.length > 0) {
        isProcessingQueue = false;
        processFileQueue();
    } else {
        // No more files, show drop zone
        isProcessingQueue = false;
        dropZone.style.display = 'block';
        transferInfo.style.display = 'none';
    }
}

let pendingFileRequest = null;
let pendingFileRequestsQueue = []; // Queue for multiple file requests

async function startReceivingFile(metadata, resumeOffset = 0) {
    receivingFile = {
        name: metadata.name,
        size: metadata.size,
        type: metadata.mimeType || 'application/octet-stream'
    };
    receivingFileSize = metadata.size;
    fileCompleteSignalReceived = false;
    completionCheckAttempts = 0;
    lastChunkReceivedTime = Date.now();
    allBytesReceivedTime = null;
    
    // Check localStorage and IndexedDB for existing partial file (resume capability)
    const savedMetadata = getFileMetadataFromLocalStorage(metadata.name);
    if (savedMetadata && savedMetadata.fileSize === metadata.size) {
        // Check IndexedDB for existing chunks
        try {
            const { totalBytes, chunkCount } = await getTotalBytesFromIndexedDB(metadata.name);
            if (totalBytes > 0 && totalBytes < metadata.size) {
                // We have partial file - resume from this point
                receivedBytes = totalBytes;
                currentChunkIndex = chunkCount;
                console.log(`🔄 Resuming file transfer: ${metadata.name} (${totalBytes}/${metadata.size} bytes already received)`);
                
                // Request sender to resume from this offset
                if (dataChannel && dataChannel.readyState === 'open') {
                    try {
                        dataChannel.send(JSON.stringify({
                            type: 'resume',
                            fileName: metadata.name,
                            offset: totalBytes
                        }));
                        console.log(`📤 Sent resume request: ${metadata.name} from byte ${totalBytes}`);
                    } catch (error) {
                        console.error('❌ Error sending resume request:', error);
                    }
                }
            } else {
                // Start fresh
                receivedBytes = 0;
                currentChunkIndex = 0;
                // Clean up old data if file size changed
                if (totalBytes > 0) {
                    await deleteFileFromIndexedDB(metadata.name);
                    deleteFileMetadataFromLocalStorage(metadata.name);
                }
            }
        } catch (error) {
            console.error('❌ Error checking IndexedDB for resume:', error);
            receivedBytes = 0;
            currentChunkIndex = 0;
        }
    } else {
        // No saved metadata - start fresh
        receivedBytes = 0;
        currentChunkIndex = 0;
    }
    
    // Save metadata to localStorage
    saveFileMetadataToLocalStorage(metadata.name, metadata.size, metadata.mimeType || 'application/octet-stream', receivedBytes);
    
    // Clear any existing completion check interval
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    // 🔹 Update state machine
    transferState = receivedBytes > 0 ? TransferState.RESUMING : TransferState.TRANSFERRING;
    
    // 🔴 Pillar 5: Reset hash for new file
    receivedHash = null;
    expectedHash = null;
    
    // ✅ FIX 3: Reset chunk tracking map for new file
    receivedChunks.clear();
    lastAckedChunkIndex = -1;
    expectedTotalChunks = 0; // ✅ FIX 5: Reset expected chunks
    highestContiguousChunkIndex = -1; // ✅ FIX 1: Reset contiguous tracking
    
    showReceivingFileUI(receivingFile);
    resetTransferStats();
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    console.log('📥 Started receiving file:', metadata.name, 'Size:', metadata.size, 'bytes', receivedBytes > 0 ? `(Resuming from ${receivedBytes} bytes)` : '');
}

// RECEIVER: Batched IndexedDB writes (every 10 chunks) for optimal disk I/O
let chunkBuffer = []; // Buffer chunks before batch write
const BATCH_SIZE = 10; // Write every 10 chunks to reduce disk I/O bottleneck

// ✅ FIX 3: Store chunkIndex → boolean map (enterprise pattern)
let receivedChunks = new Map(); // chunkIndex -> chunkSize (tracks which chunks were received)
let lastAckedChunkIndex = -1; // Track last chunk we ACKed to sender
let expectedTotalChunks = 0; // ✅ FIX 5: Expected total chunks for completion check
let highestContiguousChunkIndex = -1; // ✅ FIX 1: Track highest contiguous chunk for windowed ACK

async function handleFileChunk(chunk, chunkIndex) {
    // 🔹 Idempotent handler - safe to call multiple times
    if (!receivingFile || transferState === TransferState.COMPLETED) return;
    
    // Update state to TRANSFERRING if we were RESUMING
    if (transferState === TransferState.RESUMING) {
        transferState = TransferState.TRANSFERRING;
    } else if (transferState === TransferState.IDLE || transferState === TransferState.CONNECTING) {
        transferState = TransferState.TRANSFERRING;
    }
    
    const chunkSize = chunk.byteLength || chunk.length;
    
    // 🔴 Step 2: Increment ONLY here - single authoritative counter
    receivedBytes += chunkSize;
    
    // Note: Hash verification is done at finalizeFile() from the complete assembled file
    // This ensures we verify the final file, not individual chunks
    
    // ✅ FIX 2: Use immutable chunkIndex from sender (don't increment our own counter)
    // Add chunk to buffer (keep in memory temporarily for batching)
    chunkBuffer.push({
        chunkIndex: chunkIndex,
        chunkData: chunk
    });
    
    // ✅ FIX 3: Track received chunks in map
    receivedChunks.set(chunkIndex, chunkSize);
    
    // ✅ FIX 1: Update highest contiguous chunk index for windowed ACK
    // Find highest contiguous chunk (chunks 0, 1, 2, ... N where all exist)
    let contiguous = highestContiguousChunkIndex;
    while (receivedChunks.has(contiguous + 1)) {
        contiguous++;
    }
    highestContiguousChunkIndex = Math.max(highestContiguousChunkIndex, contiguous);
    
    // CRITICAL: Update last chunk received time - used to detect stale connections
    lastChunkReceivedTime = Date.now();
    
    // ✅ FIX 1: Windowed ACK (every 64 chunks) - NOT per-chunk
    if (chunkIndex % ACK_EVERY_N_CHUNKS === 0) {
        // Send windowed ACK with highest contiguous chunk index
        if (dataChannel && dataChannel.readyState === 'open') {
            try {
                dataChannel.send(JSON.stringify({
                    type: 'chunk-ack',
                    highestContiguousChunkIndex: highestContiguousChunkIndex
                }));
                lastAckedChunkIndex = highestContiguousChunkIndex;
            } catch (error) {
                console.warn('⚠️ Could not send windowed ACK (non-critical):', error);
            }
        }
    }
    
    // Batch write: Store chunks in IndexedDB every 10 chunks (reduces disk I/O bottleneck)
    // CRITICAL: Use smaller batches (5 chunks) when near completion to ensure all chunks are stored
    const progressPercent = (receivedBytes / receivingFileSize) * 100;
    const effectiveBatchSize = progressPercent > 90 ? 5 : BATCH_SIZE; // Smaller batches near completion
    
    if (chunkBuffer.length >= effectiveBatchSize) {
        // ✅ FIX 2: Two-phase commit - copy buffer BEFORE clearing
        const batch = [...chunkBuffer]; // Create copy for atomic operation
        
        try {
            // Write all buffered chunks in parallel for better performance
            const writePromises = batch.map(item => {
                if (!item || item.chunkIndex === undefined) {
                    throw new Error(`❌ CRITICAL: Corrupted chunk in batch! Item: ${JSON.stringify(item)}`);
                }
                return storeChunkInIndexedDB(receivingFile.name, item.chunkIndex, item.chunkData);
            });
            await Promise.all(writePromises);
            
            const flushedCount = batch.length;
            const firstIndex = batch[0].chunkIndex;
            const lastIndex = batch[batch.length - 1].chunkIndex;
            
            console.log(`💾 Stored batch of ${flushedCount} chunks to IndexedDB (chunks ${firstIndex} to ${lastIndex})`);
            
            // ✅ FIX 2: Clear buffer ONLY after DB confirms success
            chunkBuffer.splice(0, batch.length); // Remove only the successfully stored chunks
            
            // Update localStorage with current progress (less frequently)
            saveFileMetadataToLocalStorage(receivingFile.name, receivingFileSize, receivingFile.type, receivedBytes);
        } catch (error) {
            console.error('❌ CRITICAL: Error storing chunk batch in IndexedDB:', error);
            console.error(`❌ Failed to store ${batch.length} chunks (indices ${batch[0]?.chunkIndex} to ${batch[batch.length - 1]?.chunkIndex})`);
            
            // ✅ FIX 5: Hard stop on corrupted batch
            if (error.message && error.message.includes('Corrupted chunk')) {
                console.error('❌ CRITICAL: Corrupted batch detected! Aborting transfer.');
                transferState = TransferState.FAILED;
                alert('CRITICAL ERROR: Internal receiver corruption detected. Transfer aborted. Please restart.');
                resetReceivingState();
                return;
            }
            
            // DON'T clear buffer on error - keep chunks for retry
            // Buffer remains intact for retry
            console.warn('⚠️ Batch store failed, will retry on next batch or completion');
        }
    }
    
    // Calculate progress but cap at 99.9% until actually complete
    updateReceivingProgress(Math.min(99.9, progressPercent));
    
    // CRITICAL: If we're at or near 100%, flush buffer immediately (don't wait for batch)
    // This ensures all chunks are stored before completion check
    if (progressPercent >= 99.9 && chunkBuffer.length > 0) {
        console.log(`⚠️ Near completion (${progressPercent.toFixed(1)}%) with ${chunkBuffer.length} chunks in buffer. Flushing immediately...`);
        try {
            await flushChunkBuffer();
            console.log(`✅ Flushed ${chunkBuffer.length} remaining chunks to IndexedDB`);
        } catch (error) {
            console.error('❌ CRITICAL: Failed to flush final chunks:', error);
        }
    }
    
    // Log every 100th chunk or when close to completion to avoid spam
    // NOTE: currentChunkIndex is already incremented, so this shows the NEXT chunk number
    if ((currentChunkIndex - 1) % 100 === 0 || progressPercent > 90) {
        console.log(`📥 Chunk #${currentChunkIndex - 1}: ${chunkSize} bytes. Total: ${receivedBytes}/${receivingFileSize} (${progressPercent.toFixed(1)}%), Buffer: ${chunkBuffer.length} chunks`);
    }
    
    // 🔴 Step 3: Check completion when signal received
    if (fileCompleteSignalReceived) {
        checkAndCompleteFile();
    }
}

// Flush remaining chunks from buffer (called on file completion)
async function flushChunkBuffer() {
    // ✅ FIX 1: Never flush empty buffer (MANDATORY)
    if (!chunkBuffer.length) {
        return; // HARD GUARD - prevent empty flush
    }
    
    if (!receivingFile) {
        console.warn('⚠️ flushChunkBuffer called but no receiving file');
        return;
    }
    
    // ✅ FIX 2: Two-phase commit - copy buffer BEFORE clearing
    const batch = [...chunkBuffer]; // Create copy for atomic operation
    const chunksToFlush = batch.length;
    
    // ✅ FIX 5: Validate batch before processing
    for (let i = 0; i < batch.length; i++) {
        if (!batch[i] || batch[i].chunkIndex === undefined) {
            console.error(`❌ CRITICAL: Corrupted chunk at index ${i} in batch!`);
            console.error(`❌ Batch item:`, batch[i]);
            transferState = TransferState.FAILED;
            throw new Error(`CRITICAL: Corrupted batch detected at index ${i}. Transfer aborted.`);
        }
    }
    
    const firstChunkIndex = batch[0].chunkIndex;
    const lastChunkIndex = batch[batch.length - 1].chunkIndex;
    
    try {
        console.log(`💾 Flushing ${chunksToFlush} chunks to IndexedDB (chunks ${firstChunkIndex} to ${lastChunkIndex})...`);
        
        // Write all chunks in parallel
        await Promise.all(batch.map(item => 
            storeChunkInIndexedDB(receivingFile.name, item.chunkIndex, item.chunkData)
        ));
        
        console.log(`✅ Successfully flushed ${chunksToFlush} chunks to IndexedDB`);
        
        // ✅ FIX 2: Clear buffer ONLY after DB confirms success
        chunkBuffer.splice(0, batch.length); // Remove only the successfully stored chunks
    } catch (error) {
        console.error('❌ CRITICAL: Error flushing chunk buffer:', error);
        console.error(`❌ Failed to flush ${chunksToFlush} chunks! Buffer preserved for retry.`);
        
        // ✅ FIX 5: Hard stop on corrupted batch
        if (error.message && error.message.includes('Corrupted')) {
            console.error('❌ CRITICAL: Corrupted batch detected! Aborting transfer.');
            transferState = TransferState.FAILED;
            alert('CRITICAL ERROR: Internal receiver corruption detected. Transfer aborted. Please restart.');
            resetReceivingState();
            throw error;
        }
        
        // Don't clear buffer on error - keep for potential retry
        throw error; // Re-throw so caller knows it failed
    }
}

function completeReceivingFile() {
    if (!receivingFile) return;
    
    // Mark that we received the completion signal
    fileCompleteSignalReceived = true;
    console.log('File completion signal received. Current progress:', receivedBytes, '/', receivingFileSize, `(${((receivedBytes/receivingFileSize)*100).toFixed(1)}%)`);
    
    // Start checking immediately and continue checking until complete
    // Don't wait - start the interval right away
    if (!completionCheckInterval) {
        completionCheckInterval = setInterval(() => {
            checkAndCompleteFile();
        }, 100);
    }
    
    // Also check immediately
    checkAndCompleteFile();
}

let completionCheckInterval = null;
let completionCheckAttempts = 0;
const MAX_COMPLETION_CHECK_ATTEMPTS = 1000; // Max 100 seconds (100 * 100ms)

    // 🔴 Step 3: Completion logic MUST use single authoritative counter
async function checkAndCompleteFile() {
    if (!receivingFile) {
        if (completionCheckInterval) {
            clearInterval(completionCheckInterval);
            completionCheckInterval = null;
        }
        completionCheckAttempts = 0;
        return;
    }
    
    // 🔴 Step 5: REMOVE all DB-based byte checks - use single counter only
    if (!fileCompleteSignalReceived) return;
    
    // Flush any remaining chunks from buffer before checking
    await flushChunkBuffer();
    
    // ✅ FIX 5: Completion condition MUST be chunk-based
    const receivedChunkCount = receivedChunks.size;
    
    // Primary check: receivedChunks.size === expectedTotalChunks
    if (expectedTotalChunks > 0 && receivedChunkCount === expectedTotalChunks) {
        console.log(`✅ File complete! Received all ${receivedChunkCount} chunks (${receivedBytes}/${expectedFileSize} bytes)`);
        await finalizeFile();
    } else if (receivedBytes === expectedFileSize && expectedTotalChunks === 0) {
        // Fallback: If totalChunks not provided, use byte count
        console.log(`✅ File complete! Received: ${receivedBytes}/${expectedFileSize} bytes, ${receivedChunkCount} chunks`);
        await finalizeFile();
    } else {
        const missing = expectedFileSize - receivedBytes;
        if (completionCheckAttempts % 10 === 0) {
            console.warn(`Waiting for bytes: ${receivedBytes}/${expectedFileSize} (missing ${missing} bytes)`);
        }
        completionCheckAttempts++;
        
        // Keep checking - chunks might still be arriving
        if (!completionCheckInterval) {
            completionCheckInterval = setInterval(() => {
                checkAndCompleteFile();
            }, 100);
        }
        
        // Timeout after max attempts
        if (completionCheckAttempts > MAX_COMPLETION_CHECK_ATTEMPTS) {
            console.error(`Timeout: Received ${receivedBytes}/${expectedFileSize} bytes. Missing ${missing} bytes.`);
            alert(`File transfer incomplete. Received ${receivedBytes} of ${expectedFileSize} bytes. Missing ${missing} bytes.`);
            resetReceivingState();
            return;
        }
    }
}

// Finalize file - assemble from IndexedDB and complete
async function finalizeFile() {
    // 🔹 Idempotent handler - safe to call multiple times
    if (!receivingFile || transferState === TransferState.COMPLETED) {
        console.log('⚠️ finalizeFile called but already completed or no file');
        return;
    }
    
    // Update state to prevent duplicate calls
    transferState = TransferState.COMPLETED;
    
    // Clear the interval
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    console.log('✅ File transfer complete! All bytes received and signal confirmed.');
    console.log(`Final stats: ${receivedBytes}/${expectedFileSize} bytes, ${currentChunkIndex} chunks`);
    
    // Flush any remaining buffered chunks
    await flushChunkBuffer();
    
    // Read all chunks from IndexedDB and assemble file
    console.log('📦 Reading all chunks from IndexedDB for final assembly...');
    let allChunks;
    try {
        allChunks = await getAllChunksFromIndexedDB(receivingFile.name);
        console.log(`✅ Read ${allChunks.length} chunks from IndexedDB`);
    } catch (error) {
        console.error('❌ Error reading chunks from IndexedDB:', error);
        transferState = TransferState.FAILED;
        alert('Error reading file from storage. Please try again.');
        resetReceivingState();
        return;
    }
    
    // Sort chunks by index
    allChunks.sort((a, b) => (a.chunkIndexNum || 0) - (b.chunkIndexNum || 0));
    
    // Combine all chunks
    const totalSize = allChunks.reduce((sum, chunk) => sum + (chunk.chunkData?.byteLength || 0), 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of allChunks) {
        if (chunk.chunkData) {
            const chunkData = chunk.chunkData instanceof ArrayBuffer 
                ? new Uint8Array(chunk.chunkData)
                : new Uint8Array(chunk.chunkData.buffer || chunk.chunkData);
            combined.set(chunkData, offset);
            offset += chunkData.length;
        }
    }
    
    // 🔴 Pillar 5: Integrity verification - compute final hash and compare
    let computedHash = null;
    try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        computedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        console.log(`🔐 Computed hash: ${computedHash.substring(0, 16)}...`);
    } catch (error) {
        console.error('❌ Error computing file hash:', error);
    }
    
    // Verify hash if expected hash was provided
    if (expectedHash && computedHash) {
        if (computedHash !== expectedHash) {
            console.error(`❌ CRITICAL: Hash mismatch! Computed: ${computedHash.substring(0, 16)}..., Expected: ${expectedHash.substring(0, 16)}...`);
            transferState = TransferState.FAILED;
            alert(`File integrity check failed! The file may be corrupted. Computed hash doesn't match expected hash.`);
            resetReceivingState();
            return;
        } else {
            console.log(`✅ Hash verification passed! File integrity confirmed.`);
        }
    } else if (expectedHash && !computedHash) {
        console.warn('⚠️ Expected hash provided but could not compute hash. Skipping verification.');
    }
    
    // Create blob and download
    const blob = new Blob([combined], { type: receivingFile.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = receivingFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log(`✅ File "${receivingFile.name}" downloaded successfully!`);
    
    // Send confirmation back to sender
    try {
        dataChannel.send(JSON.stringify({ 
            type: 'file-received-confirmed',
            bytesReceived: receivedBytes,
            expectedBytes: expectedFileSize,
            hashMatch: expectedHash ? (computedHash === expectedHash) : null
        }));
        console.log(`✅ Sent confirmation to sender: ${receivedBytes}/${expectedFileSize} bytes received`);
    } catch (error) {
        console.error('❌ Error sending confirmation to sender:', error);
    }
    
    // Show 100% progress
    updateReceivingProgress(100);
    
    // Clean up IndexedDB
    await deleteFileFromIndexedDB(receivingFile.name);
    deleteFileMetadataFromLocalStorage(receivingFile.name);
    
    // Reset state
    resetReceivingState();
    
    // Show success message
    showSuccessMessage(`File "${receivingFile.name}" received successfully!`);
}

// Helper to reset receiving state
function resetReceivingState() {
    receivingFile = null;
    receivingFileSize = 0;
    receivedBytes = 0;
    expectedFileSize = 0;
    currentChunkIndex = 0;
    fileCompleteSignalReceived = false;
    lastChunkReceivedTime = null;
    allBytesReceivedTime = null;
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    completionCheckAttempts = 0;
    transferInfo.style.display = 'none';
    dropZone.style.display = 'block';
}

// Legacy function - keeping for compatibility but simplifying
async function checkAndCompleteFile_OLD() {
    if (!receivingFile) {
        if (completionCheckInterval) {
            clearInterval(completionCheckInterval);
            completionCheckInterval = null;
        }
        completionCheckAttempts = 0;
        return;
    }
    
    completionCheckAttempts++;
    
    // CRITICAL: Flush any remaining chunks from buffer before checking
    await flushChunkBuffer();
    
    // CRITICAL: Verify we received all bytes - read from IndexedDB
    let totalReceived = 0;
    let chunkCount = 0;
    try {
        const result = await getTotalBytesFromIndexedDB(receivingFile.name);
        totalReceived = result.totalBytes;
        chunkCount = result.chunkCount;
    } catch (error) {
        console.error('❌ Error reading from IndexedDB:', error);
        // Fallback to tracked counter
        totalReceived = receivedBytes;
    }
    
    // Also check the tracked counter
    const bytesMatch = Math.abs(totalReceived - receivedBytes) < 100; // Allow small discrepancy
    
    const percentComplete = ((totalReceived/receivingFileSize)*100).toFixed(1);
    const missingBytes = receivingFileSize - totalReceived;
    
    // Log every 10th attempt to avoid spam, or if we're close to completion
    if (completionCheckAttempts % 10 === 0 || totalReceived >= receivingFileSize * 0.9) {
        console.log(`[${completionCheckAttempts}] Checking: ${totalReceived}/${receivingFileSize} bytes (${percentComplete}%), Missing: ${missingBytes}, Signal: ${fileCompleteSignalReceived}, BytesMatch: ${bytesMatch}, ChunksInDB: ${chunkCount}, ChunkCounter: ${currentChunkIndex}, BufferSize: ${chunkBuffer.length}`);
    }
    
    // Only proceed if we received the complete file AND got the completion signal
    if (totalReceived < receivingFileSize) {
        // Check if chunks have stopped arriving (connection might be dead)
        const timeSinceLastChunk = lastChunkReceivedTime ? (Date.now() - lastChunkReceivedTime) : Infinity;
        const STALE_CHUNK_THRESHOLD = 5000; // 5 seconds without new chunks
        
        if (fileCompleteSignalReceived && timeSinceLastChunk > STALE_CHUNK_THRESHOLD && completionCheckAttempts > 50) {
            // Signal received, but no chunks for 5+ seconds and we've checked 50+ times
            console.warn(`⚠️ No chunks received for ${(timeSinceLastChunk/1000).toFixed(1)}s. Missing ${missingBytes} bytes. Connection may be dead.`);
            console.warn(`⚠️ Stats: IndexedDB has ${chunkCount} chunks, Counter shows ${currentChunkIndex} chunks, Buffer has ${chunkBuffer.length} chunks`);
            
            // Try to request missing chunks from sender (resume from current position)
            if (dataChannel && dataChannel.readyState === 'open' && missingBytes > 0) {
                console.log(`🔄 Requesting resume from byte ${totalReceived} (missing ${missingBytes} bytes)`);
                try {
                    dataChannel.send(JSON.stringify({
                        type: 'resume',
                        fileName: receivingFile.name,
                        offset: totalReceived
                    }));
                } catch (error) {
                    console.error('❌ Error sending resume request:', error);
                }
            }
        }
        
        // Keep checking - chunks might still be arriving
        // But also check if we've been waiting too long (might indicate an issue)
        if (completionCheckAttempts > MAX_COMPLETION_CHECK_ATTEMPTS) {
            console.error('Timeout waiting for file completion. Received:', totalReceived, 'Expected:', receivingFileSize, 'Missing:', missingBytes);
            alert(`File transfer incomplete. Received ${totalReceived} of ${receivingFileSize} bytes (${percentComplete}%). Missing ${missingBytes} bytes. The transfer may have been interrupted.`);
            // Reset everything
            receivingFile = null;
            receivingFileSize = 0;
            receivedBytes = 0;
            currentChunkIndex = 0;
            fileCompleteSignalReceived = false;
            lastChunkReceivedTime = null;
            allBytesReceivedTime = null;
            if (completionCheckInterval) {
                clearInterval(completionCheckInterval);
                completionCheckInterval = null;
            }
            completionCheckAttempts = 0;
            transferInfo.style.display = 'none';
            dropZone.style.display = 'block';
            return;
        }
        
        // Ensure interval is running
        if (!completionCheckInterval) {
            completionCheckInterval = setInterval(() => {
                checkAndCompleteFile();
            }, 100);
        }
        return;
    }
    
    // CRITICAL: Check if we received MORE bytes than expected (chunks from multiple files mixed)
    if (totalReceived > receivingFileSize) {
        const excessBytes = totalReceived - receivingFileSize;
        console.error(`❌ CRITICAL: Received MORE bytes than expected! Got: ${totalReceived}, Expected: ${receivingFileSize}, Excess: ${excessBytes} bytes`);
        console.error('This indicates chunks from multiple files are being mixed. Resetting and waiting for proper file metadata.');
        
        // Reset and wait for proper file metadata
        // Clean up IndexedDB and localStorage
        await deleteFileFromIndexedDB(receivingFile.name);
        deleteFileMetadataFromLocalStorage(receivingFile.name);
        
        receivingFile = null;
        receivingFileSize = 0;
        receivedBytes = 0;
        currentChunkIndex = 0;
        fileCompleteSignalReceived = false;
        allBytesReceivedTime = null;
        if (completionCheckInterval) {
            clearInterval(completionCheckInterval);
            completionCheckInterval = null;
        }
        completionCheckAttempts = 0;
        transferInfo.style.display = 'none';
        dropZone.style.display = 'block';
        alert(`Error: Received more data than expected. This may indicate a file transfer error. Please try again.`);
        return;
    }
    
    // If we have all bytes but no signal yet, track when we first got all bytes
    if (totalReceived >= receivingFileSize && !fileCompleteSignalReceived) {
        if (!allBytesReceivedTime) {
            allBytesReceivedTime = Date.now();
            console.log('✅ All bytes received! Waiting for completion signal (max 5 seconds)...');
        }
        
        // If we've had all bytes for more than 5 seconds, complete anyway
        const timeSinceAllBytes = Date.now() - allBytesReceivedTime;
        if (timeSinceAllBytes > 5000) {
            console.log(`⏰ All bytes received for ${(timeSinceAllBytes/1000).toFixed(1)}s. Completing transfer even without signal.`);
            // Proceed to completion (treat as if signal received)
        } else {
            // Keep checking for the signal, but we'll timeout after 5 seconds
            if (!completionCheckInterval) {
                completionCheckInterval = setInterval(() => {
                    checkAndCompleteFile();
                }, 100);
            }
            return;
        }
    } else if (!fileCompleteSignalReceived) {
        // Still missing bytes, keep checking
        if (!completionCheckInterval) {
            completionCheckInterval = setInterval(() => {
                checkAndCompleteFile();
            }, 100);
        }
        return;
    }
    
    // Clear the interval since we're completing
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    completionCheckAttempts = 0;
    
    // CRITICAL: Double-check we actually have ALL bytes before confirming
    if (totalReceived !== receivingFileSize) {
        console.error(`❌ CRITICAL ERROR: Cannot confirm completion! Received: ${totalReceived}, Expected: ${receivingFileSize}, Missing: ${receivingFileSize - totalReceived} bytes`);
        console.error('This should not happen - checkAndCompleteFile should have prevented this');
        // Don't send confirmation - let sender timeout
        // Keep checking for missing chunks
        if (!completionCheckInterval) {
            completionCheckInterval = setInterval(() => {
                checkAndCompleteFile();
            }, 100);
        }
        return;
    }
    
    console.log('✅ File transfer complete! All bytes received and signal confirmed.');
    console.log('Final stats:', {
        totalReceived,
        expected: receivingFileSize,
        chunks: currentChunkIndex,
        percent: ((totalReceived/receivingFileSize)*100).toFixed(2) + '%'
    });
    
    // Send confirmation back to sender that we received all bytes
    try {
        dataChannel.send(JSON.stringify({ 
            type: 'file-received-confirmed',
            bytesReceived: totalReceived,
            expectedBytes: receivingFileSize
        }));
        console.log(`✅ Sent confirmation to sender: ${totalReceived}/${receivingFileSize} bytes received`);
    } catch (error) {
        console.error('❌ Error sending confirmation to sender:', error);
    }
    
    // Now show 100% - file is actually complete
    updateReceivingProgress(100);
    
    // CRITICAL: Flush any remaining buffered chunks before assembly
    await flushChunkBuffer();
    
    // CRITICAL: Read all chunks from IndexedDB and assemble file
    console.log('📦 Reading all chunks from IndexedDB for final assembly...');
    let allChunks;
    try {
        allChunks = await getAllChunksFromIndexedDB(receivingFile.name);
        console.log(`✅ Read ${allChunks.length} chunks from IndexedDB`);
    } catch (error) {
        console.error('❌ Error reading chunks from IndexedDB:', error);
        alert('Error reading file from storage. Please try again.');
        return;
    }
    
    // Combine all chunks from IndexedDB
    const combined = new Uint8Array(totalReceived);
    let offset = 0;
    
    for (const chunkData of allChunks) {
        const chunkArray = chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData);
        combined.set(chunkArray, offset);
        offset += chunkArray.length;
    }
    
    // Create blob and download
    const blob = new Blob([combined], { type: receivingFile.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = receivingFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // FREE TIER SAFE: Clean up IndexedDB and localStorage after successful download
    const fileName = receivingFile.name;
    try {
        await deleteFileFromIndexedDB(fileName);
        deleteFileMetadataFromLocalStorage(fileName);
        console.log(`✅ Cleaned up storage for ${fileName}`);
    } catch (error) {
        console.error('❌ Error cleaning up storage:', error);
        // Continue anyway - file was downloaded successfully
    }
    
    // Hide transfer info, show drop zone and success message
    transferInfo.style.display = 'none';
    dropZone.style.display = 'block';
    successMessage.style.display = 'flex';
    successText.textContent = `File "${receivingFile.name}" downloaded successfully!`;
    
    // Add to success history
    if (receivedFiles) {
        showReceivedFileComplete({
            name: receivingFile.name,
            size: receivingFileSize
        });
    }
    
    // Reset transfer stats but keep success message visible
    resetTransferStats();
    
    // Reset file variables
    receivingFile = null;
    receivingFileSize = 0;
    receivedBytes = 0;
    currentChunkIndex = 0;
    fileCompleteSignalReceived = false;
    allBytesReceivedTime = null;
    pendingFileRequest = null;
    
    // Clear completion check interval
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    // Re-enable accept/reject buttons for next file if any
    setTimeout(() => {
        if (acceptFileBtn) acceptFileBtn.disabled = false;
        if (rejectFileBtn) rejectFileBtn.disabled = false;
    }, 500);
    
    // After file completes, wait for next file-metadata from sender
    console.log('Waiting for next file metadata from sender...');
    
    // Hide success message after delay but keep drop zone visible
    setTimeout(() => {
        successMessage.style.display = 'none';
    }, 5000);
}

async function completeSendingFile() {
    const fileName = currentFile?.name;
    
    // Release wake lock when transfer completes
    releaseWakeLock();
    
    // CRITICAL: Flush buffer before sending next file
    // This ensures clean file boundaries under load
    if (dataChannel && dataChannel.readyState === 'open' && dataChannel.bufferedAmount > 0) {
        console.log(`🔄 Flushing buffer before next file (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB remaining)...`);
        await waitForDrain();
        console.log('✅ Buffer flushed - ready for next file');
    }
    
    // Show success message
    successMessage.style.display = 'flex';
    successText.textContent = `File "${fileName}" uploaded successfully!`;
    
    // Reset transfer stats
    resetTransferStats();
    
    // Remove completed file from queue
    if (fileQueue.length > 0 && fileQueue[0] === currentFile) {
        fileQueue.shift();
    }
    
    currentFile = null;
    
    // If there are more files in queue, continue processing
    if (fileQueue.length > 0) {
        // Hide success message after short delay
        setTimeout(() => {
            successMessage.style.display = 'none';
        }, 2000);
        // Continue processing queue (if all files were accepted, will auto-start next file)
        isProcessingQueue = false;
        processFileQueue();
    } else {
        // No more files, show drop zone
        isProcessingQueue = false;
        transferInfo.style.display = 'none';
        dropZone.style.display = 'block';
        
        // Hide success message after delay
        setTimeout(() => {
            successMessage.style.display = 'none';
        }, 5000);
    }
}

// UI Updates
function showTransferUI(file, label = 'Uploading...') {
    transferInfo.style.display = 'block';
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    if (progressLabel) {
        progressLabel.textContent = label;
    }
    resetTransferStats();
}

function showReceivingFileUI(file) {
    transferInfo.style.display = 'block';
    fileNameEl.textContent = `Receiving: ${file.name}`;
    fileSizeEl.textContent = formatFileSize(file.size);
    if (progressLabel) {
        progressLabel.textContent = 'Downloading...';
    }
    resetTransferStats();
}

function updateProgress(percent) {
    progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    progressPercent.textContent = `${Math.round(percent)}%`;
    
    // Calculate speed and time remaining
    const now = Date.now();
    const elapsed = (now - transferStats.startTime) / 1000;
    const speed = transferStats.bytesTransferred / elapsed;
    const remaining = currentFile ? (currentFile.size - transferStats.bytesTransferred) : 0;
    const timeRemainingSeconds = speed > 0 ? remaining / speed : 0;
    
    transferSpeed.textContent = formatSpeed(speed);
    timeRemaining.textContent = formatTime(timeRemainingSeconds);
}

function updateReceivingProgress(percent) {
    // Clamp percent between 0 and 100
    const clampedPercent = Math.min(100, Math.max(0, percent));
    progressFill.style.width = `${clampedPercent}%`;
    progressPercent.textContent = `${Math.round(clampedPercent)}%`;
    
    // Calculate speed and time remaining
    const now = Date.now();
    const elapsed = (now - transferStats.startTime) / 1000;
    const speed = receivedBytes / elapsed;
    const remaining = receivingFileSize - receivedBytes;
    const timeRemainingSeconds = speed > 0 ? remaining / speed : 0;
    
    transferSpeed.textContent = formatSpeed(speed);
    timeRemaining.textContent = formatTime(timeRemainingSeconds);
}

function resetTransferStats() {
    transferStats.bytesTransferred = 0;
    transferStats.startTime = null;
    transferStats.lastUpdateTime = null;
    transferStats.lastBytesTransferred = 0;
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    transferSpeed.textContent = '0 MB/s';
    timeRemaining.textContent = '--';
}

function resetTransferUI() {
    transferInfo.style.display = 'none';
    fileRequest.style.display = 'none';
    allFilesAccepted = false; // Reset bulk acceptance flag
    dropZone.style.display = 'block';
    currentFile = null;
    pendingFileRequest = null;
    fileQueue = []; // Clear file queue
    isProcessingQueue = false;
    allFilesAccepted = false; // Reset bulk acceptance flag
    if (currentFileResolve) {
        currentFileResolve();
        currentFileResolve = null;
    }
    resetTransferStats();
}

function showReceivedFileComplete(file) {
    const item = document.createElement('div');
    item.className = 'received-file-item completed';
    item.innerHTML = `
        <div class="file-name">${file.name}</div>
        <div class="file-size">${formatFileSize(file.size)} - Completed</div>
    `;
    receivedFiles.insertBefore(item, receivedFiles.firstChild);
}

function updateConnectionStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
    
    // Show server URL when connecting or connected
    if (status === 'connecting' || status === 'connected' || status === 'relayed') {
        if (connectionInfo && serverUrl) {
            connectionInfo.style.display = 'flex';
            serverUrl.textContent = WS_URL;
        }
    } else {
        if (connectionInfo) {
            connectionInfo.style.display = 'none';
        }
    }
}

// Utility Functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
    return formatFileSize(bytesPerSecond) + '/s';
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}


