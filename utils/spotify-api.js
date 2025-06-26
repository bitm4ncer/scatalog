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
    try {
      const now = Date.now();
      const result = await chrome.storage.local.get([
        'apiCallsToday', 
        'lastResetDate',
        'apiCallsThisHour',
        'hourlyResetTime',
        'recentApiCalls'
      ]);
      
      const today = new Date().toDateString();
      const currentHour = new Date().getHours();
      
      // Reset daily counter if it's a new day
      let apiCallsToday = result.apiCallsToday || 0;
      if (result.lastResetDate !== today) {
        apiCallsToday = 0;
        await chrome.storage.local.set({ lastResetDate: today });
      }
      
      // Reset hourly counter if it's a new hour
      let apiCallsThisHour = result.apiCallsThisHour || 0;
      if (!result.hourlyResetTime || now - result.hourlyResetTime > 3600000) { // 1 hour
        apiCallsThisHour = 0;
        await chrome.storage.local.set({ hourlyResetTime: now });
      }
      
      // Track recent calls for minute-based rate limiting (last 60 seconds)
      let recentApiCalls = result.recentApiCalls || [];
      const oneMinuteAgo = now - 60000;
      recentApiCalls = recentApiCalls.filter(timestamp => timestamp > oneMinuteAgo);
      recentApiCalls.push(now);
      
      // Update all counters
      apiCallsToday++;
      apiCallsThisHour++;
      
      await chrome.storage.local.set({ 
        apiCallsToday,
        apiCallsThisHour,
        recentApiCalls
      });
    } catch (error) {
      console.error('Failed to track API call:', error);
    }
  }

  /**
   * Track cache hit
   */
  async trackCacheHit() {
    try {
      const result = await chrome.storage.local.get(['cacheHits']);
      const cacheHits = (result.cacheHits || 0) + 1;
      await chrome.storage.local.set({ cacheHits });
    } catch (error) {
      console.error('Failed to track cache hit:', error);
    }
  }

  /**
   * Track rate limit hit with retry-after information
   */
  async trackRateLimitHit(retryAfter = null) {
    try {
      const now = Date.now();
      const result = await chrome.storage.local.get(['rateLimitHits', 'lastRateLimitTime', 'rateLimitRetryAfter']);
      const rateLimitHits = (result.rateLimitHits || 0) + 1;
      
      await chrome.storage.local.set({ 
        rateLimitHits,
        lastRateLimitTime: now,
        rateLimitRetryAfter: retryAfter
      });
    } catch (error) {
      console.error('Failed to track rate limit hit:', error);
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
      const maxAlbumsToProcess = 100; // Limit to first 100 albums for performance

      while (hasMore && processedAlbums < maxAlbumsToProcess) {
        const albumsResponse = await this.getArtistAlbums(artistId, limit, offset);
        
        if (!albumsResponse.items || albumsResponse.items.length === 0) {
          break;
        }

        // Process albums in batches of 10 to avoid overwhelming the API
        const batchSize = 10;
        const albums = albumsResponse.items.slice(0, Math.min(albumsResponse.items.length, maxAlbumsToProcess - processedAlbums));
        
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
        hasMore = albumsResponse.items.length === limit && processedAlbums < maxAlbumsToProcess;
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
   * Search for all albums by a label with pagination to ensure no results are missed
   */
  async searchAllAlbumsByLabel(labelName) {
    const allAlbums = [];
    let offset = 0;
    const limit = 50; // Spotify's max per request
    let hasMore = true;
    
    console.log(`Starting comprehensive search for label: ${labelName}`);
    
    while (hasMore) {
      try {
        const results = await this.searchByLabel(labelName, limit, offset);
        const albums = results.albums?.items || [];
        
        if (albums.length === 0) {
          break; // No more results
        }
        
        allAlbums.push(...albums);
        
        // Check if there are more results
        const total = results.albums?.total || 0;
        hasMore = (offset + limit) < total && albums.length === limit;
        offset += limit;
        
        console.log(`Retrieved ${albums.length} albums (offset: ${offset - limit}, total found so far: ${allAlbums.length}, total available: ${total})`);
        
        // Small delay to respect rate limits
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        
      } catch (error) {
        console.error(`Failed to fetch albums at offset ${offset} for label ${labelName}:`, error);
        break; // Stop on error to avoid infinite loop
      }
    }
    
    console.log(`Completed search for ${labelName}: found ${allAlbums.length} total albums`);
    
    // Return in the same format as searchByLabel
    return {
      albums: {
        items: allAlbums,
        total: allAlbums.length
      }
    };
  }
}

// Make SpotifyAPI available globally for content script
if (typeof window !== 'undefined') {
  window.SpotifyAPI = SpotifyAPI;
} 