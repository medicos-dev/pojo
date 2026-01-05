# Git Push Troubleshooting Guide

## Current Status
✅ Your code is committed locally
❌ No GitHub remote configured yet

## Step-by-Step Solution

### Option 1: If you already have a GitHub repository

1. **Add the remote** (replace with your actual repo URL):
```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
```

2. **Rename branch to main** (GitHub standard):
```bash
git branch -M main
```

3. **Push to GitHub**:
```bash
git push -u origin main
```

### Option 2: Create new GitHub repository first

1. **Go to GitHub**: https://github.com/new
2. **Repository name**: `p2p-file-transfer` (or your choice)
3. **Visibility**: Public or Private (your choice)
4. **DO NOT** check:
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license
5. **Click "Create repository"**

6. **Then run these commands** (GitHub will show them):
```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git branch -M main
git push -u origin main
```

## Common Issues & Solutions

### Issue: "remote origin already exists"
**Solution**: Remove and re-add:
```bash
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
```

### Issue: "Authentication failed"
**Solution**: Use Personal Access Token instead of password:
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with `repo` permissions
3. Use token as password when pushing

### Issue: "Permission denied"
**Solution**: Check repository URL is correct and you have access

### Issue: "Branch name mismatch"
**Solution**: Your branch is `master`, GitHub uses `main`:
```bash
git branch -M main
git push -u origin main
```

## Quick Commands Reference

```bash
# Check current remotes
git remote -v

# Add remote
git remote add origin https://github.com/USERNAME/REPO.git

# Remove remote (if wrong)
git remote remove origin

# Rename branch
git branch -M main

# Push to GitHub
git push -u origin main

# If push fails, force push (use carefully!)
git push -u origin main --force
```

