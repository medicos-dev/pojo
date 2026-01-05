# Render Deployment Guide

This guide will help you deploy the P2P File Transfer application to Render's free tier.

## Prerequisites

1. A GitHub account
2. A Render account (sign up at https://render.com)
3. Your code pushed to a GitHub repository

## Step 1: Push Code to GitHub

If you haven't already, push your code to GitHub:

```bash
git add .
git commit -m "Initial commit - Render deployment ready"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

## Step 2: Create Render Web Service

1. **Log in to Render Dashboard**
   - Go to https://dashboard.render.com
   - Sign in or create an account

2. **Create New Web Service**
   - Click "New +" button
   - Select "Web Service"

3. **Connect GitHub Repository**
   - Click "Connect GitHub"
   - Authorize Render to access your repositories
   - Select your repository containing this project
   - Click "Connect"

## Step 3: Configure Web Service

### Basic Settings

- **Name**: `p2p-file-transfer` (or your preferred name)
- **Region**: Choose closest to your users (e.g., `Oregon (US West)`)
- **Branch**: `main` (or your default branch)
- **Root Directory**: Leave empty (root of repo)
- **Runtime**: `Node`
- **Build Command**: Leave empty (no build step needed)
- **Start Command**: `npm start`

### Environment Settings

**No environment variables needed** - the app uses `process.env.PORT` automatically.

### Advanced Settings (Optional)

- **Auto-Deploy**: `Yes` (deploys on every push to main branch)
- **Health Check Path**: `/health`

## Step 4: Deploy

1. Click "Create Web Service"
2. Render will:
   - Clone your repository
   - Install dependencies (`npm install`)
   - Start the server (`npm start`)
3. Wait for deployment to complete (usually 2-3 minutes)

## Step 5: Access Your Application

Once deployed, Render will provide:
- **Service URL**: `https://your-app-name.onrender.com`
- The app will automatically use `wss://` for WebSocket connections

## Step 6: Test the Deployment

1. Open your Render service URL in a browser
2. Create a room and share the room ID
3. Open the same URL in another browser/device
4. Join the room and test file transfer

## Important Notes

### Free Tier Limitations

- **Spins down after 15 minutes of inactivity**
- First request after spin-down takes ~30 seconds (cold start)
- **WebSocket connections persist** during active sessions
- **No file data passes through Render** - only signaling

### WebSocket on Render

- Render automatically handles WebSocket upgrades
- Use `wss://` (secure WebSocket) on Render
- The app auto-detects Render deployment and uses correct protocol

### Health Check

- Render monitors `/health` endpoint
- Keeps service alive during active use
- Helps with faster cold starts

## Troubleshooting

### Service Won't Start

1. Check build logs in Render dashboard
2. Verify `package.json` has correct `start` script
3. Ensure `server.js` listens on `process.env.PORT`

### WebSocket Not Connecting

1. Verify you're using `wss://` (not `ws://`)
2. Check browser console for WebSocket errors~
3. Ensure Render service is running (not spun down)

### Files Not Transferring

- **This is normal** - files transfer directly P2P, not through Render
- Check WebRTC connection status in the app
- Verify both peers are connected (green status indicator)

## Monitoring

- View logs in Render dashboard
- Monitor WebSocket connections in server logs
- Check health endpoint: `https://your-app.onrender.com/health`

## Cost

- **Free tier is sufficient** for this application
- No database or file storage needed
- Only WebSocket signaling traffic (minimal bandwidth)

## Support

For issues:
1. Check Render logs in dashboard
2. Check browser console for client-side errors
3. Verify both peers can access the Render service URL

---

**Deployment Complete!** 🎉

Your P2P file transfer app is now live on Render. Share the URL with others to transfer files directly between peers.

