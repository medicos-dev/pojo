const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ============================================================================
// UPLOAD SESSION MANAGEMENT
// ============================================================================
// In-memory storage for upload sessions (use Redis/DB for production)
const uploadSessions = new Map();
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour timeout for incomplete uploads

// Generate unique upload ID
function generateUploadId() {
    return crypto.randomBytes(16).toString('hex');
}

// Cleanup expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [uploadId, session] of uploadSessions.entries()) {
        if (now - session.lastActivity > UPLOAD_TIMEOUT_MS) {
            console.log(`🗑️ Cleaning up expired upload session: ${uploadId}`);
            // Clean up temp file if exists
            if (session.tempFilePath && fs.existsSync(session.tempFilePath)) {
                try {
                    fs.unlinkSync(session.tempFilePath);
                } catch (e) {
                    console.error(`Failed to delete temp file: ${e.message}`);
                }
            }
            uploadSessions.delete(uploadId);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

// Health check endpoint
function handleHealthCheck(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeUploads: uploadSessions.size
    }));
}

// Store active rooms and their connections
const rooms = new Map();

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log('📁 Created uploads directory');
}

// ============================================================================
// HTTP REQUEST HANDLERS
// ============================================================================

// Parse JSON body from request
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// Collect raw body as Buffer
function collectRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Handle upload session creation
async function handleCreateUploadSession(req, res) {
    try {
        const body = await parseJsonBody(req);
        const { fileName, fileSize, mimeType, chunkSize } = body;

        if (!fileName || !fileSize) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'fileName and fileSize are required' }));
            return;
        }

        const uploadId = generateUploadId();
        const tempFilePath = path.join(UPLOADS_DIR, `${uploadId}.tmp`);

        // Create empty temp file
        fs.writeFileSync(tempFilePath, Buffer.alloc(0));

        const session = {
            uploadId,
            fileName,
            fileSize,
            mimeType: mimeType || 'application/octet-stream',
            chunkSize: Math.max(chunkSize || 4 * 1024 * 1024, 1024 * 1024), // Min 1MB
            receivedBytes: 0,
            tempFilePath,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            complete: false
        };

        uploadSessions.set(uploadId, session);

        console.log(`📤 Upload session created: ${uploadId} for ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            uploadId,
            uploadUrl: `/upload/${uploadId}`,
            maxChunkSize: session.chunkSize,
            receivedBytes: 0
        }));
    } catch (error) {
        console.error('Error creating upload session:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Handle chunk upload with Content-Range
async function handleChunkUpload(req, res, uploadId) {
    try {
        const session = uploadSessions.get(uploadId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload session not found' }));
            return;
        }

        if (session.complete) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload already complete' }));
            return;
        }

        // Parse Content-Range header: bytes start-end/total
        const rangeHeader = req.headers['content-range'];
        let start = session.receivedBytes;
        let end, total;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes (\d+)-(\d+)\/(\d+)/);
            if (match) {
                start = parseInt(match[1], 10);
                end = parseInt(match[2], 10);
                total = parseInt(match[3], 10);

                // Validate range consistency
                if (total !== session.fileSize) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `File size mismatch: expected ${session.fileSize}, got ${total}` }));
                    return;
                }
            }
        }

        // Collect chunk data
        const chunkData = await collectRawBody(req);

        if (chunkData.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Empty chunk' }));
            return;
        }

        // Write chunk to temp file at correct offset
        const fd = fs.openSync(session.tempFilePath, 'r+');
        fs.writeSync(fd, chunkData, 0, chunkData.length, start);
        fs.closeSync(fd);

        // Update session
        session.receivedBytes = start + chunkData.length;
        session.lastActivity = Date.now();

        const isComplete = session.receivedBytes >= session.fileSize;
        if (isComplete) {
            session.complete = true;
            console.log(`✅ Upload complete: ${uploadId} (${session.fileName})`);
        }

        // Log progress periodically (every 10%)
        const progress = (session.receivedBytes / session.fileSize) * 100;
        if (Math.floor(progress / 10) > Math.floor((session.receivedBytes - chunkData.length) / session.fileSize * 100 / 10)) {
            console.log(`📊 Upload ${uploadId}: ${progress.toFixed(1)}% (${(session.receivedBytes / 1024 / 1024).toFixed(2)} MB)`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            bytesReceived: session.receivedBytes,
            complete: isComplete,
            progress: progress.toFixed(2)
        }));
    } catch (error) {
        console.error('Error handling chunk upload:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Handle upload status check
function handleUploadStatus(req, res, uploadId) {
    const session = uploadSessions.get(uploadId);
    if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload session not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        uploadId: session.uploadId,
        fileName: session.fileName,
        fileSize: session.fileSize,
        receivedBytes: session.receivedBytes,
        complete: session.complete,
        progress: ((session.receivedBytes / session.fileSize) * 100).toFixed(2)
    }));
}

// Handle upload completion (optional hash verification)
async function handleUploadComplete(req, res, uploadId) {
    try {
        const session = uploadSessions.get(uploadId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload session not found' }));
            return;
        }

        const body = await parseJsonBody(req);
        const { hash } = body;

        // Verify file size
        const stats = fs.statSync(session.tempFilePath);
        if (stats.size !== session.fileSize) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'File size mismatch',
                expected: session.fileSize,
                actual: stats.size
            }));
            return;
        }

        // Optional: Verify hash
        if (hash) {
            const fileHash = await computeFileHash(session.tempFilePath);
            if (fileHash !== hash) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Hash mismatch',
                    expected: hash,
                    actual: fileHash
                }));
                return;
            }
            console.log(`✅ Hash verified for ${uploadId}: ${hash.substring(0, 16)}...`);
        }

        session.complete = true;
        session.lastActivity = Date.now();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            uploadId,
            fileName: session.fileName,
            fileSize: session.fileSize
        }));
    } catch (error) {
        console.error('Error completing upload:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
}

// Compute SHA-256 hash of file
function computeFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Handle file download
function handleDownload(req, res, uploadId) {
    const session = uploadSessions.get(uploadId);
    if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upload session not found' }));
        return;
    }

    if (!session.complete && session.receivedBytes < session.fileSize) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Upload not complete',
            receivedBytes: session.receivedBytes,
            fileSize: session.fileSize
        }));
        return;
    }

    const filePath = session.tempFilePath;
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found on server' }));
        return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Handle Range requests for resumable downloads
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': session.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(session.fileName)}"`
        });

        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': session.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(session.fileName)}"`,
            'Accept-Ranges': 'bytes'
        });

        fs.createReadStream(filePath).pipe(res);
    }

    console.log(`📥 Download started: ${uploadId} (${session.fileName})`);
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
    // Handle WebSocket upgrade requests
    if (req.headers.upgrade === 'websocket') {
        return; // Let WebSocket server handle it
    }

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Health check endpoint
    if (pathname === '/health' || pathname === '/healthz') {
        handleHealthCheck(req, res);
        return;
    }

    // ========== UPLOAD API ==========

    // Create upload session: POST /upload/session
    if (pathname === '/upload/session' && req.method === 'POST') {
        await handleCreateUploadSession(req, res);
        return;
    }

    // Upload chunk: PUT /upload/:uploadId
    const uploadMatch = pathname.match(/^\/upload\/([a-f0-9]{32})$/);
    if (uploadMatch && req.method === 'PUT') {
        await handleChunkUpload(req, res, uploadMatch[1]);
        return;
    }

    // Get upload status: GET /upload/:uploadId
    if (uploadMatch && req.method === 'GET') {
        handleUploadStatus(req, res, uploadMatch[1]);
        return;
    }

    // Complete upload: POST /upload/:uploadId/complete
    const completeMatch = pathname.match(/^\/upload\/([a-f0-9]{32})\/complete$/);
    if (completeMatch && req.method === 'POST') {
        await handleUploadComplete(req, res, completeMatch[1]);
        return;
    }

    // ========== DOWNLOAD API ==========

    // Download file: GET /download/:uploadId
    const downloadMatch = pathname.match(/^\/download\/([a-f0-9]{32})$/);
    if (downloadMatch && req.method === 'GET') {
        handleDownload(req, res, downloadMatch[1]);
        return;
    }

    // ========== STATIC FILES ==========

    // Serve static files
    let filePath = '.' + pathname;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                fs.readFile('./index.html', (err, content) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Server Error: ' + err.code);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(content, 'utf-8');
                    }
                });
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

// ============================================================================
// WEBSOCKET SERVER (Signaling Only)
// ============================================================================

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    let currentRoom = null;
    let isInitiator = false;

    const clientIP = req.socket.remoteAddress || 'unknown';
    console.log(`📡 New WebSocket connection from ${clientIP}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.type) {
                case 'join':
                    handleJoin(ws, data.room);
                    break;
                case 'leave':
                    handleLeave(ws, data.room);
                    break;
                case 'ping':
                    // Keepalive - acknowledge
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                case 'offer':
                    handleOffer(ws, data);
                    break;
                case 'answer':
                    handleAnswer(ws, data);
                    break;
                case 'ice-candidate':
                    handleIceCandidate(ws, data);
                    break;
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        if (currentRoom) {
            handleLeave(ws, currentRoom);
        }
        console.log('WebSocket connection closed');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    function handleJoin(ws, roomId) {
        if (!roomId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room ID required' }));
            return;
        }

        if (currentRoom) {
            handleLeave(ws, currentRoom);
        }

        currentRoom = roomId;

        if (!rooms.has(roomId)) {
            rooms.set(roomId, []);
            isInitiator = true;
        }

        const room = rooms.get(roomId);
        room.push(ws);

        console.log(`✅ Client joined room: ${roomId} (${room.length} client${room.length > 1 ? 's' : ''})`);

        ws.send(JSON.stringify({ type: 'joined', room: roomId }));

        if (room.length > 1) {
            room.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'peer-joined', room: roomId }));
                }
            });
            console.log(`📤 Notified ${room.length - 1} peer(s) about new client in room ${roomId}`);
        }
    }

    function handleLeave(ws, roomId) {
        if (!roomId) {
            for (const [id, room] of rooms.entries()) {
                if (room.includes(ws)) {
                    roomId = id;
                    break;
                }
            }
        }

        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const index = room.indexOf(ws);
        if (index > -1) {
            room.splice(index, 1);
        }

        if (room.length === 0) {
            console.log(`Room ${roomId} is now empty (kept active for future joins)`);
        } else {
            console.log(`Client left room: ${roomId} (${room.length} clients remaining)`);
        }
    }

    function handleOffer(ws, data) {
        const room = rooms.get(data.room);
        if (!room) {
            console.log('Room not found for offer:', data.room);
            return;
        }

        console.log(`📤 Forwarding SDP offer in room ${data.room}`);

        let forwarded = 0;
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'offer',
                    offer: data.offer,
                    room: data.room
                }));
                forwarded++;
            }
        });
        if (forwarded > 0) {
            console.log(`✅ SDP offer forwarded to ${forwarded} peer(s)`);
        }
    }

    function handleAnswer(ws, data) {
        const room = rooms.get(data.room);
        if (!room) {
            console.log('Room not found for answer:', data.room);
            return;
        }

        console.log(`📤 Forwarding SDP answer in room ${data.room}`);

        let forwarded = 0;
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'answer',
                    answer: data.answer,
                    room: data.room
                }));
                forwarded++;
            }
        });
        if (forwarded > 0) {
            console.log(`✅ SDP answer forwarded to ${forwarded} peer(s)`);
        }
    }

    function handleIceCandidate(ws, data) {
        const room = rooms.get(data.room);
        if (!room) return;

        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: data.candidate,
                    room: data.room
                }));
            }
        });
    }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready for signaling`);
    console.log(`📤 HTTP upload API ready at /upload/*`);
    console.log(`📥 HTTP download API ready at /download/*`);
    console.log(`🏥 Health check available at /health`);
    if (process.env.RENDER) {
        console.log(`🌐 Render deployment detected`);
    } else {
        console.log(`🌐 Local development - Open http://localhost:${PORT}`);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    wss.close(() => {
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, closing server...');
    wss.close(() => {
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
});
