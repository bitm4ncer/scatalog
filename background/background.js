/**
 * scatalog - Background Service Worker
 * Handles extension lifecycle, installation, and background tasks
 */

class BackgroundManager {
  constructor() {
    this.init();
  }

  /**
   * Initialize background service worker
   */
  init() {
    this.setupEventListeners();
    console.log('scatalog background service worker initialized');
  }

  /**
   * Setup event listeners for Chrome extension events
   */
  setupEventListeners() {
    // Extension installation/update
    chrome.runtime.onInstalled.addListener((details) => {
      this.handleInstallation(details);
    });

    // Extension startup
    chrome.runtime.onStartup.addListener(() => {
      this.handleStartup();
    });

    // Message handling from content scripts and popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true; // Keep message channel open for async responses
    });

    // Tab updates (for reinjecting content scripts if needed)
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.handleTabUpdate(tabId, changeInfo, tab);
    });

    // Storage changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
      this.handleStorageChange(changes, namespace);
    });
  }

  /**
   * Handle extension installation or update
   */
  async handleInstallation(details) {
    console.log('Extension installed/updated:', details.reason);

    if (details.reason === 'install') {
      // First time installation
      await this.handleFirstInstall();
    } else if (details.reason === 'update') {
      // Extension update
      await this.handleUpdate(details.previousVersion);
    }
  }

  /**
   * Handle first time installation
   */
  async handleFirstInstall() {
    console.log('First time installation detected');

    try {
      // Set default settings
      await chrome.storage.sync.set({
        extensionVersion: '0.1.1',
        installDate: Date.now(),
        firstRun: true
      });

      // Open welcome/setup page (optional)
      // chrome.tabs.create({
      //   url: chrome.runtime.getURL('welcome.html')
      // });

      console.log('First install setup completed');
    } catch (error) {
      console.error('Failed to complete first install setup:', error);
    }
  }

  /**
   * Handle extension update
   */
  async handleUpdate(previousVersion) {
    console.log(`Extension updated from ${previousVersion} to 0.1.1`);

    try {
      // Update version in storage
      await chrome.storage.sync.set({
        extensionVersion: '0.1.1',
        lastUpdateDate: Date.now(),
        previousVersion: previousVersion
      });

      // Perform any migration tasks if needed
      await this.performMigration(previousVersion);

      console.log('Update setup completed');
    } catch (error) {
      console.error('Failed to complete update setup:', error);
    }
  }

  /**
   * Perform data migration for updates
   */
  async performMigration(previousVersion) {
    // Add migration logic here if needed in future versions
    console.log(`Performing migration from ${previousVersion}`);
    
    // Example migration tasks:
    // - Update storage schema
    // - Clear old cache data
    // - Update settings format
  }

  /**
   * Handle extension startup
   */
  handleStartup() {
    console.log('Extension startup detected');
    
    // Perform any startup tasks
    this.cleanupOldData();
  }

  /**
   * Handle messages from content scripts and popup
   */
  async handleMessage(request, sender, sendResponse) {
    try {
      switch (request.action) {
        case 'getStoredCredentials':
          const credentials = await this.getStoredCredentials();
          sendResponse({ success: true, data: credentials });
          break;

        case 'testApiConnection':
          const connectionResult = await this.testApiConnection(request.credentials);
          sendResponse({ success: true, connected: connectionResult });
          break;

        case 'clearCache':
          await this.clearCache();
          sendResponse({ success: true });
          break;

        case 'getExtensionInfo':
          const info = await this.getExtensionInfo();
          sendResponse({ success: true, data: info });
          break;

        default:
          console.log('Unknown message action:', request.action);
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * Handle tab updates
   */
  handleTabUpdate(tabId, changeInfo, tab) {
    // Only process Spotify tabs
    if (!tab.url || !tab.url.includes('open.spotify.com')) {
      return;
    }

    // If the page has finished loading, ensure content script is ready
    if (changeInfo.status === 'complete') {
      this.ensureContentScriptReady(tabId);
    }
  }

  /**
   * Ensure content script is ready on Spotify tabs
   */
  async ensureContentScriptReady(tabId) {
    try {
      // Try to ping the content script
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch (error) {
      // Content script might not be loaded, this is normal
      console.log('Content script not ready on tab:', tabId);
    }
  }

  /**
   * Handle storage changes
   */
  handleStorageChange(changes, namespace) {
    if (namespace === 'sync') {
      // Log important storage changes
      if (changes.spotifyClientId || changes.spotifyClientSecret) {
        console.log('Spotify credentials updated');
        this.notifyCredentialsChange();
      }
    }
  }

  /**
   * Notify all Spotify tabs about credential changes
   */
  async notifyCredentialsChange() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
      
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'credentialsUpdated' });
        } catch (error) {
          // Tab might not have content script, ignore
        }
      }
    } catch (error) {
      console.error('Failed to notify tabs about credential changes:', error);
    }
  }

  /**
   * Get stored credentials
   */
  async getStoredCredentials() {
    try {
      const result = await chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret']);
      return {
        clientId: result.spotifyClientId || null,
        clientSecret: result.spotifyClientSecret || null,
        configured: !!(result.spotifyClientId && result.spotifyClientSecret)
      };
    } catch (error) {
      console.error('Failed to get stored credentials:', error);
      return { clientId: null, clientSecret: null, configured: false };
    }
  }

  /**
   * Test API connection
   */
  async testApiConnection(credentials) {
    try {
      const { clientId, clientSecret } = credentials;
      
      if (!clientId || !clientSecret) {
        return false;
      }

      // Test token request
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret)
        },
        body: 'grant_type=client_credentials'
      });

      return response.ok;
    } catch (error) {
      console.error('API connection test failed:', error);
      return false;
    }
  }

  /**
   * Clear cached data
   */
  async clearCache() {
    try {
      // Clear any cached data from storage
      const keys = await chrome.storage.local.get();
      const cacheKeys = Object.keys(keys).filter(key => key.startsWith('cache_'));
      
      if (cacheKeys.length > 0) {
        await chrome.storage.local.remove(cacheKeys);
        console.log(`Cleared ${cacheKeys.length} cache entries`);
      }
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }

  /**
   * Get extension information
   */
  async getExtensionInfo() {
    try {
      const manifest = chrome.runtime.getManifest();
      const storage = await chrome.storage.sync.get(['installDate', 'lastUpdateDate']);
      
      return {
        version: manifest.version,
        name: manifest.name,
        installDate: storage.installDate || null,
        lastUpdateDate: storage.lastUpdateDate || null
      };
    } catch (error) {
      console.error('Failed to get extension info:', error);
      return null;
    }
  }

  /**
   * Cleanup old data periodically
   */
  async cleanupOldData() {
    try {
      // Remove cache entries older than 7 days
      const keys = await chrome.storage.local.get();
      const now = Date.now();
      const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
      
      const keysToRemove = [];
      
      for (const [key, value] of Object.entries(keys)) {
        if (key.startsWith('cache_') && value.timestamp && value.timestamp < weekAgo) {
          keysToRemove.push(key);
        }
      }
      
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
        console.log(`Cleaned up ${keysToRemove.length} old cache entries`);
      }
    } catch (error) {
      console.error('Failed to cleanup old data:', error);
    }
  }
}

// Initialize background manager
const backgroundManager = new BackgroundManager();

// Keep service worker alive
chrome.runtime.onConnect.addListener((port) => {
  // This helps keep the service worker alive
  port.onDisconnect.addListener(() => {
    console.log('Port disconnected');
  });
});

// Periodic cleanup (every 24 hours)
chrome.alarms.create('cleanup', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cleanup') {
    backgroundManager.cleanupOldData();
  }
}); 