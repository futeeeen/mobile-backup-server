import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { FileSystemUploadType } from 'expo-file-system/legacy';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';

// Default port from server
const DEFAULT_PORT = '11900';

interface AssetMeta {
  id: string;
  filename: string;
  creationTime: number;
}

export default function BackupScreen() {
  const router = useRouter();
  useKeepAwake();

  // State Variables
  const [serverIp, setServerIp] = useState<string>('');
  const [serverPort, setServerPort] = useState<string>(DEFAULT_PORT);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isCheckingConnection, setIsCheckingConnection] = useState<boolean>(false);
  
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<string>('');
  
  // Gallery Stats
  const [totalPhotos, setTotalPhotos] = useState<number>(0);
  const [totalVideos, setTotalVideos] = useState<number>(0);
  const [pendingUploads, setPendingUploads] = useState<MediaLibrary.Asset[]>([]);
  const [totalPendingSize, setTotalPendingSize] = useState<number>(0); // in bytes
  
  // Sync Toggles
  const [includeVideos, setIncludeVideos] = useState<boolean>(true);
  const [onlyNewItems, setOnlyNewItems] = useState<boolean>(true);
  const [enableDateFilter, setEnableDateFilter] = useState<boolean>(false);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // Upload Status
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [currentFileProgress, setCurrentFileProgress] = useState<number>(0); // 0 to 1
  const [uploadedCount, setUploadedCount] = useState<number>(0);
  const [skippedCount, setSkippedCount] = useState<number>(0);
  const [uploadSpeed, setUploadSpeed] = useState<string>('0.00 MB/s');
  const [eta, setEta] = useState<string>('--:--');
  const [sessionBytesUploaded, setSessionBytesUploaded] = useState<number>(0);

  // Server metadata
  const [serverStats, setServerStats] = useState<{
    totalFilesCount: number;
    totalFilesSize: number;
    backupDir: string;
  } | null>(null);

  // Logs Console
  const [logs, setLogs] = useState<string[]>([]);
  const logsScrollViewRef = useRef<ScrollView>(null);
  
  // Sync control flag ref to handle pauses/cancels
  const cancelSyncRef = useRef<boolean>(false);
  const uploadTaskRef = useRef<FileSystem.UploadTask | null>(null);

  // Auto-detect Server IP when screen loads
  useEffect(() => {
    // Check permission
    checkPermissions();

    // Calculate default date strings (last 30 days)
    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const formatDate = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    setStartDate(formatDate(thirtyDaysAgo));
    setEndDate(formatDate(now));

    // Auto-detect PC IP from Expo host URI
    const hostUri = Constants.expoConfig?.hostUri || '';
    addLog(`[System] 偵測 Metro Host: ${hostUri}`);
    if (hostUri) {
      const ip = hostUri.split(':')[0];
      if (ip) {
        setServerIp(ip);
        addLog(`[System] 自動偵測電腦 IP: ${ip}`);
        // Auto connect
        testConnection(ip, DEFAULT_PORT);
      }
    } else {
      addLog(`[System] 未能自動偵測 Metro IP，請手動輸入。`);
    }
  }, []);

  // Scroll to bottom of logs when log is added
  useEffect(() => {
    if (logsScrollViewRef.current) {
      setTimeout(() => {
        logsScrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [logs]);

  // Request Permissions
  const checkPermissions = async () => {
    try {
      const { status } = await MediaLibrary.getPermissionsAsync();
      setHasPermission(status === 'granted');
      if (status !== 'granted') {
        addLog(`[Permission] 尚未取得相簿讀取權限`);
      } else {
        addLog(`[Permission] 已取得相簿讀取權限`);
      }
    } catch (err: any) {
      addLog(`[Error] 檢查權限失敗: ${err.message}`);
    }
  };

  const requestPermissions = async () => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      const granted = status === 'granted';
      setHasPermission(granted);
      if (granted) {
        addLog(`[Permission] 相簿存取授權成功`);
        Alert.alert('授權成功', '已成功取得相簿讀取權限！');
      } else {
        addLog(`[Permission] 相簿存取授權拒絕`);
        Alert.alert('授權失敗', '需要相簿讀取權限才能備份相片與影片。');
      }
    } catch (err: any) {
      addLog(`[Error] 請求權限出錯: ${err.message}`);
    }
  };

  // Add a log message
  const addLog = (message: string) => {
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    setLogs((prev) => [...prev, `[${time}] ${message}`]);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  // Test Server Connection
  const testConnection = async (ip = serverIp, port = serverPort) => {
    if (!ip) {
      Alert.alert('錯誤', '請輸入電腦 IP 位址');
      return;
    }
    
    setIsCheckingConnection(true);
    setIsConnected(false);
    addLog(`[Server] 正在連線至 http://${ip}:${port}/status ...`);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s timeout
      
      const response = await fetch(`http://${ip}:${port}/status`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        setIsConnected(true);
        setServerStats({
          totalFilesCount: data.totalFilesCount,
          totalFilesSize: data.totalFilesSize,
          backupDir: data.backupDir,
        });
        addLog(`[Server] 連線成功！主機 IP: ${data.ip}`);
        addLog(`[Server] 電腦備份路徑: ${data.backupDir}`);
        addLog(`[Server] 已備份檔案數: ${data.totalFilesCount} (${(data.totalFilesSize / (1024 * 1024)).toFixed(2)} MB)`);
      } else {
        throw new Error(`伺服器回應狀態碼: ${response.status}`);
      }
    } catch (err: any) {
      addLog(`[Server] 連線失敗: ${err.message}`);
    } finally {
      setIsCheckingConnection(false);
    }
  };

  // Scan Device Gallery
  const scanGallery = async () => {
    if (!hasPermission) {
      Alert.alert('權限不足', '請先允許 App 讀取相簿權限。');
      return;
    }
    if (!isConnected) {
      Alert.alert('未連線', '請先連線到電腦伺服器。');
      return;
    }

    // Date filter validation
    let startMs = 0;
    let endMs = Date.now();
    if (enableDateFilter) {
      const startParsed = Date.parse(startDate);
      const endParsed = Date.parse(endDate.includes('T') ? endDate : `${endDate}T23:59:59`);
      
      if (isNaN(startParsed) || isNaN(endParsed)) {
        Alert.alert('日期格式錯誤', '請確保輸入的日期格式為 YYYY-MM-DD，例如 2026-05-06');
        return;
      }
      startMs = startParsed;
      endMs = endParsed;
    }

    setIsScanning(true);
    setScanProgress('正在載入相簿清單...');
    
    let logMsg = `[Scan] 開始掃描本機相簿... (包含影片: ${includeVideos ? '是' : '否'})`;
    if (enableDateFilter) {
      logMsg += ` [篩選日期: ${startDate} 至 ${endDate}]`;
    }
    addLog(logMsg);
    
    try {
      let allAssets: MediaLibrary.Asset[] = [];
      let hasNextPage = true;
      let after: string | undefined = undefined;
      let photoCount = 0;
      let videoCount = 0;

      while (hasNextPage) {
        const mediaTypes: MediaLibrary.MediaTypeValue[] = includeVideos 
          ? ['photo', 'video'] 
          : ['photo'];

        const result = await MediaLibrary.getAssetsAsync({
          first: 1000,
          after: after,
          mediaType: mediaTypes,
          sortBy: ['creationTime'],
        });

        // Filter assets by date range if enabled
        const filteredAssets = enableDateFilter 
          ? result.assets.filter(a => a.creationTime >= startMs && a.creationTime <= endMs)
          : result.assets;

        allAssets.push(...filteredAssets);
        
        // Count photo/videos
        filteredAssets.forEach(a => {
          if (a.mediaType === 'video') videoCount++;
          else photoCount++;
        });

        setScanProgress(`已掃描 ${allAssets.length} 個符合檔案...`);
        hasNextPage = result.hasNextPage;
        after = result.endCursor;
      }

      setTotalPhotos(photoCount);
      setTotalVideos(videoCount);
      addLog(`[Scan] 掃描完成。共找到 ${allAssets.length} 個媒體項目 (照片: ${photoCount}, 影片: ${videoCount})`);
      
      // If only new items are enabled, query server for duplicates
      if (onlyNewItems && allAssets.length > 0) {
        setScanProgress('正在與電腦比對重複檔案...');
        addLog(`[Scan] 傳送 ${allAssets.length} 個項目至電腦進行重複比對...`);

        // Batch the duplicate checks to avoid huge payloads (max 1000 per request)
        const batchSize = 1000;
        const missing: MediaLibrary.Asset[] = [];
        
        for (let i = 0; i < allAssets.length; i += batchSize) {
          const batch = allAssets.slice(i, i + batchSize).map(asset => ({
            id: asset.id,
            filename: asset.filename,
            creationTime: asset.creationTime,
          }));

          const response = await fetch(`http://${serverIp}:${serverPort}/check-duplicates`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ assets: batch }),
          });

          if (!response.ok) {
            throw new Error(`重複檢查 API 失敗: ${response.statusText}`);
          }

          const data = await response.json();
          const batchMissingIds = new Set(data.missingAssets.map((a: any) => a.id));
          
          // Reconstruct assets
          const batchMissing = allAssets.slice(i, i + batchSize).filter(asset => 
            batchMissingIds.has(asset.id)
          );
          
          missing.push(...batchMissing);
          setScanProgress(`比對進度: ${Math.min(i + batchSize, allAssets.length)} / ${allAssets.length}`);
        }

        const skipped = allAssets.length - missing.length;
        setPendingUploads(missing);
        setSkippedCount(skipped);
        addLog(`[Scan] 比對結束。新檔案: ${missing.length} 個，已備份 (跳過): ${skipped} 個`);
        
        // Sum up sizes (requires assetInfo, but since that requires API call per file, we'll estimate or fetch sizes during upload)
        // Set estimated total size (assuming 3MB per image/video average just for UI representation, or we can fetch them later)
        setTotalPendingSize(0); // We will compute actual sizes on the fly
      } else {
        setPendingUploads(allAssets);
        setSkippedCount(0);
        addLog(`[Scan] 新增 ${allAssets.length} 個項目至備份佇列 (未比對重複)`);
      }
      
    } catch (err: any) {
      addLog(`[Error] 掃描相簿出錯: ${err.message}`);
      Alert.alert('掃描失敗', err.message);
    } finally {
      setIsScanning(false);
      setScanProgress('');
    }
  };

  // Start Syncing / Backup
  const startSync = async () => {
    if (pendingUploads.length === 0) {
      Alert.alert('佇列空', '沒有需要備份的項目，請先重新掃描相簿。');
      return;
    }

    setIsSyncing(true);
    cancelSyncRef.current = false;
    addLog(`[Sync] 開始備份處理程序。待傳送: ${pendingUploads.length} 個檔案`);
    
    let uploaded = 0;
    let localSessionBytes = 0;
    setUploadedCount(0);
    setCurrentFileIndex(0);

    const startTime = Date.now();

    for (let i = 0; i < pendingUploads.length; i++) {
      // Check if paused
      if (cancelSyncRef.current) {
        addLog(`[Sync] 備份已被使用者暫停`);
        break;
      }

      const asset = pendingUploads[i];
      setCurrentFileIndex(i);
      setCurrentFileName(asset.filename);
      setCurrentFileProgress(0);
      
      try {
        addLog(`[Sync] [${i + 1}/${pendingUploads.length}] 正在取得 ${asset.filename} 的檔案資訊...`);
        
        // 1. Get full asset info to obtain local path uri
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        const fileUri = info.localUri || info.uri;
        
        if (!fileUri) {
          addLog(`[Warning] 無法取得檔案路徑: ${asset.filename}，跳過。`);
          continue;
        }

        // 2. Start upload task with progress tracking
        const uploadUrl = `http://${serverIp}:${serverPort}/upload?assetId=${encodeURIComponent(asset.id)}&creationTime=${asset.creationTime}&filename=${encodeURIComponent(asset.filename)}`;
        
        const fileStart = Date.now();

        const uploadTask = FileSystem.createUploadTask(
          uploadUrl,
          fileUri,
          {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: FileSystemUploadType.MULTIPART,
          },
          (data) => {
            // Update progress
            const progress = data.totalBytesSent / data.totalBytesExpectedToSend;
            setCurrentFileProgress(progress);
            
            // Calculate speed
            const elapsedSecs = (Date.now() - fileStart) / 1000;
            if (elapsedSecs > 0) {
              const speedBytesSec = data.totalBytesSent / elapsedSecs;
              const speedMBs = speedBytesSec / (1024 * 1024);
              setUploadSpeed(`${speedMBs.toFixed(2)} MB/s`);
              
              // Calculate overall ETA
              const totalBytesSentSession = localSessionBytes + data.totalBytesSent;
              const sessionElapsed = (Date.now() - startTime) / 1000;
              const avgSpeed = totalBytesSentSession / sessionElapsed; // bytes/sec
              
              // Estimate total size of remaining files
              // Since we don't know exact sizes of all remaining files, we estimate based on average size of uploaded files
              const avgFileSize = totalBytesSentSession / (uploaded + 1);
              const remainingCount = pendingUploads.length - (uploaded + 1);
              const estimatedRemainingBytes = remainingCount * avgFileSize;
              
              if (avgSpeed > 0 && estimatedRemainingBytes > 0) {
                const etaSeconds = estimatedRemainingBytes / avgSpeed;
                const minutes = Math.floor(etaSeconds / 60);
                const seconds = Math.floor(etaSeconds % 60);
                setEta(`${minutes}分 ${seconds}秒`);
              }
            }
          }
        );

        uploadTaskRef.current = uploadTask;
        
        addLog(`[Sync] 正在上傳 ${asset.filename}...`);
        const response = await uploadTask.uploadAsync();
        
        if (response && response.status === 200) {
          const resJson = JSON.parse(response.body);
          uploaded++;
          setUploadedCount(uploaded);
          localSessionBytes += (resJson.size || 0);
          setSessionBytesUploaded(localSessionBytes);
          addLog(`[Sync] 成功備份: ${asset.filename} (${((resJson.size || 0) / (1024 * 1024)).toFixed(2)} MB)`);
        } else {
          addLog(`[Error] 備份失敗: ${asset.filename} (伺服器錯誤: ${response?.status || 'No Response'})`);
        }
      } catch (err: any) {
        addLog(`[Error] 處理檔案出錯: ${asset.filename} - ${err.message}`);
      }
    }

    setIsSyncing(false);
    setCurrentFileName('');
    setCurrentFileProgress(0);
    setUploadSpeed('0.00 MB/s');
    setEta('--:--');
    
    // Refresh server status
    testConnection(serverIp, serverPort);

    if (!cancelSyncRef.current) {
      addLog(`[Sync] 🎉 備份任務完成！共上傳 ${uploaded} 個檔案。`);
      Alert.alert('備份完畢', `恭喜！已成功備份 ${uploaded} 個檔案到電腦主機。`);
      setPendingUploads([]);
    }
  };

  // Pause / Stop Syncing
  const pauseSync = () => {
    cancelSyncRef.current = true;
    addLog(`[Sync] 正在暫停傳送... (等候目前檔案上傳完成)`);
    if (uploadTaskRef.current) {
      try {
        // Expo FileSystem upload tasks can be cancelled
        uploadTaskRef.current.cancelAsync();
        addLog(`[Sync] 已取消當前傳送任務。`);
      } catch (e) {}
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace('/')}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.title}>相簿備份系統</Text>
        <View style={[styles.statusDot, { backgroundColor: isConnected ? '#10B981' : '#EF4444' }]} />
      </View>

      {/* Connection Panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>主機連線設定</Text>
        
        <View style={styles.inputRow}>
          <View style={{ flex: 3, marginRight: 8 }}>
            <Text style={styles.label}>電腦 IP 位址</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 192.168.1.100"
              placeholderTextColor="#64748B"
              value={serverIp}
              onChangeText={setServerIp}
              keyboardType="numeric"
              editable={!isSyncing}
            />
          </View>
          <View style={{ flex: 1.5 }}>
            <Text style={styles.label}>Port 連接埠</Text>
            <TextInput
              style={styles.input}
              placeholder="11900"
              placeholderTextColor="#64748B"
              value={serverPort}
              onChangeText={setServerPort}
              keyboardType="numeric"
              editable={!isSyncing}
            />
          </View>
        </View>

        <TouchableOpacity 
          style={[styles.button, isConnected ? styles.buttonSuccess : styles.buttonPrimary]}
          onPress={() => testConnection()}
          disabled={isCheckingConnection || isSyncing}
        >
          {isCheckingConnection ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.buttonText}>
              {isConnected ? '已連線 (按此重新測試)' : '測試連線到電腦'}
            </Text>
          )}
        </TouchableOpacity>

        {serverStats && (
          <View style={styles.serverInfoBox}>
            <Text style={styles.serverInfoText}>🏠 備份資料夾: {serverStats.backupDir}</Text>
            <Text style={styles.serverInfoText}>🗂️ 電腦已存: {serverStats.totalFilesCount} 個檔案 ({(serverStats.totalFilesSize / (1024 * 1024)).toFixed(2)} MB)</Text>
          </View>
        )}
      </View>

      {/* Permission Check */}
      {hasPermission === false && (
        <View style={[styles.card, styles.alertCard]}>
          <Ionicons name="warning-outline" size={24} color="#F59E0B" style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.alertTitle}>需要相簿讀取權限</Text>
            <Text style={styles.alertDesc}>此功能需要取得您 iPhone 的相簿讀取授權，才能傳送備份。</Text>
            <TouchableOpacity style={styles.alertButton} onPress={requestPermissions}>
              <Text style={styles.alertButtonText}>授權相簿存取權限</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Gallery Scanning Panel */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>備份偏好設定</Text>
        
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>備份影片 & 照片</Text>
            <Text style={styles.toggleSub}>開啟時同時上傳影片，關閉則僅備份相片</Text>
          </View>
          <Switch
            value={includeVideos}
            onValueChange={(val) => {
              setIncludeVideos(val);
              setPendingUploads([]); // Reset queue to force rescan
            }}
            disabled={isSyncing || isScanning}
            trackColor={{ false: '#1E293B', true: '#3B82F6' }}
            thumbColor={includeVideos ? '#FFF' : '#94A3B8'}
          />
        </View>

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>略過重複項目 (增量備份)</Text>
            <Text style={styles.toggleSub}>開啟時僅上傳電腦中沒有的新拍攝項目</Text>
          </View>
          <Switch
            value={onlyNewItems}
            onValueChange={(val) => {
              setOnlyNewItems(val);
              setPendingUploads([]); // Reset queue to force rescan
            }}
            disabled={isSyncing || isScanning}
            trackColor={{ false: '#1E293B', true: '#3B82F6' }}
            thumbColor={onlyNewItems ? '#FFF' : '#94A3B8'}
          />
        </View>

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleLabel}>篩選特定時間區段</Text>
            <Text style={styles.toggleSub}>開啟時僅比對與備份指定日期內的相片/影片</Text>
          </View>
          <Switch
            value={enableDateFilter}
            onValueChange={(val) => {
              setEnableDateFilter(val);
              setPendingUploads([]); // Reset queue to force rescan
            }}
            disabled={isSyncing || isScanning}
            trackColor={{ false: '#1E293B', true: '#3B82F6' }}
            thumbColor={enableDateFilter ? '#FFF' : '#94A3B8'}
          />
        </View>

        {enableDateFilter && (
          <View style={styles.dateFilterContainer}>
            <View style={styles.dateInputWrapper}>
              <Text style={styles.dateInputLabel}>開始日期</Text>
              <TextInput
                style={styles.dateTextInput}
                value={startDate}
                onChangeText={(val) => {
                  setStartDate(val);
                  setPendingUploads([]); // Reset queue to force rescan
                }}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#64748B"
                editable={!isSyncing && !isScanning}
              />
            </View>
            <View style={styles.dateInputWrapper}>
              <Text style={styles.dateInputLabel}>結束日期</Text>
              <TextInput
                style={styles.dateTextInput}
                value={endDate}
                onChangeText={(val) => {
                  setEndDate(val);
                  setPendingUploads([]); // Reset queue to force rescan
                }}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#64748B"
                editable={!isSyncing && !isScanning}
              />
            </View>
          </View>
        )}

        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary]}
          onPress={scanGallery}
          disabled={isScanning || isSyncing || !isConnected}
        >
          {isScanning ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#FFF" style={{ marginRight: 8 }} />
              <Text style={styles.buttonText}>{scanProgress}</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>🔄 掃描本機相簿與電腦比對</Text>
          )}
        </TouchableOpacity>

        {/* Scan Results */}
        {(totalPhotos > 0 || totalVideos > 0) && (
          <View style={styles.scanResults}>
            <Text style={styles.resultText}>📸 照片數量: <Text style={styles.bold}>{totalPhotos}</Text> 張</Text>
            <Text style={styles.resultText}>🎥 影片數量: <Text style={styles.bold}>{totalVideos}</Text> 部</Text>
            <Text style={[styles.resultText, { color: '#60A5FA' }]}>
              ⏳ 待上傳新檔案: <Text style={[styles.bold, { color: '#60A5FA' }]}>{pendingUploads.length}</Text> 個
            </Text>
            {skippedCount > 0 && (
              <Text style={[styles.resultText, { color: '#10B981' }]}>
                ✅ 已略過重複: <Text style={[styles.bold, { color: '#10B981' }]}>{skippedCount}</Text> 個項目
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Syncing Progress Card */}
      {(isSyncing || pendingUploads.length > 0) && (
        <View style={[styles.card, isSyncing ? styles.cardActive : null]}>
          <Text style={styles.cardTitle}>備份進度監控</Text>
          
          <View style={styles.progressStats}>
            <View style={styles.progressStatItem}>
              <Text style={styles.statLabel}>總待傳送</Text>
              <Text style={styles.statVal}>{pendingUploads.length}</Text>
            </View>
            <View style={styles.progressStatItem}>
              <Text style={styles.statLabel}>已成功傳送</Text>
              <Text style={[styles.statVal, { color: '#10B981' }]}>{uploadedCount}</Text>
            </View>
            <View style={styles.progressStatItem}>
              <Text style={styles.statLabel}>傳送進度</Text>
              <Text style={[styles.statVal, { color: '#3B82F6' }]}>
                {pendingUploads.length > 0 
                  ? `${Math.round((uploadedCount / pendingUploads.length) * 100)}%` 
                  : '0%'}
              </Text>
            </View>
          </View>

          {isSyncing && (
            <View style={styles.activeUploadBox}>
              <Text style={styles.activeFileText} numberOfLines={1}>
                📁 正在傳送: {currentFileName || '讀取中...'}
              </Text>
              
              {/* Progress Bar */}
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${currentFileProgress * 100}%` }]} />
              </View>
              <Text style={styles.progressPctText}>{Math.round(currentFileProgress * 100)}%</Text>
              
              <View style={styles.speedRow}>
                <Text style={styles.speedText}>⚡ 速度: {uploadSpeed}</Text>
                <Text style={styles.speedText}>⏱️ 預估剩餘時間: {eta}</Text>
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, isSyncing ? styles.buttonDanger : styles.buttonAccent]}
            onPress={isSyncing ? pauseSync : startSync}
            disabled={pendingUploads.length === 0}
          >
            <Text style={styles.buttonText}>
              {isSyncing ? '⏸️ 暫停備份傳送' : '🚀 開始備份上傳'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Terminal logs console */}
      <View style={styles.card}>
        <View style={styles.consoleHeader}>
          <Text style={styles.consoleTitle}>📟 備份日誌主控台</Text>
          <TouchableOpacity onPress={clearLogs}>
            <Text style={styles.clearText}>清除</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.console}>
          <ScrollView 
            ref={logsScrollViewRef}
            style={styles.consoleScroll}
            nestedScrollEnabled={true}
          >
            {logs.length === 0 ? (
              <Text style={styles.consolePlaceholder}>無日誌資料...</Text>
            ) : (
              logs.map((log, index) => (
                <Text key={index} style={styles.consoleText}>{log}</Text>
              ))
            )}
          </ScrollView>
        </View>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F19',
  },
  contentContainer: {
    padding: 16,
    paddingTop: Platform.OS === 'ios' ? 48 : 24,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    justifyContent: 'space-between',
  },
  backButton: {
    padding: 8,
    backgroundColor: '#1E293B',
    borderRadius: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFF',
    flex: 1,
    marginLeft: 16,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  card: {
    backgroundColor: '#141C2F',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  cardActive: {
    borderColor: '#3B82F6',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#ECEFF1',
    marginBottom: 14,
  },
  label: {
    fontSize: 12,
    color: '#94A3B8',
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  input: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    color: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#2563EB',
  },
  buttonSecondary: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  buttonSuccess: {
    backgroundColor: '#10B981',
  },
  buttonAccent: {
    backgroundColor: '#3B82F6',
  },
  buttonDanger: {
    backgroundColor: '#EF4444',
  },
  buttonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  serverInfoBox: {
    marginTop: 12,
    padding: 10,
    backgroundColor: '#0F172A',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#10B981',
  },
  serverInfoText: {
    fontSize: 12,
    color: '#94A3B8',
    marginBottom: 4,
  },
  alertCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: '#F59E0B',
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#F59E0B',
    marginBottom: 4,
  },
  alertDesc: {
    fontSize: 12,
    color: '#D97706',
    marginBottom: 8,
  },
  alertButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#D97706',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  alertButtonText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFF',
  },
  toggleSub: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scanResults: {
    marginTop: 14,
    padding: 12,
    backgroundColor: '#0F172A',
    borderRadius: 8,
  },
  resultText: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 6,
  },
  bold: {
    fontWeight: 'bold',
    color: '#FFF',
  },
  progressStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  progressStatItem: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#1E293B',
    borderRadius: 8,
    paddingVertical: 10,
    marginHorizontal: 4,
  },
  statLabel: {
    fontSize: 10,
    color: '#94A3B8',
    marginBottom: 4,
  },
  statVal: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },
  activeUploadBox: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  activeFileText: {
    color: '#E2E8F0',
    fontSize: 12,
    marginBottom: 8,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: '#1E293B',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#3B82F6',
  },
  progressPctText: {
    textAlign: 'right',
    fontSize: 10,
    color: '#94A3B8',
    marginTop: 4,
  },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  speedText: {
    fontSize: 11,
    color: '#64748B',
  },
  consoleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  consoleTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#94A3B8',
  },
  clearText: {
    fontSize: 12,
    color: '#60A5FA',
  },
  console: {
    backgroundColor: '#05070B',
    borderRadius: 8,
    height: 150,
    padding: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  consoleScroll: {
    flex: 1,
  },
  consolePlaceholder: {
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
  },
  consoleText: {
    color: '#10B981',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 2,
  },
  dateFilterContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  dateInputWrapper: {
    width: '48%',
  },
  dateInputLabel: {
    fontSize: 11,
    color: '#94A3B8',
    marginBottom: 6,
  },
  dateTextInput: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    color: '#FFF',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
});
