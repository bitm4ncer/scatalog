/**
 * Spotify Web API wrapper for the Label Explorer extension
 * Handles authentication, search, caching, and rate limiting
 */
class SpotifyAPI {
  constructor() {
    this.baseURL = 'https://api.spotify.com/v1';
    this.tokenURL = 'https://accounts.spotify.com/api/token';
    this.accessToken = null;
    this.tokenExpiry = null;
    this.cache = new Map();
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // 100ms between requests to respect rate limits
    this.shutdownInitiated = false; // Track if shutdown was initiated
  }

  /**
   * Check if the extension context is still valid
   */
  isExtensionContextValid() {
    try {
      // Try to access chrome.runtime which will throw if context is invalidated
      if (chrome.runtime && chrome.runtime.id) {
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Safe wrapper for chrome.storage operations
   */
  async safeStorageOperation(operation) {
    if (this.shutdownInitiated || !this.isExtensionContextValid()) {
      return null;
    }
    
    try {
      return await operation();
    } catch (error) {
      if (error.message && (error.message.includes('Extension context invalidated') || 
                           error.message.includes('Cannot access chrome'))) {
        this.shutdownInitiated = true;
        console.warn('spotify-api: Extension context invalidated, initiating shutdown');
        return null;
      }
      throw error;
    }
  }

  /**
   * Initialize the API with stored credentials
   */
  async initialize() {
    try {
      const result = await chrome.storage.sync.get(['spotifyClientId', 'spotifyClientSecret']);
      if (result.spotifyClientId && result.spotifyClientSecret) {
        this.clientId = result.spotifyClientId;
        this.clientSecret = result.spotifyClientSecret;
        await this.getAccessToken();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to initialize Spotify API:', error);
      return false;
    }
  }

  /**
   * Reinitialize the API with new credentials (clears cache and tokens)
   */
  async reinitialize() {
    try {
      // Clear existing tokens and cache
      this.accessToken = null;
      this.tokenExpiry = null;
      this.clearCache();
      
      // Clear request queue
      this.requestQueue = [];
      this.isProcessingQueue = false;
      
      // Reinitialize with new credentials
      const success = await this.initialize();
      
      if (success) {
        console.log('Spotify API reinitialized with new credentials');
      }
      
      return success;
    } catch (error) {
      console.error('Failed to reinitialize Spotify API:', error);
      return false;
    }
  }

  /**
   * Get access token using client credentials flow
   */
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('Spotify API credentials not configured');
    }

    try {
      const response = await fetch(this.tokenURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(this.clientId + ':' + this.clientSecret)
        },
        body: 'grant_type=client_credentials'
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 minute early
      
      return this.accessToken;
    } catch (error) {
      console.error('Failed to get access token:', error);
      throw error;
    }
  }

  /**
   * Make a rate-limited API request
   */
  async makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ url, options, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Track API call statistics with time-based tracking
   */
  async trackApiCall() {
    if (this.shutdownInitiated) return;
    
    try {
      const now = Date.now();
      const result = await this.safeStorageOperation(() => chrome.storage.local.get([
        'apiCallsToday', 
        'lastResetDate',
        'apiCallsThisHour',
        'hourlyResetTime',
        'recentApiCalls'
      ]));

      if (!result || this.shutdownInitiated) {
        // Context invalidated or shutdown initiated, skip tracking
        return;
      }
      
      const today = new Date().toDateString();
      const currentHour = new Date().getHours();
      
      // Reset daily counter if it's a new day
      let apiCallsToday = result.apiCallsToday || 0;
      if (result.lastResetDate !== today) {
        apiCallsToday = 0;
        await this.safeStorageOperation(() => chrome.storage.local.set({ lastResetDate: today }));
      }
      
      // Reset hourly counter if it's a new hour
      let apiCallsThisHour = result.apiCallsThisHour || 0;
      if (!result.hourlyResetTime || now - result.hourlyResetTime > 3600000) { // 1 hour
        apiCallsThisHour = 0;
        await this.safeStorageOperation(() => chrome.storage.local.set({ hourlyResetTime: now }));
      }
      
      // Track recent calls for minute-based rate limiting (last 60 seconds)
      let recentApiCalls = result.recentApiCalls || [];
      const oneMinuteAgo = now - 60000;
      recentApiCalls = recentApiCalls.filter(timestamp => timestamp > oneMinuteAgo);
      recentApiCalls.push(now);
      
      // Update all counters
      apiCallsToday++;
      apiCallsThisHour++;
      
      await this.safeStorageOperation(() => chrome.storage.local.set({ 
        apiCallsToday,
        apiCallsThisHour,
        recentApiCalls
      }));
    } catch (error) {
      console.error('Failed to track API call:', error);
    }
  }

  /**
   * Track cache hit
   */
  async trackCacheHit() {
    if (this.shutdownInitiated) return;
    
    try {
      const result = await this.safeStorageOperation(() => chrome.storage.local.get(['cacheHits']));
      if (!result || this.shutdownInitiated) return; // Context invalidated or shutdown
      
      const cacheHits = (result.cacheHits || 0) + 1;
      await this.safeStorageOperation(() => chrome.storage.local.set({ cacheHits }));
    } catch (error) {
      if (!this.shutdownInitiated) {
        console.error('Failed to track cache hit:', error);
      }
    }
  }

  /**
   * Track rate limit hit with retry-after information
   */
  async trackRateLimitHit(retryAfter = null) {
    if (this.shutdownInitiated) return;
    
    try {
      const now = Date.now();
      const result = await this.safeStorageOperation(() => chrome.storage.local.get(['rateLimitHits', 'lastRateLimitTime', 'rateLimitRetryAfter']));
      if (!result || this.shutdownInitiated) return; // Context invalidated or shutdown
      
      const rateLimitHits = (result.rateLimitHits || 0) + 1;
      
      await this.safeStorageOperation(() => chrome.storage.local.set({ 
        rateLimitHits,
        lastRateLimitTime: now,
        rateLimitRetryAfter: retryAfter
      }));
    } catch (error) {
      if (!this.shutdownInitiated) {
        console.error('Failed to track rate limit hit:', error);
      }
    }
  }

  /**
   * Process the request queue with rate limiting
   */
  async processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }

      const { url, options, resolve, reject } = this.requestQueue.shift();
      
      try {
        const token = await this.getAccessToken();
        const response = await fetch(url, {
          ...options,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers
          }
        });

        this.lastRequestTime = Date.now();

        if (!response.ok) {
          if (response.status === 429) {
            // Rate limit hit - extract retry-after header
            const retryAfter = response.headers.get('Retry-After');
            await this.trackRateLimitHit(retryAfter ? parseInt(retryAfter) : null);
          }
          throw new Error(`API request failed: ${response.status}`);
        }

        // Track successful API call
        await this.trackApiCall();

        const data = await response.json();
        resolve(data);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Search for albums by label
   */
  async searchByLabel(labelName, limit = 50, offset = 0) {
    const cacheKey = `label:${labelName}:${limit}:${offset}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24 hour cache
        await this.trackCacheHit();
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const query = encodeURIComponent(`label:"${labelName}"`);
      const url = `${this.baseURL}/search?q=${query}&type=album&limit=${limit}&offset=${offset}`;
      
      const data = await this.makeRequest(url);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Search failed:', error);
      throw error;
    }
  }

  /**
   * Get artist albums
   */
  async getArtistAlbums(artistId, limit = 50, offset = 0) {
    const cacheKey = `artist-albums:${artistId}:${limit}:${offset}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24 hour cache
        await this.trackCacheHit();
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const url = `${this.baseURL}/artists/${artistId}/albums?include_groups=album,single&limit=${limit}&offset=${offset}`;
      
      const data = await this.makeRequest(url);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Failed to get artist albums:', error);
      throw error;
    }
  }

  /**
   * Get artist details including images
   */
  async getArtist(artistId) {
    const cacheKey = `artist-details:${artistId}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24 hour cache
        await this.trackCacheHit();
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const url = `${this.baseURL}/artists/${artistId}`;
      
      const data = await this.makeRequest(url);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Failed to get artist details:', error);
      throw error;
    }
  }

  /**
   * Get detailed album information including label
   */
  async getAlbumDetails(albumId) {
    const cacheKey = `album-details:${albumId}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24 hour cache
        await this.trackCacheHit();
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const url = `${this.baseURL}/albums/${albumId}`;
      
      const data = await this.makeRequest(url);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });

      return data;
    } catch (error) {
      console.error('Failed to get album details:', error);
      throw error;
    }
  }

  /**
   * Get all labels for an artist by analyzing their discography
   */
  async getArtistLabels(artistId) {
    const cacheKey = `artist-labels:${artistId}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) { // 24 hour cache
        await this.trackCacheHit();
        return cached.data;
      }
      this.cache.delete(cacheKey);
    }

    try {
      const labels = new Map(); // Use Map to track unique labels with their albums
      let offset = 0;
      const limit = 50;
      let hasMore = true;
      let processedAlbums = 0;
      // Note: Album processing limit removed to show ALL albums as requested

      while (hasMore) {
        const albumsResponse = await this.getArtistAlbums(artistId, limit, offset);
        
        if (!albumsResponse.items || albumsResponse.items.length === 0) {
          break;
        }

        // Process albums in batches of 10 to avoid overwhelming the API
        const batchSize = 10;
        const albums = albumsResponse.items;
        
        for (let i = 0; i < albums.length; i += batchSize) {
          const batch = albums.slice(i, i + batchSize);
          
          // Process batch with some delay to respect rate limits
          const batchPromises = batch.map(async (album) => {
            try {
              const albumDetails = await this.getAlbumDetails(album.id);
              if (albumDetails.label) {
                const labelName = albumDetails.label;
                if (!labels.has(labelName)) {
                  labels.set(labelName, {
                    name: labelName,
                    albums: [],
                    enabled: true // Default to enabled
                  });
                }
                labels.get(labelName).albums.push({
                  id: album.id,
                  name: album.name,
                  release_date: album.release_date,
                  images: album.images,
                  external_urls: album.external_urls,
                  artists: album.artists
                });
              }
            } catch (error) {
              console.warn(`Failed to get details for album ${album.id}:`, error);
            }
          });
          
          await Promise.all(batchPromises);
          
          // Small delay between batches to be nice to the API
          if (i + batchSize < albums.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        processedAlbums += albums.length;
        hasMore = albumsResponse.items.length === limit;
        offset += limit;
      }

      const result = Array.from(labels.values());
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      console.error('Failed to get artist labels:', error);
      throw error;
    }
  }

  /**
   * Test API connection
   */
  async testConnection() {
    try {
      await this.getAccessToken();
      // Make a simple search to test the connection
      await this.makeRequest(`${this.baseURL}/search?q=test&type=album&limit=1`);
      return true;
    } catch (error) {
      console.error('Connection test failed:', error);
      return false;
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache size for debugging
   */
  getCacheSize() {
    return this.cache.size;
  }

  /**
   * Get current rate limit status with time-based analysis
   */
  async getRateLimitStatus() {
    try {
      const now = Date.now();
      const result = await chrome.storage.local.get([
        'apiCallsToday',
        'apiCallsThisHour', 
        'recentApiCalls',
        'rateLimitHits',
        'lastRateLimitTime',
        'rateLimitRetryAfter',
        'hourlyResetTime'
      ]);

      const recentApiCalls = result.recentApiCalls || [];
      const callsLastMinute = recentApiCalls.filter(timestamp => timestamp > now - 60000).length;
      const callsThisHour = result.apiCallsThisHour || 0;
      const lastRateLimitTime = result.lastRateLimitTime || 0;
      const retryAfter = result.rateLimitRetryAfter || 0;

      // Check if we're currently in a rate limit period
      const isCurrentlyLimited = lastRateLimitTime && (now - lastRateLimitTime < (retryAfter * 1000));

      // Determine status based on current usage
      let status = 'Normal';
      let level = 'normal';
      let details = '';

      if (isCurrentlyLimited) {
        status = 'Rate Limited';
        level = 'error';
        const remainingTime = Math.ceil((retryAfter * 1000 - (now - lastRateLimitTime)) / 1000);
        details = `Wait ${remainingTime}s`;
      } else if (callsLastMinute >= 90) {
        status = 'Critical';
        level = 'error';
        details = `${callsLastMinute}/100 per minute`;
      } else if (callsLastMinute >= 70) {
        status = 'High Usage';
        level = 'warning';
        details = `${callsLastMinute}/100 per minute`;
      } else if (callsThisHour >= 5000) {
        status = 'High Hourly';
        level = 'warning';
        details = `${callsThisHour} this hour`;
      } else if (callsLastMinute >= 50) {
        status = 'Moderate';
        level = 'warning';
        details = `${callsLastMinute}/100 per minute`;
      } else {
        details = `${callsLastMinute}/100 per minute`;
      }

      return {
        status,
        level,
        details,
        callsLastMinute,
        callsThisHour,
        callsToday: result.apiCallsToday || 0,
        rateLimitHits: result.rateLimitHits || 0,
        isCurrentlyLimited
      };
    } catch (error) {
      console.error('Failed to get rate limit status:', error);
      return {
        status: 'Unknown',
        level: 'normal',
        details: 'Error checking status',
        callsLastMinute: 0,
        callsThisHour: 0,
        callsToday: 0,
        rateLimitHits: 0,
        isCurrentlyLimited: false
      };
    }
  }

  /**
   * Search for all albums by a label using intelligent strategy selection
   */
  async searchAllAlbumsByLabel(labelName, progressCallback = null) {
    console.log(`🔍 Starting intelligent search for label: "${labelName}"`);
    
    // Strategy 1: Always start with direct search
    if (progressCallback) progressCallback('Searching label catalog...', false);
    
    const directResults = await this.searchDirectlyByLabel(labelName);
    console.log(`📊 Direct search: Found ${directResults.length} albums`);
    
    // Check if we likely hit API limitations (90+ results suggests we hit the ~100 limit)
    const hitLimitations = directResults.length >= 90;
    
    if (!hitLimitations) {
      console.log(`✅ Small/medium label detected (${directResults.length} < 90). Using direct results only for speed.`);
      return {
        albums: {
          items: directResults,
          total: directResults.length
        }
      };
    }
    
    console.log(`🚨 Large label detected (${directResults.length} >= 90). Using advanced strategies to find more releases...`);
    
    // Notify about extended search
    if (progressCallback) {
      progressCallback(`Large catalog detected (${directResults.length} releases found).<br/>Searching comprehensively... This may take 30-60 seconds.`, true);
    }
    
    // Strategy 2: Search with label variations (only for large labels)
    if (progressCallback) progressCallback('Searching label variations...', true);
    const variationResults = await this.searchByLabelVariations(labelName);
    console.log(`📊 Variations: Found ${variationResults.length} additional albums`);
    
    // Strategy 3: Temporal search (only for large labels)
    if (progressCallback) progressCallback('Searching by year ranges...', true);
    const temporalResults = await this.searchByLabelAndYear(labelName);
    console.log(`📊 Temporal: Found ${temporalResults.length} additional albums`);
    
    // Final processing
    if (progressCallback) progressCallback('Combining and organizing results...', true);
    
    // Combine and deduplicate all results
    const allAlbums = this.deduplicateAlbums([...directResults, ...variationResults, ...temporalResults]);
    
    console.log(`✅ Multi-strategy search completed for "${labelName}": found ${allAlbums.length} unique albums`);
    console.log(`📈 Breakdown: Direct=${directResults.length}, Variations=${variationResults.length}, Temporal=${temporalResults.length}, Final=${allAlbums.length}`);
    
    return {
      albums: {
        items: allAlbums,
        total: allAlbums.length
      }
    };
  }

  /**
   * Original direct label search method
   */
  async searchDirectlyByLabel(labelName) {
    const allAlbums = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    
    console.log(`🎯 Direct search for: "${labelName}"`);
    
    while (hasMore) {
      try {
        const results = await this.searchByLabel(labelName, limit, offset);
        const albums = results.albums?.items || [];
        
        if (albums.length === 0) break;
        
        allAlbums.push(...albums);
        hasMore = albums.length === limit && offset + limit < (results.albums?.total || 0);
        offset += limit;
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      } catch (error) {
        console.warn(`Direct search failed at offset ${offset}:`, error);
        break;
      }
    }
    
    return allAlbums;
  }

  /**
   * Search using label name variations to catch more results
   */
  async searchByLabelVariations(labelName) {
    const variations = this.generateLabelVariations(labelName);
    const allAlbums = [];
    
    console.log(`🔄 Testing ${variations.length} label variations:`, variations);
    
    for (const variation of variations) {
      try {
        console.log(`🔍 Searching variation: "${variation}"`);
        const results = await this.searchDirectlyByLabel(variation);
        allAlbums.push(...results);
        
        // Small delay between variations
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.warn(`Variation search failed for "${variation}":`, error);
      }
    }
    
    return allAlbums;
  }

  /**
   * Search by label and year ranges to overcome API limits
   */
  async searchByLabelAndYear(labelName) {
    const allAlbums = [];
    const currentYear = new Date().getFullYear();
    const startYear = 1950;
    const yearRangeSize = 5; // Search in 5-year chunks
    
    console.log(`📅 Temporal search from ${startYear} to ${currentYear} in ${yearRangeSize}-year chunks`);
    
    for (let year = startYear; year <= currentYear; year += yearRangeSize) {
      const endYear = Math.min(year + yearRangeSize - 1, currentYear);
      
      try {
        console.log(`🔍 Searching ${year}-${endYear} for "${labelName}"`);
        const yearResults = await this.searchByLabelAndYearRange(labelName, year, endYear);
        allAlbums.push(...yearResults);
        
        // Delay between year ranges
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        console.warn(`Year range search failed for ${year}-${endYear}:`, error);
      }
    }
    
    return allAlbums;
  }

  /**
   * Search for a specific year range
   */
  async searchByLabelAndYearRange(labelName, startYear, endYear) {
    const allAlbums = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    
    while (hasMore && offset < 200) { // Limit to 200 per year range to avoid infinite loops
      try {
        const query = encodeURIComponent(`label:"${labelName}" year:${startYear}-${endYear}`);
        const url = `${this.baseURL}/search?q=${query}&type=album&limit=${limit}&offset=${offset}`;
        const data = await this.makeRequest(url);
        
        const albums = data.albums?.items || [];
        if (albums.length === 0) break;
        
        allAlbums.push(...albums);
        hasMore = albums.length === limit;
        offset += limit;
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.warn(`Year range search failed for ${startYear}-${endYear} at offset ${offset}:`, error);
        break;
      }
    }
    
    return allAlbums;
  }

  /**
   * Generate label name variations
   */
  generateLabelVariations(labelName) {
    const variations = new Set();
    
    // Original name
    variations.add(labelName);
    
    // Common variations for major labels
    const commonVariations = {
      'Atlantic Records': ['Atlantic', 'Atlantic Recording Corporation', 'Atlantic Records LLC'],
      'Warner Bros. Records': ['Warner Bros.', 'Warner Brothers Records', 'WBR'],
      'Columbia Records': ['Columbia', 'CBS Records'],
      'Capitol Records': ['Capitol', 'Capitol Music Group'],
      'Universal Music Group': ['Universal', 'UMG'],
      'Sony Music': ['Sony Music Entertainment', 'Sony'],
      'EMI Records': ['EMI', 'EMI Music'],
      'Interscope Records': ['Interscope', 'Interscope Geffen A&M'],
      'RCA Records': ['RCA', 'RCA Victor'],
      'Epic Records': ['Epic', 'Epic Records Group']
    };
    
    if (commonVariations[labelName]) {
      commonVariations[labelName].forEach(variant => variations.add(variant));
    }
    
    // Generic transformations
    if (labelName.includes('Records')) {
      variations.add(labelName.replace(' Records', ''));
      variations.add(labelName.replace('Records', ''));
    }
    
    if (labelName.includes('Music')) {
      variations.add(labelName.replace(' Music', ''));
      variations.add(labelName.replace('Music', ''));
    }
    
    // Remove the original to avoid duplicate searches
    variations.delete(labelName);
    
    return Array.from(variations).slice(0, 5); // Limit to 5 variations to avoid too many API calls
  }

  /**
   * Deduplicate albums by ID
   */
  deduplicateAlbums(albums) {
    const seen = new Set();
    return albums.filter(album => {
      if (seen.has(album.id)) {
        return false;
      }
      seen.add(album.id);
      return true;
    });
  }
}

// Make SpotifyAPI available globally for content script
if (typeof window !== 'undefined') {
  window.SpotifyAPI = SpotifyAPI;
} 