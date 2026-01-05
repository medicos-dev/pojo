# Push to GitHub - Quick Guide

## Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Create a new repository (e.g., `p2p-file-transfer`)
3. **DO NOT** initialize with README, .gitignore, or license (we already have these)
4. Click "Create repository"

## Step 2: Push Your Code

Run these commands in your terminal (from the project directory):

```bash
# Add your GitHub repository as remote
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

# Rename branch to main (if needed)
git branch -M main

# Push to GitHub
git push -u origin main
```

Replace:
- `YOUR_USERNAME` with your GitHub username
- `YOUR_REPO_NAME` with your repository name

## Step 3: Verify

1. Go to your GitHub repository page
2. Verify all files are uploaded
3. Check that `.gitignore` is present (to exclude `node_modules/`)

## Next Steps

After pushing to GitHub, follow `RENDER_DEPLOYMENT.md` to deploy to Render.

