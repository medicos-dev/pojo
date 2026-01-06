const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

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

// Create HTTP server
const server = http.createServer((req, res) => {
    // Handle WebSocket upgrade requests
    if (req.headers.upgrade === 'websocket') {
        return; // Let WebSocket server handle it
    }

    // Parse URL
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    // Get file extension
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    // Read and serve file
    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                // File not found, serve index.html for SPA routing
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

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    let currentRoom = null;
    let isInitiator = false;
    
    console.log('New WebSocket connection');
    
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
                    // Keepalive - just acknowledge
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
        // Only clean up if we have a room
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
        
        // Leave previous room if any
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
        
        console.log(`Client joined room: ${roomId} (${room.length} clients)`);
        
        // Notify client
        ws.send(JSON.stringify({ type: 'joined', room: roomId }));
        
        // Notify other clients in room
        if (room.length > 1) {
            room.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'peer-joined', room: roomId }));
                }
            });
        }
    }
    
    function handleLeave(ws, roomId) {
        if (!roomId) {
            // If no roomId provided, find the room this client is in
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
        
        // Don't auto-delete rooms - keep them active indefinitely
        // Rooms persist until server restart
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
        
        console.log(`Forwarding offer in room ${data.room} to ${room.length - 1} other client(s)`);
        
        // Forward offer to other clients in room
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'offer',
                    offer: data.offer,
                    room: data.room
                }));
                console.log('Offer forwarded');
            }
        });
    }
    
    function handleAnswer(ws, data) {
        const room = rooms.get(data.room);
        if (!room) {
            console.log('Room not found for answer:', data.room);
            return;
        }
        
        console.log(`Forwarding answer in room ${data.room} to ${room.length - 1} other client(s)`);
        
        // Forward answer to other clients in room
        room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'answer',
                    answer: data.answer,
                    room: data.room
                }));
                console.log('Answer forwarded');
            }
        });
    }
    
    function handleIceCandidate(ws, data) {
        const room = rooms.get(data.room);
        if (!room) return;
        
        // Forward ICE candidate to other clients in room
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

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
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
