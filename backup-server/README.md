# iOS Local Wi-Fi Backup Server (Web Edition)

這是一個極簡且高效的 iOS 照片與影片無線備份系統。採用 Web App 架構，手機免安裝 App，直接用 Safari 瀏覽器掃碼即可極速備份照片！

## 特色

1. **免安裝 App**：手機掃描電腦終端機的 QR Code 即可直接使用，無需透過 Expo 或任何 App Store 下載。
2. **極速重複比對**：前端自動計算檔案唯一 ID，傳送至後端進行瞬間比對，自動顯示「新照片 X 張，已略過重複 Y 張」。
3. **高質感深色主題**：具備科技感的 Glassmorphism 磨砂玻璃設計，支援即時傳輸進度條、上傳速度 (MB/s) 和剩餘時間估算 (ETA)。
4. **自動資料夾歸檔**：後端自動讀取檔案 lastModified 時間，按照「年-月」格式將備份檔案分類放置。
5. **單一執行檔**：可使用 `pkg` 將 Node.js 服務與網頁前端打包成單一 `backup-server.exe` 執行檔，綠色免安裝，方便分享給他人。

## 開發與執行步驟

### 安裝依賴套件

```bash
npm install
```

### 啟動開發伺服器

```bash
npm start
```

啟動後，終端機會以 ASCII 繪製 QR Code，並輸出本機 Wi-Fi IP 網址（例如 `http://192.168.1.100:11900`）。

### 打包成 `.exe` 執行檔

```bash
npm run build
```

打包完成後，將在 `backup-server/` 目錄下生成 `backup-server.exe`。您可以直接執行此 exe 檔案，功能完全獨立，不需要安裝 Node.js！

## 設定設定檔 `backup-config.json`

您可以修改資料夾內的 `backup-config.json`：

- `port`: 伺服器運作通訊埠（預設 `11900`）
- `backupDir`: 照片儲存資料夾位置（預設 `""` 代表伺服器同級目錄下的 `ios-camera-backups-file`）
