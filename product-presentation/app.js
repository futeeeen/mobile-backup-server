const journeyData = {
  web: {
    eyebrow: "Safari Web journey",
    title: "不用安裝 App，掃 QR Code 就能開始備份。",
    body: "Windows 端啟動伺服器後，命令列會顯示本機網址與 QR Code。iPhone 在同一個 Wi-Fi 下用 Safari 開啟網頁，選擇照片或影片後就能上傳到電腦。",
    points: ["同網段開啟 Web 介面", "拖放或選取照片影片", "先送 metadata 做去重檢查", "顯示速度、進度與剩餘時間"],
    steps: ["Run backup-server.exe", "Scan QR Code", "Select media", "Upload to PC"]
  },
  expo: {
    eyebrow: "Expo App journey",
    title: "App 版能掃描相簿、套用條件，適合大量同步。",
    body: "Expo App 會請求相簿權限，偵測 Expo host IP 作為預設伺服器位址，並可切換是否包含影片、是否只備份新項目，以及日期範圍。",
    points: ["自動帶入伺服器 IP", "支援照片與影片切換", "可只同步新檔案", "上傳中保持螢幕喚醒"],
    steps: ["Grant permission", "Test connection", "Scan gallery", "Start sync"]
  },
  desktop: {
    eyebrow: "Windows server journey",
    title: "電腦端是一個可打包的 Node.js 本機服務。",
    body: "伺服器使用 Express、Multer 與本機檔案系統，預設 Port 11900。可透過 backup-config.json 調整備份路徑，或用 pkg 打包成 backup-server.exe。",
    points: ["自動建立備份資料夾", "依 YYYY-MM 分層歸檔", "維護 backup-index.json", "可重建索引與清理失效項目"],
    steps: ["Load config", "Expose HTTP API", "Receive files", "Persist index"]
  }
};

const flowData = {
  client: {
    title: "iOS Client: Web 與 Expo App 共享同一套 HTTP API",
    body: "Web 介面適合快速上手，Expo App 則適合掃描整個相簿與長時間同步。兩者都先取得伺服器狀態，再批次檢查重複，最後逐檔上傳。",
    code: ["GET /status", "POST /check-duplicates", "POST /upload?assetId=...", "multipart/form-data file"]
  },
  server: {
    title: "Express Server: 以區域網路提供備份入口",
    body: "Node 服務自動挑選 Wi-Fi / Ethernet IP，避免優先使用虛擬網卡。首頁直接提供 Web App，上傳端點由 Multer 寫入本機資料夾。",
    code: ["port = backup-config.port || 11900", "cors + json limit 50mb", "multer diskStorage", "fileSize limit 10GB"]
  },
  index: {
    title: "Backup Index: 判斷新檔、避免重複上傳",
    body: "伺服器把 assetId 對應到相對路徑、檔名、建立時間與大小。若索引缺失或損壞，會掃描備份資料夾重建，降低長期使用風險。",
    code: ["assetId -> { path, filename, creationTime, size }", "timeNameSet for fallback matching", "remove missing indexed files", "rebuildIndexFromDisk()"]
  },
  storage: {
    title: "Local Storage: 照片影片留在使用者指定的資料夾",
    body: "預設輸出到 ios-camera-backups-file，也可在 backup-config.json 設為 D 槽或外接硬碟。檔名碰撞時會加上 _(1) 之類的後綴。",
    code: ["backupDir = config.backupDir || default", "subDir = YYYY-MM", "collision -> IMG_0001_(1).JPG", "relative paths stored in index"]
  }
};

const trustData = {
  local: {
    title: "本機優先：資料走區域網路，不依賴雲端帳號",
    body: "這個系統的核心假設很直接：手機與電腦在同一個 Wi-Fi，檔案就傳回自己的 Windows 資料夾。它適合不想把完整相簿交給雲端服務、或希望另外保留離線備份的人。",
    badges: ["Local Wi-Fi", "No cloud dependency", "Windows folder"]
  },
  dedupe: {
    title: "去重索引：先比對，再傳真正缺少的檔案",
    body: "Expo App 會批次送出相簿 metadata，Web 版會用檔案大小與 lastModified 建立 web id。伺服器用 assetId 與時間檔名組合雙重檢查，避免多次備份堆出大量重複檔。",
    badges: ["assetId", "creationTime", "filename"]
  },
  rebuild: {
    title: "自我修復：索引與資料夾不一致時可重新掃描",
    body: "啟動時會載入 backup-index.json，並檢查索引中的檔案是否仍存在。若索引不存在或 JSON 損壞，伺服器會掃描備份資料夾重建索引，讓資料夾本身仍是可信來源。",
    badges: ["rebuildIndexFromDisk", "scanBackupFiles", "missing cleanup"]
  },
  ops: {
    title: "可設定部署：從開發版到 exe 都能跑",
    body: "開發時可在 backup-server 目錄使用 npm start；交付時可用 pkg 打包出 backup-server.exe。使用者只需要調整 backup-config.json，就能改 Port 或備份路徑。",
    badges: ["backup-config.json", "pkg build", "custom path"]
  }
};

const scenarioData = {
  newPhone: {
    title: "新手機整理：先把舊照片安全搬回電腦",
    body: "使用者啟動 Windows 備份服務，手機開啟 Web 入口，選取大量照片後，系統先跳過已存在項目，再逐檔上傳。",
    rows: [
      ["掃描素材", 92],
      ["去重完成", 68],
      ["上傳進度", 45]
    ],
    outcome: "最終照片依月份落在本機資料夾，手機可以釋放容量，電腦端仍保留可重建的索引。"
  },
  travel: {
    title: "旅行大量影片：把 4K 影片從手機卸到外接硬碟",
    body: "在 backup-config.json 將 backupDir 指向外接硬碟，App 端開啟包含影片，並在同步期間保持螢幕喚醒。",
    rows: [
      ["影片佇列", 76],
      ["即時速度", 58],
      ["預估時間", 36]
    ],
    outcome: "大型檔案透過區網傳輸，不吃雲端流量；單檔最高支援到 10GB，適合長片段備份。"
  },
  family: {
    title: "家庭相簿歸檔：每月整理，不再重複複製",
    body: "每隔一段時間打開 App，只同步新項目。伺服器會根據 creationTime 將檔案放入 `YYYY-MM` 子資料夾。",
    rows: [
      ["本月新檔", 64],
      ["略過重複", 82],
      ["月份歸檔", 100]
    ],
    outcome: "資料夾結構穩定、可用檔案總管直接管理，也能在索引遺失時重新掃描回復。"
  }
};

function renderJourney(key) {
  const data = journeyData[key];
  document.querySelectorAll("[data-journey]").forEach((btn) => btn.classList.toggle("active", btn.dataset.journey === key));
  document.getElementById("journeyCopy").innerHTML = `
    <p class="eyebrow">${data.eyebrow}</p>
    <h3>${data.title}</h3>
    <p>${data.body}</p>
    <ul class="check-list">${data.points.map((point) => `<li>${point}</li>`).join("")}</ul>
  `;
  document.getElementById("journeyVisual").innerHTML = `
    <div class="timeline">${data.steps.map((step, index) => `
      <div class="timeline-item"><b>${index + 1}</b><span>${step}</span></div>
    `).join("")}</div>
  `;
}

function renderFlow(key) {
  const data = flowData[key];
  document.querySelectorAll("[data-flow]").forEach((btn) => btn.classList.toggle("active", btn.dataset.flow === key));
  document.getElementById("flowDetail").innerHTML = `
    <div>
      <h3>${data.title}</h3>
      <p>${data.body}</p>
      <div class="badge-row"><span>PoC supported</span><span>Local network</span><span>Node.js</span></div>
    </div>
    <div class="code-card">${data.code.map((line) => `<div>${line}</div>`).join("")}</div>
  `;
}

function renderTrust(key) {
  const data = trustData[key];
  document.querySelectorAll("[data-trust]").forEach((btn) => btn.classList.toggle("active", btn.dataset.trust === key));
  document.getElementById("trustPanel").innerHTML = `
    <h3>${data.title}</h3>
    <p>${data.body}</p>
    <div class="badge-row">${data.badges.map((badge) => `<span>${badge}</span>`).join("")}</div>
  `;
}

function renderScenario(key) {
  const data = scenarioData[key];
  document.querySelectorAll("[data-scenario]").forEach((btn) => btn.classList.toggle("active", btn.dataset.scenario === key));
  document.getElementById("scenarioCard").innerHTML = `
    <h3>${data.title}</h3>
    <p>${data.body}</p>
    <div class="progress-stack">
      ${data.rows.map(([label, value]) => `
        <div class="progress-row">
          <span>${label}</span>
          <div class="bar"><i style="width:${value}%"></i></div>
          <strong>${value}%</strong>
        </div>
      `).join("")}
    </div>
    <p><strong>結果：</strong>${data.outcome}</p>
  `;
}

function setupInteractions() {
  document.querySelectorAll("[data-journey]").forEach((btn) => btn.addEventListener("click", () => renderJourney(btn.dataset.journey)));
  document.querySelectorAll("[data-flow]").forEach((btn) => btn.addEventListener("click", () => renderFlow(btn.dataset.flow)));
  document.querySelectorAll("[data-trust]").forEach((btn) => btn.addEventListener("click", () => renderTrust(btn.dataset.trust)));
  document.querySelectorAll("[data-scenario]").forEach((btn) => btn.addEventListener("click", () => renderScenario(btn.dataset.scenario)));

  document.querySelectorAll("[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: "smooth" });
    });
  });

  document.getElementById("focusModeBtn").addEventListener("click", () => {
    document.body.classList.toggle("focus-mode");
  });
}

function setupObservers() {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add("visible");
    });
  }, { threshold: 0.18 });

  document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      document.querySelectorAll(".slide-rail button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.target === entry.target.id);
      });
    });
  }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });

  document.querySelectorAll("[data-section]").forEach((section) => sectionObserver.observe(section));
}

renderJourney("web");
renderFlow("client");
renderTrust("local");
renderScenario("newPhone");
setupInteractions();
setupObservers();
