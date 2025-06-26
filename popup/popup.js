/**
 * scatalog - Popup Script
 * Handles settings interface, credential management, and API testing
 */

class PopupManager {
  constructor() {
    this.elements = {
      statusIndicator: document.getElementById('statusIndicator'),
      statusText: document.getElementById('statusText'),
      credentialsForm: document.getElementById('credentialsForm'),
      clientIdInput: document.getElementById('clientId'),
      clientSecretInput: document.getElementById('clientSecret'),
      saveBtn: document.getElementById('saveBtn'),
      testBtn: document.getElementById('testBtn'),
      saveBtnText: document.querySelector('.btn-text'),
      saveBtnSpinner: document.querySelector('.btn-spinner'),
      extensionToggle: document.getElementById('extensionToggle'),
      apiCallsToday: document.getElementById('apiCallsToday'),
      cacheHits: document.getElementById('cacheHits'),
      rateLimitStatus: document.getElementById('rateLimitStatus'),
      resetStatsBtn: document.getElementById('resetStatsBtn'),
      pressureValue: document.getElementById('pressureValue'),
      pressureFill: document.getElementById('pressureFill')
    };

    this.init();
  }

  /**
   * Initialize the popup
   */
  async init() {
    await this.loadStoredCredentials();
    await this.loadExtensionSettings();
    await this.loadApiStats();
    this.attachEventListeners();
    await this.checkConnectionStatus();
    
    // Auto-refresh rate limit status every 5 seconds
    this.startAutoRefresh();
  }

  /**
   * Load stored credentials from Chrome storage
   */
  async loadStoredCredentials() {
    try {
      const result = await chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret']);
      
      if (result.spotifyClientId) {
        this.elements.clientIdInput.value = result.spotifyClientId;
      }
      
      if (result.spotifyClientSecret) {
        this.elements.clientSecretInput.value = result.spotifyClientSecret;
      }

      // Enable test button if both credentials are present
      if (result.spotifyClientId && result.spotifyClientSecret) {
        this.elements.testBtn.disabled = false;
      }
    } catch (error) {
      console.error('Failed to load stored credentials:', error);
      this.showError('Failed to load stored credentials');
    }
  }

  /**
   * Attach event listeners
   */
  attachEventListeners() {
    // Form submission
    this.elements.credentialsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveCredentials();
    });

    // Test connection button
    this.elements.testBtn.addEventListener('click', () => {
      this.testConnection();
    });

    // Input validation and auto-save
    this.elements.clientIdInput.addEventListener('input', () => {
      this.validateInputs();
      this.clearErrors();
    });

    this.elements.clientSecretInput.addEventListener('input', () => {
      this.validateInputs();
      this.clearErrors();
    });

    // Auto-save individual fields on blur
    this.elements.clientIdInput.addEventListener('blur', () => {
      this.saveClientId();
    });

    this.elements.clientSecretInput.addEventListener('blur', () => {
      this.saveClientSecret();
    });

    // Extension toggle
    this.elements.extensionToggle.addEventListener('change', () => {
      this.toggleExtension();
    });

    // Reset stats button
    this.elements.resetStatsBtn.addEventListener('click', () => {
      this.resetApiStats();
    });
  }

  /**
   * Validate input fields
   */
  validateInputs() {
    const clientId = this.elements.clientIdInput.value.trim();
    const clientSecret = this.elements.clientSecretInput.value.trim();
    
    const isValid = clientId.length > 0 && clientSecret.length > 0;
    
    // Enable/disable test button
    this.elements.testBtn.disabled = !isValid;
    
    return isValid;
  }

  /**
   * Save credentials to Chrome storage
   */
  async saveCredentials(silent = false) {
    const clientId = this.elements.clientIdInput.value.trim();
    const clientSecret = this.elements.clientSecretInput.value.trim();

    // Validate inputs
    if (!clientId || !clientSecret) {
      this.showInputError('Both Client ID and Client Secret are required');
      return;
    }

    if (!silent) {
      this.setLoadingState(true);
    }

    try {
      // Save to Chrome storage
      await chrome.storage.sync.set({
        spotifyClientId: clientId,
        spotifyClientSecret: clientSecret
      });

      // Reset API statistics when new credentials are saved
      await this.resetApiStatsOnCredentialChange();

      if (!silent) {
        this.showSuccess('Credentials saved successfully!');
        
        // Test connection automatically after saving
        setTimeout(() => {
          this.testConnection();
        }, 1000);
      }

      // Enable test button
      this.elements.testBtn.disabled = false;

      // Notify content scripts to reinitialize
      this.notifyContentScripts();

    } catch (error) {
      console.error('Failed to save credentials:', error);
      this.showError('Failed to save credentials. Please try again.');
    } finally {
      if (!silent) {
        this.setLoadingState(false);
      }
    }
  }

  /**
   * Test API connection
   */
  async testConnection() {
    this.updateStatus('connecting', 'Testing connection...');
    
    try {
      // Create a temporary API instance for testing
      const testAPI = new SpotifyTestAPI();
      const clientId = this.elements.clientIdInput.value.trim();
      const clientSecret = this.elements.clientSecretInput.value.trim();
      
      const success = await testAPI.testCredentials(clientId, clientSecret);
      
      if (success) {
        this.updateStatus('connected', 'Connected successfully!');
        this.showSuccess('API connection successful!');
      } else {
        this.updateStatus('error', 'Connection failed');
        this.showError('Failed to connect. Please check your credentials.');
      }
    } catch (error) {
      console.error('Connection test failed:', error);
      this.updateStatus('error', 'Connection failed');
      this.showError(`Connection failed: ${error.message}`);
    }
  }

  /**
   * Check current connection status
   */
  async checkConnectionStatus() {
    try {
      const result = await chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret', 'extensionEnabled']);
      const isExtensionEnabled = result.extensionEnabled !== false; // Default to true
      
      // If extension is disabled, show disconnected regardless of credentials
      if (!isExtensionEnabled) {
        this.updateStatus('error', 'Disconnected');
        return;
      }
      
      if (result.spotifyClientId && result.spotifyClientSecret) {
        this.updateStatus('connecting', 'Checking connection...');
        
        // Test the stored credentials
        const testAPI = new SpotifyTestAPI();
        const success = await testAPI.testCredentials(result.spotifyClientId, result.spotifyClientSecret);
        
        if (success) {
          this.updateStatus('connected', 'Connected and ready');
        } else {
          this.updateStatus('error', 'Invalid credentials');
        }
      } else {
        this.updateStatus('error', 'Not configured');
      }
    } catch (error) {
      console.error('Failed to check connection status:', error);
      this.updateStatus('error', 'Status unknown');
    }
  }

  /**
   * Update status indicator
   */
  updateStatus(status, message) {
    const dot = this.elements.statusIndicator.querySelector('.status-dot');
    const text = this.elements.statusText;
    
    // Remove all status classes
    dot.classList.remove('connected', 'connecting');
    text.classList.remove('connected', 'connecting');
    
    // Add appropriate class
    if (status === 'connected') {
      dot.classList.add('connected');
      text.classList.add('connected');
    } else if (status === 'connecting') {
      dot.classList.add('connecting');
      text.classList.add('connecting');
    }
    
    text.textContent = message;
  }

  /**
   * Set loading state for save button
   */
  setLoadingState(loading) {
    if (loading) {
      this.elements.saveBtn.disabled = true;
      this.elements.saveBtnText.style.display = 'none';
      this.elements.saveBtnSpinner.style.display = 'block';
    } else {
      this.elements.saveBtn.disabled = false;
      this.elements.saveBtnText.style.display = 'block';
      this.elements.saveBtnSpinner.style.display = 'none';
    }
  }

  /**
   * Show success message
   */
  showSuccess(message) {
    this.elements.saveBtn.classList.add('btn-success');
    const originalText = this.elements.saveBtnText.textContent;
    this.elements.saveBtnText.textContent = '✓ ' + message;
    
    setTimeout(() => {
      this.elements.saveBtn.classList.remove('btn-success');
      this.elements.saveBtnText.textContent = originalText;
    }, 2000);
  }

  /**
   * Show error message
   */
  showError(message) {
    // Remove any existing error messages
    this.clearErrors();
    
    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    
    // Insert after the form
    this.elements.credentialsForm.appendChild(errorDiv);
    
    // Remove after 5 seconds
    setTimeout(() => {
      if (errorDiv.parentNode) {
        errorDiv.parentNode.removeChild(errorDiv);
      }
    }, 5000);
  }

  /**
   * Show input validation error
   */
  showInputError(message) {
    this.elements.clientIdInput.classList.add('input-error');
    this.elements.clientSecretInput.classList.add('input-error');
    this.showError(message);
  }

  /**
   * Clear error states
   */
  clearErrors() {
    // Remove error classes from inputs
    this.elements.clientIdInput.classList.remove('input-error');
    this.elements.clientSecretInput.classList.remove('input-error');
    
    // Remove error messages
    const errorMessages = this.elements.credentialsForm.querySelectorAll('.error-message');
    errorMessages.forEach(msg => msg.remove());
  }

  /**
   * Notify content scripts to reinitialize
   */
  async notifyContentScripts() {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
      
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'reinitialize' });
        } catch (error) {
          // Tab might not have content script loaded, ignore
          console.log('Could not notify tab:', tab.id);
        }
      }
    } catch (error) {
      console.error('Failed to notify content scripts:', error);
    }
  }

  /**
   * Save Client ID individually
   */
  async saveClientId() {
    const clientId = this.elements.clientIdInput.value.trim();
    
    if (clientId) {
      try {
        await chrome.storage.sync.set({ spotifyClientId: clientId });
        console.log('Client ID saved');
      } catch (error) {
        console.error('Failed to save Client ID:', error);
      }
    }
  }

  /**
   * Save Client Secret individually
   */
  async saveClientSecret() {
    const clientSecret = this.elements.clientSecretInput.value.trim();
    
    if (clientSecret) {
      try {
        await chrome.storage.sync.set({ spotifyClientSecret: clientSecret });
        console.log('Client Secret saved');
      } catch (error) {
        console.error('Failed to save Client Secret:', error);
      }
    }
  }

  /**
   * Load extension settings
   */
  async loadExtensionSettings() {
    try {
      const result = await chrome.storage.sync.get(['extensionEnabled']);
      const isEnabled = result.extensionEnabled !== false; // Default to true
      this.elements.extensionToggle.checked = isEnabled;
    } catch (error) {
      console.error('Failed to load extension settings:', error);
    }
  }

  /**
   * Toggle extension on/off
   */
  async toggleExtension() {
    const isEnabled = this.elements.extensionToggle.checked;
    
    try {
      await chrome.storage.sync.set({ extensionEnabled: isEnabled });
      
      // Notify content scripts
      this.notifyContentScripts();
      
      // Update status immediately
      await this.checkConnectionStatus();
      
      // Update status text
      if (isEnabled) {
        this.showSuccess('Extension activated');
      } else {
        this.showSuccess('Extension deactivated');
      }
    } catch (error) {
      console.error('Failed to toggle extension:', error);
      this.showError('Failed to update extension status');
    }
  }

  /**
   * Load API statistics with accurate rate limit status
   */
  async loadApiStats() {
    try {
      const result = await chrome.storage.local.get([
        'apiCallsToday',
        'cacheHits',
        'lastResetDate',
        'apiCallsThisHour',
        'recentApiCalls',
        'rateLimitHits',
        'lastRateLimitTime',
        'rateLimitRetryAfter'
      ]);

      // Check if we need to reset daily stats
      const today = new Date().toDateString();
      const lastReset = result.lastResetDate;
      
      if (lastReset !== today) {
        // Reset daily stats
        await chrome.storage.local.set({
          apiCallsToday: 0,
          lastResetDate: today
        });
        this.elements.apiCallsToday.textContent = '0';
      } else {
        this.elements.apiCallsToday.textContent = result.apiCallsToday || '0';
      }

      this.elements.cacheHits.textContent = result.cacheHits || '0';
      
      // Get accurate rate limit status using time-based analysis
      const now = Date.now();
      const recentApiCalls = result.recentApiCalls || [];
      const callsLastMinute = recentApiCalls.filter(timestamp => timestamp > now - 60000).length;
      const lastRateLimitTime = result.lastRateLimitTime || 0;
      const retryAfter = result.rateLimitRetryAfter || 0;

      // Check if we're currently in a rate limit period
      const isCurrentlyLimited = lastRateLimitTime && (now - lastRateLimitTime < (retryAfter * 1000));

      let status = 'Normal';
      let statusClass = '';
      let statusTitle = '';

      if (isCurrentlyLimited) {
        const remainingTime = Math.ceil((retryAfter * 1000 - (now - lastRateLimitTime)) / 1000);
        status = `Limited (${remainingTime}s)`;
        statusClass = 'error';
        statusTitle = `Rate limited. Wait ${remainingTime} seconds before making more requests.`;
      } else if (callsLastMinute >= 90) {
        status = `Critical (${callsLastMinute}/100)`;
        statusClass = 'error';
        statusTitle = `${callsLastMinute} requests in the last minute. Approaching rate limit.`;
      } else if (callsLastMinute >= 70) {
        status = `High (${callsLastMinute}/100)`;
        statusClass = 'warning';
        statusTitle = `${callsLastMinute} requests in the last minute. High usage.`;
      } else if (callsLastMinute >= 50) {
        status = `Moderate (${callsLastMinute}/100)`;
        statusClass = 'warning';
        statusTitle = `${callsLastMinute} requests in the last minute. Moderate usage.`;
      } else {
        status = `Normal (${callsLastMinute}/100)`;
        statusTitle = `${callsLastMinute} requests in the last minute. Normal usage.`;
      }
      
      this.elements.rateLimitStatus.textContent = status;
      this.elements.rateLimitStatus.className = `stat-value ${statusClass}`;
      this.elements.rateLimitStatus.title = statusTitle;
      
      // Update pressure indicator
      this.updatePressureIndicator(callsLastMinute, isCurrentlyLimited);
      
    } catch (error) {
      console.error('Failed to load API stats:', error);
    }
  }

  /**
   * Update the API pressure indicator
   */
  updatePressureIndicator(callsLastMinute, isCurrentlyLimited) {
    if (!this.elements.pressureValue || !this.elements.pressureFill) {
      return;
    }
    
    const maxCalls = 100; // Spotify's rate limit per minute
    const percentage = Math.min((callsLastMinute / maxCalls) * 100, 100);
    
    // Update the text value
    this.elements.pressureValue.textContent = `${callsLastMinute}/${maxCalls}`;
    
    // Update the fill bar
    this.elements.pressureFill.style.width = `${percentage}%`;
    
    // Add visual effects based on pressure level
    if (isCurrentlyLimited) {
      this.elements.pressureFill.style.background = '#8b0000';
      this.elements.pressureFill.style.animation = 'pulse-red 1s infinite';
    } else if (callsLastMinute >= 90) {
      this.elements.pressureFill.style.background = '#e22134';
      this.elements.pressureFill.style.animation = 'none';
    } else if (callsLastMinute >= 70) {
      this.elements.pressureFill.style.background = 'linear-gradient(90deg, #ffa500 0%, #e22134 100%)';
      this.elements.pressureFill.style.animation = 'none';
    } else if (callsLastMinute >= 50) {
      this.elements.pressureFill.style.background = 'linear-gradient(90deg, #1db954 0%, #ffa500 100%)';
      this.elements.pressureFill.style.animation = 'none';
    } else {
      this.elements.pressureFill.style.background = '#1db954';
      this.elements.pressureFill.style.animation = 'none';
    }
  }

  /**
   * Reset API statistics
   */
  async resetApiStats() {
    try {
      await chrome.storage.local.set({
        apiCallsToday: 0,
        apiCallsThisHour: 0,
        recentApiCalls: [],
        cacheHits: 0,
        rateLimitHits: 0,
        lastRateLimitTime: 0,
        rateLimitRetryAfter: 0,
        lastResetDate: new Date().toDateString(),
        hourlyResetTime: Date.now()
      });
      
      this.elements.apiCallsToday.textContent = '0';
      this.elements.cacheHits.textContent = '0';
      this.elements.rateLimitStatus.textContent = 'Normal (0/100)';
      this.elements.rateLimitStatus.className = 'stat-value';
      this.elements.rateLimitStatus.title = '0 requests in the last minute. Normal usage.';
      
      // Reset pressure indicator
      this.updatePressureIndicator(0, false);
      
      this.showSuccess('Statistics reset successfully');
    } catch (error) {
      console.error('Failed to reset API stats:', error);
      this.showError('Failed to reset statistics');
    }
  }

  /**
   * Reset API statistics when credentials change (silent version)
   */
  async resetApiStatsOnCredentialChange() {
    try {
      await chrome.storage.local.set({
        apiCallsToday: 0,
        apiCallsThisHour: 0,
        recentApiCalls: [],
        cacheHits: 0,
        rateLimitHits: 0,
        lastRateLimitTime: 0,
        rateLimitRetryAfter: 0,
        lastResetDate: new Date().toDateString(),
        hourlyResetTime: Date.now()
      });
      
      // Update UI elements if they exist (popup might be open)
      if (this.elements.apiCallsToday) {
        this.elements.apiCallsToday.textContent = '0';
      }
      if (this.elements.cacheHits) {
        this.elements.cacheHits.textContent = '0';
      }
      if (this.elements.rateLimitStatus) {
        this.elements.rateLimitStatus.textContent = 'Normal (0/100)';
        this.elements.rateLimitStatus.className = 'stat-value';
        this.elements.rateLimitStatus.title = '0 requests in the last minute. Normal usage.';
      }
      
      // Reset pressure indicator
      this.updatePressureIndicator(0, false);
      
      console.log('API statistics reset due to credential change');
    } catch (error) {
      console.error('Failed to reset API stats on credential change:', error);
    }
  }

  /**
   * Start auto-refresh of rate limit status
   */
  startAutoRefresh() {
    // Clear any existing interval
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    
    // Refresh every 5 seconds
    this.refreshInterval = setInterval(async () => {
      await this.loadApiStats();
    }, 5000);
  }

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

/**
 * Simplified API class for testing credentials
 */
class SpotifyTestAPI {
  constructor() {
    this.tokenURL = 'https://accounts.spotify.com/api/token';
    this.baseURL = 'https://api.spotify.com/v1';
  }

  /**
   * Test credentials by attempting to get an access token
   */
  async testCredentials(clientId, clientSecret) {
    try {
      // Get access token
      const tokenResponse = await fetch(this.tokenURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret)
        },
        body: 'grant_type=client_credentials'
      });

      if (!tokenResponse.ok) {
        throw new Error(`Token request failed: ${tokenResponse.status}`);
      }

      const tokenData = await tokenResponse.json();
      
      // Test the token with a simple API call
      const testResponse = await fetch(`${this.baseURL}/search?q=test&type=album&limit=1`, {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`
        }
      });

      return testResponse.ok;
    } catch (error) {
      console.error('Credential test failed:', error);
      return false;
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});

// Handle popup close/reopen
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Popup became visible, refresh status and restart auto-refresh
    setTimeout(() => {
      if (window.popupManager) {
        window.popupManager.checkConnectionStatus();
        window.popupManager.loadApiStats();
        window.popupManager.startAutoRefresh();
      }
    }, 100);
  } else {
    // Popup hidden, stop auto-refresh to save resources
    if (window.popupManager) {
      window.popupManager.stopAutoRefresh();
    }
  }
});

// Store reference for visibility change handler
window.addEventListener('load', () => {
  window.popupManager = new PopupManager();
}); 