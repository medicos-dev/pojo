// ============================================================================
// POJO FILES - HYBRID TRANSFER MODEL
// ============================================================================
// WebRTC: Signaling, peer discovery, metadata, control messages
// HTTP: All file data transfer (resumable, high-speed)
// ============================================================================

// WebRTC Configuration (for signaling only, not file data)
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
];

// ============================================================================
// HTTP TRANSFER CONFIGURATION
// ============================================================================
const HTTP_CHUNK_SIZE = 4 * 1024 * 1024;  // 4MB chunks (balance of speed and memory)
const MAX_PARALLEL_UPLOADS = 2;            // Parallel upload streams
const PROGRESS_UPDATE_INTERVAL = 500;      // Progress updates every 500ms

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

function getHttpBaseURL() {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    const port = window.location.port || '';
    return port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`;
}

const WS_URL = getWebSocketURL();
const HTTP_BASE_URL = getHttpBaseURL();
console.log('WebSocket URL:', WS_URL);
console.log('HTTP Base URL:', HTTP_BASE_URL);

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

// Upload session state
let currentUploadSession = null;  // { uploadId, fileName, fileSize, offset }
let uploadAbortController = null;

// Transfer state
const TransferState = {
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    SENDING: 'SENDING',
    RECEIVING: 'RECEIVING',
    PAUSED: 'PAUSED',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};
let transferState = TransferState.IDLE;

// Receiver state
let pendingFileOffer = null;      // { fileId, fileName, fileSize, mimeType, uploadId }
let pendingFileOfferQueue = [];    // Queue for multiple file offers

// Transfer statistics
let transferStats = {
    bytesTransferred: 0,
    startTime: null,
    lastUpdateTime: null,
    lastBytesTransferred: 0
};

// Mobile detection
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// Wake Lock for mobile
let wakeLock = null;

// ============================================================================
// LOCALSTORAGE PERSISTENCE
// ============================================================================

function saveUploadSession(session) {
    try {
        localStorage.setItem(`uploadSession_${session.uploadId}`, JSON.stringify({
            ...session,
            timestamp: Date.now()
        }));
        console.log(`💾 Saved upload session: ${session.uploadId}`);
    } catch (error) {
        console.error('Error saving upload session:', error);
    }
}

function getUploadSession(uploadId) {
    try {
        const data = localStorage.getItem(`uploadSession_${uploadId}`);
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error('Error reading upload session:', error);
        return null;
    }
}

function deleteUploadSession(uploadId) {
    try {
        localStorage.removeItem(`uploadSession_${uploadId}`);
        console.log(`🗑️ Deleted upload session: ${uploadId}`);
    } catch (error) {
        console.error('Error deleting upload session:', error);
    }
}

// ============================================================================
// SCREEN WAKE LOCK (Mobile)
// ============================================================================

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('📱 Screen Wake Lock active');
        }
    } catch (err) {
        console.warn(`Wake Lock not available: ${err.message}`);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        try {
            wakeLock.release();
            wakeLock = null;
            console.log('📱 Screen Wake Lock released');
        } catch (err) {
            console.warn(`Error releasing wake lock: ${err.message}`);
        }
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

    if (progressFill) {
        progressFill.style.width = `${percent}%`;
    }
    if (progressPercent) {
        progressPercent.textContent = `${percent.toFixed(1)}%`;
    }
}

function updateTransferSpeed() {
    const now = Date.now();
    const elapsedSinceLastUpdate = (now - transferStats.lastUpdateTime) / 1000;
    const bytesSinceLastUpdate = transferStats.bytesTransferred - transferStats.lastBytesTransferred;

    if (elapsedSinceLastUpdate > 0) {
        const speedBps = bytesSinceLastUpdate / elapsedSinceLastUpdate;
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

        if (timeRemaining && currentFile) {
            const remainingBytes = currentFile.size - transferStats.bytesTransferred;
            if (speedBps > 0) {
                const remainingSeconds = remainingBytes / speedBps;
                timeRemaining.textContent = formatTime(remainingSeconds);
            }
        }
    }

    transferStats.lastUpdateTime = now;
    transferStats.lastBytesTransferred = transferStats.bytesTransferred;
}

function resetTransferStats() {
    transferStats = {
        bytesTransferred: 0,
        startTime: null,
        lastUpdateTime: null,
        lastBytesTransferred: 0
    };
}

function updateConnectionStatus(status, text) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = document.getElementById('statusText');

    if (statusIndicator) {
        statusIndicator.className = 'status-indicator';
        if (status === 'connected') {
            statusIndicator.classList.add('connected');
        } else if (status === 'connecting') {
            statusIndicator.classList.add('connecting');
        }
    }

    if (statusText) {
        statusText.textContent = text;
    }
}

function showTransferInfo(fileName, fileSize) {
    const transferInfo = document.getElementById('transferInfo');
    const fileNameEl = document.getElementById('fileName');
    const fileSizeEl = document.getElementById('fileSize');
    const dropZone = document.getElementById('dropZone');
    const transferSection = document.getElementById('transferSection');

    if (transferSection) transferSection.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (transferInfo) transferInfo.style.display = 'block';
    if (fileNameEl) fileNameEl.textContent = fileName;
    if (fileSizeEl) fileSizeEl.textContent = formatFileSize(fileSize);

    updateProgress(0);
}

function hideTransferInfo() {
    const transferInfo = document.getElementById('transferInfo');
    const dropZone = document.getElementById('dropZone');

    if (transferInfo) transferInfo.style.display = 'none';
    if (dropZone) dropZone.style.display = 'flex';
}

function showSuccessMessage(fileName) {
    const successMessage = document.getElementById('successMessage');
    const successText = document.getElementById('successText');

    if (successMessage) {
        successMessage.style.display = 'flex';
        if (successText) {
            successText.textContent = `${fileName} transferred successfully!`;
        }
        setTimeout(() => {
            successMessage.style.display = 'none';
        }, 5000);
    }
}

function showUserMessage(message) {
    alert(message);
}

// ============================================================================
// HTTP UPLOAD API (Sender)
// ============================================================================

async function createUploadSession(file) {
    console.log(`📤 Creating upload session for: ${file.name}`);

    const response = await fetch(`${HTTP_BASE_URL}/upload/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream',
            chunkSize: HTTP_CHUNK_SIZE
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create upload session');
    }

    const session = await response.json();
    console.log(`✅ Upload session created: ${session.uploadId}`);

    currentUploadSession = {
        uploadId: session.uploadId,
        uploadUrl: session.uploadUrl,
        fileName: file.name,
        fileSize: file.size,
        offset: 0,
        maxChunkSize: session.maxChunkSize
    };

    saveUploadSession(currentUploadSession);
    return session;
}

async function uploadFileHTTP(file, session, startOffset = 0) {
    console.log(`📤 Starting HTTP upload: ${file.name} from offset ${startOffset}`);

    await requestWakeLock();

    transferState = TransferState.SENDING;
    transferStats.startTime = Date.now();
    transferStats.lastUpdateTime = Date.now();
    transferStats.bytesTransferred = startOffset;

    showTransferInfo(file.name, file.size);
    updateProgress((startOffset / file.size) * 100);

    uploadAbortController = new AbortController();
    const { signal } = uploadAbortController;

    let offset = startOffset;
    const chunkSize = session.maxChunkSize || HTTP_CHUNK_SIZE;

    // Progress update interval
    const progressInterval = setInterval(() => {
        updateTransferSpeed();
        sendProgressUpdate(transferStats.bytesTransferred, file.size);
    }, PROGRESS_UPDATE_INTERVAL);

    try {
        while (offset < file.size) {
            // Check for abort
            if (signal.aborted) {
                throw new Error('Upload aborted');
            }

            const end = Math.min(offset + chunkSize, file.size);
            const chunk = file.slice(offset, end);

            const response = await fetch(`${HTTP_BASE_URL}/upload/${session.uploadId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`
                },
                body: chunk,
                signal
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Upload failed' }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            offset = result.bytesReceived;

            // Update state
            transferStats.bytesTransferred = offset;
            currentUploadSession.offset = offset;
            saveUploadSession(currentUploadSession);

            // Update UI
            const percent = (offset / file.size) * 100;
            updateProgress(percent);
        }

        clearInterval(progressInterval);

        // Upload complete
        console.log(`✅ Upload complete: ${file.name}`);
        transferState = TransferState.COMPLETED;
        updateProgress(100);

        // Send completion via WebRTC
        sendUploadComplete(session.uploadId, file.name, file.size);

        // Cleanup
        deleteUploadSession(session.uploadId);
        showSuccessMessage(file.name);

        setTimeout(() => {
            hideTransferInfo();
            currentFile = null;
            currentUploadSession = null;
            processFileQueue();
        }, 2000);

    } catch (error) {
        clearInterval(progressInterval);

        if (error.name === 'AbortError' || error.message === 'Upload aborted') {
            console.log('📤 Upload aborted by user');
            transferState = TransferState.PAUSED;
        } else {
            console.error('❌ Upload error:', error);
            transferState = TransferState.FAILED;
            showUserMessage(`Upload failed: ${error.message}`);
        }
    } finally {
        releaseWakeLock();
        uploadAbortController = null;
    }
}

async function resumeUpload(file) {
    if (!currentUploadSession) {
        console.log('No upload session to resume');
        return false;
    }

    // Check session on server
    try {
        const response = await fetch(`${HTTP_BASE_URL}/upload/${currentUploadSession.uploadId}`);
        if (!response.ok) {
            console.log('Upload session expired, starting new upload');
            currentUploadSession = null;
            return false;
        }

        const serverSession = await response.json();
        const resumeOffset = serverSession.receivedBytes || 0;

        console.log(`🔄 Resuming upload from byte ${resumeOffset}`);
        await uploadFileHTTP(file, currentUploadSession, resumeOffset);
        return true;

    } catch (error) {
        console.error('Failed to check upload session:', error);
        return false;
    }
}

// ============================================================================
// WEBRTC CONTROL MESSAGES
// ============================================================================

function sendFileOffer(uploadId, file) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.error('Cannot send file offer: DataChannel not open');
        return false;
    }

    const offer = {
        type: 'file-offer',
        fileId: uploadId,
        uploadId: uploadId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream'
    };

    dataChannel.send(JSON.stringify(offer));
    console.log(`📤 Sent file offer: ${file.name} (${uploadId})`);
    return true;
}

function sendFileAccept(fileId) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.error('Cannot send file accept: DataChannel not open');
        return;
    }

    dataChannel.send(JSON.stringify({
        type: 'file-accept',
        fileId: fileId
    }));
    console.log(`✅ Sent file accept: ${fileId}`);
}

function sendFileReject(fileId) {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        console.error('Cannot send file reject: DataChannel not open');
        return;
    }

    dataChannel.send(JSON.stringify({
        type: 'file-reject',
        fileId: fileId
    }));
    console.log(`❌ Sent file reject: ${fileId}`);
}

function sendProgressUpdate(bytesUploaded, totalBytes) {
    if (!dataChannel || dataChannel.readyState !== 'open') return;

    try {
        dataChannel.send(JSON.stringify({
            type: 'progress',
            bytesUploaded,
            totalBytes,
            percent: Math.round((bytesUploaded / totalBytes) * 100)
        }));
    } catch (error) {
        // Non-critical, ignore
    }
}

function sendUploadComplete(uploadId, fileName, fileSize) {
    if (!dataChannel || dataChannel.readyState !== 'open') return;

    dataChannel.send(JSON.stringify({
        type: 'upload-complete',
        uploadId,
        fileName,
        fileSize
    }));
    console.log(`✅ Sent upload complete: ${fileName}`);
}

// ============================================================================
// WEBRTC MESSAGE HANDLERS
// ============================================================================

function handleDataChannelMessage(event) {
    const data = event.data;

    // All messages should be JSON (no binary on DataChannel anymore)
    if (typeof data !== 'string') {
        console.warn('⚠️ Received unexpected binary data on DataChannel');
        return;
    }

    try {
        const message = JSON.parse(data);

        switch (message.type) {
            case 'ping':
                dataChannel.send(JSON.stringify({ type: 'pong' }));
                break;

            case 'pong':
                // Keepalive acknowledged
                break;

            case 'file-offer':
                handleFileOffer(message);
                break;

            case 'file-accept':
                handleFileAccepted(message.fileId);
                break;

            case 'file-reject':
                handleFileRejected(message.fileId);
                break;

            case 'progress':
                handleProgressUpdate(message);
                break;

            case 'upload-complete':
                handleUploadComplete(message);
                break;

            default:
                console.warn('Unknown message type:', message.type);
        }
    } catch (error) {
        console.error('Error parsing DataChannel message:', error);
    }
}

function handleFileOffer(offer) {
    console.log(`📥 Received file offer: ${offer.fileName} (${formatFileSize(offer.fileSize)})`);

    pendingFileOfferQueue.push(offer);

    // Show first offer in queue
    if (pendingFileOfferQueue.length === 1) {
        showFileOfferUI();
    }
}

function handleFileAccepted(fileId) {
    console.log(`✅ File accepted by peer: ${fileId}`);

    // Start upload now that peer accepted
    if (currentFile && currentUploadSession && currentUploadSession.uploadId === fileId) {
        uploadFileHTTP(currentFile, currentUploadSession, 0);
    }
}

function handleFileRejected(fileId) {
    console.log(`❌ File rejected by peer: ${fileId}`);

    // Cleanup
    if (currentUploadSession && currentUploadSession.uploadId === fileId) {
        deleteUploadSession(fileId);
        currentUploadSession = null;
        currentFile = null;
        hideTransferInfo();
        showUserMessage('File transfer was rejected by the receiver.');
        processFileQueue();
    }
}

function handleProgressUpdate(progress) {
    // Update UI with sender's progress
    if (transferState === TransferState.RECEIVING) {
        updateProgress(progress.percent);
        transferStats.bytesTransferred = progress.bytesUploaded;
    }
}

function handleUploadComplete(message) {
    console.log(`✅ Upload complete notification: ${message.fileName}`);

    if (pendingFileOffer && pendingFileOffer.uploadId === message.uploadId) {
        // Download the file
        downloadFile(message.uploadId, message.fileName);
    }
}

// ============================================================================
// HTTP DOWNLOAD API (Receiver)
// ============================================================================

async function downloadFile(uploadId, fileName) {
    console.log(`📥 Starting download: ${fileName}`);

    await requestWakeLock();
    transferState = TransferState.RECEIVING;

    try {
        const response = await fetch(`${HTTP_BASE_URL}/download/${uploadId}`);

        if (!response.ok) {
            throw new Error(`Download failed: HTTP ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = parseInt(contentLength, 10) || 0;

        // Read the response as a stream
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;

        transferStats.startTime = Date.now();
        transferStats.lastUpdateTime = Date.now();

        showTransferInfo(fileName, total);

        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            received += value.length;

            // Update progress
            if (total > 0) {
                const percent = (received / total) * 100;
                updateProgress(percent);
                transferStats.bytesTransferred = received;
                updateTransferSpeed();
            }
        }

        // Create blob and trigger download
        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        console.log(`✅ Download complete: ${fileName}`);
        transferState = TransferState.COMPLETED;
        showSuccessMessage(fileName);

        // Cleanup
        pendingFileOffer = null;
        hideTransferInfo();
        processNextFileOffer();

    } catch (error) {
        console.error('❌ Download error:', error);
        transferState = TransferState.FAILED;
        showUserMessage(`Download failed: ${error.message}`);
    } finally {
        releaseWakeLock();
    }
}

// ============================================================================
// FILE OFFER UI
// ============================================================================

function showFileOfferUI() {
    if (pendingFileOfferQueue.length === 0) return;

    const offer = pendingFileOfferQueue[0];
    pendingFileOffer = offer;

    const transferSection = document.getElementById('transferSection');
    const dropZone = document.getElementById('dropZone');
    const fileRequest = document.getElementById('fileRequest');
    const requestFileName = document.getElementById('requestFileName');
    const requestFileSize = document.getElementById('requestFileSize');

    if (transferSection) transferSection.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (fileRequest) fileRequest.style.display = 'block';

    if (requestFileName) {
        if (pendingFileOfferQueue.length > 1) {
            requestFileName.textContent = `${offer.fileName} (+${pendingFileOfferQueue.length - 1} more files)`;
        } else {
            requestFileName.textContent = offer.fileName;
        }
    }

    if (requestFileSize) {
        const totalSize = pendingFileOfferQueue.reduce((sum, o) => sum + o.fileSize, 0);
        requestFileSize.textContent = formatFileSize(totalSize);
    }
}

function hideFileOfferUI() {
    const fileRequest = document.getElementById('fileRequest');
    const dropZone = document.getElementById('dropZone');

    if (fileRequest) fileRequest.style.display = 'none';
    if (dropZone) dropZone.style.display = 'flex';
}

function processNextFileOffer() {
    if (pendingFileOfferQueue.length > 0) {
        pendingFileOfferQueue.shift();
        if (pendingFileOfferQueue.length > 0) {
            showFileOfferUI();
        } else {
            pendingFileOffer = null;
            hideFileOfferUI();
        }
    }
}

function handleAcceptFile() {
    if (!pendingFileOffer) return;

    console.log(`✅ Accepting file: ${pendingFileOffer.fileName}`);

    // Accept all pending files
    for (const offer of pendingFileOfferQueue) {
        sendFileAccept(offer.fileId);
    }

    hideFileOfferUI();

    // Show progress UI for first file
    transferState = TransferState.RECEIVING;
    showTransferInfo(pendingFileOffer.fileName, pendingFileOffer.fileSize);

    // Update progress label
    const progressLabel = document.getElementById('progressLabel');
    if (progressLabel) {
        progressLabel.textContent = 'Downloading...';
    }
}

function handleRejectFile() {
    if (!pendingFileOffer) return;

    console.log(`❌ Rejecting files`);

    // Reject all pending files
    for (const offer of pendingFileOfferQueue) {
        sendFileReject(offer.fileId);
    }

    pendingFileOfferQueue = [];
    pendingFileOffer = null;
    hideFileOfferUI();
}

// ============================================================================
// FILE HANDLING (Sender)
// ============================================================================

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    const dropZone = document.getElementById('dropZone');
    if (dropZone) dropZone.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
        addFilesToQueue(Array.from(files));
    }
}

function handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
        addFilesToQueue(Array.from(files));
    }
    e.target.value = '';  // Reset input
}

async function addFilesToQueue(files) {
    // CRITICAL GUARD: Ensure WebSocket is connected before file transfer
    const socket = getSocket();
    if (socket.readyState !== WebSocket.OPEN) {
        console.log('⚠️ WebSocket not connected, attempting reconnect...');
        updateConnectionStatus('connecting', 'Reconnecting...');
        try {
            await ensureSocketConnected();
        } catch (error) {
            showUserMessage('Connection lost. Please wait for reconnection or refresh the page.');
            return;
        }
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
        showUserMessage('Please wait for peer connection to be established.');
        return;
    }

    console.log(`📁 Adding ${files.length} file(s) to queue`);

    for (const file of files) {
        fileQueue.push(file);
    }

    if (!isProcessingQueue) {
        processFileQueue();
    }
}

async function processFileQueue() {
    if (fileQueue.length === 0) {
        isProcessingQueue = false;
        return;
    }

    isProcessingQueue = true;
    currentFile = fileQueue.shift();

    console.log(`📤 Processing file: ${currentFile.name}`);

    try {
        // Create upload session
        const session = await createUploadSession(currentFile);

        // Update progress label
        const progressLabel = document.getElementById('progressLabel');
        if (progressLabel) {
            progressLabel.textContent = 'Uploading...';
        }

        // Send file offer to peer via WebRTC
        if (!sendFileOffer(session.uploadId, currentFile)) {
            throw new Error('Failed to send file offer');
        }

        // Show waiting UI
        showTransferInfo(currentFile.name, currentFile.size);
        updateConnectionStatus('connected', 'Waiting for peer to accept...');

        // Upload will start when peer accepts (handleFileAccepted)

    } catch (error) {
        console.error('Error processing file:', error);
        showUserMessage(`Failed to start transfer: ${error.message}`);
        currentFile = null;
        processFileQueue();
    }
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

function createRoom(e) {
    if (e) e.preventDefault();
    const roomId = generateRoomId();
    joinRoom(roomId, true);
}

function joinRoom(roomId = null, isCreator = false) {
    if (!roomId) {
        const roomIdInput = document.getElementById('roomId');
        roomId = roomIdInput ? roomIdInput.value.trim() : '';
    }

    if (!roomId) {
        showUserMessage('Please enter a room ID');
        return;
    }

    console.log(`🚪 Joining room: ${roomId}`);
    currentRoom = roomId;
    isInitiator = isCreator;

    connectWebSocket();
}

function leaveRoom() {
    console.log('🚪 Leaving room');

    // Abort any ongoing upload
    if (uploadAbortController) {
        uploadAbortController.abort();
    }

    // Close WebRTC
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    // Notify server
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'leave', room: currentRoom }));
    }

    // Reset state
    currentRoom = null;
    isInitiator = false;
    fileQueue = [];
    currentFile = null;
    transferState = TransferState.IDLE;

    // Update UI
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
// WEBSOCKET SINGLETON (Signaling) - RULE 1: Singleton & Persistent
// ============================================================================

let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 2000;

// RULE 1: Singleton WebSocket - lives outside UI lifecycle
function getSocket() {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.log('📡 Creating new WebSocket connection...');
        ws = createWebSocket();
    }
    return ws;
}

// Check if socket is ready, reconnect if needed
async function ensureSocketConnected() {
    const socket = getSocket();

    if (socket.readyState === WebSocket.OPEN) {
        return socket;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
        // Wait for connection
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, 10000);

            socket.addEventListener('open', () => {
                clearTimeout(timeout);
                resolve(socket);
            }, { once: true });

            socket.addEventListener('error', () => {
                clearTimeout(timeout);
                reject(new Error('WebSocket connection failed'));
            }, { once: true });
        });
    }

    // Socket is closed, reconnect
    return reconnectSocket();
}

// Reconnect WebSocket
async function reconnectSocket() {
    if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max reconnection attempts reached');
        updateConnectionStatus('disconnected', 'Connection failed - please refresh');
        return null;
    }

    wsReconnectAttempts++;
    console.log(`� Reconnecting WebSocket (attempt ${wsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    return new Promise((resolve, reject) => {
        ws = createWebSocket();

        const timeout = setTimeout(() => {
            reject(new Error('WebSocket reconnection timeout'));
        }, 10000);

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            wsReconnectAttempts = 0; // Reset on successful connection

            // Rejoin room if we were in one
            if (currentRoom) {
                ws.send(JSON.stringify({
                    type: 'join',
                    room: currentRoom
                }));
            }

            resolve(ws);
        }, { once: true });

        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            setTimeout(() => {
                reconnectSocket().then(resolve).catch(reject);
            }, RECONNECT_DELAY_MS);
        }, { once: true });
    });
}

// Create WebSocket with event handlers
function createWebSocket() {
    console.log(`�📡 Connecting to WebSocket: ${WS_URL}`);
    updateConnectionStatus('connecting', 'Connecting to server...');

    const socket = new WebSocket(WS_URL);

    socket.onopen = () => {
        console.log('✅ WebSocket connected');
        wsReconnectAttempts = 0;
        updateConnectionStatus('connecting', 'Connected to server');

        // Join room if specified
        if (currentRoom) {
            socket.send(JSON.stringify({
                type: 'join',
                room: currentRoom
            }));
        }
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleSignalingMessage(message);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus('disconnected', 'Connection error');
    };

    socket.onclose = (event) => {
        console.log(`WebSocket closed (code: ${event.code}, reason: ${event.reason})`);

        // Only show disconnected if we were connected and it wasn't intentional
        if (currentRoom && event.code !== 1000) {
            updateConnectionStatus('disconnected', 'Disconnected - reconnecting...');
            // Auto-reconnect
            setTimeout(() => {
                reconnectSocket().catch(err => {
                    console.error('Reconnection failed:', err);
                });
            }, RECONNECT_DELAY_MS);
        } else {
            updateConnectionStatus('disconnected', 'Disconnected');
        }
    };

    return socket;
}

// RULE 2: DO NOT close WebSocket on visibility change
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('📱 Page hidden — keeping WebSocket connection alive');
        // Send keepalive ping to prevent server timeout
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    } else {
        console.log('📱 Page visible — checking connection status');
        // Verify connection is still alive on return
        if (ws && ws.readyState !== WebSocket.OPEN && currentRoom) {
            console.log('🔄 Connection lost while hidden, reconnecting...');
            reconnectSocket().catch(err => {
                console.error('Reconnection failed:', err);
            });
        }
    }
});

// Legacy function kept for compatibility
function connectWebSocket() {
    ws = getSocket();
}

function handleSignalingMessage(message) {
    switch (message.type) {
        case 'joined':
            console.log(`✅ Joined room: ${message.room}`);
            // Use isInitiator from server if provided
            if (message.isInitiator !== undefined) {
                isInitiator = message.isInitiator;
            }
            showRoomDisplay();
            updateConnectionStatus('connecting', 'Waiting for peer...');

            if (isInitiator) {
                createPeerConnection();
            }
            break;

        // RULE 3: State-replayable peer presence
        case 'room-state':
            console.log(`📊 Room state: ${message.peerCount} peer(s), hasPeer: ${message.hasPeer}`);
            if (message.hasPeer) {
                updateConnectionStatus('connecting', 'Peer found, connecting...');
                // Trigger connection if we have a peer and aren't connected yet
                if (!peerConnection) {
                    createPeerConnection();
                }
                if (isInitiator && !dataChannel) {
                    createDataChannel();
                    createOffer();
                }
            } else {
                updateConnectionStatus('connecting', 'Waiting for peer...');
            }
            break;

        case 'peer-joined':
            console.log('👤 Peer joined the room');

            if (!peerConnection) {
                createPeerConnection();
            }

            if (isInitiator) {
                createDataChannel();
                createOffer();
            }
            break;

        case 'peer-left':
            console.log('👋 Peer left the room');
            updateConnectionStatus('connecting', 'Peer disconnected, waiting...');

            // Close DataChannel and PeerConnection, but stay in room
            if (dataChannel) {
                dataChannel.close();
                dataChannel = null;
            }
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }
            break;

        case 'offer':
            handleOffer(message.offer);
            break;

        case 'answer':
            handleAnswer(message.answer);
            break;

        case 'ice-candidate':
            handleIceCandidate(message.candidate);
            break;

        case 'pong':
            // Server keepalive response
            break;

        case 'error':
            console.error('Server error:', message.message);
            showUserMessage(message.message);
            break;
    }
}

// ============================================================================
// WEBRTC (Signaling Only - No File Data)
// ============================================================================

function createPeerConnection() {
    console.log('🔗 Creating peer connection');

    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate,
                room: currentRoom
            }));
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log(`🔗 Connection state: ${peerConnection.connectionState}`);

        if (peerConnection.connectionState === 'connected') {
            updateConnectionStatus('connected', 'P2P Connected');
        } else if (peerConnection.connectionState === 'failed') {
            updateConnectionStatus('disconnected', 'Connection failed');
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log(`🧊 ICE state: ${peerConnection.iceConnectionState}`);
    };

    peerConnection.ondatachannel = (event) => {
        console.log('📡 Received DataChannel');
        setupDataChannel(event.channel);
    };
}

function createDataChannel() {
    console.log('📡 Creating DataChannel');

    dataChannel = peerConnection.createDataChannel('control', {
        ordered: true
    });

    setupDataChannel(dataChannel);
}

function setupDataChannel(channel) {
    dataChannel = channel;

    channel.onopen = () => {
        console.log('✅ DataChannel opened (control channel only)');
        updateConnectionStatus('connected', 'P2P Connected - Ready');
    };

    channel.onclose = () => {
        console.log('📡 DataChannel closed');
        updateConnectionStatus('disconnected', 'DataChannel closed');
    };

    channel.onerror = (error) => {
        console.error('DataChannel error:', error);
    };

    channel.onmessage = handleDataChannelMessage;
}

async function createOffer() {
    try {
        console.log('📤 Creating offer');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

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
        console.log('📥 Received offer');

        if (!peerConnection) {
            createPeerConnection();
        }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

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
        console.log('📥 Received answer');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
        console.error('Error handling answer:', error);
    }
}

async function handleIceCandidate(candidate) {
    try {
        if (peerConnection && candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function init() {
    console.log('🚀 POJO Files - Hybrid Transfer Model');
    console.log('📡 WebRTC: Signaling & Control');
    console.log('📤 HTTP: File Data Transfer');

    setupEventListeners();
    updateConnectionStatus('disconnected', 'Disconnected');
}

function setupEventListeners() {
    const createRoomBtn = document.getElementById('createRoomBtn');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const leaveRoomBtn = document.getElementById('leaveRoomBtn');
    const roomIdInput = document.getElementById('roomId');
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const acceptFileBtn = document.getElementById('acceptFileBtn');
    const rejectFileBtn = document.getElementById('rejectFileBtn');
    const donateBtn = document.getElementById('donateBtn');
    const donateModal = document.getElementById('donateModal');
    const closeModal = document.getElementById('closeModal');
    const developerAvatar = document.querySelector('.developer-avatar');
    const donationImage = document.querySelector('.donation-image');

    if (createRoomBtn) createRoomBtn.addEventListener('click', createRoom);
    if (joinRoomBtn) joinRoomBtn.addEventListener('click', () => joinRoom());
    if (leaveRoomBtn) leaveRoomBtn.addEventListener('click', leaveRoom);

    if (roomIdInput) {
        roomIdInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                joinRoom();
            }
        });
    }

    if (dropZone) {
        dropZone.addEventListener('click', () => fileInput && fileInput.click());
        dropZone.addEventListener('dragover', handleDragOver);
        dropZone.addEventListener('dragleave', handleDragLeave);
        dropZone.addEventListener('drop', handleDrop);
    }

    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }

    if (acceptFileBtn) acceptFileBtn.addEventListener('click', handleAcceptFile);
    if (rejectFileBtn) rejectFileBtn.addEventListener('click', handleRejectFile);

    // Donation modal
    if (donateBtn) {
        donateBtn.addEventListener('click', () => {
            if (donateModal && donationImage) {
                donationImage.src = 'image.png';
                donateModal.style.display = 'flex';
            }
        });
    }

    if (developerAvatar) {
        developerAvatar.addEventListener('click', () => {
            if (donateModal && donationImage) {
                donationImage.src = 'aiks.jpg';
                donateModal.style.display = 'flex';
            }
        });
        developerAvatar.style.cursor = 'pointer';
    }

    if (closeModal) {
        closeModal.addEventListener('click', () => {
            if (donateModal) donateModal.style.display = 'none';
        });
    }

    if (donateModal) {
        donateModal.addEventListener('click', (e) => {
            if (e.target === donateModal) donateModal.style.display = 'none';
        });
    }

    // Escape key closes modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && donateModal) {
            donateModal.style.display = 'none';
        }
    });
}

// Start the application
init();