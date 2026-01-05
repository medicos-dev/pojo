# Setup Instructions

## 1. Start the Signaling Server

First, make sure you have Node.js installed, then:

```bash
npm install
npm start
```

The server will start on `http://localhost:8080`

## 2. Open VS Code Dev Tunnel

### Option A: Using VS Code Command Palette

1. In VS Code, press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Ports: Focus on Ports View" and select it
3. In the Ports panel, find port `8080`
4. Right-click on port `8080` and select "Port Visibility: Public"
5. VS Code will create a dev tunnel and show you the public URL (e.g., `https://xxxx-xx-xx-xx-xx.asse.devtunnels.ms`)

### Option B: Using Command Line

1. Install the Dev Tunnels CLI if not already installed:
   ```bash
   npm install -g @microsoft/dev-tunnels-cli
   ```

2. Create a tunnel:
   ```bash
   devtunnel host -p 8080 --allow-anonymous
   ```

3. Copy the public URL shown (e.g., `https://xxxx-xx-xx-xx-xx.asse.devtunnels.ms`)

## 3. Update WebSocket URL

Once you have the dev tunnel URL, you need to update the WebSocket connection:

### Method 1: URL Parameters (Recommended)

Open `index.html` in your browser with URL parameters:
```
file:///path/to/index.html?ws=your-tunnel-url.asse.devtunnels.ms&port=443
```

Or if using a local server:
```
http://localhost:3000/index.html?ws=your-tunnel-url.asse.devtunnels.ms&port=443
```

**Important:** 
- Remove `https://` from the tunnel URL
- Use port `443` for HTTPS tunnels (wss://)
- Use the actual port if it's different

### Method 2: Edit app.js Directly

If you prefer, you can edit `app.js` and change line 10:

```javascript
const WS_URL = 'wss://your-tunnel-url.asse.devtunnels.ms';
```

## 4. Share the Setup

**For the person receiving files:**
1. They need the same dev tunnel URL
2. Open `index.html` with the same URL parameters
3. Or edit their `app.js` with the same WebSocket URL

## 5. Connect

1. **Person 1 (Sender):**
   - Click "Create Room"
   - Share the room ID with Person 2

2. **Person 2 (Receiver):**
   - Enter the room ID
   - Click "Join Room"

3. Wait for "P2P Connected" status
4. Start transferring files!

## Troubleshooting

### "Disconnected" Status

- **Check if server is running:** Make sure `npm start` is running
- **Check WebSocket URL:** Verify the URL in browser console (F12)
- **Check firewall:** Make sure port 8080 is accessible
- **Check dev tunnel:** Verify the tunnel is active and public

### Connection Errors

- Open browser console (F12) to see detailed error messages
- Verify both users are using the same WebSocket URL
- Check that the dev tunnel is set to "Public" visibility

### WebSocket Connection Failed

- If using dev tunnel, make sure to use `wss://` (secure WebSocket) not `ws://`
- Check that the tunnel URL is correct (no trailing slashes)
- Verify the port matches (usually 443 for HTTPS tunnels)

## Quick Test (Local Only)

If testing locally without dev tunnel:

1. Both users should be on the same network
2. Use `localhost:8080` (default)
3. Open `index.html` directly in browser
4. Make sure server is running on both machines OR
5. One person runs server, other connects to that IP: `ws://192.168.x.x:8080`

