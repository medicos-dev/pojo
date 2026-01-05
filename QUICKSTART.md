# Quick Start Guide

## Step 1: Start the Server

Open a terminal in the project folder and run:
```bash
npm install
npm start
```

You should see:
```
🚀 Server running on http://localhost:8080
📡 WebSocket server ready for connections
🌐 Open http://localhost:8080 in your browser
```

## Step 2: Open the Web Page (Local Testing)

Simply open your browser and go to:
```
http://localhost:8080
```

The page should load automatically! The WebSocket will connect to the same server.

## Step 3: Set Up VS Code Dev Tunnel (For Remote Access)

If you want to share with someone else over the internet:

### In VS Code:

1. Press `Ctrl+Shift+P` (Windows) or `Cmd+Shift+P` (Mac)
2. Type: **"Ports: Focus on Ports View"** and press Enter
3. In the Ports panel, find **port 8080**
4. Right-click on port 8080 → Select **"Port Visibility: Public"**
5. VS Code will show you a public URL like: `https://xxxx-xx-xx-xx-xx.asse.devtunnels.ms`

**Copy this URL!**

## Step 4: Share the Dev Tunnel URL

**Person 1 (You):**
- Open: `http://localhost:8080` (or the dev tunnel URL)
- Click "Create Room"
- Share the room ID with Person 2

**Person 2:**
- Open: `https://xxxx-xx-xx-xx-xx.asse.devtunnels.ms` (the dev tunnel URL)
- Enter the room ID
- Click "Join Room"
- Wait for "P2P Connected" status

## Step 5: Start Transferring Files!

1. Once both people see "P2P Connected" status
2. Drag & drop files or click to browse
3. Files will transfer automatically!

**Note:** When using dev tunnel, both people should use the same dev tunnel URL.

## Troubleshooting

### "Disconnected" Status

- ✅ Check browser console (F12) for errors
- ✅ Verify server is running: `npm start` (should show "Server running on http://localhost:8080")
- ✅ Make sure you're accessing via `http://localhost:8080` not `file://`
- ✅ Check dev tunnel is "Public" in VS Code Ports panel (if using remote access)
- ✅ Verify WebSocket URL in the connection info (shown when connecting)

### Connection Errors in Console

- **"WebSocket connection failed"**: 
  - Make sure server is running (`npm start`)
  - Check you're using `http://localhost:8080` not opening the HTML file directly
- **"Server connection failed"**: 
  - Server might not be running - check terminal
  - Port 8080 might be blocked by firewall
- **"Connection refused"**: 
  - Dev tunnel might not be active (check VS Code Ports panel)
  - Server might have crashed (check terminal)

### Local Network Test (No Dev Tunnel)

If both people are on the same local network:

1. Person 1: Run `npm start` and find your local IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Person 1: Open `http://localhost:8080`
3. Person 2: Open `http://192.168.x.x:8080` (replace with Person 1's IP address)
4. Both should now be able to connect!

## Need Help?

- Check browser console (F12) for detailed error messages
- The connection info will show the WebSocket URL being used
- Make sure both people use the same dev tunnel URL

