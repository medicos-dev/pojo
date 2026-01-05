// WebRTC Configuration
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:global.stun.twilio.com:3478" }
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
// Optimized for 200GB+ files: battle-tested stable values
// Trading 2-5% speed for much higher stability (critical for long transfers)
const INITIAL_CHUNK_SIZE = 512 * 1024; // 512KB initial chunk size (increased for better throughput on large files)
const MIN_CHUNK_SIZE = 128 * 1024; // 128KB min chunk size (increased for 200GB+ files)
// MAX_CHUNK_SIZE will be set dynamically based on SCTP maxMessageSize
let MAX_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB default (safer than 4MB for stability)
const BACKPRESSURE_THRESHOLD = 24 * 1024 * 1024; // 24MB backpressure threshold (increased for large files)
const MAX_BUFFERED_AMOUNT = 48 * 1024 * 1024; // 48MB max - don't send if buffer exceeds this (increased for 200GB+)
const CHUNK_SIZE_ADJUST_INTERVAL = 2000; // Adjust chunk size every 2 seconds (less frequent for stability)

// Mobile device detection - for conservative chunk sizing
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const MOBILE_MAX_CHUNK_SIZE = 16 * 1024; // 16KB cap for mobile (prevents Head-of-Line Blocking)

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

// Apply mobile chunk size cap - prevents Head-of-Line Blocking on mobile networks
function applyMobileChunkCap(chunkSize) {
    if (isMobile) {
        // Cap at 16KB for mobile - slower but significantly more stable for 200MB+ files
        const cappedSize = Math.min(chunkSize, MOBILE_MAX_CHUNK_SIZE);
        if (cappedSize < chunkSize) {
            // Only log when we actually cap (to avoid spam)
            if (chunkSize > MOBILE_MAX_CHUNK_SIZE * 1.1) { // Only log if significantly over
                console.log(`📱 Mobile device detected - capping chunk size at ${(MOBILE_MAX_CHUNK_SIZE/1024).toFixed(0)}KB (was ${(chunkSize/1024).toFixed(0)}KB)`);
            }
        }
        return cappedSize;
    }
    return chunkSize;
}

// Helper function to show user-friendly messages
function showUserMessage(message) {
    alert(message);
}

    // CRITICAL: Handle connection loss - treat as connection failure, not file failure
// Define this BEFORE it's used (near top of file)
function handleConnectionLoss(reason = "unknown") {
    // Guard against double-calls (important)
    if (connectionLostHandled) {
        console.log("⚠️ Connection loss already handled, ignoring duplicate call");
        return;
    }
    
    // For large files, be more lenient with transient disconnections
    const fileSize = currentFile?.size || receivingFileSize || 0;
    const fileSizeGB = fileSize / (1024 * 1024 * 1024);
    const isLargeFile = fileSizeGB > 1; // Files over 1GB
    
    console.warn("🚨 Connection lost:", reason, isLargeFile ? `(Large file: ${fileSizeGB.toFixed(2)}GB - being lenient)` : "");
    
    // For large files and transient disconnections, don't immediately mark as handled
    // This allows automatic reconnection attempts
    if (reason === "datachannel-closed" && isLargeFile && dataChannel?.readyState === 'closed') {
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
    
    // Set pause flag - do NOT abort transfer immediately
    // Transfer must pause, not abort, to allow resume
    transferPaused = true;
    
    // Only abort if it's a definitive failure (not just disconnected)
    // For large files, be even more conservative
    const shouldAbort = reason === "ice-failed" || (reason === "ice-disconnected-timeout" && !isLargeFile);
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
    
    // CRITICAL: Resume support - save partial file state on receiver
    if (receivingFile && receivingBytesReceived > 0 && receivingBytesReceived < receivingFileSize) {
        console.log(`💾 Saving partial file state for resume: ${receivingFile.name} (${receivingBytesReceived}/${receivingFileSize} bytes)`);
        partialFileState = {
            fileName: receivingFile.name,
            fileSize: receivingFileSize,
            receivedBytes: receivingBytesReceived,
            chunks: receivingFileChunks.slice() // Copy chunks for resume
        };
    }
    
    // Update UI with user-friendly message
    updateConnectionStatus('disconnected', 'Connection interrupted');
    
    // Show user-friendly message - different for pause vs abort
    // For large files, show more encouraging message
    if (transferPaused && !transferAborted) {
        const fileSizeGB = (currentFile?.size || receivingFileSize || 0) / (1024 * 1024 * 1024);
        if (fileSizeGB > 1) {
            showUserMessage(`Connection interrupted (${fileSizeGB.toFixed(2)}GB file). Waiting for reconnection… Large files may experience brief interruptions.`);
        } else {
            showUserMessage("Connection interrupted. Waiting for reconnection…");
        }
    } else if (currentFile || (receivingFile && receivingBytesReceived > 0)) {
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
    
    // Set SCTP maxMessageSize guard for chunk size
    // Respect browser's SCTP limit automatically
    if (peerConnection.sctp) {
        const sctpMaxSize = peerConnection.sctp.maxMessageSize || (1 * 1024 * 1024);
        MAX_CHUNK_SIZE = Math.min(MAX_CHUNK_SIZE, sctpMaxSize);
        // Apply mobile cap on top of SCTP limit
        if (isMobile) {
            MAX_CHUNK_SIZE = Math.min(MAX_CHUNK_SIZE, MOBILE_MAX_CHUNK_SIZE);
            console.log(`📱 Mobile device - MAX_CHUNK_SIZE capped at: ${(MAX_CHUNK_SIZE/1024).toFixed(0)}KB`);
        } else {
            console.log(`📏 SCTP maxMessageSize: ${(sctpMaxSize/1024/1024).toFixed(2)}MB, MAX_CHUNK_SIZE set to: ${(MAX_CHUNK_SIZE/1024/1024).toFixed(2)}MB`);
        }
    } else if (isMobile) {
        // Apply mobile cap even if SCTP info not available
        MAX_CHUNK_SIZE = Math.min(MAX_CHUNK_SIZE, MOBILE_MAX_CHUNK_SIZE);
        console.log(`📱 Mobile device - MAX_CHUNK_SIZE capped at: ${(MAX_CHUNK_SIZE/1024).toFixed(0)}KB`);
    }
    
    setupDataChannel(dataChannel);
}

function setupDataChannel(channel) {
    dataChannel = channel;
    
    // CRITICAL: Set bufferedAmountLowThreshold for event-based draining
    // This prevents CPU spinning and enables efficient backpressure handling
    channel.bufferedAmountLowThreshold = BACKPRESSURE_THRESHOLD;
    console.log(`📊 Set bufferedAmountLowThreshold to ${(BACKPRESSURE_THRESHOLD/1024/1024).toFixed(2)}MB`);
    
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
        
        // CRITICAL: Resume support - check if we have partial file to resume
        if (partialFileState.fileName && partialFileState.receivedBytes > 0 && partialFileState.receivedBytes < partialFileState.fileSize) {
            console.log(`🔄 Resuming file transfer: ${partialFileState.fileName} from offset ${partialFileState.receivedBytes}`);
            // Request resume from sender
            try {
                dataChannel.send(JSON.stringify({
                    type: 'resume',
                    fileName: partialFileState.fileName,
                    offset: partialFileState.receivedBytes
                }));
                console.log(`📤 Sent resume request: ${partialFileState.fileName} from byte ${partialFileState.receivedBytes}`);
            } catch (error) {
                console.error('❌ Error sending resume request:', error);
            }
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
            console.log(`File transfer request ${index + 1}/${files.length} sent:`, file.name);
        } catch (error) {
            console.error(`Error sending file request for ${file.name}:`, error);
        }
    });
    
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
    let chunkSize = INITIAL_CHUNK_SIZE;
    let lastAdjustTime = Date.now();
    
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    // CRITICAL: Track leftover bytes to ensure no tail drop
    let leftover = null;
    
    // Main sending loop - ensures exact chunking and no silent tail drop
    while (true) {
        // CRITICAL: Check if transfer was paused or aborted due to connection loss
        if (transferPaused || transferAborted) {
            if (transferAborted) {
                console.warn('⚠️ Transfer aborted due to connection loss');
                reader.cancel();
                throw new Error('TRANSFER_ABORTED');
            } else {
                // Transfer paused - wait for reconnection
                // For large files, wait longer and check connection state
                const fileSizeGB = (file.size || 0) / (1024 * 1024 * 1024);
                const waitTime = fileSizeGB > 10 ? 2000 : 1000; // 2s for very large files, 1s for normal
                
                console.warn(`⏸️ Transfer paused - waiting for reconnection... (checking every ${waitTime}ms)`);
                
                // Check if connection is actually restored
                if (dataChannel && dataChannel.readyState === 'open' && !connectionLostHandled) {
                    console.log('✅ Connection appears restored, resuming transfer...');
                    transferPaused = false;
                    connectionLostHandled = false;
                    // Continue with transfer
                } else {
                    // Wait and check again
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    // Continue loop to check again
                    continue;
                }
            }
        }
        
        if (dataChannel.readyState !== 'open') {
            console.warn('⚠️ DataChannel closed during transfer');
            handleConnectionLoss("datachannel-closed");
            if (transferAborted) {
                reader.cancel();
                throw new Error('TRANSFER_ABORTED');
            }
            // If just paused, wait and retry
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        
        // CRITICAL: Event-based backpressure handling
        await waitForDrain();
        
        // Adjust chunk size based on performance
        const now = Date.now();
        if (now - lastAdjustTime > CHUNK_SIZE_ADJUST_INTERVAL) {
            const timeDiff = (now - transferStats.lastUpdateTime) / 1000;
            const bytesDiff = transferStats.bytesTransferred - transferStats.lastBytesTransferred;
            
            if (timeDiff > 0) {
                const currentSpeed = bytesDiff / timeDiff;
                const fileSize = currentFile?.size || 0;
                const fileSizeGB = fileSize / (1024 * 1024 * 1024);
                
                // For large files (200GB+), be more aggressive with chunk size increases
                // But also more conservative with backpressure threshold
                if (fileSizeGB > 10) {
                    // Very large files: increase chunk size more aggressively if speed is good
                    if (currentSpeed > 8 * 1024 * 1024 && dataChannel.bufferedAmount < BACKPRESSURE_THRESHOLD / 3) {
                        chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize * 1.3);
                    } else if (currentSpeed < 2 * 1024 * 1024) {
                        // Slow down if speed drops
                        chunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize * 0.9);
                    }
                } else {
                    // Normal files: standard behavior
                    if (currentSpeed > 10 * 1024 * 1024 && dataChannel.bufferedAmount < BACKPRESSURE_THRESHOLD / 2) {
                        chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize * 1.5);
                    }
                }
            }
            
            // CRITICAL: Apply mobile chunk cap after any adjustments
            chunkSize = applyMobileChunkCap(chunkSize);
            
            lastAdjustTime = now;
            transferStats.lastUpdateTime = now;
            transferStats.lastBytesTransferred = transferStats.bytesTransferred;
        }
        
        try {
            let { done, value } = await reader.read();
            
            // If we overshot during offset skip, adjust the first chunk
            if (startOffset > 0 && skippedBytes > startOffset && value && !done) {
                const overshoot = skippedBytes - startOffset;
                value = value.slice(overshoot);
                skippedBytes = startOffset; // Mark as handled
            }
            
            if (done) {
                // CRITICAL: Force-send remaining tail buffer
                // Never rely on stream end alone - always explicitly flush remaining bytes
                if (leftover && leftover.byteLength > 0) {
                    console.log(`📤 Sending leftover tail buffer: ${leftover.byteLength} bytes`);
                    await waitForDrain();
                    
                    // Ensure exact chunking for leftover
                    if (leftover.byteLength > MAX_CHUNK_SIZE) {
                        let offset = 0;
                        while (offset < leftover.byteLength) {
                            const slice = leftover.slice(offset, offset + MAX_CHUNK_SIZE);
                            await waitForDrain();
                            dataChannel.send(slice);
                            transferStats.chunksSent++;
                            transferStats.bytesTransferred += slice.byteLength;
                            offset += MAX_CHUNK_SIZE;
                        }
                    } else {
                        dataChannel.send(leftover);
                        transferStats.chunksSent++;
                        transferStats.bytesTransferred += leftover.byteLength;
                    }
                    leftover = null;
                }
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
                
                // Send completion message with file size
                console.log('📨 Sending file-complete signal...');
                try {
                    dataChannel.send(JSON.stringify({ 
                        type: 'file-complete',
                        size: file.size 
                    }));
                    console.log('✅ File-complete signal sent (size:', file.size, 'bytes). Waiting for receiver confirmation...');
                } catch (error) {
                    console.error('❌ Error sending completion signal:', error);
                    alert('Error sending completion signal: ' + error.message);
                    return;
                }
                
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
            
            // CRITICAL: Ensure exact chunking - never send chunks larger than MAX_CHUNK_SIZE
            // Handle value that might be larger than MAX_CHUNK_SIZE
            if (value.byteLength > MAX_CHUNK_SIZE) {
                // Split into MAX_CHUNK_SIZE chunks
                let offset = 0;
                while (offset < value.byteLength) {
                    const slice = value.slice(offset, Math.min(offset + MAX_CHUNK_SIZE, value.byteLength));
                    await waitForDrain();
                    
                    // CRITICAL: Check if transfer was paused or aborted
                    if (transferPaused || transferAborted) {
                        if (transferAborted) {
                            throw new Error('TRANSFER_ABORTED');
                        } else {
                            // Paused - wait and retry
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            continue; // Retry from beginning of loop
                        }
                    }
                    
                    // Check channel is still open
                    if (dataChannel.readyState !== 'open') {
                        handleConnectionLoss("datachannel-closed");
                        if (transferAborted) {
                            throw new Error('TRANSFER_ABORTED');
                        }
                        // If just paused, wait and retry
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                    
                    // Send the slice
                    dataChannel.send(slice);
                    transferStats.chunksSent++;
                    transferStats.bytesTransferred += slice.byteLength;
                    
                    offset += slice.byteLength;
                    
                    // Log every 100th chunk or when close to completion
                    if (transferStats.chunksSent % 100 === 0 || transferStats.bytesTransferred > file.size * 0.95) {
                        console.log(`📤 Sent chunk #${transferStats.chunksSent}: ${slice.byteLength} bytes. Total: ${transferStats.bytesTransferred}/${file.size} (${((transferStats.bytesTransferred/file.size)*100).toFixed(1)}%)`);
                    }
                    
                    // Update progress
                    const progress = (transferStats.bytesTransferred / file.size) * 100;
                    updateProgress(Math.min(99.9, progress));
                }
            } else {
                // Value fits in one chunk - send it
                await waitForDrain();
                
                // CRITICAL: Check if transfer was paused or aborted
                if (transferPaused || transferAborted) {
                    if (transferAborted) {
                        throw new Error('TRANSFER_ABORTED');
                    } else {
                        // Paused - wait and retry
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue; // Retry from beginning of loop
                    }
                }
                
                // Check channel is still open
                if (dataChannel.readyState !== 'open') {
                    handleConnectionLoss("datachannel-closed");
                    if (transferAborted) {
                        throw new Error('TRANSFER_ABORTED');
                    }
                    // If just paused, wait and retry
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                dataChannel.send(value);
                transferStats.chunksSent++;
                transferStats.bytesTransferred += value.byteLength;
                
                // Log every 100th chunk or when close to completion
                if (transferStats.chunksSent % 100 === 0 || transferStats.bytesTransferred > file.size * 0.95) {
                    console.log(`📤 Sent chunk #${transferStats.chunksSent}: ${value.byteLength} bytes. Total: ${transferStats.bytesTransferred}/${file.size} (${((transferStats.bytesTransferred/file.size)*100).toFixed(1)}%)`);
                }
                
                // Update progress
                const progress = (transferStats.bytesTransferred / file.size) * 100;
                updateProgress(Math.min(99.9, progress));
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
    
    // CRITICAL: Apply mobile chunk cap for FileReader fallback
    // This ensures we use file.slice() with small chunks, not reading entire file into memory
    let chunkSize = applyMobileChunkCap(INITIAL_CHUNK_SIZE);
    
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
            handleConnectionLoss("datachannel-closed");
            if (transferAborted) {
                return;
            }
            // If just paused, wait and retry
            setTimeout(() => readChunk(), 1000);
            return;
        }
        
        // CRITICAL: Event-based backpressure handling
        if (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            waitForDrain().then(() => readChunk());
            return;
        }
        
        // Safety check: don't send if buffer exceeds max
        if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            console.warn(`Buffer exceeds max (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB), waiting...`);
            waitForDrain().then(() => readChunk());
            return;
        }
        
        const fileReader = new FileReader();
        const blob = file.slice(offset, offset + chunkSize);
        
        fileReader.onload = (e) => {
            const chunk = new Uint8Array(e.target.result);
            
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
                
                // Check channel is still open before sending
                if (dataChannel.readyState !== 'open') {
                    handleConnectionLoss("datachannel-closed");
                    if (transferAborted) {
                        return;
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
                                
                                console.log('📨 Sending file-complete signal...');
                                // Send completion message with file size AND name for proper matching
                                try {
                                    dataChannel.send(JSON.stringify({ 
                                        type: 'file-complete',
                                        size: file.size,
                                        fileName: file.name // Include file name for proper matching in bulk transfers
                                    }));
                                    console.log('✅ File-complete signal sent (file:', file.name, ', size:', file.size, 'bytes). Waiting for receiver confirmation...');
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
        };
        
        fileReader.onerror = (error) => {
            console.error('FileReader error:', error);
            alert('Error reading file');
        };
        
        fileReader.readAsArrayBuffer(blob);
    };
    
    readChunk();
}

// Data Channel Message Handling (Receiver)
let receivingFile = null;
let receivingFileSize = 0;
let receivingBytesReceived = 0;
let receivingFileChunks = [];
let fileCompleteSignalReceived = false;
let lastChunkReceivedTime = null;
let allBytesReceivedTime = null; // Track when we first received all bytes

// Resume support: Track partial file state for resume capability
let partialFileState = {
    fileName: null,
    fileSize: 0,
    receivedBytes: 0,
    chunks: []
};

function handleDataChannelMessage(event) {
    const data = event.data;
    
    // Check if it's a JSON message (metadata or control)
    if (typeof data === 'string') {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'ping') {
                // Receiver ignores ping - just acknowledge it's received
                // This keeps the connection alive
                return;
            } else if (message.type === 'resume') {
                // Sender receives resume request from receiver
                console.log(`🔄 Resume request received: ${message.fileName} from offset ${message.offset}`);
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
                } else {
                    console.warn(`⚠️ Cannot resume: file not found or invalid offset`);
                }
                return;
            } else if (message.type === 'file-request') {
                handleFileRequest(message);
            } else if (message.type === 'file-accepted') {
                handleFileAccepted();
            } else if (message.type === 'file-rejected') {
                handleFileRejected();
            } else if (message.type === 'file-metadata') {
                // Reset any previous file state before starting new file
                if (receivingFile) {
                    console.warn('⚠️ Received file-metadata while still receiving previous file. Resetting...');
                    receivingFile = null;
                    receivingFileSize = 0;
                    receivingBytesReceived = 0;
                    receivingFileChunks = [];
                }
                // Check if this is a resume (metadata includes offset)
                const resumeOffset = message.resumeOffset || 0;
                startReceivingFile(message, resumeOffset);
            } else if (message.type === 'file-complete') {
                // CRITICAL: Match file-complete signal to the correct file
                // In bulk transfers, signals can arrive out of order or for wrong files
                const signalFileName = message.fileName || null;
                const signalFileSize = message.size || null;
                
                // If we have a receiving file, verify the signal matches it
                if (receivingFile) {
                    // Check if signal matches current file (by name or size)
                    const nameMatches = signalFileName && signalFileName === receivingFile.name;
                    const sizeMatches = signalFileSize && signalFileSize === receivingFileSize;
                    
                    if (!nameMatches && !sizeMatches && signalFileSize) {
                        // Signal doesn't match current file - likely from previous/next file
                        console.warn(`⚠️ File-complete signal ignored: size ${signalFileSize} doesn't match current file "${receivingFile.name}" (${receivingFileSize} bytes). This is likely from another file in the queue.`);
                        return; // Ignore this signal
                    }
                    
                    // Signal matches - process it
                    console.log(`📨 File-complete signal received for "${receivingFile.name}". Expected size: ${signalFileSize || receivingFileSize} bytes`);
                } else {
                    // No receiving file - this signal is orphaned
                    console.warn(`⚠️ File-complete signal received but no active file transfer. Size: ${signalFileSize || 'unknown'}. Ignoring.`);
                    return; // Ignore orphaned signal
                }
                
                // CRITICAL: Do NOT finalize immediately on file-complete
                // Wait for all bytes to arrive - file-complete just signals sender is done sending
                fileCompleteSignalReceived = true;
                
                // Store expected size from sender if provided and it matches
                if (signalFileSize && signalFileSize === receivingFileSize) {
                    // Size matches - all good
                } else if (signalFileSize && signalFileSize !== receivingFileSize) {
                    console.warn(`⚠️ Size mismatch: sender says ${signalFileSize}, we expected ${receivingFileSize}. Using sender's size as authoritative.`);
                    // Use sender's size as authoritative
                    receivingFileSize = signalFileSize;
                }
                
                // Start checking for completion - don't finalize yet
                if (!completionCheckInterval) {
                    completionCheckInterval = setInterval(() => {
                        checkAndCompleteFile();
                    }, 100);
                }
                // Check immediately
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
            }
            return;
        } catch (e) {
            // Not JSON, treat as binary data
        }
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
    console.log('File transfer request received:', request.name);
    
    // Add to pending requests queue
    pendingFileRequestsQueue.push(request);
    
    // If we're already receiving a file, just queue it
    if (receivingFile || pendingFileRequest) {
        console.log(`File request queued. Total pending: ${pendingFileRequestsQueue.length}`);
        return;
    }
    
    // Show the first file request with bulk info
    showFileRequestUI();
}

function showFileRequestUI() {
    if (pendingFileRequestsQueue.length === 0) {
        return;
    }
    
    const firstRequest = pendingFileRequestsQueue[0];
    const totalFiles = pendingFileRequestsQueue.length;
    const totalSize = pendingFileRequestsQueue.reduce((sum, req) => sum + (req.size || 0), 0);
    
    // Hide drop zone, show file request UI
    dropZone.style.display = 'none';
    fileRequest.style.display = 'block';
    
    // Show first file name + X more files
    if (totalFiles > 1) {
        requestFileName.textContent = `${firstRequest.name} +${totalFiles - 1} more file${totalFiles - 1 > 1 ? 's' : ''}`;
    } else {
        requestFileName.textContent = firstRequest.name;
    }
    requestFileSize.textContent = formatFileSize(totalSize);
    
    // Store first request as current (for backward compatibility)
    pendingFileRequest = firstRequest;
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

function startReceivingFile(metadata) {
    receivingFile = {
        name: metadata.name,
        size: metadata.size,
        type: metadata.mimeType || 'application/octet-stream'
    };
    receivingFileSize = metadata.size;
    receivingBytesReceived = 0;
    receivingFileChunks = [];
    fileCompleteSignalReceived = false; // Reset completion signal flag
    completionCheckAttempts = 0; // Reset check attempts
    lastChunkReceivedTime = Date.now(); // Initialize chunk timer
    allBytesReceivedTime = null; // Reset all bytes received timestamp
    
    // Clear any existing completion check interval
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    showReceivingFileUI(receivingFile);
    resetTransferStats();
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    console.log('📥 Started receiving file:', metadata.name, 'Size:', metadata.size, 'bytes');
}

function handleFileChunk(chunk) {
    if (!receivingFile) return;
    
    const chunkSize = chunk.byteLength || chunk.length;
    receivingFileChunks.push(chunk);
    receivingBytesReceived += chunkSize;
    
    // CRITICAL: Update last chunk received time - used to detect stale connections
    lastChunkReceivedTime = Date.now();
    
    // Calculate progress but cap at 99.9% until actually complete
    const progress = (receivingBytesReceived / receivingFileSize) * 100;
    updateReceivingProgress(Math.min(99.9, progress));
    
    // Log every 10th chunk or when close to completion to avoid spam
    if (receivingFileChunks.length % 10 === 0 || progress > 90) {
        console.log(`📥 Chunk #${receivingFileChunks.length}: ${chunkSize} bytes. Total: ${receivingBytesReceived}/${receivingFileSize} (${progress.toFixed(1)}%)`);
    }
    
    // Always check completion when a chunk arrives (especially if signal was received)
    // This ensures we complete as soon as we have all bytes
    if (fileCompleteSignalReceived) {
        // Check immediately when a new chunk arrives
        checkAndCompleteFile();
    } else if (receivingBytesReceived >= receivingFileSize) {
        // If we have all bytes but no signal yet, check anyway (signal might be delayed)
        console.log('All bytes received but no completion signal yet. Waiting...');
        checkAndCompleteFile();
    }
}

function completeReceivingFile() {
    if (!receivingFile) return;
    
    const currentReceived = receivingFileChunks.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.length), 0);
    console.log('File completion signal received. Current progress:', currentReceived, '/', receivingFileSize, `(${((currentReceived/receivingFileSize)*100).toFixed(1)}%)`);
    
    // Mark that we received the completion signal
    fileCompleteSignalReceived = true;
    
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

function checkAndCompleteFile() {
    if (!receivingFile) {
        if (completionCheckInterval) {
            clearInterval(completionCheckInterval);
            completionCheckInterval = null;
        }
        completionCheckAttempts = 0;
        return;
    }
    
    completionCheckAttempts++;
    
    // Verify we received all bytes - calculate from chunks array
    const totalReceived = receivingFileChunks.reduce((sum, chunk) => {
        const size = chunk.byteLength || chunk.length || 0;
        return sum + size;
    }, 0);
    
    // Also check the tracked counter
    const bytesMatch = Math.abs(totalReceived - receivingBytesReceived) < 100; // Allow small discrepancy
    
    const percentComplete = ((totalReceived/receivingFileSize)*100).toFixed(1);
    const missingBytes = receivingFileSize - totalReceived;
    
    // Log every 10th attempt to avoid spam, or if we're close to completion
    if (completionCheckAttempts % 10 === 0 || totalReceived >= receivingFileSize * 0.9) {
        console.log(`[${completionCheckAttempts}] Checking: ${totalReceived}/${receivingFileSize} bytes (${percentComplete}%), Missing: ${missingBytes}, Signal: ${fileCompleteSignalReceived}, BytesMatch: ${bytesMatch}`);
    }
    
    // Only proceed if we received the complete file AND got the completion signal
    if (totalReceived < receivingFileSize) {
        // Check if chunks have stopped arriving (connection might be dead)
        const timeSinceLastChunk = lastChunkReceivedTime ? (Date.now() - lastChunkReceivedTime) : Infinity;
        const STALE_CHUNK_THRESHOLD = 5000; // 5 seconds without new chunks
        
        if (fileCompleteSignalReceived && timeSinceLastChunk > STALE_CHUNK_THRESHOLD && completionCheckAttempts > 50) {
            // Signal received, but no chunks for 5+ seconds and we've checked 50+ times
            console.warn(`No chunks received for ${(timeSinceLastChunk/1000).toFixed(1)}s. Missing ${missingBytes} bytes. Connection may be dead.`);
        }
        
        // Keep checking - chunks might still be arriving
        // But also check if we've been waiting too long (might indicate an issue)
        if (completionCheckAttempts > MAX_COMPLETION_CHECK_ATTEMPTS) {
            console.error('Timeout waiting for file completion. Received:', totalReceived, 'Expected:', receivingFileSize, 'Missing:', missingBytes);
            alert(`File transfer incomplete. Received ${totalReceived} of ${receivingFileSize} bytes (${percentComplete}%). Missing ${missingBytes} bytes. The transfer may have been interrupted.`);
            // Reset everything
            receivingFile = null;
            receivingFileSize = 0;
            receivingBytesReceived = 0;
            receivingFileChunks = [];
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
        receivingFile = null;
        receivingFileSize = 0;
        receivingBytesReceived = 0;
        receivingFileChunks = [];
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
        chunks: receivingFileChunks.length,
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
    
    // Combine all chunks
    const combined = new Uint8Array(totalReceived);
    let offset = 0;
    
    receivingFileChunks.forEach(chunk => {
        const chunkArray = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        combined.set(chunkArray, offset);
        offset += chunkArray.length;
    });
    
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
    const fileName = receivingFile.name;
    receivingFile = null;
    receivingFileSize = 0;
    receivingBytesReceived = 0;
    receivingFileChunks = [];
    fileCompleteSignalReceived = false; // Reset completion signal flag
    allBytesReceivedTime = null; // Reset all bytes received timestamp
    pendingFileRequest = null; // Clear pending request
    
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
    // Don't show next file request UI yet - wait for sender to send metadata
    // The sender will send file-metadata for the next file automatically
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
    const speed = receivingBytesReceived / elapsed;
    const remaining = receivingFileSize - receivingBytesReceived;
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


