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
    
    // For dev tunnels, don't append port (already included in hostname)
    if (hostname.includes('devtunnels.ms')) {
        return `${protocol}//${hostname}`;
    }
    
    // For local or other hosts, use the port from URL or default to 8080
    const port = window.location.port || '8080';
    return `${protocol}//${hostname}:${port}`;
}
const WS_URL = getWebSocketURL();
console.log('WebSocket URL:', WS_URL);
const INITIAL_CHUNK_SIZE = 64 * 1024; // 64KB initial chunk size
const MAX_CHUNK_SIZE = 1024 * 1024; // 1MB max chunk size
const MIN_CHUNK_SIZE = 16 * 1024; // 16KB min chunk size
const BACKPRESSURE_THRESHOLD = 8 * 1024 * 1024; // 8MB backpressure threshold (reduced to prevent queue full errors)
const MAX_BUFFERED_AMOUNT = 15 * 1024 * 1024; // 15MB max - don't send if buffer exceeds this
const CHUNK_SIZE_ADJUST_INTERVAL = 1000; // Adjust chunk size every second

// State
let ws = null;
let peerConnection = null;
let dataChannel = null;
let currentRoom = null;
let isInitiator = false;
let currentFile = null;
let fileQueue = []; // Queue for multiple files
let isProcessingQueue = false; // Flag to prevent concurrent processing
let fileReader = null;
let fileStream = null;
// Promise resolver for file transfer confirmation
let fileTransferConfirmationResolver = null;

let transferStats = {
    bytesTransferred: 0,
    startTime: null,
    lastUpdateTime: null,
    lastBytesTransferred: 0,
    chunksSent: 0,
    chunksQueued: 0,
    totalChunksExpected: 0
};

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
    
    // Track ICE connection state for better feedback
    peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;
        console.log('ICE connection state:', iceState);
        checkRelayStatus();
        if (iceState === 'connected' || iceState === 'completed') {
            updateConnectionStatus('connecting', 'ICE connected, establishing DataChannel...');
        } else if (iceState === 'failed') {
            updateConnectionStatus('disconnected', 'ICE connection failed');
        } else if (iceState === 'disconnected') {
            updateConnectionStatus('disconnected', 'ICE disconnected');
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
    
    setupDataChannel(dataChannel);
}

function setupDataChannel(channel) {
    dataChannel = channel;
    
    console.log('DataChannel setup. Current state:', channel.readyState);
    
    // Check if already open
    if (channel.readyState === 'open') {
        console.log('DataChannel already open!');
        updateConnectionStatus('connected', 'P2P Connected');
    }
    
    dataChannel.onopen = () => {
        console.log('✅ DataChannel opened! Ready to transfer files.');
        updateConnectionStatus('connected', 'P2P Connected - Ready');
    };
    
    dataChannel.onclose = () => {
        console.log('DataChannel closed. State:', dataChannel?.readyState);
        updateConnectionStatus('disconnected', 'DataChannel closed');
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
        handleFile(files[0]);
    }
}

async function handleFile(file) {
    if (!dataChannel) {
        alert('DataChannel not created yet. Please wait for peer to join.\n\nStatus: ' + statusText.textContent + '\n\nCheck browser console (F12) for details.');
        console.log('No dataChannel. peerConnection:', !!peerConnection, 'isInitiator:', isInitiator, 'connectionState:', peerConnection?.connectionState);
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
        console.log('DataChannel state:', state, 'peerConnection state:', peerConnection?.connectionState, 'ICE state:', peerConnection?.iceConnectionState);
        return;
    }
    
    currentFile = file;
    
    // Hide drop zone, show transfer info (waiting for acceptance)
    dropZone.style.display = 'none';
    transferInfo.style.display = 'block';
    showTransferUI(file, 'Waiting for acceptance...');
    resetTransferStats();
    
    // Send file transfer request
    const request = {
        type: 'file-request',
        name: file.name,
        size: file.size,
        mimeType: file.type
    };
    
    dataChannel.send(JSON.stringify(request));
    console.log('File transfer request sent:', file.name);
}

async function streamFile(file) {
    if (!file.stream) {
        // Fallback for browsers without ReadableStream support
        await streamFileLegacy(file);
        return;
    }
    
    fileStream = file.stream();
    const reader = fileStream.getReader();
    let chunkSize = INITIAL_CHUNK_SIZE;
    let lastAdjustTime = Date.now();
    
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    const sendChunk = async () => {
        if (dataChannel.readyState !== 'open') {
            reader.cancel();
            return;
        }
        
        // Check backpressure - wait longer if buffer is high
        if (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            // Reduce chunk size if backpressure is high
            chunkSize = Math.max(MIN_CHUNK_SIZE, chunkSize * 0.5);
            const waitTime = dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT ? 100 : 50;
            setTimeout(sendChunk, waitTime);
            return;
        }
        
        // Adjust chunk size based on performance
        const now = Date.now();
        if (now - lastAdjustTime > CHUNK_SIZE_ADJUST_INTERVAL) {
            const timeDiff = (now - transferStats.lastUpdateTime) / 1000;
            const bytesDiff = transferStats.bytesTransferred - transferStats.lastBytesTransferred;
            
            if (timeDiff > 0) {
                const currentSpeed = bytesDiff / timeDiff;
                // Increase chunk size if we're sending fast and no backpressure
                if (currentSpeed > 10 * 1024 * 1024 && dataChannel.bufferedAmount < BACKPRESSURE_THRESHOLD / 2) {
                    chunkSize = Math.min(MAX_CHUNK_SIZE, chunkSize * 1.5);
                }
            }
            
            lastAdjustTime = now;
            transferStats.lastUpdateTime = now;
            transferStats.lastBytesTransferred = transferStats.bytesTransferred;
        }
        
        try {
            const { done, value } = await reader.read();
            
            if (done) {
                console.log('📤 File reading complete.');
                console.log(`📊 Transfer stats: Bytes: ${transferStats.bytesTransferred}/${file.size}, Chunks sent: ${transferStats.chunksSent}, Chunks queued: ${transferStats.chunksQueued}`);
                
                // CRITICAL: Verify ALL bytes were actually sent
                if (transferStats.bytesTransferred < file.size) {
                    const missing = file.size - transferStats.bytesTransferred;
                    console.error(`❌ ERROR: Not all bytes sent! Sent: ${transferStats.bytesTransferred}, Expected: ${file.size}, Missing: ${missing} bytes (${(missing/1024/1024).toFixed(2)}MB)`);
                    alert(`Transfer error: Not all bytes were sent (${transferStats.bytesTransferred}/${file.size}). Missing ${(missing/1024/1024).toFixed(2)}MB. Please try again.`);
                    return;
                }
                
                // Verify chunks were sent
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
                
                // CRITICAL: Verify all bytes were sent - double check
                if (transferStats.bytesTransferred !== file.size) {
                    console.error(`❌ CRITICAL ERROR: Byte count mismatch! Sent: ${transferStats.bytesTransferred}, Expected: ${file.size}, Difference: ${file.size - transferStats.bytesTransferred}`);
                    alert(`Transfer error: Byte count mismatch (${transferStats.bytesTransferred}/${file.size}). Missing ${file.size - transferStats.bytesTransferred} bytes. Please try again.`);
                    return;
                }
                
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
                
                // Send completion message
                console.log('📨 Sending file-complete signal...');
                try {
                    dataChannel.send(JSON.stringify({ type: 'file-complete' }));
                    console.log('✅ Completion signal sent. Waiting for receiver confirmation...');
                } catch (error) {
                    console.error('❌ Error sending completion signal:', error);
                    alert('Error sending completion signal: ' + error.message);
                    return;
                }
                
                // Wait for receiver confirmation that all bytes were received
                // This ensures we don't mark as complete until receiver has everything
                console.log('⏳ Waiting for receiver confirmation that all bytes were received...');
                
                const confirmationPromise = new Promise((resolve) => {
                    fileTransferConfirmationResolver = resolve;
                });
                
                const timeoutPromise = new Promise((resolve) => {
                    setTimeout(() => {
                        if (fileTransferConfirmationResolver) {
                            console.warn('⚠️ Timeout waiting for receiver confirmation (30s), but proceeding anyway');
                            fileTransferConfirmationResolver = null;
                        }
                        resolve();
                    }, 30000); // 30 second timeout
                });
                
                // Wait for either confirmation or timeout
                await Promise.race([confirmationPromise, timeoutPromise]);
                
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
            
            // Send chunk in smaller pieces if needed
            let offset = 0;
            while (offset < value.length) {
                const chunk = value.slice(offset, offset + chunkSize);
                const chunkLength = chunk.length;
                
                // CRITICAL: Wait until buffer has space - don't send if buffer is too full
                while (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
                    if (dataChannel.readyState !== 'open') {
                        throw new Error('DataChannel closed during transfer');
                    }
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                
                // Double-check before sending to prevent "queue is full" error
                if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    // Wait longer if buffer is very full
                    console.warn(`Buffer very full (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB), waiting...`);
                    await new Promise(resolve => setTimeout(resolve, 200));
                    continue; // Re-check buffer
                }
                
                // Check channel is still open before sending
                if (dataChannel.readyState !== 'open') {
                    console.error('❌ DataChannel closed during transfer! State:', dataChannel.readyState);
                    throw new Error('DataChannel closed during transfer');
                }
                
                // Track chunk before sending
                transferStats.chunksQueued++;
                let sendSuccess = false;
                let retryCount = 0;
                const MAX_RETRIES = 20; // Increased retries
                
                while (!sendSuccess && retryCount < MAX_RETRIES) {
                    try {
                        // Check channel state before each attempt
                        if (dataChannel.readyState !== 'open') {
                            console.error('❌ DataChannel closed during send attempt');
                            throw new Error('DataChannel closed during send');
                        }
                        
                        // Check buffer before sending - be very conservative
                        if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                            console.warn(`Buffer too full (${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB), waiting before send (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                            await new Promise(resolve => setTimeout(resolve, 300));
                            retryCount++;
                            continue;
                        }
                        
                        // Actually send the chunk
                        dataChannel.send(chunk);
                        sendSuccess = true;
                        transferStats.chunksSent++;
                        transferStats.bytesTransferred += chunkLength;
                        
                        // Log every 100th chunk or when close to completion
                        if (transferStats.chunksSent % 100 === 0 || transferStats.bytesTransferred > file.size * 0.95) {
                            console.log(`📤 Sent chunk #${transferStats.chunksSent}: ${chunkLength} bytes. Total: ${transferStats.bytesTransferred}/${file.size} (${((transferStats.bytesTransferred/file.size)*100).toFixed(1)}%)`);
                        }
                    } catch (error) {
                        // If send fails due to queue full, wait and retry
                        if (error.message && (error.message.includes('queue is full') || error.message.includes('send queue'))) {
                            console.warn(`Send queue full (attempt ${retryCount + 1}/${MAX_RETRIES}), buffered: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB, waiting...`);
                            await new Promise(resolve => setTimeout(resolve, 300));
                            retryCount++;
                            continue;
                        }
                        // Other errors - throw immediately
                        console.error('❌ Error sending chunk:', error);
                        throw error;
                    }
                }
                
                if (!sendSuccess) {
                    console.error(`❌ Failed to send chunk after ${MAX_RETRIES} retries. Buffer: ${(dataChannel.bufferedAmount/1024/1024).toFixed(2)}MB`);
                    alert(`Failed to send chunk after ${MAX_RETRIES} retries. Transfer may be incomplete.`);
                    return;
                }
                
                offset += chunkLength;
                
                // Calculate progress but cap at 99.9% until actually complete
                const progress = (transferStats.bytesTransferred / file.size) * 100;
                updateProgress(Math.min(99.9, progress));
                
                // CRITICAL: If this is the last chunk, wait extra time to ensure it's transmitted
                if (transferStats.bytesTransferred >= file.size) {
                    console.log('📤 Last chunk sent. Waiting extra time to ensure transmission...');
                    // Wait for buffer to clear for the last chunk - be very conservative
                    let lastChunkWaitAttempts = 0;
                    let lastChunkEmptyChecks = 0;
                    const LAST_CHUNK_WAIT = 300; // Wait up to 30 seconds for last chunk
                    const LAST_CHUNK_EMPTY_REQUIRED = 50; // Buffer must be empty for 5 seconds
                    
                    while (lastChunkWaitAttempts < LAST_CHUNK_WAIT) {
                        if (dataChannel.readyState !== 'open') {
                            console.error('❌ DataChannel closed while waiting for last chunk!');
                            return;
                        }
                        
                        const currentBuffer = dataChannel.bufferedAmount;
                        if (currentBuffer === 0) {
                            lastChunkEmptyChecks++;
                            if (lastChunkEmptyChecks >= LAST_CHUNK_EMPTY_REQUIRED) {
                                console.log(`✅ Last chunk buffer cleared and stayed empty for ${(lastChunkEmptyChecks * 0.1).toFixed(1)}s`);
                                break;
                            }
                        } else {
                            lastChunkEmptyChecks = 0; // Reset if buffer has data
                            if (lastChunkWaitAttempts % 20 === 0) {
                                console.log(`⏳ Waiting for last chunk to transmit. Buffered: ${(currentBuffer/1024).toFixed(2)} KB (attempt ${lastChunkWaitAttempts + 1}/${LAST_CHUNK_WAIT})`);
                            }
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 100));
                        lastChunkWaitAttempts++;
                    }
                    
                    if (dataChannel.bufferedAmount > 0) {
                        console.warn(`⚠️ Buffer still has ${(dataChannel.bufferedAmount/1024).toFixed(2)} KB after last chunk wait`);
                    }
                    
                    // Additional wait after buffer clears to ensure last chunk reaches receiver
                    console.log('⏳ Additional 3-second wait for last chunk to reach receiver...');
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 more seconds
                }
            }
            
            // Continue reading
            sendChunk();
        } catch (error) {
            console.error('Error reading file:', error);
            alert('Error reading file: ' + error.message);
        }
    };
    
    sendChunk();
}

async function streamFileLegacy(file) {
    // Fallback for browsers without ReadableStream support
    const chunkSize = INITIAL_CHUNK_SIZE;
    
    // Reset and initialize transfer stats
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    transferStats.bytesTransferred = 0;
    transferStats.chunksSent = 0;
    transferStats.chunksQueued = 0;
    transferStats.totalChunksExpected = Math.ceil(file.size / chunkSize);
    
    console.log(`📤 Starting file transfer (legacy): ${file.name} (${(file.size/1024/1024).toFixed(2)}MB), Expected chunks: ~${transferStats.totalChunksExpected}`);
    let offset = 0;
    
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    
    const readChunk = () => {
        if (dataChannel.readyState !== 'open') {
            return;
        }
        
        // Check backpressure - wait longer if buffer is high
        if (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            const waitTime = dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT ? 100 : 50;
            setTimeout(readChunk, waitTime);
            return;
        }
        
        const fileReader = new FileReader();
        const blob = file.slice(offset, offset + chunkSize);
        
        fileReader.onload = (e) => {
            const chunk = new Uint8Array(e.target.result);
            
            // Wait if backpressure is too high
            const sendWithBackpressure = async () => {
                // Check channel is still open
                if (dataChannel.readyState !== 'open') {
                    console.error('DataChannel closed during transfer');
                    return;
                }
                
                if (dataChannel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
                    setTimeout(sendWithBackpressure, 50);
                    return;
                }
                
                // Double-check before sending
                if (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    setTimeout(sendWithBackpressure, 200);
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
                    
                    // Verify ALL bytes were sent
                    if (transferStats.bytesTransferred < file.size) {
                        const missing = file.size - transferStats.bytesTransferred;
                        console.error(`❌ ERROR: Not all bytes sent! Sent: ${transferStats.bytesTransferred}, Expected: ${file.size}, Missing: ${missing} bytes (${(missing/1024/1024).toFixed(2)}MB)`);
                        alert(`Transfer error: Not all bytes were sent (${transferStats.bytesTransferred}/${file.size}). Missing ${(missing/1024/1024).toFixed(2)}MB. Please try again.`);
                        return;
                    }
                    
                    // Verify chunks were sent
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
                                
                            console.log('📨 Sending file-complete signal...');
                            // Send completion message
                            try {
                                dataChannel.send(JSON.stringify({ type: 'file-complete' }));
                                console.log('✅ Completion signal sent. Waiting for receiver confirmation...');
                            } catch (error) {
                                console.error('❌ Error sending completion signal:', error);
                                alert('Error sending completion signal: ' + error.message);
                                return;
                            }
                            
                            // Wait for receiver confirmation that all bytes were received
                            console.log('⏳ Waiting for receiver confirmation that all bytes were received...');
                            
                            const confirmationPromise = new Promise((resolve) => {
                                fileTransferConfirmationResolver = resolve;
                            });
                            
                            const timeoutPromise = new Promise((resolve) => {
                                setTimeout(() => {
                                    if (fileTransferConfirmationResolver) {
                                        console.warn('⚠️ Timeout waiting for receiver confirmation (30s), but proceeding anyway');
                                        fileTransferConfirmationResolver = null;
                                    }
                                    resolve();
                                }, 30000); // 30 second timeout
                            });
                            
                            // Wait for either confirmation or timeout
                            Promise.race([confirmationPromise, timeoutPromise]).then(() => {
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

function handleDataChannelMessage(event) {
    const data = event.data;
    
    // Check if it's a JSON message (metadata or control)
    if (typeof data === 'string') {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'file-request') {
                handleFileRequest(message);
            } else if (message.type === 'file-accepted') {
                handleFileAccepted();
            } else if (message.type === 'file-rejected') {
                handleFileRejected();
            } else if (message.type === 'file-metadata') {
                startReceivingFile(message);
            } else if (message.type === 'file-complete') {
                completeReceivingFile();
            } else if (message.type === 'file-received-confirmed') {
                // Sender receives this confirmation from receiver
                console.log('✅ Received confirmation from receiver that all bytes were received');
                if (fileTransferConfirmationResolver) {
                    fileTransferConfirmationResolver();
                    fileTransferConfirmationResolver = null;
                }
                // Ensure completion is triggered
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
    
    // Handle binary file data
    if (receivingFile) {
        handleFileChunk(data);
    }
}

// File Request Handling
function handleFileRequest(request) {
    console.log('File transfer request received:', request.name);
    // Hide drop zone, show file request UI
    dropZone.style.display = 'none';
    fileRequest.style.display = 'block';
    requestFileName.textContent = request.name;
    requestFileSize.textContent = formatFileSize(request.size);
    
    // Store request info for when user accepts
    pendingFileRequest = request;
}

function handleAcceptFile() {
    if (!pendingFileRequest) {
        console.warn('No pending file request to accept');
        return;
    }
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Connection not ready. Please wait for connection to be established.');
        return;
    }
    
    console.log('File transfer accepted:', pendingFileRequest.name);
    
    // Disable buttons to prevent double-clicking
    if (acceptFileBtn) acceptFileBtn.disabled = true;
    if (rejectFileBtn) rejectFileBtn.disabled = true;
    
    // Hide request UI, show transfer info
    fileRequest.style.display = 'none';
    transferInfo.style.display = 'block';
    
    // Start receiving file
    startReceivingFile(pendingFileRequest);
    
    // Send acceptance to sender
    try {
        dataChannel.send(JSON.stringify({ type: 'file-accepted' }));
        console.log('Acceptance message sent');
    } catch (error) {
        console.error('Error sending acceptance:', error);
        alert('Error sending acceptance. Please try again.');
        // Reset UI
        fileRequest.style.display = 'block';
        transferInfo.style.display = 'none';
        if (acceptFileBtn) acceptFileBtn.disabled = false;
        if (rejectFileBtn) rejectFileBtn.disabled = false;
        return;
    }
    
    pendingFileRequest = null;
}

function handleRejectFile() {
    if (!pendingFileRequest) {
        console.warn('No pending file request to reject');
        return;
    }
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
        alert('Connection not ready. Please wait for connection to be established.');
        return;
    }
    
    console.log('File transfer rejected:', pendingFileRequest.name);
    
    // Disable buttons to prevent double-clicking
    if (acceptFileBtn) acceptFileBtn.disabled = true;
    if (rejectFileBtn) rejectFileBtn.disabled = true;
    
    // Send rejection to sender
    try {
        dataChannel.send(JSON.stringify({ type: 'file-rejected' }));
        console.log('Rejection message sent');
    } catch (error) {
        console.error('Error sending rejection:', error);
    }
    
    // Reset UI
    fileRequest.style.display = 'none';
    dropZone.style.display = 'block';
    pendingFileRequest = null;
    
    // Re-enable buttons after a short delay
    setTimeout(() => {
        if (acceptFileBtn) acceptFileBtn.disabled = false;
        if (rejectFileBtn) rejectFileBtn.disabled = false;
    }, 500);
}

function handleFileAccepted() {
    console.log('File transfer accepted by receiver, starting upload...');
    // Receiver accepted, start sending file
    if (currentFile) {
        // Update UI to show uploading
        showTransferUI(currentFile, 'Uploading...');
        // Send file metadata and start streaming
        const metadata = {
            type: 'file-metadata',
            name: currentFile.name,
            size: currentFile.size,
            mimeType: currentFile.type
        };
        dataChannel.send(JSON.stringify(metadata));
        streamFile(currentFile);
    }
}

function handleFileRejected() {
    console.log('File transfer rejected by receiver');
    // Show rejection message
    alert('File transfer was rejected by the receiver.');
    
    // Reset UI
    resetTransferUI();
    dropZone.style.display = 'block';
    transferInfo.style.display = 'none';
    currentFile = null;
}

let pendingFileRequest = null;

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
    
    // Clear completion check interval
    if (completionCheckInterval) {
        clearInterval(completionCheckInterval);
        completionCheckInterval = null;
    }
    
    // Hide success message after delay but keep drop zone visible
    setTimeout(() => {
        successMessage.style.display = 'none';
    }, 5000);
}

function completeSendingFile() {
    const fileName = currentFile?.name;
    
    // Hide transfer info, show drop zone and success message
    transferInfo.style.display = 'none';
    dropZone.style.display = 'block';
    successMessage.style.display = 'flex';
    successText.textContent = `File "${fileName}" uploaded successfully!`;
    
    // Reset transfer stats but keep success message visible
    resetTransferStats();
    currentFile = null;
    
    // Hide success message after delay but keep drop zone visible
    setTimeout(() => {
        successMessage.style.display = 'none';
    }, 5000);
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
    dropZone.style.display = 'block';
    currentFile = null;
    pendingFileRequest = null;
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

