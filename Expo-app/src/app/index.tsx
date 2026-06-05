import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView, Platform, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

const { width } = Dimensions.get('window');

export default function HomeScreen() {
  const router = useRouter();

  const handleNavigateBackup = () => {
    router.push('/backup');
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <StatusBar style="light" />
      
      {/* Hero Header */}
      <View style={styles.heroSection}>
        <View style={styles.iconCircle}>
          <Ionicons name="cloud-upload" size={56} color="#3B82F6" />
        </View>
        <Text style={styles.appName}>Local Wi-Fi Sync</Text>
        <Text style={styles.appTagline}>無容量限制的本地相簿與影片備份方案</Text>
      </View>

      {/* Main Grid / Navigation Cards */}
      <View style={styles.menuContainer}>
        
        {/* Backup Card (Primary action) */}
        <TouchableOpacity style={styles.backupCard} onPress={handleNavigateBackup}>
          <View style={styles.cardHeader}>
            <View style={styles.cardIconBox}>
              <Ionicons name="images" size={32} color="#FFF" />
            </View>
            <Ionicons name="chevron-forward" size={24} color="rgba(255,255,255,0.4)" />
          </View>
          <Text style={styles.cardTitle}>相簿備份 (Backup Gallery)</Text>
          <Text style={styles.cardDescription}>
            自動偵測您的 PC 伺服器，高速傳送手機內的所有照片與 4K 影片，並智慧過濾重複項目。
          </Text>
          <View style={styles.cardBadge}>
            <Text style={styles.cardBadgeText}>無雲端限制</Text>
            <View style={styles.badgeDot} />
            <Text style={styles.cardBadgeText}>增量備份</Text>
          </View>
        </TouchableOpacity>

        {/* Feature Overview Card */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>✨ 系統核心優勢</Text>
          
          <View style={styles.featureItem}>
            <View style={[styles.featureBullet, { backgroundColor: '#10B981' }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.featureTitle}>100% 免費與本地傳輸</Text>
              <Text style={styles.featureDesc}>不經任何雲端，透過內部網路直接備份到您的 PC 硬碟，隱私安全無虞。</Text>
            </View>
          </View>

          <View style={styles.featureItem}>
            <View style={[styles.featureBullet, { backgroundColor: '#3B82F6' }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.featureTitle}>自動化 IP 偵測</Text>
              <Text style={styles.featureDesc}>利用與 Expo 同一網段的 Metro 變數，App 能自適應偵測電腦 IP 位址。</Text>
            </View>
          </View>

          <View style={styles.featureItem}>
            <View style={[styles.featureBullet, { backgroundColor: '#F59E0B' }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.featureTitle}>智慧按年月歸檔</Text>
              <Text style={styles.featureDesc}>電腦端伺服器會依據每張相片的拍攝時間 (年-月) 自動建立資料夾存放。</Text>
            </View>
          </View>
        </View>

      </View>

      {/* Footer info */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>iOS Local Backup v1.0.0</Text>
        <Text style={styles.footerSubText}>請確保電腦已執行 npm run backup:server 並且兩者連上同一個 Wi-Fi</Text>
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
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 64 : 40,
    paddingBottom: 40,
    alignItems: 'center',
  },
  heroSection: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 40,
  },
  iconCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1.5,
    borderColor: 'rgba(59, 130, 246, 0.25)',
    ...Platform.select({
      ios: {
        shadowColor: '#3B82F6',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
      },
    }),
  },
  appName: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFF',
    letterSpacing: 0.5,
  },
  appTagline: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 8,
    textAlign: 'center',
  },
  menuContainer: {
    width: '100%',
    maxWidth: 500,
    gap: 20,
  },
  backupCard: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.2)',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 10,
      },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIconBox: {
    width: 54,
    height: 54,
    borderRadius: 14,
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 8,
  },
  cardDescription: {
    fontSize: 13,
    color: '#94A3B8',
    lineHeight: 20,
    marginBottom: 18,
  },
  cardBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 30,
  },
  cardBadgeText: {
    fontSize: 11,
    color: '#E2E8F0',
    fontWeight: '600',
  },
  badgeDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#64748B',
    marginHorizontal: 8,
  },
  infoCard: {
    backgroundColor: '#141C2F',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#E2E8F0',
    marginBottom: 16,
  },
  featureItem: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  featureBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
    marginRight: 12,
  },
  featureTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#FFF',
    marginBottom: 2,
  },
  featureDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 18,
  },
  footer: {
    marginTop: 40,
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  footerText: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '600',
  },
  footerSubText: {
    fontSize: 10,
    color: '#475569',
    marginTop: 4,
    textAlign: 'center',
    lineHeight: 14,
  },
});
