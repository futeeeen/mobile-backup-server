const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode-terminal');

const isPackaged = typeof process.pkg !== 'undefined';
const rootAppDir = isPackaged ? path.dirname(process.execPath) : __dirname;

// Helper to load config or use defaults
function loadConfig() {
  const configPath = path.join(rootAppDir, 'backup-config.json');
  let config = { backupDir: '', port: 11900 };
  
  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      config = { ...config, ...JSON.parse(fileContent) };
    } catch (e) {
      console.error('Warning: Failed to parse backup-config.json. Using defaults.', e.message);
    }
  }
  return config;
}

const config = loadConfig();
const PORT = config.port || 11900;

// Resolve backup directory
function getBackupDirectory() {
  let dir = config.backupDir;
  if (!dir) {
    // Default to 'ios-camera-backups-file' in the parent directory (or same directory if packaged)
    dir = path.join(rootAppDir, 'ios-camera-backups-file');
  } else if (!path.isAbsolute(dir)) {
    // Resolve relative path to absolute
    dir = path.resolve(rootAppDir, dir);
  }
  return dir;
}

const backupDir = getBackupDirectory();

// Ensure backup directory exists
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Set up Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Helper to get prioritized list of local IP addresses
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const list = [];
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        list.push({ name, address: iface.address });
      }
    }
  }
  // Sort prioritized interfaces (prefer Wi-Fi, avoid virtual switches like WSL)
  list.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aWifi = aName.includes('wi-fi') || aName.includes('wireless') || aName.includes('wlan');
    const bWifi = bName.includes('wi-fi') || bName.includes('wireless') || bName.includes('wlan');
    if (aWifi && !bWifi) return -1;
    if (!aWifi && bWifi) return 1;
    
    const aVirt = aName.includes('vethernet') || aName.includes('virtual') || aName.includes('wsl');
    const bVirt = bName.includes('vethernet') || bName.includes('virtual') || bName.includes('wsl');
    if (aVirt && !bVirt) return 1;
    if (!aVirt && bVirt) return -1;

    const aEth = aName.includes('ethernet');
    const bEth = bName.includes('ethernet');
    if (aEth && !bEth) return -1;
    if (!aEth && bEth) return 1;
    
    return 0;
  });
  return list.length > 0 ? list.map(item => item.address) : ['localhost'];
}

// Helper to get the top priority local IP address
function getLocalIpAddress() {
  return getLocalIpAddresses()[0];
}

// Helper to recursively scan files in the backup directory
function scanBackupFiles(dirPath, fileList = []) {
  if (!fs.existsSync(dirPath)) return fileList;
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanBackupFiles(fullPath, fileList);
      } else {
        fileList.push({
          filename: file,
          path: fullPath,
          size: stat.size,
          mtime: stat.mtime
        });
      }
    } catch (err) {
      // Ignore read errors
    }
  }
  return fileList;
}

const indexFilePath = path.join(rootAppDir, 'backup-index.json');
let backupIndex = {}; // Mapping: assetId -> { path, filename, creationTime, size }
const timeNameSet = new Set(); // Set of strings: `${creationTime}_${filename.toLowerCase()}`

// Save index database to disk
function saveIndex() {
  try {
    fs.writeFileSync(indexFilePath, JSON.stringify(backupIndex, null, 2), 'utf8');
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      exec(`attrib +h "${indexFilePath}"`, (err) => {
        if (err) {
          console.warn('Warning: Could not hide backup-index.json:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('Error saving backup-index.json:', err.message);
  }
}

// Helper to sanitize/clean base name from suffix counters (e.g. IMG_0001_(1).JPG -> IMG_0001.JPG)
function getOriginalFilename(savedFilename) {
  const parsed = path.parse(savedFilename);
  const cleanBase = parsed.name.replace(/_\(\d+\)$/, '');
  return cleanBase + parsed.ext;
}

// Load or rebuild index database
function loadOrRebuildIndex() {
  let loadedIndex = {};
  let needsSave = false;
  timeNameSet.clear();

  if (fs.existsSync(indexFilePath)) {
    try {
      const content = fs.readFileSync(indexFilePath, 'utf8');
      loadedIndex = JSON.parse(content);
      console.log(`Loaded ${Object.keys(loadedIndex).length} index entries from backup-index.json`);
      
      // Verify that all indexed files actually exist on disk and build timeNameSet
      for (const assetId in loadedIndex) {
        const entry = loadedIndex[assetId];
        const relPath = typeof entry === 'string' ? entry : entry.path;
        const fullPath = path.join(backupDir, relPath);
        
        if (!fs.existsSync(fullPath)) {
          console.log(`Indexed file missing on disk, removing: ${relPath}`);
          delete loadedIndex[assetId];
          needsSave = true;
        } else {
          // Normalize legacy entries to object format
          if (typeof entry === 'string') {
            const stat = fs.statSync(fullPath);
            const savedName = path.basename(fullPath);
            const origName = getOriginalFilename(savedName);
            loadedIndex[assetId] = {
              path: relPath,
              filename: origName,
              creationTime: stat.mtime.getTime(),
              size: stat.size
            };
            needsSave = true;
          }
          
          const normEntry = loadedIndex[assetId];
          const key = `${normEntry.creationTime}_${normEntry.filename.toLowerCase()}`;
          timeNameSet.add(key);
        }
      }
    } catch (err) {
      console.error('Failed to parse backup-index.json, triggering rebuild:', err.message);
      loadedIndex = rebuildIndexFromDisk();
      needsSave = true;
    }
  } else {
    console.log('backup-index.json not found. Scanning backup folder to rebuild index...');
    loadedIndex = rebuildIndexFromDisk();
    needsSave = true;
  }

  backupIndex = loadedIndex;
  if (needsSave) {
    saveIndex();
  }
}

// Scan files on disk and rebuild index
function rebuildIndexFromDisk() {
  const newIndex = {};
  const allFiles = scanBackupFiles(backupDir);
  timeNameSet.clear();

  // Exclude backup-index.json and backup-config.json from index scanning
  const filesToProcess = allFiles.filter(f => {
    const name = path.basename(f.path).toLowerCase();
    return name !== 'backup-index.json' && name !== 'backup-config.json';
  });

  for (const file of filesToProcess) {
    const filename = file.filename;
    const relPath = path.relative(backupDir, file.path).replace(/\\/g, '/');
    
    // Check if it's the old naming format (with double underscore '__')
    const doubleUnderscoreIdx = filename.indexOf('__');
    let cleanId;
    let origFilename;
    let creationTime;

    if (doubleUnderscoreIdx !== -1) {
      cleanId = filename.substring(0, doubleUnderscoreIdx);
      origFilename = filename.substring(doubleUnderscoreIdx + 2);
      creationTime = file.mtime.getTime();
    } else {
      creationTime = file.mtime.getTime();
      cleanId = `web_${file.size}_${creationTime}`;
      origFilename = getOriginalFilename(filename);
    }

    newIndex[cleanId] = {
      path: relPath,
      filename: origFilename,
      creationTime: creationTime,
      size: file.size
    };

    const key = `${creationTime}_${origFilename.toLowerCase()}`;
    timeNameSet.add(key);
  }

  console.log(`Rebuilt index with ${Object.keys(newIndex).length} entries.`);
  return newIndex;
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const creationTime = parseInt(req.query.creationTime, 10);
    let subDir = 'unknown-date';

    if (!isNaN(creationTime) && creationTime > 0) {
      const date = new Date(creationTime);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDir = `${year}-${month}`;
    } else {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDir = `${year}-${month}`;
    }

    const targetDir = path.join(backupDir, subDir);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const originalName = req.query.filename || file.originalname || 'file';
    const parsedName = path.parse(originalName);
    
    // Parse creationTime to resolve correct destination directory path
    const creationTime = parseInt(req.query.creationTime, 10);
    let subDir = 'unknown-date';
    if (!isNaN(creationTime) && creationTime > 0) {
      const date = new Date(creationTime);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDir = `${year}-${month}`;
    } else {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      subDir = `${year}-${month}`;
    }
    
    const targetDir = path.join(backupDir, subDir);
    
    let finalFilename = originalName;
    let counter = 1;
    
    while (fs.existsSync(path.join(targetDir, finalFilename))) {
      const cleanId = (req.query.assetId || 'unknown-id').replace(/[^a-zA-Z0-9-_]/g, '_');
      const relPath = `${subDir}/${finalFilename}`.replace(/\\/g, '/');
      
      // If same asset ID mapping to the same filename, overwrite
      if (backupIndex[cleanId] && (typeof backupIndex[cleanId] === 'string' ? backupIndex[cleanId] : backupIndex[cleanId].path) === relPath) {
        break;
      }
      
      // Filename collision resolution: append suffix like _(1)
      finalFilename = `${parsedName.name}_(${counter})${parsedName.ext}`;
      counter++;
    }
    
    cb(null, finalFilename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // limit: 10GB per file
});

// Serve HTML Web Interface
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iOS Wi-Fi 照片備份系統</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: rgba(30, 41, 59, 0.45);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary-color: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.3);
      --success-color: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
      --accent-color: #06b6d4;
      --accent-glow: rgba(6, 182, 212, 0.2);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-radius-lg: 20px;
      --border-radius-md: 12px;
      --transition-fast: 0.2s ease;
      --transition-normal: 0.3s ease;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      background-color: var(--bg-color);
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
        radial-gradient(circle at 100% 80%, rgba(6, 182, 212, 0.08) 0%, transparent 40%);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px;
    }

    .container {
      width: 100%;
      max-width: 600px;
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Glassmorphism Styles */
    .glass-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: var(--border-radius-lg);
      padding: 24px;
      box-shadow: 0 10px 30px -5px rgba(0, 0, 0, 0.3);
      transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
    }

    .glass-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
    }

    /* Header */
    header {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      text-align: center;
      margin-bottom: 10px;
    }

    header h1 {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #f8fafc 30%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header .badge {
      background: linear-gradient(135deg, var(--primary-color), var(--accent-color));
      color: white;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 50px;
      text-transform: uppercase;
      letter-spacing: 1px;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.4);
    }

    /* System Status Card */
    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 16px;
    }

    .status-item {
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: var(--border-radius-md);
      padding: 12px 16px;
    }

    .status-item .label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .status-item .value {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main);
      word-break: break-all;
    }

    /* Connection Pulse */
    .connection-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
    }

    .pulse-dot {
      width: 10px;
      height: 10px;
      background-color: var(--success-color);
      border-radius: 50%;
      box-shadow: 0 0 0 0 var(--success-glow);
      animation: pulse 2s infinite;
    }

    .pulse-dot.disconnected {
      background-color: #f43f5e;
      box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.4);
    }

    @keyframes pulse {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      }
      70% {
        transform: scale(1);
        box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
      }
      100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    /* Main Drag-Drop Zone */
    .dropzone {
      border: 2px dashed rgba(99, 102, 241, 0.35);
      background: rgba(99, 102, 241, 0.02);
      border-radius: var(--border-radius-lg);
      padding: 40px 20px;
      text-align: center;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      transition: all var(--transition-normal);
    }

    .dropzone:hover, .dropzone.dragover {
      border-color: var(--primary-color);
      background: rgba(99, 102, 241, 0.05);
      box-shadow: 0 0 20px var(--primary-glow);
    }

    .dropzone svg {
      width: 56px;
      height: 56px;
      stroke: var(--primary-color);
      transition: transform var(--transition-normal);
    }

    .dropzone:hover svg {
      transform: translateY(-4px);
    }

    .dropzone-text {
      font-size: 16px;
      font-weight: 500;
      color: var(--text-main);
    }

    .dropzone-subtext {
      font-size: 13px;
      color: var(--text-muted);
    }

    /* Buttons */
    .btn {
      width: 100%;
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
      color: white;
      border: none;
      border-radius: var(--border-radius-md);
      padding: 14px 20px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
    }

    .btn:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.5);
    }

    .btn:active:not(:disabled) {
      transform: translateY(1px);
    }

    .btn:disabled {
      background: #334155;
      color: var(--text-muted);
      cursor: not-allowed;
      box-shadow: none;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text-main);
      box-shadow: none;
    }

    .btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: none;
    }

    .btn-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 10px;
    }

    /* Selected Details & De-duplication Stats */
    .stats-card {
      background: rgba(15, 23, 42, 0.35);
      border-radius: var(--border-radius-md);
      padding: 16px;
      margin-top: 16px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .stats-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 14px;
    }

    .stats-row .value {
      font-weight: 600;
    }

    .stats-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.06);
    }

    .dup-banner {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.2);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      color: #34d399;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
    }

    .dup-banner.has-duplicates {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }

    /* Progress Dashboard */
    .progress-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }

    .progress-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-main);
    }

    .progress-percentage {
      font-size: 32px;
      font-weight: 700;
      color: var(--primary-color);
      line-height: 1;
      text-shadow: 0 0 15px rgba(99, 102, 241, 0.2);
    }

    .progress-track {
      height: 10px;
      background: #1e293b;
      border-radius: 50px;
      overflow: hidden;
      position: relative;
    }

    .progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--primary-color), var(--accent-color));
      border-radius: 50px;
      transition: width var(--transition-fast);
      box-shadow: 0 0 10px var(--primary-glow);
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .metric-card {
      background: rgba(15, 23, 42, 0.3);
      padding: 12px;
      border-radius: var(--border-radius-md);
      border: 1px solid rgba(255, 255, 255, 0.03);
      text-align: center;
    }

    .metric-card .val {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent-color);
    }

    .metric-card .lbl {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* File Queue List */
    .queue-list {
      max-height: 200px;
      overflow-y: auto;
      margin-top: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-right: 4px;
    }

    .queue-list::-webkit-scrollbar {
      width: 6px;
    }
    
    .queue-list::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.02);
      border-radius: 10px;
    }
    
    .queue-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
    }

    .queue-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(15, 23, 42, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      font-size: 13px;
    }

    .queue-item-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-width: 75%;
    }

    .queue-item-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .queue-item-size {
      font-size: 11px;
      color: var(--text-muted);
    }

    .queue-item-status {
      font-weight: 600;
      font-size: 12px;
    }

    .queue-item-status.pending { color: var(--text-muted); }
    .queue-item-status.uploading { color: var(--accent-color); }
    .queue-item-status.success { color: var(--success-color); }
    .queue-item-status.error { color: #f43f5e; }

    /* Success Result Screen */
    .success-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 20px 0;
      gap: 16px;
    }

    .success-icon {
      width: 64px;
      height: 64px;
      background: var(--success-glow);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid rgba(16, 185, 129, 0.3);
      animation: scaleIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }

    .success-icon svg {
      width: 36px;
      height: 36px;
      stroke: var(--success-color);
    }

    @keyframes scaleIn {
      from { transform: scale(0); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    /* Footer */
    footer {
      margin-top: 40px;
      margin-bottom: 20px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge">Wi-Fi Backup</div>
      <h1>iOS 相片備份工具</h1>
      <div class="connection-status">
        <div class="pulse-dot" id="connDot"></div>
        <span id="connText">已連線至電腦伺服器</span>
      </div>
    </header>

    <!-- Status panel -->
    <div class="glass-card">
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 4px;">電腦端伺服器狀態</h3>
      <div class="status-grid">
        <div class="status-item">
          <div class="label">備份儲存路徑</div>
          <div class="value" id="srvPath">讀取中...</div>
        </div>
        <div class="status-item">
          <div class="label">已備份檔案容量</div>
          <div class="value" id="srvSize">讀取中...</div>
        </div>
        <div class="status-item">
          <div class="label">總備份檔案數量</div>
          <div class="value" id="srvCount">讀取中...</div>
        </div>
        <div class="status-item">
          <div class="label">伺服器 IP 網址</div>
          <div class="value" id="srvIp">讀取中...</div>
        </div>
      </div>
    </div>

    <!-- Upload Selection screen -->
    <div class="glass-card" id="selectionCard">
      <div class="dropzone" id="dropzone">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v12m0 0l-3-3m3 3l3-3m-9-6a9 9 0 1118 0 9 9 0 01-18 0z" />
        </svg>
        <div class="dropzone-text">點擊選取相片與影片</div>
        <div class="dropzone-subtext">支援多選照片或影片，會自動排除重複項目</div>
      </div>
      <input type="file" id="fileInput" multiple accept="image/*,video/*">

      <!-- Details show when files selected -->
      <div class="hidden" id="selectionStats">
        <div class="stats-card">
          <div class="stats-row">
            <span style="color: var(--text-muted)">已選檔案數量</span>
            <span class="value" id="selectedCount">0</span>
          </div>
          <div class="stats-row">
            <span style="color: var(--text-muted)">檔案總容量</span>
            <span class="value" id="selectedSize">0 MB</span>
          </div>
          <div class="stats-divider"></div>
          <div class="dup-banner" id="dupBanner">
            <svg style="width: 16px; height: 16px; flex-shrink: 0;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span id="dupMsg">進行比對中...</span>
          </div>
        </div>

        <div class="btn-group">
          <button class="btn btn-secondary" id="clearBtn">取消</button>
          <button class="btn" id="startBtn" disabled>開始備份</button>
        </div>
      </div>
    </div>

    <!-- Active Uploading Screen -->
    <div class="glass-card hidden" id="uploadingCard">
      <div class="progress-section">
        <div class="progress-header">
          <div class="progress-title" id="uploadStatusTitle">備份傳輸中...</div>
          <div class="progress-percentage" id="overallPercentage">0%</div>
        </div>
        
        <div class="progress-track">
          <div class="progress-bar" id="overallProgressBar"></div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="val" id="uploadSpeed">0.0 MB/s</div>
            <div class="lbl">傳輸速度</div>
          </div>
          <div class="metric-card">
            <div class="val" id="uploadEta">--</div>
            <div class="lbl">預估剩餘時間</div>
          </div>
        </div>

        <div class="stats-divider"></div>
        
        <div style="font-size: 14px; text-align: center;" id="progressCountText">
          正在上傳第 0 / 0 個檔案
        </div>

        <div class="queue-list" id="queueList">
          <!-- Queue items generated dynamically -->
        </div>
      </div>
    </div>

    <!-- Success Screen -->
    <div class="glass-card hidden" id="successCard">
      <div class="success-screen">
        <div class="success-icon">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h2 style="font-size: 22px; font-weight: 700; color: var(--success-color);">備份已完成！</h2>
        <p style="font-size: 14px; color: var(--text-muted); line-height: 1.6;" id="successSummary">
          成功傳輸了 X 張照片，共計 Y MB。<br>所有重複的照片均已安全跳過。
        </p>
        <button class="btn" id="finishBtn" style="margin-top: 10px;">再備份其他照片</button>
      </div>
    </div>
  </div>

  <footer>
    iOS Local Wi-Fi Backup System &bull; Web App Edition
  </footer>

  <script>
    // Global error handler for debugging on mobile
    window.onerror = function(message, source, lineno, colno, error) {
      const errDiv = document.createElement('div');
      errDiv.style.position = 'fixed';
      errDiv.style.top = '0';
      errDiv.style.left = '0';
      errDiv.style.width = '100%';
      errDiv.style.background = 'rgba(244, 63, 94, 0.95)';
      errDiv.style.color = 'white';
      errDiv.style.padding = '15px';
      errDiv.style.zIndex = '99999';
      errDiv.style.fontSize = '14px';
      errDiv.style.fontFamily = 'monospace';
      errDiv.style.wordBreak = 'break-all';
      errDiv.innerHTML = '<strong>JS Error:</strong> ' + message + '<br><strong>Line:</strong> ' + lineno + ':' + colno + '<br><strong>File:</strong> ' + source;
      document.body.appendChild(errDiv);
      return false;
    };

    const fileInput = document.getElementById('fileInput');
    const dropzone = document.getElementById('dropzone');
    const selectionCard = document.getElementById('selectionCard');
    const selectionStats = document.getElementById('selectionStats');
    const selectedCount = document.getElementById('selectedCount');
    const selectedSize = document.getElementById('selectedSize');
    const dupBanner = document.getElementById('dupBanner');
    const dupMsg = document.getElementById('dupMsg');
    const clearBtn = document.getElementById('clearBtn');
    const startBtn = document.getElementById('startBtn');

    const uploadingCard = document.getElementById('uploadingCard');
    const overallPercentage = document.getElementById('overallPercentage');
    const overallProgressBar = document.getElementById('overallProgressBar');
    const uploadSpeed = document.getElementById('uploadSpeed');
    const uploadEta = document.getElementById('uploadEta');
    const progressCountText = document.getElementById('progressCountText');
    const queueList = document.getElementById('queueList');

    const successCard = document.getElementById('successCard');
    const successSummary = document.getElementById('successSummary');
    const finishBtn = document.getElementById('finishBtn');

    // Server Stats UI
    const srvPath = document.getElementById('srvPath');
    const srvSize = document.getElementById('srvSize');
    const srvCount = document.getElementById('srvCount');
    const srvIp = document.getElementById('srvIp');
    const connDot = document.getElementById('connDot');
    const connText = document.getElementById('connText');

    let allSelectedFiles = [];
    let filesToUpload = [];
    let currentUploadXHR = null;

    // Load server stats on load
    async function loadServerStatus() {
      try {
        const response = await fetch('/status');
        const data = await response.json();
        
        if (data.status === 'ok') {
          srvPath.innerText = data.backupDir;
          srvCount.innerText = data.totalFilesCount + ' 個檔案';
          srvSize.innerText = formatBytes(data.totalFilesSize);
          srvIp.innerText = 'http://' + data.ip + ':' + data.port;
          
          connDot.className = 'pulse-dot';
          connText.innerText = '已連線至電腦伺服器';
        }
      } catch (err) {
        console.error('Failed to load server status:', err);
        connDot.className = 'pulse-dot disconnected';
        connText.innerText = '與伺服器斷開連線';
      }
    }

    loadServerStatus();
    setInterval(loadServerStatus, 5000); // refresh status every 5 seconds

    // File selection trigger
    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      handleFilesSelected(Array.from(e.target.files));
    });

    // Drag and drop events
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFilesSelected(Array.from(e.dataTransfer.files));
      }
    });

    // Reset input so change event triggers even for same file
    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });

    // Format bytes helper
    function formatBytes(bytes, decimals = 2) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const dm = decimals < 0 ? 0 : decimals;
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    // Handle files selected
    function handleFilesSelected(files) {
      if (files.length === 0) return;
      
      allSelectedFiles = files;
      selectedCount.innerText = allSelectedFiles.length;
      
      const totalSize = allSelectedFiles.reduce((sum, f) => sum + f.size, 0);
      selectedSize.innerText = formatBytes(totalSize);

      selectionStats.classList.remove('hidden');
      
      // Update stats info immediately (we will check duplicates in batches later)
      dupBanner.className = 'dup-banner';
      dupMsg.innerHTML = '已選取 <strong>' + allSelectedFiles.length + '</strong> 個檔案，準備就緒。';
      startBtn.disabled = false;
    }

    // Clear selection
    function clearSelection() {
      allSelectedFiles = [];
      filesToUpload = [];
      selectionStats.classList.add('hidden');
      fileInput.value = '';
    }

    clearBtn.addEventListener('click', clearSelection);

    // Start upload process
    startBtn.addEventListener('click', () => {
      if (allSelectedFiles.length === 0) return;
      
      // Transition to uploading view
      selectionCard.classList.add('hidden');
      uploadingCard.classList.remove('hidden');
      
      startBatchUpload();
    });

    // Upload execution logic
    function startBatchUpload() {
      const totalBytes = allSelectedFiles.reduce((sum, f) => sum + f.size, 0);
      let totalUploadedBytes = 0;
      let completedFiles = 0;
      let skippedFiles = 0;
      let failedFiles = 0;
      const startTime = Date.now();
      const CHUNK_SIZE = 100; // Process in batches of 100 files to avoid UI lock and connection timeout

      queueList.innerHTML = '';

      // Process batches sequentially
      async function processNextChunk(chunkIndex) {
        const startIdx = chunkIndex * CHUNK_SIZE;
        if (startIdx >= allSelectedFiles.length) {
          // Finished all chunks!
          showSuccessScreen(completedFiles, skippedFiles, failedFiles, totalBytes);
          return;
        }

        const endIdx = Math.min(startIdx + CHUNK_SIZE, allSelectedFiles.length);
        const chunkFiles = allSelectedFiles.slice(startIdx, endIdx);

        progressCountText.innerText = '正在比對第 ' + (startIdx + 1) + ' ~ ' + endIdx + ' 個檔案 (共 ' + allSelectedFiles.length + ' 個)...';

        // 1. Prepare assetsMeta for this chunk
        const assetsMeta = chunkFiles.map(file => {
          const uniqueId = 'web_' + file.size + '_' + file.lastModified;
          return {
            id: uniqueId,
            filename: file.name,
            creationTime: file.lastModified
          };
        });

        // 2. Query /check-duplicates for this chunk
        let missingFiles = [];
        try {
          const response = await fetch('/check-duplicates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assets: assetsMeta })
          });
          
          if (response.ok) {
            const resData = await response.json();
            const missingIds = new Set(resData.missingAssets.map(ma => ma.id));
            
            missingFiles = chunkFiles.filter(file => {
              const id = 'web_' + file.size + '_' + file.lastModified;
              return missingIds.has(id);
            });

            const chunkSkipped = chunkFiles.length - missingFiles.length;
            skippedFiles += chunkSkipped;
            
            // Immediately account for skipped files size in the progress bar
            const skippedBytes = chunkFiles.filter(file => {
              const id = 'web_' + file.size + '_' + file.lastModified;
              return !missingIds.has(id);
            }).reduce((sum, f) => sum + f.size, 0);
            
            totalUploadedBytes += skippedBytes;
          } else {
            // Fallback: upload all files in the chunk on server error
            missingFiles = chunkFiles;
          }
        } catch (err) {
          console.error('Deduplication check error for chunk:', err);
          // Fallback: upload all files in the chunk on network error
          missingFiles = chunkFiles;
        }

        // 3. Upload missing files in this chunk sequentially
        let missingFileIndex = 0;

        function uploadNextMissingFile() {
          if (missingFileIndex >= missingFiles.length) {
            // Done with this batch, move to next batch
            processNextChunk(chunkIndex + 1);
            return;
          }

          const file = missingFiles[missingFileIndex];
          const assetId = 'web_' + file.size + '_' + file.lastModified;
          const globalFileIndex = startIdx + chunkFiles.indexOf(file);

          progressCountText.innerText = '正在上傳第 ' + (globalFileIndex + 1) + ' / ' + allSelectedFiles.length + ' 個檔案 (已略過重複 ' + skippedFiles + ' 個)';

          // Render current item in queue list on-demand
          const item = document.createElement('div');
          item.className = 'queue-item';
          item.id = 'queue-item-' + globalFileIndex;
          item.innerHTML = '<div class="queue-item-info"><div class="queue-item-name">' + file.name + '</div><div class="queue-item-size">' + formatBytes(file.size) + '</div></div><div class="queue-item-status uploading" id="queue-status-' + globalFileIndex + '">0%</div>';
          
          queueList.appendChild(item);
          item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          
          // Maintain at most 10 items in the queue list to keep performance high
          while (queueList.childNodes.length > 10) {
            queueList.removeChild(queueList.firstChild);
          }

          const statusEl = document.getElementById('queue-status-' + globalFileIndex);

          const formData = new FormData();
          formData.append('file', file);

          const xhr = new XMLHttpRequest();
          currentUploadXHR = xhr;

          let lastFileUploadedBytes = 0;

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const filePct = Math.round((e.loaded / e.total) * 100);
              statusEl.innerText = filePct + '%';

              // Calculate overall progress
              const fileDelta = e.loaded - lastFileUploadedBytes;
              lastFileUploadedBytes = e.loaded;
              totalUploadedBytes += fileDelta;

              const overallPct = Math.min(Math.round((totalUploadedBytes / totalBytes) * 100), 100);
              overallProgressBar.style.width = overallPct + '%';
              overallPercentage.innerText = overallPct + '%';

              // Speed & ETA calculations
              const elapsedSeconds = (Date.now() - startTime) / 1000;
              if (elapsedSeconds > 0) {
                const speedBytesSec = totalUploadedBytes / elapsedSeconds;
                uploadSpeed.innerText = (speedBytesSec / (1024 * 1024)).toFixed(2) + ' MB/s';
                
                const remainingBytes = Math.max(totalBytes - totalUploadedBytes, 0);
                const etaSeconds = speedBytesSec > 0 ? Math.round(remainingBytes / speedBytesSec) : 0;
                
                if (etaSeconds > 60) {
                  const mins = Math.floor(etaSeconds / 60);
                  const secs = etaSeconds % 60;
                  uploadEta.innerText = mins + ' 分 ' + secs + ' 秒';
                } else {
                  uploadEta.innerText = etaSeconds + ' 秒';
                }
              }
            }
          });

          xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
              statusEl.className = 'queue-item-status success';
              statusEl.innerText = '已完成';
              completedFiles++;
              
              // Adjust to ensure we accounted for full file size in case of rounding
              const fileDelta = file.size - lastFileUploadedBytes;
              totalUploadedBytes += fileDelta;

              const overallPct = Math.min(Math.round((totalUploadedBytes / totalBytes) * 100), 100);
              overallProgressBar.style.width = overallPct + '%';
              overallPercentage.innerText = overallPct + '%';

              missingFileIndex++;
              uploadNextMissingFile();
            } else {
              statusEl.className = 'queue-item-status error';
              statusEl.innerText = '失敗';
              console.error('File upload failed', xhr.responseText);
              failedFiles++;

              const fileDelta = file.size - lastFileUploadedBytes;
              totalUploadedBytes += fileDelta;

              missingFileIndex++;
              uploadNextMissingFile();
            }
          };

          xhr.onerror = function() {
            statusEl.className = 'queue-item-status error';
            statusEl.innerText = '網路錯誤';
            console.error('XHR network error');
            failedFiles++;

            const fileDelta = file.size - lastFileUploadedBytes;
            totalUploadedBytes += fileDelta;

            missingFileIndex++;
            uploadNextMissingFile();
          };

          // Prepare upload query parameters for directory resolution
          const uploadUrl = '/upload?creationTime=' + file.lastModified + 
                            '&assetId=' + encodeURIComponent(assetId) + 
                            '&filename=' + encodeURIComponent(file.name);

          xhr.open('POST', uploadUrl);
          xhr.send(formData);
        }

        uploadNextMissingFile();
      }

      processNextChunk(0);
    }

    // Show success view
    function showSuccessScreen(completed, skipped, failed, totalSize) {
      uploadingCard.classList.add('hidden');
      successCard.classList.remove('hidden');
      
      let summaryText = '備份完成！此次作業共處理了 <strong>' + (completed + skipped + failed) + '</strong> 個檔案，總容量 <strong>' + formatBytes(totalSize) + '</strong>。<br>';
      summaryText += '✨ 成功備份：<strong>' + completed + '</strong> 張全新照片/影片。<br>';
      if (skipped > 0) {
        summaryText += '⏭ 略過重複：<strong>' + skipped + '</strong> 張已存在檔案。<br>';
      }
      if (failed > 0) {
        summaryText += '❌ 上傳失敗：<strong>' + failed + '</strong> 張檔案。<br>';
      }
      summaryText += '照片均已按照拍攝年月自動整理歸檔。';
      
      successSummary.innerHTML = summaryText;
      
      // Reload server info
      loadServerStatus();
    }

    // Restart process
    finishBtn.addEventListener('click', () => {
      successCard.classList.add('hidden');
      selectionCard.classList.remove('hidden');
      clearSelection();
    });
  </script>
</body>
</html>`;
  res.send(html);
});

// Endpoint: GET /status
app.get('/status', (req, res) => {
  try {
    const files = scanBackupFiles(backupDir);
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    
    // Dynamically retrieve client-facing host IP
    const hostHeader = req.headers.host || '';
    const ipPort = hostHeader.split(':');
    const clientRequestedIp = ipPort[0] || getLocalIpAddress();

    res.json({
      status: 'ok',
      port: PORT,
      backupDir: backupDir,
      totalFilesCount: files.length,
      totalFilesSize: totalSize,
      ip: clientRequestedIp
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Endpoint: POST /check-duplicates
app.post('/check-duplicates', (req, res) => {
  try {
    const requestedAssets = req.body.assets || [];
    if (!Array.isArray(requestedAssets)) {
      return res.status(400).json({ error: 'assets must be an array' });
    }

    // Filter requested assets using in-memory index + composite key (creationTime + filename)
    const missingAssets = requestedAssets.filter(asset => {
      const cleanId = asset.id.replace(/[^a-zA-Z0-9-_]/g, '_');
      
      // 1. Check if ID matches
      if (backupIndex.hasOwnProperty(cleanId)) {
        return false;
      }
      
      // 2. Check if creationTime + filename matches
      const key = `${asset.creationTime}_${asset.filename.toLowerCase()}`;
      if (timeNameSet.has(key)) {
        return false;
      }
      
      return true;
    });

    res.json({
      missingAssets: missingAssets,
      missingCount: missingAssets.length,
      alreadyBackedUpCount: requestedAssets.length - missingAssets.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: POST /upload
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file received' });
    }

    // Preserve the file modification time
    const creationTime = parseInt(req.query.creationTime, 10);
    const assetId = req.query.assetId || 'unknown-id';
    const cleanId = assetId.replace(/[^a-zA-Z0-9-_]/g, '_');
    
    if (!isNaN(creationTime) && creationTime > 0) {
      try {
        const fileDate = new Date(creationTime);
        fs.utimesSync(req.file.path, fileDate, fileDate);
      } catch (utimeErr) {
        console.error(`Warning: Failed to set modification time for ${req.file.filename}:`, utimeErr.message);
      }
    }

    // Save mapping to index database
    const subDir = path.basename(path.dirname(req.file.path)); // YYYY-MM
    const relativePath = `${subDir}/${req.file.filename}`.replace(/\\/g, '/');
    const originalName = req.query.filename || req.file.filename;

    backupIndex[cleanId] = {
      path: relativePath,
      filename: getOriginalFilename(originalName),
      creationTime: !isNaN(creationTime) && creationTime > 0 ? creationTime : Date.now(),
      size: req.file.size
    };
    
    // Add to in-memory lookup set
    const key = `${backupIndex[cleanId].creationTime}_${backupIndex[cleanId].filename.toLowerCase()}`;
    timeNameSet.add(key);
    
    saveIndex();
    
    console.log(`[Backup Success] ${req.file.filename} -> ${req.file.path}`);
    res.json({
      success: true,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size
    });
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  // Initialize and load or rebuild index database
  loadOrRebuildIndex();

  const localIps = getLocalIpAddresses();
  const primaryIp = localIps[0] || 'localhost';
  const url = `http://${primaryIp}:${PORT}`;
  
  console.log(`==================================================`);
  console.log(`🚀 iOS Local Wi-Fi Backup Server (Web Edition) is running!`);
  console.log(`📶 Scan the QR Code below to connect from your iPhone:`);
  console.log(`🔗 Primary Web URL: ${url}`);
  
  if (localIps.length > 1) {
    console.log(`🌐 Available Alternative Local URLs:`);
    localIps.forEach(ip => {
      console.log(`   - http://${ip}:${PORT}`);
    });
  }
  
  console.log(`🏠 Backup Storage Directory: ${backupDir}`);
  console.log(`==================================================\n`);
  
  // Generate QR Code in console for the primary/Wi-Fi IP
  qrcode.generate(url, { small: true });
});
