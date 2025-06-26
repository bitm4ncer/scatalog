/**
 * scatalog - Content Script
 * Main extension logic for detecting labels and adding interactive buttons
 */

class SpotifyLabelExplorer {
  constructor() {
    this.api = new SpotifyAPI();
    this.isInitialized = false;
    this.observer = null;
    this.processedElements = new WeakSet();
    this.processedButtons = new Set(); // Track processed button locations
    this.currentModal = null;
    this.iconSvg = null; // Cache for the SVG icon
    this.scatalogs = new Map(); // Cache for Scatalogs
    this.scatalogMenu = null; // Scatalog management menu
    this.currentArtistDrawer = null; // Track current artist drawer
    this.artistDrawerVisible = true; // Track drawer visibility state
    
    this.init();
  }

  /**
   * Load the SVG icon from file
   */
  async loadSvgIcon() {
    if (this.iconSvg) {
      return this.iconSvg; // Return cached version
    }

    try {
      const iconUrl = chrome.runtime.getURL('icons/info_icon.svg');
      const response = await fetch(iconUrl);
      const svgText = await response.text();
      
      // Extract the inner content of the SVG (everything between <svg> tags)
      const svgMatch = svgText.match(/<svg[^>]*>(.*?)<\/svg>/s);
      if (svgMatch) {
        this.iconSvg = svgMatch[1]; // Cache the inner SVG content
        console.log('scatalog: SVG icon loaded successfully');
        return this.iconSvg;
      } else {
        throw new Error('Invalid SVG format');
      }
    } catch (error) {
      console.error('Failed to load SVG icon:', error);
      // Fallback to a simple icon
      this.iconSvg = `
        <circle cx="1500" cy="1500" r="1200" fill="rgb(30,215,96)"/>
        <text x="1500" y="1800" text-anchor="middle" fill="white" font-size="1000" font-family="Arial">L</text>
      `;
      return this.iconSvg;
    }
  }

  /**
   * Initialize the extension
   */
  async init() {
    try {
      // Check if extension is enabled
      const result = await chrome.storage.sync.get(['extensionEnabled']);
      const isEnabled = result.extensionEnabled !== false; // Default to true
      
      if (!isEnabled) {
        console.log('scatalog: Extension is disabled');
        return;
      }
      
      // Load the SVG icon first
      await this.loadSvgIcon();
      
      const initialized = await this.api.initialize();
      if (initialized) {
        this.isInitialized = true;
        this.startObserving();
        await this.processExistingElements();
        
        // Add global pressure indicators to all tabs
        this.addGlobalPressureIndicators();
        
        // Add Scatalog management menu
        this.addScatalogMenu();
        
        // Load cached Scatalogs
        await this.loadCachedScatalogs();
        
        console.log('scatalog initialized successfully');
      } else {
        console.log('scatalog: API credentials not configured');
      }
    } catch (error) {
      console.error('Failed to initialize scatalog:', error);
    }
  }

  /**
   * Start observing DOM changes
   */
  startObserving() {
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              this.processElement(node);
            }
          });
        }
      });
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Process existing elements on page load
   */
  async processExistingElements() {
    const elements = document.querySelectorAll('[data-testid="more-button"], [data-testid="context-menu-button"]');
    for (const element of elements) {
      await this.processElement(element);
    }
    

  }

  /**
   * Process a single element to add label info button
   */
  processElement(element) {
    if (!this.isInitialized || this.processedElements.has(element)) {
      return;
    }

    // Look for Spotify's "More Options" buttons
    const moreButtons = element.querySelectorAll ? 
      element.querySelectorAll('[data-testid="more-button"], [data-testid="context-menu-button"]') : 
      (element.matches && element.matches('[data-testid="more-button"], [data-testid="context-menu-button"]') ? [element] : []);

    // Group buttons by their containers to ensure only one button per container
    const containerButtonMap = new Map();
    
    moreButtons.forEach((button) => {
      const container = button.closest('[data-testid="tracklist-row"], [data-testid="album-page"], .main-trackList-trackListRow, .main-entityHeader-container') ||
                       button.closest('[role="row"], .main-card-card, .main-gridContainer-gridContainer');
      
      if (container && !containerButtonMap.has(container)) {
        // Only store the first button found for each container
        containerButtonMap.set(container, button);
        console.log('scatalog: Mapped container to button, total buttons found:', moreButtons.length, 'containers:', containerButtonMap.size);
      }
    });

    // Process only one button per container
    containerButtonMap.forEach(async (button, container) => {
      if (!this.processedElements.has(button)) {
        await this.addLabelInfoButton(button);
        this.processedElements.add(button);
      }
    });

    this.processedElements.add(element);
  }

  /**
   * Add label info button next to more options button
   */
  async addLabelInfoButton(moreButton) {
    // Check if we already added a button for this more button
    const parent = moreButton.parentElement;
    if (!parent) {
      return;
    }

    // Find the track/album container to check for existing buttons
    const container = moreButton.closest('[data-testid="tracklist-row"], [data-testid="album-page"], .main-trackList-trackListRow, .main-entityHeader-container') ||
                     moreButton.closest('[role="row"], .main-card-card, .main-gridContainer-gridContainer');
    
    if (!container) {
      return;
    }

    // FIRST CHECK: Immediately return if ANY label button already exists in this container
    const existingButton = container.querySelector('.spotify-label-explorer-btn');
    if (existingButton) {
      console.log('scatalog: EARLY EXIT - button already exists in container');
      return;
    }

    // SECOND CHECK: Return if container was already processed
    if (container.hasAttribute('data-label-explorer-container-processed')) {
      console.log('scatalog: EARLY EXIT - container already processed (attribute check)');
      return;
    }

    // THIRD CHECK: Check if we already processed this specific more button
    if (moreButton.hasAttribute('data-label-explorer-processed')) {
      console.log('scatalog: EARLY EXIT - button already processed (attribute check)');
      return;
    }

    // FOURTH CHECK: Create a unique identifier for this container
    const containerLocationId = this.createContainerLocationId(container);
    if (this.processedButtons.has(containerLocationId)) {
      console.log('scatalog: EARLY EXIT - container already processed:', containerLocationId);
      return;
    }

    // Mark container as being processed immediately to prevent race conditions
    container.setAttribute('data-label-explorer-container-processed', 'true');
    this.processedButtons.add(containerLocationId);

    const labelInfo = this.extractLabelInfo(moreButton, container);
    if (!labelInfo) {
      // Clean up the early marking since we're not adding a button
      container.removeAttribute('data-label-explorer-container-processed');
      this.processedButtons.delete(containerLocationId);
      return;
    }

    // Ensure icon is loaded before creating button
    if (!this.iconSvg) {
      await this.loadSvgIcon();
    }

    // Create the label info button immediately (no API calls during creation)
    const labelButton = document.createElement('button');
    labelButton.className = 'spotify-label-explorer-btn';
    labelButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 3000 3000" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
        ${this.iconSvg || '<circle cx="1500" cy="1500" r="1200" fill="rgb(30,215,96)"/><text x="1500" y="1800" text-anchor="middle" fill="white" font-size="1000" font-family="Arial">L</text>'}
      </svg>
    `;
    
    // Generic title - we'll update it after API call if needed
    labelButton.title = 'Explore label catalog';
    
    // Store the label info in the button for later use
    labelButton.labelInfo = labelInfo;
    
    labelButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Show loading state
      labelButton.disabled = true;
      labelButton.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z">
            <animateTransform attributeName="transform" type="rotate" dur="1s" values="0 12 12;360 12 12" repeatCount="indefinite"/>
          </path>
        </svg>
      `;
      
      try {
        // Perform API lookup when button is clicked
    let finalLabelInfo = labelInfo;
    if (labelInfo.needsApiLookup) {
      finalLabelInfo = await this.getLabelFromSpotifyData(labelInfo);
      if (!finalLabelInfo || !finalLabelInfo.label) {
            // Show error state
            labelButton.innerHTML = `
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z"/>
              </svg>
            `;
            labelButton.title = 'No label information found';
            setTimeout(() => {
              // Restore original icon after 2 seconds
              labelButton.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 3000 3000" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
                  ${this.iconSvg || '<circle cx="1500" cy="1500" r="1200" fill="rgb(30,215,96)"/><text x="1500" y="1800" text-anchor="middle" fill="white" font-size="1000" font-family="Arial">L</text>'}
                </svg>
              `;
              labelButton.title = 'Explore label catalog';
              labelButton.disabled = false;
            }, 2000);
        return;
      }
    }

        // Restore original icon and show modal
    labelButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 3000 3000" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
            ${this.iconSvg || '<circle cx="1500" cy="1500" r="1200" fill="rgb(30,215,96)"/><text x="1500" y="1800" text-anchor="middle" fill="white" font-size="1000" font-family="Arial">L</text>'}
      </svg>
    `;
    labelButton.title = `Explore ${finalLabelInfo.label} catalog`;
        labelButton.disabled = false;
        
      this.showLabelModal(finalLabelInfo);
      } catch (error) {
        console.error('Failed to get label info:', error);
        // Show error state
        labelButton.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z"/>
          </svg>
        `;
        labelButton.title = 'Failed to load label information';
        setTimeout(() => {
          // Restore original icon after 2 seconds
          labelButton.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 3000 3000" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
              ${this.iconSvg || '<circle cx="1500" cy="1500" r="1200" fill="rgb(30,215,96)"/><text x="1500" y="1800" text-anchor="middle" fill="white" font-size="1000" font-family="Arial">L</text>'}
            </svg>
          `;
          labelButton.title = 'Explore label catalog';
          labelButton.disabled = false;
        }, 2000);
      }
    });

    // Insert the button next to the more button
    parent.insertBefore(labelButton, moreButton.nextSibling);
    
    // Mark this more button as processed
    moreButton.setAttribute('data-label-explorer-processed', 'true');
    
    console.log('scatalog: Successfully added button (no API call yet), Container ID:', containerLocationId);
  }

  /**
   * Create a unique identifier for a container location
   */
  createContainerLocationId(container) {
    if (!container) return Math.random().toString();
    
    let contextInfo = '';
    
    // Try to get track/album name for uniqueness
    const trackElement = container.querySelector('[data-testid="internal-track-link"], .main-trackInfo-name a, .main-entityHeader-title');
    const artistElement = container.querySelector('[data-testid="internal-track-link"] + span a, .main-trackInfo-artists a, .main-entityHeader-subtitle a');
    const albumElement = container.querySelector('[data-testid="album-link"], .main-cardHeader-link');
    
    if (trackElement) contextInfo += trackElement.textContent.trim();
    if (artistElement) contextInfo += '|' + artistElement.textContent.trim();
    if (albumElement) contextInfo += '|' + albumElement.textContent.trim();
    
    // Add container position in its parent for additional uniqueness
    const parent = container.parentElement;
    if (parent) {
      const positionInfo = Array.from(parent.children).indexOf(container);
      contextInfo += `|pos:${positionInfo}`;
    }
    
    // Add container class/id info if available
    if (container.className) contextInfo += `|class:${container.className}`;
    if (container.id) contextInfo += `|id:${container.id}`;
    
    return contextInfo || Math.random().toString();
  }

  /**
   * Extract label information from the current context
   */
  extractLabelInfo(button, providedContainer = null) {
    // Use provided container or find it
    let container = providedContainer;
    if (!container) {
      container = button.closest('[data-testid="tracklist-row"], [data-testid="album-page"], .main-trackList-trackListRow, .main-entityHeader-container');
      
      if (!container) {
        // Try alternative selectors for different page types
        container = button.closest('[role="row"], .main-card-card, .main-gridContainer-gridContainer');
      }

      if (!container) {
        return null;
      }
    }

    // Try to extract track and artist information first
    let trackName = null;
    let artistName = null;
    let albumName = null;

    // Get track name
    const trackElement = container.querySelector('[data-testid="internal-track-link"], .main-trackInfo-name a, .main-entityHeader-title');
    if (trackElement) {
      trackName = trackElement.textContent.trim();
    }

    // Get artist name
    const artistElement = container.querySelector('[data-testid="internal-track-link"] + span a, .main-trackInfo-artists a, .main-entityHeader-subtitle a');
    if (artistElement) {
      artistName = artistElement.textContent.trim();
    }

    // Get album name if available
    const albumElement = container.querySelector('[data-testid="album-link"], .main-cardHeader-link');
    if (albumElement) {
      albumName = albumElement.textContent.trim();
    }

    // Method 1: Check if we're on an album page and can get the album ID
    if (window.location.pathname.includes('/album/')) {
      const albumId = window.location.pathname.split('/album/')[1].split('?')[0];
      if (albumId) {
        return {
          label: null, // Will be fetched via API when clicked
          track: trackName,
          artist: artistName,
          album: albumName,
          albumId: albumId,
          context: container,
          needsApiLookup: true
        };
      }
    }

    // Method 2: Try to extract album ID from track links
    const trackLink = container.querySelector('[data-testid="internal-track-link"]');
    if (trackLink && trackLink.href) {
      const trackMatch = trackLink.href.match(/\/track\/([a-zA-Z0-9]+)/);
      if (trackMatch) {
        const trackId = trackMatch[1];
        return {
          label: null, // Will be fetched via API when clicked
          track: trackName,
          artist: artistName,
          album: albumName,
          trackId: trackId,
          context: container,
          needsApiLookup: true
        };
      }
    }

    // Method 3: Look for album links to get album ID
    const albumLink = container.querySelector('[data-testid="album-link"]');
    if (albumLink && albumLink.href) {
      const albumMatch = albumLink.href.match(/\/album\/([a-zA-Z0-9]+)/);
      if (albumMatch) {
        const albumId = albumMatch[1];
        return {
          label: null, // Will be fetched via API when clicked
          track: trackName,
          artist: artistName,
          album: albumName,
          albumId: albumId,
          context: container,
          needsApiLookup: true
        };
      }
    }

    // Method 4: If we have track/artist info but no IDs, still show button
    // The API call will attempt to find the track/album when clicked
    if (trackName && artistName) {
      return {
        label: null, // Will be fetched via API when clicked
        track: trackName,
        artist: artistName,
        album: albumName,
        context: container,
        needsApiLookup: true
      };
    }

    // Only return null if we have absolutely no useful information
    return null;
  }

  /**
   * Heuristic to determine if text looks like an artist name
   */
  looksLikeArtist(text, container) {
    // Check if this text appears in artist-related elements
    const artistElements = container.querySelectorAll('[data-testid="internal-track-link"] + span a, .main-trackInfo-artists a');
    return Array.from(artistElements).some(el => el.textContent.trim() === text);
  }

  /**
   * Heuristic to determine if text looks like a label name
   */
  looksLikeLabel(text) {
    // More strict label name patterns - only match if it really looks like a label
    const labelPatterns = [
      /^.+\s+records?$/i,
      /^.+\s+music$/i,
      /^.+\s+entertainment$/i,
      /^.+\s+recordings?$/i,
      /^.+\s+label$/i,
      /^(atlantic|columbia|warner|universal|sony|emi|bmg|def jam|interscope|capitol|rca|epic|republic|island|virgin|parlophone|elektra|geffen|polydor|mercury|decca|blue note|verve|concord|nonesuch|domino|matador|sub pop|merge|kranky|thrill jockey|warp|ninja tune|xl recordings|rough trade|4ad|mute|factory|creation|heavenly|bella union|secretly canadian|jagjaguwar|drag city|touch and go|dischord|sst|epitaph|fat wreck chords|victory|roadrunner|metal blade|century media|nuclear blast|relapse|southern lord|hydra head|neurot|ipecac|temporary residence|constellation|kranky|type|editions mego|pan|blackest ever black|hospital|metalheadz|goldie lookin chain|warp|planet mu|rephlex|aphex twin|skam|n5md|hymen|ant-zen|ad noiseam|hands|spectrum spools|software|not not fun|olde english spelling bee|sacred bones|felte|captured tracks|slumberland|kanine|frenchkiss|polyvinyl|merge|saddle creek|sub pop|kill rock stars|k records|dischord|touch and go|drag city|thrill jockey|kranky|constellation|temporary residence|type|editions mego|pan|blackest ever black)$/i
    ];
    
    // Only return true if it matches known label patterns
    return labelPatterns.some(pattern => pattern.test(text));
  }



  /**
   * Get label information using Spotify API
   */
  async getLabelFromSpotifyData(labelInfo) {
    try {
      let albumData = null;

      if (labelInfo.albumId) {
        // Get album data directly
        albumData = await this.api.makeRequest(`https://api.spotify.com/v1/albums/${labelInfo.albumId}`);
      } else if (labelInfo.trackId) {
        // Get track data first, then album data
        const trackData = await this.api.makeRequest(`https://api.spotify.com/v1/tracks/${labelInfo.trackId}`);
        if (trackData.album && trackData.album.id) {
          albumData = await this.api.makeRequest(`https://api.spotify.com/v1/albums/${trackData.album.id}`);
        }
      } else if (labelInfo.track && labelInfo.artist) {
        // Search for the track using track and artist names
        const searchQuery = encodeURIComponent(`track:"${labelInfo.track}" artist:"${labelInfo.artist}"`);
        const searchUrl = `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=1`;
        const searchData = await this.api.makeRequest(searchUrl);
        
        if (searchData.tracks && searchData.tracks.items && searchData.tracks.items.length > 0) {
          const track = searchData.tracks.items[0];
          if (track.album && track.album.id) {
            albumData = await this.api.makeRequest(`https://api.spotify.com/v1/albums/${track.album.id}`);
          }
        }
      }

      if (albumData && albumData.label) {
        return {
          ...labelInfo,
          label: albumData.label,
          album: albumData.name,
          albumId: albumData.id,
          needsApiLookup: false
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to get label from Spotify API:', error);
      return null;
    }
  }

  /**
   * Infer label from page context when not explicitly available
   */
  inferLabelFromContext(container, trackName, artistName) {
    // This method is now deprecated - we should always use API data
    return null;
  }

  /**
   * Show the label exploration modal
   */
  async showLabelModal(labelInfo) {
    // Close any existing modal first
    if (this.currentModal) {
      this.closeModal();
    }

    // Reset labels and albums for new modal
    this.currentLabels = null;
    this.originalAlbums = [];
    this.currentAlbums = [];

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'spotify-label-explorer-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'spotify-label-explorer-modal';
    
    // Modal header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `
      <div class="header-controls">
        <div class="rate-limit-indicator" id="rateLimitIndicator" title="API Rate Limit Status">
          <div class="rate-limit-dot"></div>
        </div>
      <button class="close-btn" title="Close">×</button>
      </div>
    `;
    
    // Modal content
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = '<div class="loading">Loading label catalog...</div>';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    this.currentModal = overlay;
    
    // Close button functionality
    header.querySelector('.close-btn').addEventListener('click', () => {
      this.closeModal();
    });
    
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeModal();
      }
    });
    
    // Close on escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
    
    // Set up rate limit indicator updates
    this.setupRateLimitIndicator();
    
    // Load label catalog with comprehensive search
    try {
      const results = await this.api.searchAllAlbumsByLabel(labelInfo.label);
      await this.displayResults(content, results, labelInfo.label, labelInfo);
    } catch (error) {
      content.innerHTML = `
        <div class="error">
          <p>Failed to load catalog for ${labelInfo.label}</p>
          <p class="error-details">${error.message}</p>
        </div>
      `;
    }
  }



  /**
   * Show modal with other labels for the artist, allowing individual addition to current results
   */
  async showOtherLabelsModal(artistId, artistName) {
    // Create labels drawer similar to artist drawer
    this.createLabelsDrawer(artistId, artistName);
  }

  /**
   * Display other labels with add buttons
   */
  displayOtherLabels(container, labels, artistName) {
    const totalAlbums = labels.reduce((sum, label) => sum + label.albums.length, 0);

    const resultsHTML = `
      <div class="results-header">
        <p>Found ${labels.length} other label${labels.length !== 1 ? 's' : ''} with ${totalAlbums} release${totalAlbums !== 1 ? 's' : ''}</p>
        <p class="other-labels-instruction">Click "Add to Results" to include albums from that label in your current search.</p>
      </div>
      
      <div class="other-labels-list">
        ${labels.map(label => `
          <div class="other-label-item" data-label-name="${label.name}">
            <div class="label-info">
              <h3 class="label-name">${label.name}</h3>
              <p class="label-details">
                <span class="artist-releases">${label.albums.length} release${label.albums.length !== 1 ? 's' : ''} by ${artistName}</span>
              </p>
              <p class="label-total-count" data-label-name="${label.name}">
                <span class="total-text">hover for total</span>
              </p>
              <div class="label-albums-preview">
                ${label.albums.slice(0, 3).map(album => `
                  <div class="album-preview">
                    <img src="${album.images[0]?.url || ''}" alt="${album.name}" loading="lazy">
                  </div>
                `).join('')}
                ${label.albums.length > 3 ? `<div class="album-preview-more">+${label.albums.length - 3}</div>` : ''}
              </div>
            </div>
            <div class="label-action-buttons">
              <button class="add-label-btn" data-label-name="${label.name}">
                Add
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/>
                </svg>
              </button>
              <button class="create-scatalog-btn" data-label-name="${label.name}" title="+ save">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
                </svg>
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    container.innerHTML = resultsHTML;
    
    // Set up hover functionality for total label counts
    this.setupLabelTotalCountHover(container);
    
    // Set up add button event listeners
    container.querySelectorAll('.add-label-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const labelName = btn.dataset.labelName;
        
        console.log('[DEBUG] Add button clicked for label:', labelName);
        
        // Show loading state
        btn.disabled = true;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z">
              <animateTransform attributeName="transform" type="rotate" dur="1s" values="0 12 12;360 12 12" repeatCount="indefinite"/>
            </path>
          </svg>
          Adding...
        `;
        
        try {
          console.log('[DEBUG] Calling addLabelToCurrentResults...');
          await this.addLabelToCurrentResults(labelName);
          console.log('[DEBUG] addLabelToCurrentResults completed successfully');
          
          // Show success state
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
            </svg>
            Added!
          `;
          btn.classList.add('added');
          
        } catch (error) {
          console.error('Failed to add label:', error);
          btn.innerHTML = `
            Add
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/>
            </svg>
          `;
          btn.disabled = false;
        }
      });
    });

    // Set up create Scatalog button event listeners
    container.querySelectorAll('.create-scatalog-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const labelName = btn.dataset.labelName;
        
        // Show loading state
        btn.disabled = true;
        btn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z">
              <animateTransform attributeName="transform" type="rotate" dur="1s" values="0 12 12;360 12 12" repeatCount="indefinite"/>
            </path>
          </svg>
        `;
        
        try {
          // Search for albums from this label with comprehensive search
          const results = await this.api.searchAllAlbumsByLabel(labelName);
          
          // Create a new Scatalog
          await this.createScatalog(labelName, results);
          
          // Restore button state
          btn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
            </svg>
          `;
          btn.classList.add('created');
          
          // Update Scatalog menu
          this.updateScatalogMenu();
          
        } catch (error) {
          console.error('Failed to create Scatalog:', error);
          btn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
            </svg>
          `;
          btn.disabled = false;
        }
      });
    });
  }

  /**
   * Setup hover functionality for label total counts
   */
  setupLabelTotalCountHover(container) {
    const labelItems = container.querySelectorAll('.other-label-item');
    const loadedCounts = new Map(); // Cache to avoid duplicate API calls
    const pendingRequests = new Set(); // Track pending requests to avoid duplicates
    
    // Prefetch counts for the first few visible labels
    this.prefetchPopularLabelCounts(labelItems, loadedCounts, pendingRequests);
    
    labelItems.forEach(item => {
      const labelName = item.dataset.labelName;
      const totalCountElement = item.querySelector('.label-total-count');
      const totalTextElement = item.querySelector('.total-text');
      
      if (!totalCountElement || !totalTextElement) return;
      
      let hoverTimeout = null;
      let isHovering = false;
      
      const handleMouseEnter = () => {
        isHovering = true;
        
        // Clear any existing timeout
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
        }
        
        // If already loaded, show immediately
        if (loadedCounts.has(labelName)) {
          const count = loadedCounts.get(labelName);
                      totalTextElement.innerHTML = count !== null ? `<strong>${count}</strong> total releases` : 'unknown total';
          // Apply consistent styling for prefetched items
          if (count !== null) {
            totalCountElement.classList.add('loaded');
          } else {
            totalCountElement.classList.add('error');
          }
          return;
        }
        
        // If request is already pending, don't show loading state
        if (pendingRequests.has(labelName)) {
          return;
        }
        
        // Delay the API call to avoid calls on quick mouse movements
        hoverTimeout = setTimeout(async () => {
          // Double-check we're still hovering and don't have the data
          if (!isHovering || loadedCounts.has(labelName) || pendingRequests.has(labelName)) {
            return;
          }
          
          // Just mark as pending, no visual loading state
          pendingRequests.add(labelName);
          
          try {
            const totalCount = await this.getLabelTotalReleaseCount(labelName);
            loadedCounts.set(labelName, totalCount);
            
            // Only update if still hovering
            if (isHovering) {
              if (totalCount !== null && totalCount !== 0) {
                const displayCount = typeof totalCount === 'string' ? totalCount : totalCount.toString();
                totalTextElement.innerHTML = `<strong>${displayCount}</strong> total releases`;
                totalCountElement.classList.add('loaded');
              } else {
                totalTextElement.textContent = 'unknown total';
                totalCountElement.classList.add('error');
              }
            }
          } catch (error) {
            console.error('Failed to load total count for label:', labelName, error);
            loadedCounts.set(labelName, null); // Cache the error
            
            if (isHovering) {
              totalTextElement.textContent = 'error loading';
              totalCountElement.classList.add('error');
            }
          } finally {
            pendingRequests.delete(labelName);
          }
        }, 300); // Reduced delay from 500ms to 300ms for better responsiveness
      };
      
      const handleMouseLeave = () => {
        isHovering = false;
        
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        
        // Reset to original state if not loaded yet and no pending request
        if (!loadedCounts.has(labelName) && !pendingRequests.has(labelName)) {
          totalTextElement.textContent = 'hover for total';
        }
      };
      
      item.addEventListener('mouseenter', handleMouseEnter);
      item.addEventListener('mouseleave', handleMouseLeave);
    });
  }

  /**
   * Prefetch label counts for better perceived performance
   */
  async prefetchPopularLabelCounts(labelItems, loadedCounts, pendingRequests) {
    // Prefetch the first 8 labels that are likely to be hovered
    const itemsToPreload = Array.from(labelItems).slice(0, 8);
    
    for (const item of itemsToPreload) {
      const labelName = item.dataset.labelName;
      
      if (!loadedCounts.has(labelName) && !pendingRequests.has(labelName)) {
        pendingRequests.add(labelName);
        
        try {
          const totalCount = await this.getLabelTotalReleaseCount(labelName);
          loadedCounts.set(labelName, totalCount);
        } catch (error) {
          console.warn('Failed to prefetch count for label:', labelName, error);
          loadedCounts.set(labelName, null);
        } finally {
          pendingRequests.delete(labelName);
        }
        
        // Small delay between prefetch requests
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  /**
   * Get total release count for a label via API
   */
  async getLabelTotalReleaseCount(labelName) {
    // Check if we have this cached globally
    const cacheKey = `label-total:${labelName}`;
    const cached = await chrome.storage.local.get([cacheKey]);
    
    if (cached[cacheKey]) {
      const cachedData = cached[cacheKey];
      // Cache for 1 hour
      if (Date.now() - cachedData.timestamp < 60 * 60 * 1000) {
        return cachedData.count;
      }
    }
    
    try {
      // Search for albums by this label with a higher limit
      const searchQuery = encodeURIComponent(`label:"${labelName}"`);
      const searchUrl = `https://api.spotify.com/v1/search?q=${searchQuery}&type=album&limit=1&market=US`;
      
      const searchData = await this.api.makeRequest(searchUrl);
      
      if (searchData.albums && searchData.albums.total !== undefined) {
        const total = searchData.albums.total;
        const result = total >= 100 ? '100+' : total;
        
        // Cache the result
        await chrome.storage.local.set({
          [cacheKey]: {
            count: result,
            timestamp: Date.now()
          }
        });
        
        return result;
      }
      
      return 0;
    } catch (error) {
      console.error('Failed to get total release count for label:', labelName, error);
      return 0;
    }
  }

  /**
   * Save current catalog state as a new Scatalog
   */
  async saveCurrentStateAsScatalog(container) {
    if (!this.currentAlbums || this.currentAlbums.length === 0) {
      alert('No albums to save');
      return;
    }

    if (!this.currentLabels || this.currentLabels.length === 0) {
      alert('No labels to save');
      return;
    }

    // Get current filter state
    const sortSelect = container.querySelector('#sort-select');
    const sortOrderBtn = container.querySelector('#sort-order-btn');
    const searchInput = container.querySelector('#search-input');
    const newTabToggle = container.querySelector('#new-tab-toggle');

    const currentFilters = {
      sortBy: sortSelect ? sortSelect.value : 'release_date',
      sortOrder: sortOrderBtn ? (sortOrderBtn.querySelector('.sort-order-text').textContent.toLowerCase()) : 'desc',
      searchTerm: searchInput ? searchInput.value : ''
    };

    // Get current artist buttons state for restoration
    const artistButtons = [];
    const artistButtonElements = container.querySelectorAll('.other-labels-btn');
    artistButtonElements.forEach(btn => {
      const artist = {
        id: btn.dataset.artistId,
        name: btn.dataset.artistName,
        albumCount: parseInt(btn.querySelector('.artist-album-count').textContent.replace(/[()]/g, '')),
        isGray: btn.classList.contains('gray-artist-btn')
      };
      
      // Try to determine the reason from the button content
      const reasonElement = btn.querySelector('.artist-reason');
      if (reasonElement) {
        const reasonText = reasonElement.textContent.toLowerCase();
        if (reasonText.includes('originally clicked') || reasonText.includes('you clicked')) {
          artist.reason = 'original';
        } else if (reasonText.includes('collaborates') || reasonText.includes('appears on albums with')) {
          artist.reason = 'collaborator';
        } else if (reasonText.includes('multiple releases') || reasonText.includes('frequent')) {
          artist.reason = 'frequent';
        } else if (reasonText.includes('cross') || reasonText.includes('labels')) {
          artist.reason = artist.isGray ? 'cross-label' : 'top-frequent';
        } else {
          artist.reason = artist.isGray ? 'top-overall' : 'top';
        }
      } else {
        artist.reason = artist.isGray ? 'top-overall' : 'top';
      }
      
      artistButtons.push(artist);
    });

    // Prompt for Scatalog name
    const defaultName = this.currentLabels.length === 1 
      ? `${this.currentLabels[0]}`
      : `${this.currentLabels.slice(0, 2).join(' & ')}${this.currentLabels.length > 2 ? ` +${this.currentLabels.length - 2} more` : ''}`;
    
    const scatalogName = prompt('Enter name for this Scatalog:', defaultName);
    if (!scatalogName || scatalogName.trim() === '') {
      return; // User cancelled or entered empty name
    }

    // Show loading state on button
    const saveBtn = container.querySelector('#saveScatalogBtn');
    const originalContent = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z">
          <animateTransform attributeName="transform" type="rotate" dur="1s" values="0 12 12;360 12 12" repeatCount="indefinite"/>
        </path>
      </svg>
      Saving...
    `;

    try {
      // Create Scatalog object with full state
      const scatalogId = `scatalog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const scatalog = {
        id: scatalogId,
        name: scatalogName.trim(),
        labels: [...this.currentLabels],
        albums: [...this.originalAlbums], // Save all albums, not just filtered ones
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        filters: currentFilters,
        artistButtons: artistButtons, // Save artist button state
        openInNewTab: newTabToggle ? newTabToggle.checked : this.openInNewTab
      };

      // Store in memory and cache
      this.scatalogs.set(scatalogId, scatalog);
      await this.saveScatalogToCache(scatalog);

      // Show success state
      saveBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
        </svg>
        Saved!
      `;
      saveBtn.classList.add('saved');

      // Update Scatalog menu
      this.updateScatalogMenu();

      // Add subtle scale animation to scatalog toggle
      this.animateScatalogToggle();

      console.log(`Saved Scatalog: ${scatalog.name} with ${this.originalAlbums.length} releases from ${this.currentLabels.length} labels`);

      // Restore button after 2 seconds
      setTimeout(() => {
        saveBtn.innerHTML = originalContent;
        saveBtn.disabled = false;
        saveBtn.classList.remove('saved');
      }, 2000);

    } catch (error) {
      console.error('Failed to save Scatalog:', error);
      
      // Show error state
      saveBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z"/>
        </svg>
        Error
      `;
      
      // Restore button after 2 seconds
      setTimeout(() => {
        saveBtn.innerHTML = originalContent;
        saveBtn.disabled = false;
      }, 2000);
      
      alert('Failed to save Scatalog. Please try again.');
    }
  }

  /**
   * Create a new Scatalog
   */
  async createScatalog(labelName, results) {
    const albums = results.albums?.items || [];
    
    if (albums.length === 0) {
      alert(`No releases found for "${labelName}"`);
      return;
    }

    // Process albums to handle "Various Artists" cases
    const processedAlbums = await this.processVariousArtistsAlbums(albums);

    // Create Scatalog object
    const scatalogId = `scatalog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const scatalog = {
      id: scatalogId,
      name: `${labelName} Catalog`,
      labels: [labelName],
      albums: processedAlbums.map(album => ({
        ...album,
        labelName: labelName
      })),
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      filters: {
        sortBy: 'release_date',
        sortOrder: 'desc',
        searchTerm: ''
      }
    };

    // Store in memory and cache
    this.scatalogs.set(scatalogId, scatalog);
    await this.saveScatalogToCache(scatalog);

    console.log(`Created Scatalog: ${scatalog.name} with ${albums.length} releases`);
  }

  /**
   * Add Scatalog management menu
   */
  addScatalogMenu() {
    // Remove any existing menu
    this.removeScatalogMenu();
    
    // Create the menu container
    const menuContainer = document.createElement('div');
    menuContainer.id = 'spotify-scatalog-menu';
    menuContainer.className = 'spotify-scatalog-menu';
    menuContainer.innerHTML = `
      <div class="scatalog-menu-toggle" title="Scatalog Manager">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19,3H5C3.9,3 3,3.9 3,5V19C3,20.1 3.9,21 5,21H19C20.1,21 21,20.1 21,19V5C21,3.9 20.1,3 19,3M19,19H5V5H19V19M17,17H7V15H17V17M17,13H7V11H17V13M17,9H7V7H17V9Z"/>
        </svg>
        <span class="scatalog-count">0</span>
      </div>
      <div class="scatalog-menu-panel">
        <div class="scatalog-menu-header">
                      <h3><span style="font-weight: normal;">s</span><span style="font-weight: bold; font-size: 0.9em;">catalog</span></h3>
          <button class="scatalog-menu-close">×</button>
        </div>
        <div class="scatalog-menu-content">
          <div class="scatalog-empty-state">
            <p>No Scatalogs created yet</p>
            <p class="scatalog-hint">Create Scatalogs from label searches to save and manage your collections</p>
          </div>
        </div>
      </div>
    `;
    
    // Add to page
    document.body.appendChild(menuContainer);
    this.scatalogMenu = menuContainer;
    
    // Set up event listeners
    this.setupScatalogMenuEvents();
    
    console.log('scatalog: Added Scatalog menu');
  }

  /**
   * Remove Scatalog menu
   */
  removeScatalogMenu() {
    const existing = document.getElementById('spotify-scatalog-menu');
    if (existing) {
      existing.remove();
    }
    this.scatalogMenu = null;
  }

  /**
   * Setup Scatalog menu event listeners
   */
  setupScatalogMenuEvents() {
    if (!this.scatalogMenu) return;

    const toggle = this.scatalogMenu.querySelector('.scatalog-menu-toggle');
    const panel = this.scatalogMenu.querySelector('.scatalog-menu-panel');
    const closeBtn = this.scatalogMenu.querySelector('.scatalog-menu-close');

    // Toggle menu
    toggle.addEventListener('click', () => {
      panel.classList.toggle('open');
    });

    // Close menu
    closeBtn.addEventListener('click', () => {
      panel.classList.remove('open');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!this.scatalogMenu.contains(e.target)) {
        panel.classList.remove('open');
      }
    });
  }

  /**
   * Animate scatalog toggle with subtle scale effect
   */
  animateScatalogToggle() {
    if (!this.scatalogMenu) return;
    
    const toggle = this.scatalogMenu.querySelector('.scatalog-menu-toggle');
    if (!toggle) return;
    
    // Add scale animation class
    toggle.classList.add('scatalog-saved-animation');
    
    // Remove the class after animation completes
    setTimeout(() => {
      toggle.classList.remove('scatalog-saved-animation');
    }, 600);
  }

  /**
   * Update Scatalog menu content
   */
  updateScatalogMenu() {
    if (!this.scatalogMenu) return;

    const countElement = this.scatalogMenu.querySelector('.scatalog-count');
    const contentElement = this.scatalogMenu.querySelector('.scatalog-menu-content');
    
    const scatalogCount = this.scatalogs.size;
    countElement.textContent = scatalogCount;

    if (scatalogCount === 0) {
      contentElement.innerHTML = `
        <div class="scatalog-empty-state">
          <p>No Scatalogs created yet</p>
          <p class="scatalog-hint">Create Scatalogs from label searches to save and manage your collections</p>
        </div>
      `;
    } else {
      const scatalogList = Array.from(this.scatalogs.values())
        .sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));

      contentElement.innerHTML = `
        <div class="scatalog-list">
          ${scatalogList.map(scatalog => `
            <div class="scatalog-item" data-scatalog-id="${scatalog.id}" title="Click to open ${scatalog.name}">
              <div class="scatalog-info">
                <div class="scatalog-name">${scatalog.name}</div>
                <div class="scatalog-details">
                  ${scatalog.albums.length} releases • ${scatalog.labels.length} label${scatalog.labels.length !== 1 ? 's' : ''}
                </div>
                <div class="scatalog-labels">
                  ${scatalog.labels.map(label => `<span class="scatalog-label">${label}</span>`).join('')}
                </div>
              </div>
              <div class="scatalog-actions">
                <button class="scatalog-delete-btn" data-scatalog-id="${scatalog.id}" title="Delete Scatalog">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                  </svg>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `;

      // Set up event listeners for Scatalog items
      this.setupScatalogItemEvents(contentElement);
    }
  }

  /**
   * Setup event listeners for Scatalog items
   */
  setupScatalogItemEvents(container) {
    // Make scatalog items clickable to open
    container.querySelectorAll('.scatalog-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't open if clicking on delete button
        if (e.target.closest('.scatalog-delete-btn')) {
          return;
        }
        
        const scatalogId = item.dataset.scatalogId;
        this.openScatalog(scatalogId);
      });
    });

    // Delete Scatalog buttons
    container.querySelectorAll('.scatalog-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const scatalogId = btn.dataset.scatalogId;
        this.deleteScatalog(scatalogId);
      });
    });
  }

  /**
   * Open a Scatalog in a new modal
   */
  async openScatalog(scatalogId) {
    const scatalog = this.scatalogs.get(scatalogId);
    if (!scatalog) {
      console.error('Scatalog not found:', scatalogId);
      return;
    }

    // Update last accessed time
    scatalog.lastAccessed = new Date().toISOString();
    await this.saveScatalogToCache(scatalog);

    // Close the menu
    const panel = this.scatalogMenu.querySelector('.scatalog-menu-panel');
    panel.classList.remove('open');

    // Open the Scatalog modal
    this.showScatalogModal(scatalog);
  }

  /**
   * Delete a Scatalog
   */
  async deleteScatalog(scatalogId) {
    const scatalog = this.scatalogs.get(scatalogId);
    if (!scatalog) return;

    if (confirm(`Delete Scatalog "${scatalog.name}"?`)) {
      this.scatalogs.delete(scatalogId);
      await this.removeScatalogFromCache(scatalogId);
      this.updateScatalogMenu();
      console.log(`Deleted Scatalog: ${scatalog.name}`);
    }
  }

  /**
   * Show Scatalog modal
   */
  showScatalogModal(scatalog) {
    // Close any existing modal first
    if (this.currentModal) {
      this.closeModal();
    }

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'spotify-label-explorer-overlay';
    
    const modal = document.createElement('div');
    modal.className = 'spotify-label-explorer-modal';
    
    // Modal header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `
      <div class="header-controls">
        <div class="rate-limit-indicator" id="rateLimitIndicator" title="API Rate Limit Status">
          <div class="rate-limit-dot"></div>
        </div>
      <button class="close-btn" title="Close">×</button>
      </div>
    `;
    
    // Modal content
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = '<div class="loading">Loading Scatalog...</div>';
    
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    this.currentModal = overlay;
    
    // Close button functionality
    header.querySelector('.close-btn').addEventListener('click', () => {
      this.closeModal();
    });
    
    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.closeModal();
      }
    });
    
    // Close on escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        document.removeEventListener('keydown', escapeHandler);
      }
    };
    document.addEventListener('keydown', escapeHandler);
    
    // Set up rate limit indicator updates
    this.setupRateLimitIndicator();
    
    // Display Scatalog content
    this.displayScatalogContent(content, scatalog);
  }

  /**
   * Display Scatalog content
   */
  async displayScatalogContent(container, scatalog) {
    // Load cached "open in new tab" preference or use saved preference
    this.openInNewTab = scatalog.openInNewTab !== undefined ? scatalog.openInNewTab : await this.getOpenInNewTabPreference();

    // Set up state variables needed for related artists and labels functionality
    this.currentLabels = [...scatalog.labels];
    this.originalAlbums = [...scatalog.albums];
    this.currentAlbums = [...scatalog.albums];

    // Create the artist drawer for saved scatalogs (always create it since we have the data)
    setTimeout(() => {
      try {
        console.log('Attempting to create artist drawer for scatalog:', scatalog.name);
        const drawer = this.createArtistDrawer(scatalog);
        if (drawer) {
          console.log('Artist drawer created successfully for saved scatalog');
        } else {
          console.log('Artist drawer creation returned null');
        }
      } catch (error) {
        console.error('Error creating artist drawer:', error);
      }
    }, 200);

    // Generate label management HTML for multiple labels
    const labelManagementHtml = this.currentLabels && this.currentLabels.length >= 1 ? `
      <div class="label-management-section">
        <div class="label-management-title">Active labels:</div>
        <div class="active-labels-list">
          ${this.currentLabels.map(label => `
            <div class="active-label-item" data-label-name="${label}">
              <span class="label-name-highlight">${label}</span>
              <button class="remove-label-btn" data-label-name="${label}" title="Remove ${label} from results">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    // Generate the same content as displayResults but for Scatalog
    const resultsHTML = `
      <div class="results-header">
        <div class="results-header-top">
          <div class="results-header-content">
            ${labelManagementHtml}
            <div class="results-summary">
              <p>Found ${scatalog.albums.length} release${scatalog.albums.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div class="results-header-actions">
            <button class="related-artists-btn" id="relatedArtistsBtn" title="Toggle Related Artists panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z"/>
              </svg>
            </button>
            <button class="save-scatalog-btn" id="saveScatalogBtn" title="Save current catalog as Scatalog">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
              </svg>
              scatalog
            </button>
          </div>
        </div>
      </div>
      
      <div class="results-controls">
        <div class="control-group">
          <label for="sort-select">Sort by:</label>
          <select id="sort-select" class="sort-select">
            <option value="name">Album Name</option>
            <option value="release_date" ${scatalog.filters.sortBy === 'release_date' ? 'selected' : ''}>Release Date</option>
            <option value="artist">Artist Name</option>
          </select>
          
          <button id="sort-order-btn" class="sort-order-btn" title="Toggle sort order">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="${scatalog.filters.sortOrder === 'asc' ? 'M3 6h6v2H3V6zm0 5h12v2H3v-2zm0 5h18v2H3v-2z' : 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z'}"/>
            </svg>
            <span class="sort-order-text">${scatalog.filters.sortOrder === 'asc' ? 'Asc' : 'Desc'}</span>
          </button>
        </div>
        
        <div class="control-group">
          <input type="text" id="search-input" class="search-input" placeholder="Search releases..." value="${scatalog.filters.searchTerm}" />
        </div>
        
        <div class="control-group">
          <label class="toggle-label">
            <input type="checkbox" id="new-tab-toggle" ${this.openInNewTab ? 'checked' : ''} />
            <span class="toggle-slider"></span>
            <span class="toggle-text">Open in new tab</span>
          </label>
        </div>
      </div>
      
      <div class="results-grid" id="results-grid">
        ${this.renderAlbumCards(scatalog.albums)}
      </div>
      
      <div class="scatalog-metadata">
        <small>Created ${new Date(scatalog.createdAt).toLocaleDateString()} • Last accessed ${new Date(scatalog.lastAccessed).toLocaleDateString()}</small>
      </div>
    `;
    
    container.innerHTML = resultsHTML;
    
    // Set up event listeners for controls
    this.setupResultsControls(container);
    
    // Artist buttons are now handled in the drawer, no setup needed here

    // Set up remove label buttons if they exist
    const removeLabelButtons = container.querySelectorAll('.remove-label-btn');
    removeLabelButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const labelName = button.dataset.labelName;
        await this.removeLabelFromResults(labelName, container);
      });
    });

    // Set up save Scatalog button
    const saveScatalogBtn = container.querySelector('#saveScatalogBtn');
    if (saveScatalogBtn) {
      saveScatalogBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.saveCurrentStateAsScatalog(container);
      });
    }

    // Set up Related Artists button
    const relatedArtistsBtn = container.querySelector('#relatedArtistsBtn');
    if (relatedArtistsBtn) {
      relatedArtistsBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleRelatedArtistsDrawer(relatedArtistsBtn);
      });
      
      // Initialize the button state based on current drawer visibility
      this.updateRelatedArtistsButton(relatedArtistsBtn);
    }
  }

  /**
   * Save Scatalog to cache
   */
  async saveScatalogToCache(scatalog) {
    try {
      const scatalogs = await this.getCachedScatalogs();
      scatalogs[scatalog.id] = scatalog;
      await chrome.storage.local.set({ scatalogs });
    } catch (error) {
      console.error('Failed to save Scatalog to cache:', error);
    }
  }

  /**
   * Load cached Scatalogs
   */
  async loadCachedScatalogs() {
    try {
      const scatalogs = await this.getCachedScatalogs();
      this.scatalogs.clear();
      
      Object.values(scatalogs).forEach(scatalog => {
        this.scatalogs.set(scatalog.id, scatalog);
      });
      
      this.updateScatalogMenu();
      console.log(`Loaded ${this.scatalogs.size} cached Scatalogs`);
    } catch (error) {
      console.error('Failed to load cached Scatalogs:', error);
    }
  }

  /**
   * Get cached Scatalogs from storage
   */
  async getCachedScatalogs() {
    try {
      const result = await chrome.storage.local.get(['scatalogs']);
      return result.scatalogs || {};
    } catch (error) {
      console.error('Failed to get cached Scatalogs:', error);
      return {};
    }
  }

  /**
   * Remove Scatalog from cache
   */
  async removeScatalogFromCache(scatalogId) {
    try {
      const scatalogs = await this.getCachedScatalogs();
      delete scatalogs[scatalogId];
      await chrome.storage.local.set({ scatalogs });
    } catch (error) {
      console.error('Failed to remove Scatalog from cache:', error);
    }
  }

  /**
   * Remove albums from a specific label from the current results
   */
  async removeLabelFromResults(labelName, container) {
    try {
      // Don't allow removing the last label
      if (this.currentLabels.length <= 1) {
        return;
      }

      // Remove the label from the labels list
      this.currentLabels = this.currentLabels.filter(label => label !== labelName);
      
      // Remove albums from this label
      this.originalAlbums = this.originalAlbums.filter(album => album.labelName !== labelName);
      this.currentAlbums = this.currentAlbums.filter(album => album.labelName !== labelName);
      
      // Remove from total counts
      if (this.labelTotalCounts) {
        this.labelTotalCounts.delete(labelName);
      }
      
      // Update the display
      this.refreshResultsDisplay(container);
      this.updateModalTitle(); // Update title when labels are removed
      
      // Update artist drawer with new recommendations
      console.log('🔄 Calling updateArtistDrawer from removeLabelFromResults');
      await this.updateArtistDrawer();
      
    } catch (error) {
      console.error('Failed to remove label from results:', error);
    }
  }

  /**
   * Get count of different labels an artist appears on in current results
   */
  getArtistLabelsCount(artistId) {
    if (!this.originalAlbums || this.originalAlbums.length === 0) {
      return 0;
    }

    const labelsSet = new Set();
    this.originalAlbums.forEach(album => {
      if (album.artists.some(artist => artist.id === artistId)) {
        labelsSet.add(album.labelName);
      }
    });
    
    return labelsSet.size;
  }

  /**
   * Get estimated total label count for an artist (via API call)
   */
  async getArtistTotalLabelsCount(artistId) {
    try {
      // Use the existing API method which should work like the showOtherLabelsModal
      const labels = await this.api.getArtistLabels(artistId);
      
      if (!labels || labels.length === 0) {
        console.log(`No labels found for artist ${artistId}`);
        return 0;
      }
      
      console.log(`Artist ${artistId} has ${labels.length} different labels:`, labels.map(l => l.name));
      return labels.length;
    } catch (error) {
      console.warn(`Failed to get labels count for artist ${artistId}:`, error);
      return 0;
    }
  }

  /**
   * Load total label counts for all artist buttons (progressive enhancement)
   */
  async loadTotalLabelCounts(container) {
    const labelCountElements = container.querySelectorAll('.artist-total-labels');
    
    // Process artists one by one to avoid overwhelming the API
    for (const element of labelCountElements) {
      const artistId = element.dataset.artistId;
      if (!artistId) continue;

      try {
        // Show loading state
        element.textContent = '⏳';
        element.title = 'Loading total label count...';
        
        const totalLabels = await this.getArtistTotalLabelsCount(artistId);
        
        if (totalLabels > 0) {
          element.textContent = `~${totalLabels}L`;
          element.title = `This artist appears on approximately ${totalLabels} different labels total. Clicking will search through their discography.`;
          
          // Add warning styling for artists with many labels
          if (totalLabels > 10) {
            element.classList.add('high-label-count');
          } else if (totalLabels > 5) {
            element.classList.add('medium-label-count');
          }
        } else {
          element.textContent = '?';
          element.title = 'Could not determine total label count';
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error('Failed to load label count for artist:', artistId, error);
        element.textContent = '!';
        element.title = 'Error loading label count';
      }
    }
  }

  /**
   * Generate short reason text for artist buttons
   */
  generateArtistReason(artist, isGray = false) {
    const albumText = artist.albumCount === 1 ? 'release' : 'releases';
    
    if (isGray) {
      switch (artist.reason) {
        case 'cross-label':
          const labelsCount = this.getArtistLabelsCount(artist.id);
          return `has ${artist.albumCount} ${albumText} on ${labelsCount} labels`;
        case 'top-overall':
          return `has ${artist.albumCount} ${albumText} across all labels`;
        default:
          return `has ${artist.albumCount} ${albumText} across labels`;
      }
    } else {
      switch (artist.reason) {
        case 'original':
          return 'the artist you clicked';
        case 'collaborator':
          return 'collaborates with original artist';
        case 'top-frequent':
          return `has ${artist.albumCount} ${albumText} on this label`;
        case 'frequent':
          return `has ${artist.albumCount} ${albumText} on this label`;
        case 'top':
          return `has ${artist.albumCount} ${albumText} on this label`;
        case 'fallback':
          return `has ${artist.albumCount} ${albumText} on this label`;
        default:
          return `has ${artist.albumCount} ${albumText} on this label`;
      }
    }
  }

  /**
   * Generate tooltip text for artist buttons (kept for backward compatibility)
   */
  generateArtistTooltip(artist, isGray = false) {
    const albumText = artist.albumCount === 1 ? 'album' : 'albums';
    const baseText = `${artist.name} has ${artist.albumCount} ${albumText}`;
    
    if (isGray) {
      switch (artist.reason) {
        case 'cross-label':
          const labelsCount = this.getArtistLabelsCount(artist.id);
          return `${baseText} across ${labelsCount} labels in your current selection`;
        case 'top-overall':
          return `${baseText} - top artist across all selected labels`;
        default:
          return `${baseText} in your current selection`;
      }
    } else {
      switch (artist.reason) {
        case 'original':
          return `${baseText} on this label - the artist you originally clicked`;
        case 'collaborator':
          return `${baseText} on this label - appears on albums with the original artist`;
        case 'top-frequent':
          return `${baseText} on this label - top artist with multiple releases`;
        case 'frequent':
          return `${baseText} on this label - frequent collaborator`;
        case 'top':
          return `${baseText} on this label - top featured artist`;
        case 'fallback':
          return `${baseText} on this label - most featured artist`;
        default:
          return `${baseText} on this label`;
      }
    }
  }

  /**
   * Get top artists across all currently loaded albums from all labels
   */
  getTopArtistsAcrossCurrentLabels() {
    if (!this.originalAlbums || this.originalAlbums.length === 0) {
      return [];
    }

    const artistsMap = new Map();
    
    // Count artists across all current albums
    this.originalAlbums.forEach(album => {
      album.artists.forEach(artist => {
        if (!artistsMap.has(artist.id)) {
          artistsMap.set(artist.id, {
            id: artist.id,
            name: artist.name,
            albumCount: 0,
            albums: []
          });
        }
        const artistData = artistsMap.get(artist.id);
        artistData.albumCount++;
        artistData.albums.push(album);
      });
    });
    
    // Return top artists sorted by album count
    return Array.from(artistsMap.values())
      .sort((a, b) => b.albumCount - a.albumCount)
      .filter(artist => artist.albumCount >= 2); // Only show artists with 2+ albums
  }

  /**
   * Setup mouse-following tooltip for artist buttons
   */
  setupTooltip(button, container) {
    let tooltip = null;
    let isHovering = false;

    // Store the tooltip text before removing the title attribute
    const tooltipText = button.title || button.getAttribute('title') || button.dataset.tooltipText || '';
    
    // Debug logging
    console.log('Setting up tooltip for button:', button.dataset.artistName, 'with text:', tooltipText);
    
    if (!tooltipText) {
      console.warn('No tooltip text found for button:', button);
      return;
    }
    
    const showTooltip = (e) => {
      console.log('Showing tooltip:', tooltipText);
      
      // Create tooltip if it doesn't exist
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'artist-tooltip';
        tooltip.textContent = tooltipText;
        document.body.appendChild(tooltip);
        console.log('Created tooltip element:', tooltip);
      }

      isHovering = true;
      tooltip.classList.add('visible');
      updateTooltipPosition(e);
    };

    const hideTooltip = () => {
      console.log('Hiding tooltip');
      isHovering = false;
      if (tooltip) {
        tooltip.classList.remove('visible');
        setTimeout(() => {
          if (!isHovering && tooltip && tooltip.parentNode) {
            tooltip.parentNode.removeChild(tooltip);
            tooltip = null;
            console.log('Removed tooltip element');
          }
        }, 200);
      }
    };

    const updateTooltipPosition = (e) => {
      if (!tooltip || !isHovering) return;

      // Force a reflow to get accurate dimensions
      tooltip.style.visibility = 'hidden';
      tooltip.style.display = 'block';
      const tooltipRect = tooltip.getBoundingClientRect();
      tooltip.style.visibility = 'visible';
      
      const containerRect = container.getBoundingClientRect();
      
      // Calculate initial position (above the mouse)
      let x = e.clientX - tooltipRect.width / 2;
      let y = e.clientY - tooltipRect.height - 10;

      // Respect container boundaries
      const minX = containerRect.left + 10;
      const maxX = containerRect.right - tooltipRect.width - 10;
      const minY = containerRect.top + 10;
      const maxY = containerRect.bottom - tooltipRect.height - 10;

      // Adjust horizontal position
      if (x < minX) {
        x = minX;
      } else if (x > maxX) {
        x = maxX;
      }

      // Adjust vertical position
      if (y < minY) {
        // If tooltip would go above container, show it below the mouse instead
        y = e.clientY + 10;
        tooltip.style.setProperty('--arrow-position', 'top');
      } else {
        tooltip.style.setProperty('--arrow-position', 'bottom');
      }

      // Final boundary check for bottom position
      if (y > maxY) {
        y = maxY;
      }

      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
      
      console.log('Positioned tooltip at:', x, y);
    };

    // Event listeners
    button.addEventListener('mouseenter', showTooltip);
    button.addEventListener('mouseleave', hideTooltip);
    button.addEventListener('mousemove', updateTooltipPosition);

    // Store tooltip text in data attribute and remove title to prevent browser tooltip
    button.dataset.tooltipText = tooltipText;
    button.removeAttribute('title');
  }

  /**
   * Refresh the results display after changes
   */
  async refreshResultsDisplay(container) {
    const resultsGrid = container.querySelector('#results-grid');
    const resultsHeader = container.querySelector('.results-header');
    
    // Ensure we have current search data stored
    if (!this.currentSearchData) {
      console.warn('No current search data available for refresh');
      return;
    }
    
    if (resultsGrid && resultsHeader) {
      // Update the grid
      resultsGrid.innerHTML = this.renderAlbumCards(this.currentAlbums);
      this.setupAlbumClickHandlers(resultsGrid);

      // Regenerate the entire header with updated data
      const labelNamesHtml = this.currentLabels.map(label => 
        `<span class="label-name-highlight">${label}</span>`
      ).join(', ');

      // Generate label management HTML for multiple labels
      console.log('RefreshResults - Label management check:', this.currentLabels, 'length:', this.currentLabels?.length);
      const labelManagementHtml = this.currentLabels && this.currentLabels.length >= 1 ? `
        <div class="label-management-section">
          <div class="label-management-title">Active labels:</div>
          <div class="active-labels-list">
            ${this.currentLabels.map(label => `
              <div class="active-label-item" data-label-name="${label}">
                <span class="label-name-highlight">${label}</span>
                <button class="remove-label-btn" data-label-name="${label}" title="Remove ${label} from results">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
                  </svg>
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : '';

      // Build the new header HTML
      const newHeader = document.createElement('div');
      newHeader.className = 'results-header';
      newHeader.innerHTML = `
        <div class="results-header-top">
          <div class="results-header-content">
            ${labelManagementHtml}
            <div class="results-summary">
              <p>${this.generateResultsSummary()}</p>
            </div>
          </div>
          <div class="results-header-actions">
            <button class="related-artists-btn" id="relatedArtistsBtn" title="Toggle Related Artists panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z"/>
              </svg>
            </button>
            <button class="save-scatalog-btn" id="saveScatalogBtn" title="Save current catalog as Scatalog">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
              </svg>
              scatalog
            </button>
          </div>
        </div>
      `;
      // Replace the old header node
      resultsHeader.parentNode.replaceChild(newHeader, resultsHeader);

      // Re-setup event listeners for the new buttons
      const removeLabelButtons = newHeader.querySelectorAll('.remove-label-btn');
      removeLabelButtons.forEach(button => {
        button.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const labelName = button.dataset.labelName;
          await this.removeLabelFromResults(labelName, container);
        });
      });

      // Re-setup save Scatalog button
      const saveScatalogBtn = newHeader.querySelector('#saveScatalogBtn');
      if (saveScatalogBtn) {
        saveScatalogBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.saveCurrentStateAsScatalog(container);
        });
      }

      // Re-setup Related Artists button
      const relatedArtistsBtn = newHeader.querySelector('#relatedArtistsBtn');
      if (relatedArtistsBtn) {
        relatedArtistsBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.toggleRelatedArtistsDrawer(relatedArtistsBtn);
        });
      }
      
      // Recreate artist drawer to reflect the current labels
      setTimeout(async () => {
        await this.recreateArtistDrawer();
      }, 100);
      
    }
  }

  /**
   * Generate results summary showing actual total counts
   */
  generateResultsSummary() {
    if (!this.labelTotalCounts || this.labelTotalCounts.size === 0) {
      // Fallback to current display if no total counts available
      return `Found ${this.currentAlbums.length} release${this.currentAlbums.length !== 1 ? 's' : ''}`;
    }
    
    // Sum up the actual total counts for all labels
    let totalActualReleases = 0;
    for (const labelName of this.currentLabels) {
      const count = this.labelTotalCounts.get(labelName);
      if (count) {
        totalActualReleases += count;
      }
    }
    
    // Show both currently displayed and total available
    if (this.currentAlbums.length === totalActualReleases) {
      return `Found ${totalActualReleases} release${totalActualReleases !== 1 ? 's' : ''}`;
    } else {
      return `Showing ${this.currentAlbums.length} of ${totalActualReleases} release${totalActualReleases !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Process albums to handle "Various Artists" cases
   */
  async processVariousArtistsAlbums(albums) {
    const processedAlbums = [];
    
    for (const album of albums) {
      let processedAlbum = { ...album };
      
      // Check if this is a "Various Artists" album (German or English)
      const isVariousArtists = album.artists.some(artist => 
        artist.name.toLowerCase() === 'various artists' ||
        artist.name.toLowerCase() === 'verschiedene interpreten' ||
        artist.name.toLowerCase() === 'va'
      );
      
      if (isVariousArtists) {
        try {
          // Get the album tracks to find the actual artists
          const albumDetails = await this.api.makeRequest(`https://api.spotify.com/v1/albums/${album.id}`);
          
          if (albumDetails && albumDetails.tracks && albumDetails.tracks.items) {
            // Collect all unique artists from tracks
            const trackArtists = new Map();
            
            albumDetails.tracks.items.forEach(track => {
              track.artists.forEach(artist => {
                if (!trackArtists.has(artist.id)) {
                  trackArtists.set(artist.id, {
                    id: artist.id,
                    name: artist.name,
                    external_urls: artist.external_urls,
                    href: artist.href,
                    type: artist.type,
                    uri: artist.uri
                  });
                }
              });
            });
            
            // Replace album artists with track artists, but keep "Various Artists" as first
            const trackArtistsList = Array.from(trackArtists.values());
            if (trackArtistsList.length > 0) {
              processedAlbum.artists = [
                {
                  id: 'various-artists',
                  name: 'Various Artists',
                  external_urls: {},
                  href: '',
                  type: 'artist',
                  uri: 'spotify:artist:various-artists'
                },
                ...trackArtistsList.slice(0, 10) // Limit to prevent too many artists
              ];
            }
          }
        } catch (error) {
          console.warn('Failed to get track artists for Various Artists album:', album.name, error);
          // Fallback: just rename "Verschiedene Interpreten" to "Various Artists"
          processedAlbum.artists = album.artists.map(artist => ({
            ...artist,
            name: artist.name.toLowerCase() === 'verschiedene interpreten' ? 'Various Artists' : artist.name
          }));
        }
      }
      
      processedAlbums.push(processedAlbum);
    }
    
    return processedAlbums;
  }

  /**
   * Add albums from a label to the current results
   */
  async addLabelToCurrentResults(labelName) {
    try {
      // Search for albums from this label with comprehensive search
      const results = await this.api.searchAllAlbumsByLabel(labelName);
      const newAlbums = results.albums?.items || [];
      
      if (newAlbums.length === 0) {
        return;
      }
      
      const processedNewAlbums = await this.processVariousArtistsAlbums(newAlbums);
      const existingIds = new Set(this.originalAlbums.map(album => album.id));
      const uniqueNewAlbums = processedNewAlbums.filter(album => !existingIds.has(album.id));
      if (uniqueNewAlbums.length === 0) {
        // Even if no new albums, still recreate the artist drawer
        await this.recreateArtistDrawer();
        return;
      }
      const albumsWithLabel = uniqueNewAlbums.map(album => ({
        ...album,
        labelName: labelName
      }));
      
      // Store the actual total count from the comprehensive search
      if (!this.labelTotalCounts) {
        this.labelTotalCounts = new Map();
      }
      this.labelTotalCounts.set(labelName, results.albums?.total || newAlbums.length);
      
      // Append new albums
      this.originalAlbums = [...this.originalAlbums, ...albumsWithLabel];
      this.currentAlbums = [...this.originalAlbums];
      // Append new label
      if (!this.currentLabels.includes(labelName)) {
        this.currentLabels.push(labelName);
      }
      // Update the main modal display
      const mainModal = this.currentModal;
      if (mainModal) {
        const modalContent = mainModal.querySelector('.modal-content');
        if (modalContent) {
          await this.refreshResultsDisplay(modalContent);
          this.updateModalTitle();
        }
      }
      
      // Recreate artist drawer with new recommendations
      console.log('🔄 Calling recreateArtistDrawer from addLabelToCurrentResults');
      console.log('🔍 Current state before recreating drawer:', {
        currentModal: !!this.currentModal,
        currentAlbums: this.currentAlbums?.length || 0,
        currentLabels: this.currentLabels,
        modalSelector: document.querySelector('.spotify-label-explorer-modal') ? 'found' : 'not found'
      });
      await this.recreateArtistDrawer();
    } catch (error) {
      console.error('Failed to add label to results:', error);
      throw error;
    }
  }

  /**
   * Display search results in the modal
   */
  async displayResults(container, results, labelName, originalLabelInfo = null) {
    // Store current label name and search data for smart recommendations
    this.currentLabelName = labelName;
    this.currentSearchData = results;
    const albums = results.albums?.items || [];
    
    if (albums.length === 0) {
      container.innerHTML = `
        <div class="no-results">
          <p>No releases found for "${labelName}"</p>
          <p>This might be because:</p>
          <ul>
            <li>The label name wasn't detected correctly</li>
            <li>The label has no releases on Spotify</li>
            <li>The label uses a different name format</li>
          </ul>
        </div>
      `;
      return;
    }

    // Process albums to handle "Various Artists" cases
    const processedAlbums = await this.processVariousArtistsAlbums(albums);

    // Always reset to just this label and its albums
    this.originalAlbums = processedAlbums.map(album => ({
      ...album,
      labelName: labelName
    }));
    this.currentAlbums = [...this.originalAlbums];
    this.currentLabelName = labelName;
    this.currentLabels = [labelName];
    
    // Store the actual total count from the initial search
    if (!this.labelTotalCounts) {
      this.labelTotalCounts = new Map();
    }
    this.labelTotalCounts.set(labelName, results.albums?.total || processedAlbums.length);
    
    // Load cached "open in new tab" preference
    this.openInNewTab = await this.getOpenInNewTabPreference();

    // Get all artists from the albums for flexible "Other Labels" exploration
    const artistsMap = new Map();
    albums.forEach(album => {
      album.artists.forEach(artist => {
        if (!artistsMap.has(artist.id)) {
          artistsMap.set(artist.id, {
            id: artist.id,
            name: artist.name,
            albumCount: 0,
            albums: []
          });
        }
        const artistData = artistsMap.get(artist.id);
        artistData.albumCount++;
        artistData.albums.push(album);
      });
    });
    
    // Sort artists by album count and filter for significant presence
    const allArtists = Array.from(artistsMap.values())
      .sort((a, b) => b.albumCount - a.albumCount);
    
    // Determine which artists to show "Other Labels" buttons for
    let featuredArtists = [];
    
    // Strategy 1: If we have original artist info, prioritize that artist
    if (originalLabelInfo && originalLabelInfo.artist) {
      const originalArtistName = originalLabelInfo.artist.toLowerCase();
      const originalArtist = allArtists.find(artist => 
        artist.name.toLowerCase() === originalArtistName
      );
      if (originalArtist) {
        originalArtist.reason = 'original'; // Mark as original artist
        featuredArtists.push(originalArtist);
      }
    }
    
    // Strategy 2: Add artists from the same album as the original artist
    let albumCollaborators = [];
    if (originalLabelInfo && originalLabelInfo.artist) {
      const originalArtistName = originalLabelInfo.artist.toLowerCase();
      // Find albums that include the original artist
      const originalArtistAlbums = albums.filter(album => 
        album.artists.some(artist => artist.name.toLowerCase() === originalArtistName)
      );
      
      // Get all collaborators from those albums
      const collaboratorsMap = new Map();
      originalArtistAlbums.forEach(album => {
        album.artists.forEach(artist => {
          if (artist.name.toLowerCase() !== originalArtistName && !collaboratorsMap.has(artist.id)) {
            const artistData = allArtists.find(a => a.id === artist.id);
            if (artistData) {
              artistData.reason = 'collaborator'; // Album collaborator
              collaboratorsMap.set(artist.id, artistData);
            }
          }
        });
      });
      
      albumCollaborators = Array.from(collaboratorsMap.values()).slice(0, 2); // Limit to 2 collaborators
    }

    // Strategy 3: Add other significant artists (with 2+ albums or top 3 artists)
    const otherSignificantArtists = allArtists.filter(artist => {
      // Don't duplicate the original artist or collaborators
      const isOriginalArtist = featuredArtists.some(fa => fa.id === artist.id);
      const isCollaborator = albumCollaborators.some(ca => ca.id === artist.id);
      if (isOriginalArtist || isCollaborator) return false;
      
      // Include if they have 2+ albums OR are in top 3 most featured
      const hasMultipleAlbums = artist.albumCount >= 2;
      const isTopArtist = allArtists.indexOf(artist) < 3;
      
      if (hasMultipleAlbums && isTopArtist) {
        artist.reason = 'top-frequent'; // Top artist with multiple albums
      } else if (hasMultipleAlbums) {
        artist.reason = 'frequent'; // Multiple albums
      } else if (isTopArtist) {
        artist.reason = 'top'; // Top artist
      }
      
      return hasMultipleAlbums || isTopArtist;
    }).slice(0, 2); // Limit to 2 additional artists to make room for collaborators
    
    featuredArtists = [...featuredArtists, ...albumCollaborators, ...otherSignificantArtists];
    
    // If no featured artists found, fall back to top artist
    if (featuredArtists.length === 0 && allArtists.length > 0) {
      allArtists[0].reason = 'fallback'; // Fallback top artist
      featuredArtists = [allArtists[0]];
    }

    // Create label names display with green styling
    const labelNamesHtml = this.currentLabels.map(label => 
      `<span class="label-name-highlight">${label}</span>`
    ).join(', ');

    // Get top artists across all current albums for gray buttons
    const topArtistsAcrossLabels = this.getTopArtistsAcrossCurrentLabels();
    
    // Filter out artists that are already in featured artists and add reasons
    const grayArtists = topArtistsAcrossLabels.filter(artist => 
      !featuredArtists.some(fa => fa.id === artist.id)
    ).map(artist => {
      // Determine why this gray artist was selected
      const labelsCount = this.getArtistLabelsCount(artist.id);
      if (labelsCount > 1) {
        artist.reason = 'cross-label'; // Appears on multiple labels
      } else {
        artist.reason = 'top-overall'; // Top artist overall
      }
      return artist;
    }).slice(0, 4); // Limit to 4 additional gray artists

    // Simple artist drawer without heavy API calls
    if (allArtists.length > 0) {
      const simpleArtistRecommendations = allArtists.slice(0, 6).map(artist => ({
        id: artist.id,
        name: artist.name,
        albumCount: artist.albumCount,
        totalLabelsCount: 'multiple', // Show generic text to avoid API calls
        isGray: true
      }));
      
      setTimeout(() => {
        try {
          console.log('Attempting to create artist drawer for regular search');
          const mockScatalog = { artistButtons: simpleArtistRecommendations };
          const drawer = this.createArtistDrawer(mockScatalog);
          if (drawer) {
            console.log('Simple artist drawer created');
          } else {
            console.log('Artist drawer creation returned null for regular search');
          }
        } catch (error) {
          console.error('Error creating artist drawer for regular search:', error);
        }
      }, 300);
    }

    // Generate label management HTML for multiple labels
    const labelManagementHtml = this.currentLabels && this.currentLabels.length >= 1 ? `
      <div class="label-management-section">
        <div class="label-management-title">Active labels:</div>
        <div class="active-labels-list">
          ${this.currentLabels.map(label => `
            <div class="active-label-item" data-label-name="${label}">
              <span class="label-name-highlight">${label}</span>
              <button class="remove-label-btn" data-label-name="${label}" title="Remove ${label} from results">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
                </svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    const resultsHTML = `
      <div class="results-header">
        <div class="results-header-top">
          <div class="results-header-content">
            ${labelManagementHtml}
            <div class="results-summary">
              <p>Found ${albums.length} release${albums.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div class="results-header-actions">
            <button class="related-artists-btn" id="relatedArtistsBtn" title="Toggle Related Artists panel">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z"/>
              </svg>
            </button>
            <button class="save-scatalog-btn" id="saveScatalogBtn" title="Save current catalog as Scatalog">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
              </svg>
              scatalog
            </button>
          </div>
        </div>
      </div>
      
      <div class="results-controls">
        <div class="control-group">
          <label for="sort-select">Sort by:</label>
          <select id="sort-select" class="sort-select">
            <option value="name">Album Name</option>
            <option value="release_date" selected>Release Date</option>
            <option value="artist">Artist Name</option>
          </select>
          
          <button id="sort-order-btn" class="sort-order-btn" title="Toggle sort order">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
            </svg>
            <span class="sort-order-text">Desc</span>
          </button>
        </div>
        
        <div class="control-group">
          <input type="text" id="search-input" class="search-input" placeholder="Search releases..." />
        </div>
        
        <div class="control-group">
          <label class="toggle-label">
            <input type="checkbox" id="new-tab-toggle" ${this.openInNewTab ? 'checked' : ''} />
            <span class="toggle-slider"></span>
            <span class="toggle-text">Open in new tab</span>
          </label>
        </div>
      </div>
      
      <div class="results-grid" id="results-grid">
        ${this.renderAlbumCards(albums)}
      </div>
    `;
    
    container.innerHTML = resultsHTML;
    
    // Set up event listeners for controls
    this.setupResultsControls(container);
    
    // Artist buttons are now in the drawer, no event listeners needed here

    // Set up remove label buttons
    const removeLabelButtons = container.querySelectorAll('.remove-label-btn');
    removeLabelButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const labelName = button.dataset.labelName;
        await this.removeLabelFromResults(labelName, container);
      });
    });

    // Set up save Scatalog button
    const saveScatalogBtn = container.querySelector('#saveScatalogBtn');
    if (saveScatalogBtn) {
      saveScatalogBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.saveCurrentStateAsScatalog(container);
      });
    }

    // Set up Related Artists button
    const relatedArtistsBtn = container.querySelector('#relatedArtistsBtn');
    if (relatedArtistsBtn) {
      relatedArtistsBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleRelatedArtistsDrawer(relatedArtistsBtn);
      });
    }
  }

  /**
   * Render album cards HTML
   */
  renderAlbumCards(albums) {
    const showLabels = this.currentLabels && this.currentLabels.length >= 1;
    
    return albums.map(album => {
      // Format artist display for Various Artists albums
      let artistDisplay = '';
      if (album.artists.length > 0 && album.artists[0].name === 'Various Artists') {
        if (album.artists.length > 1) {
          // Show "Various Artists" and a few actual artists
          const actualArtists = album.artists.slice(1, 4).map(a => a.name);
          artistDisplay = `Various Artists (${actualArtists.join(', ')}${album.artists.length > 4 ? '...' : ''})`;
        } else {
          artistDisplay = 'Various Artists';
        }
      } else {
        artistDisplay = album.artists.map(a => a.name).join(', ');
      }
      
      return `
      <div class="album-card" data-spotify-url="${album.external_urls.spotify}" data-album-name="${album.name.toLowerCase()}" data-artist-name="${album.artists.map(a => a.name).join(', ').toLowerCase()}" data-release-date="${album.release_date}">
        <div class="album-artwork">
          <img src="${album.images[0]?.url || ''}" alt="${album.name}" loading="lazy">
          <div class="play-overlay">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        </div>
        <div class="album-info">
          <h3 class="album-title" title="${album.name}">${album.name}</h3>
            <p class="album-artist" title="${artistDisplay}">${artistDisplay}</p>
          <p class="album-year">${new Date(album.release_date).getFullYear()}</p>
            ${showLabels && album.labelName ? `<p class="album-label"><span class="label-name-highlight">${album.labelName}</span></p>` : ''}
        </div>
      </div>
      `;
    }).join('');
  }

  /**
   * Set up event listeners for results controls
   */
  setupResultsControls(container) {
    const sortSelect = container.querySelector('#sort-select');
    const sortOrderBtn = container.querySelector('#sort-order-btn');
    const searchInput = container.querySelector('#search-input');
    const newTabToggle = container.querySelector('#new-tab-toggle');
    const resultsGrid = container.querySelector('#results-grid');
    
    let sortOrder = 'desc'; // Default to descending (newest first)
    
    // Sort functionality
    const applySorting = () => {
      const sortBy = sortSelect.value;
      const isAscending = sortOrder === 'asc';
      
      this.currentAlbums.sort((a, b) => {
        let valueA, valueB;
        
        switch (sortBy) {
          case 'name':
            valueA = a.name.toLowerCase();
            valueB = b.name.toLowerCase();
            break;
          case 'release_date':
            valueA = new Date(a.release_date);
            valueB = new Date(b.release_date);
            break;
          case 'artist':
            valueA = a.artists[0]?.name.toLowerCase() || '';
            valueB = b.artists[0]?.name.toLowerCase() || '';
            break;
          default:
            return 0;
        }
        
        if (valueA < valueB) return isAscending ? -1 : 1;
        if (valueA > valueB) return isAscending ? 1 : -1;
        return 0;
      });
      
      resultsGrid.innerHTML = this.renderAlbumCards(this.currentAlbums);
      this.setupAlbumClickHandlers(resultsGrid);
    };
    
    // Search functionality
    const applySearch = () => {
      const searchTerm = searchInput.value.toLowerCase().trim();
      
      if (searchTerm === '') {
        this.currentAlbums = [...this.originalAlbums];
      } else {
        this.currentAlbums = this.originalAlbums.filter(album => 
          album.name.toLowerCase().includes(searchTerm) ||
          album.artists.some(artist => artist.name.toLowerCase().includes(searchTerm))
        );
      }
      
      applySorting(); // Re-apply sorting after filtering
    };
    
    // Sort select change
    sortSelect.addEventListener('change', applySorting);
    
    // Sort order toggle
    sortOrderBtn.addEventListener('click', () => {
      sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      const orderText = sortOrderBtn.querySelector('.sort-order-text');
      orderText.textContent = sortOrder === 'asc' ? 'Asc' : 'Desc';
      
      // Update icon
      const icon = sortOrderBtn.querySelector('svg path');
      if (sortOrder === 'asc') {
        icon.setAttribute('d', 'M3 6h6v2H3V6zm0 5h12v2H3v-2zm0 5h18v2H3v-2z'); // Ascending bars
      } else {
        icon.setAttribute('d', 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z'); // Descending bars
      }
      
      applySorting();
    });
    
    // Search input
    searchInput.addEventListener('input', applySearch);
    
    // New tab toggle
    newTabToggle.addEventListener('change', () => {
      this.openInNewTab = newTabToggle.checked;
      this.saveOpenInNewTabPreference(this.openInNewTab);
    });
    
    // Initial setup
    applySorting();
    this.setupAlbumClickHandlers(resultsGrid);
  }

  /**
   * Set up click handlers for album cards
   */
  setupAlbumClickHandlers(container) {
    container.querySelectorAll('.album-card').forEach(card => {
      // Remove any existing click listeners by cloning the element
      const newCard = card.cloneNode(true);
      card.parentNode.replaceChild(newCard, card);
      
      // Add the click listener to the new element
      newCard.addEventListener('click', () => {
        const spotifyUrl = newCard.dataset.spotifyUrl;
        if (spotifyUrl) {
          if (this.openInNewTab) {
            window.open(spotifyUrl, '_blank');
          } else {
            window.location.href = spotifyUrl;
          }
        }
      });
    });
  }

  /**
   * Setup rate limit indicator in modal header and footer
   */
  setupRateLimitIndicator() {
    if (!this.currentModal) return;
    
    const updateIndicator = async () => {
      const indicator = this.currentModal.querySelector('#rateLimitIndicator');
      const modalPressureValue = this.currentModal.querySelector('#modalPressureValue');
      const modalPressureFill = this.currentModal.querySelector('#modalPressureFill');
      
      if (!indicator) return;
      
      try {
        // Get rate limit status from Chrome storage (same as popup)
        const result = await chrome.storage.local.get([
          'recentApiCalls',
          'lastRateLimitTime',
          'rateLimitRetryAfter'
        ]);

        const now = Date.now();
        const recentApiCalls = result.recentApiCalls || [];
        const callsLastMinute = recentApiCalls.filter(timestamp => timestamp > now - 60000).length;
        const lastRateLimitTime = result.lastRateLimitTime || 0;
        const retryAfter = result.rateLimitRetryAfter || 0;

        // Check if we're currently in a rate limit period
        const isLimited = lastRateLimitTime && (now - lastRateLimitTime < (retryAfter * 1000));
        const recentCalls = callsLastMinute;
        
        const dot = indicator.querySelector('.rate-limit-dot');
        
        // Update header dot indicator
        if (isLimited) {
          dot.className = 'rate-limit-dot limited';
          indicator.title = 'Rate Limited - Please wait';
        } else if (recentCalls >= 90) {
          dot.className = 'rate-limit-dot critical';
          indicator.title = `Critical: ${recentCalls} calls/min`;
        } else if (recentCalls >= 70) {
          dot.className = 'rate-limit-dot high';
          indicator.title = `High: ${recentCalls} calls/min`;
        } else if (recentCalls >= 50) {
          dot.className = 'rate-limit-dot moderate';
          indicator.title = `Moderate: ${recentCalls} calls/min`;
        } else {
          dot.className = 'rate-limit-dot normal';
          indicator.title = `Normal: ${recentCalls} calls/min`;
        }
        
        // Update footer pressure bar
        if (modalPressureValue && modalPressureFill) {
          this.updateModalPressureIndicator(recentCalls, isLimited, modalPressureValue, modalPressureFill);
          console.log('scatalog: Updated modal pressure indicator:', recentCalls, 'calls/min');
        }
      } catch (error) {
        console.error('Failed to update rate limit indicator:', error);
      }
    };
    
    // Update immediately and then every 5 seconds
    updateIndicator();
    this.rateLimitInterval = setInterval(updateIndicator, 5000);
    
    // Also initialize the pressure bar immediately with 0 values if elements exist
    const modalPressureValue = this.currentModal.querySelector('#modalPressureValue');
    const modalPressureFill = this.currentModal.querySelector('#modalPressureFill');
    if (modalPressureValue && modalPressureFill) {
      this.updateModalPressureIndicator(0, false, modalPressureValue, modalPressureFill);
      console.log('scatalog: Initialized modal pressure indicator');
    }
  }

  /**
   * Update the modal pressure indicator
   */
  updateModalPressureIndicator(callsLastMinute, isCurrentlyLimited, pressureValueElement, pressureFillElement) {
    const maxCalls = 100; // Spotify's rate limit per minute
    const percentage = Math.min((callsLastMinute / maxCalls) * 100, 100);
    
    // Update the text value
    pressureValueElement.textContent = `${callsLastMinute}/${maxCalls}`;
    
    // Update the fill bar
    pressureFillElement.style.width = `${percentage}%`;
    
    // Add visual effects based on pressure level
    if (isCurrentlyLimited) {
      pressureFillElement.style.background = '#8b0000';
      pressureFillElement.style.animation = 'pulse-red 1s infinite';
    } else if (callsLastMinute >= 90) {
      pressureFillElement.style.background = '#e22134';
      pressureFillElement.style.animation = 'none';
    } else if (callsLastMinute >= 70) {
      pressureFillElement.style.background = 'linear-gradient(90deg, #ffa500 0%, #e22134 100%)';
      pressureFillElement.style.animation = 'none';
    } else if (callsLastMinute >= 50) {
      pressureFillElement.style.background = 'linear-gradient(90deg, #1db954 0%, #ffa500 100%)';
      pressureFillElement.style.animation = 'none';
    } else {
      pressureFillElement.style.background = '#1db954';
      pressureFillElement.style.animation = 'none';
    }
  }

  /**
   * Update modal title based on current label selection
   */
  updateModalTitle() {
    if (!this.currentModal || !this.currentLabels) return;
    
    const titleElement = this.currentModal.querySelector('#modal-title');
    if (!titleElement) return;
    
    if (this.currentLabels.length === 1) {
      titleElement.innerHTML = `<span class="label-prefix">Label</span> ${this.currentLabels[0]}`;
    } else {
      const labelCount = this.currentLabels.length;
      const labelNames = this.currentLabels.slice(0, 2).map(label => 
        `<span class="label-name-highlight">${label}</span>`
      ).join(', ');
      
      if (labelCount > 2) {
        titleElement.innerHTML = `<span class="label-prefix">Labels</span> ${labelNames} <span class="label-count">+${labelCount - 2} more</span>`;
      } else {
        titleElement.innerHTML = `<span class="label-prefix">Labels</span> ${labelNames}`;
      }
    }
  }

  /**
   * Close the modal
   */
  closeModal() {
    if (this.rateLimitInterval) {
      clearInterval(this.rateLimitInterval);
      this.rateLimitInterval = null;
    }
    
    if (this.currentModal) {
      this.currentModal.remove();
      this.currentModal = null;
    }
    
    // Clear drawer references
    this.currentArtistDrawer = null;
    this.artistDrawerVisible = true; // Reset for next modal
  }

  /**
   * Debug method to count buttons per container
   */
  debugButtonCount() {
    const containers = document.querySelectorAll('[data-testid="tracklist-row"], .main-trackList-trackListRow');
    let totalButtons = 0;
    let containersWithButtons = 0;
    let containersWithMultipleButtons = 0;

    containers.forEach((container, index) => {
      const buttons = container.querySelectorAll('.spotify-label-explorer-btn');
      if (buttons.length > 0) {
        containersWithButtons++;
        totalButtons += buttons.length;
        if (buttons.length > 1) {
          containersWithMultipleButtons++;
          console.log(`Container ${index} has ${buttons.length} buttons - PROBLEM!`);
        }
      }
    });

    console.log(`Debug: ${containers.length} containers, ${containersWithButtons} with buttons, ${totalButtons} total buttons, ${containersWithMultipleButtons} with multiple buttons`);
    return { containers: containers.length, withButtons: containersWithButtons, totalButtons, withMultiple: containersWithMultipleButtons };
  }

  /**
   * Clean up all existing label buttons and reset tracking
   */
  cleanupExistingButtons() {
    // Remove all existing label buttons
    const existingButtons = document.querySelectorAll('.spotify-label-explorer-btn');
    existingButtons.forEach(button => button.remove());
    
    // Remove all processing attributes
    const processedButtons = document.querySelectorAll('[data-label-explorer-processed]');
    processedButtons.forEach(button => button.removeAttribute('data-label-explorer-processed'));
    
    const processedContainers = document.querySelectorAll('[data-label-explorer-container-processed]');
    processedContainers.forEach(container => container.removeAttribute('data-label-explorer-container-processed'));
    
    // Clear tracking sets
    this.processedButtons.clear();
    this.processedElements.clear();
    
    console.log('scatalog: Cleaned up all existing buttons and reset tracking');
  }

  /**
   * Reload the SVG icon (useful for development/testing)
   */
  async reloadSvgIcon() {
    this.iconSvg = null; // Clear cache
    await this.loadSvgIcon();
    console.log('scatalog: SVG icon reloaded');
  }

  /**
   * Get the cached "open in new tab" preference
   */
  async getOpenInNewTabPreference() {
    try {
      const result = await chrome.storage.local.get(['openInNewTab']);
      return result.openInNewTab !== false; // Default to true
    } catch (error) {
      console.error('Failed to get open in new tab preference:', error);
      return true; // Default to true on error
    }
  }

  /**
   * Save the "open in new tab" preference
   */
  async saveOpenInNewTabPreference(openInNewTab) {
    try {
      await chrome.storage.local.set({ openInNewTab });
    } catch (error) {
      console.error('Failed to save open in new tab preference:', error);
    }
  }

  /**
   * Open artist page on Spotify, respecting the "open in new tab" preference
   */
  async openArtistPage(artistId) {
    try {
      // Get the cached "open in new tab" preference
      const openInNewTab = await this.getOpenInNewTabPreference();
      
      // Construct Spotify artist URL
      const artistUrl = `https://open.spotify.com/artist/${artistId}`;
      
      if (openInNewTab) {
        window.open(artistUrl, '_blank');
      } else {
        window.location.href = artistUrl;
      }
    } catch (error) {
      console.error('Failed to open artist page:', error);
    }
  }

  /**
   * Add global pressure indicators to all Spotify tabs
   */
  addGlobalPressureIndicators() {
    // Disabled for testing - API pressure indicators removed
    console.log('scatalog: Global pressure indicators disabled');
  }

  /**
   * Remove global pressure indicators
   */
  removeGlobalPressureIndicators() {
    const existing = document.getElementById('spotify-label-explorer-global-indicator');
    if (existing) {
      existing.remove();
    }
    
    if (this.globalPressureInterval) {
      clearInterval(this.globalPressureInterval);
      this.globalPressureInterval = null;
    }
  }

  /**
   * Start updating global pressure indicators
   */
  startGlobalPressureUpdates() {
    const updateGlobalIndicators = async () => {
      const globalPressureValue = document.getElementById('globalPressureValue');
      const globalPressureFill = document.getElementById('globalPressureFill');
      const globalPressureDot = document.getElementById('globalPressureDot');
      
      if (!globalPressureValue || !globalPressureFill || !globalPressureDot) {
        return;
      }
      
      try {
        // Get rate limit status from Chrome storage
        const result = await chrome.storage.local.get([
          'recentApiCalls',
          'lastRateLimitTime',
          'rateLimitRetryAfter'
        ]);

        const now = Date.now();
        const recentApiCalls = result.recentApiCalls || [];
        const callsLastMinute = recentApiCalls.filter(timestamp => timestamp > now - 60000).length;
        const lastRateLimitTime = result.lastRateLimitTime || 0;
        const retryAfter = result.rateLimitRetryAfter || 0;

        // Check if we're currently in a rate limit period
        const isLimited = lastRateLimitTime && (now - lastRateLimitTime < (retryAfter * 1000));

        // Update pressure bar
        this.updateGlobalPressureIndicator(callsLastMinute, isLimited, globalPressureValue, globalPressureFill);
        
        // Update dot indicator
        if (isLimited) {
          globalPressureDot.className = 'global-pressure-dot limited';
          globalPressureDot.title = 'Rate Limited - Please wait';
        } else if (callsLastMinute >= 90) {
          globalPressureDot.className = 'global-pressure-dot critical';
          globalPressureDot.title = `Critical: ${callsLastMinute} calls/min`;
        } else if (callsLastMinute >= 70) {
          globalPressureDot.className = 'global-pressure-dot high';
          globalPressureDot.title = `High: ${callsLastMinute} calls/min`;
        } else if (callsLastMinute >= 50) {
          globalPressureDot.className = 'global-pressure-dot moderate';
          globalPressureDot.title = `Moderate: ${callsLastMinute} calls/min`;
        } else {
          globalPressureDot.className = 'global-pressure-dot normal';
          globalPressureDot.title = `Normal: ${callsLastMinute} calls/min`;
        }
      } catch (error) {
        console.error('Failed to update global pressure indicators:', error);
      }
    };
    
    // Update immediately and then every 5 seconds
    updateGlobalIndicators();
    this.globalPressureInterval = setInterval(updateGlobalIndicators, 5000);
  }

  /**
   * Update the global pressure indicator
   */
  updateGlobalPressureIndicator(callsLastMinute, isCurrentlyLimited, pressureValueElement, pressureFillElement) {
    const maxCalls = 100; // Spotify's rate limit per minute
    const percentage = Math.min((callsLastMinute / maxCalls) * 100, 100);
    
    // Update the text value
    pressureValueElement.textContent = `${callsLastMinute}/${maxCalls}`;
    
    // Update the fill bar
    pressureFillElement.style.width = `${percentage}%`;
    
    // Add visual effects based on pressure level
    if (isCurrentlyLimited) {
      pressureFillElement.style.background = '#8b0000';
      pressureFillElement.style.animation = 'pulse-red 1s infinite';
    } else if (callsLastMinute >= 90) {
      pressureFillElement.style.background = '#e22134';
      pressureFillElement.style.animation = 'none';
    } else if (callsLastMinute >= 70) {
      pressureFillElement.style.background = 'linear-gradient(90deg, #ffa500 0%, #e22134 100%)';
      pressureFillElement.style.animation = 'none';
    } else if (callsLastMinute >= 50) {
      pressureFillElement.style.background = 'linear-gradient(90deg, #1db954 0%, #ffa500 100%)';
      pressureFillElement.style.animation = 'none';
    } else {
      pressureFillElement.style.background = '#1db954';
      pressureFillElement.style.animation = 'none';
    }
  }

  /**
   * Reinitialize when credentials are updated
   */
  async reinitialize() {
    this.isInitialized = false;
    
    // Clean up global indicators and Scatalog menu
    this.removeGlobalPressureIndicators();
    this.removeScatalogMenu();
    
    // Reinitialize the API with new credentials (clears cache and tokens)
    if (this.api) {
      await this.api.reinitialize();
    }
    
    // Clean up existing buttons and reset tracking
    this.cleanupExistingButtons();
    await this.init();
  }

  /**
   * Create labels drawer for exploring other labels
   */
  createLabelsDrawer(artistId, artistName) {
    // Remove existing labels drawer if any
    let existingDrawer = document.querySelector('.scatalog-labels-drawer');
    if (existingDrawer) {
      existingDrawer.remove();
    }

    // Create the drawer
    const drawer = document.createElement('div');
    drawer.className = 'scatalog-labels-drawer';

    // Create toggle button
    const toggleButton = document.createElement('button');
    toggleButton.className = 'labels-drawer-toggle';
    toggleButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15,17L10,12L15,7V17Z"/>
      </svg>
      <span class="toggle-text">Other Labels</span>
    `;

    // Create drawer content
    const drawerContent = document.createElement('div');
    drawerContent.className = 'labels-drawer-content';
    drawerContent.innerHTML = `
      <div class="labels-drawer-header">
        <h3><span style="color: #1db954; font-weight: 600;">${artistName}</span><br><span style="font-weight: 400;">has also released on</span></h3>
        <button class="labels-drawer-close">×</button>
      </div>
      <div class="labels-drawer-body">
        <div class="loading">Loading artist labels...</div>
      </div>
    `;

    drawer.appendChild(toggleButton);
    drawer.appendChild(drawerContent);

    // Add to DOM
    document.body.appendChild(drawer);

    // Setup drawer functionality
    this.setupLabelsDrawer(drawer, toggleButton, drawerContent, artistId, artistName);

    return drawer;
  }

  /**
   * Setup labels drawer functionality
   */
  setupLabelsDrawer(drawer, toggleButton, drawerContent, artistId, artistName) {
    let isOpen = false;
    
    // Toggle drawer open/close
    const toggleDrawer = () => {
      isOpen = !isOpen;
      drawer.classList.toggle('open', isOpen);
      
      // Clear active state when closing
      if (!isOpen) {
        this.clearActiveArtistButton();
      }
      
      // Update toggle button icon
      const icon = toggleButton.querySelector('svg path');
      if (isOpen) {
        icon.setAttribute('d', 'M10,17L15,12L10,7V17Z'); // Right arrow
      } else {
        icon.setAttribute('d', 'M15,17L10,12L15,7V17Z'); // Left arrow
      }
    };
    
    // Toggle button click
    toggleButton.addEventListener('click', toggleDrawer);
    
    // Close drawer button
    const closeButton = drawerContent.querySelector('.labels-drawer-close');
    closeButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen = false;
      drawer.classList.remove('open');
      this.clearActiveArtistButton();
      
      // Update toggle button icon
      const icon = toggleButton.querySelector('svg path');
      icon.setAttribute('d', 'M15,17L10,12L15,7V17Z'); // Left arrow
    });
    
    // Load and display the labels
    this.loadLabelsDrawerContent(drawerContent, artistId, artistName);
    
    // Position the drawer next to the main modal
    this.positionLabelsDrawer(drawer);
    
    // Update position when window resizes
    window.addEventListener('resize', () => this.positionLabelsDrawer(drawer));
    
    // Remove drawer when main modal is closed
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.spotify-label-explorer-modal')) {
        drawer.remove();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  }

  /**
   * Set active state for artist button
   */
  setActiveArtistButton(button) {
    // Remove active state from all artist buttons
    document.querySelectorAll('.artist-other-labels-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    
    // Add active state to the clicked button
    button.classList.add('active');
  }

  /**
   * Clear active state from all artist buttons
   */
  clearActiveArtistButton() {
    document.querySelectorAll('.artist-other-labels-btn').forEach(btn => {
      btn.classList.remove('active');
    });
  }

  /**
   * Position the labels drawer next to the main modal
   */
  positionLabelsDrawer(drawer) {
    const modal = document.querySelector('.spotify-label-explorer-modal');
    if (!modal) {
      console.log('Modal not found for labels drawer positioning');
      return;
    }
    
    const modalRect = modal.getBoundingClientRect();
    const drawerWidth = 320; // Same as artist drawer
    
    // Position drawer to the left of the modal
    drawer.style.left = `${modalRect.left - drawerWidth - 10}px`;
    drawer.style.top = `${modalRect.top}px`;
    drawer.style.maxHeight = `${modalRect.height}px`;
    
    // Make drawer visible by default
    drawer.classList.add('open');
  }

  /**
   * Load content for the labels drawer
   */
  async loadLabelsDrawerContent(drawerContent, artistId, artistName) {
    const drawerBody = drawerContent.querySelector('.labels-drawer-body');
    
    try {
      // Get all labels for this artist
      const labels = await this.api.getArtistLabels(artistId);
      
      if (labels.length === 0) {
        drawerBody.innerHTML = `
          <div class="no-results">
            <p>No other labels found for ${artistName}</p>
            <p>This artist may only have releases on ${this.currentLabelName} or independent releases.</p>
          </div>
        `;
        return;
      }

      // Filter out all currently active labels
      const otherLabels = labels.filter(label => 
        !this.currentLabels.includes(label.name)
      );
      
      if (otherLabels.length === 0) {
        drawerBody.innerHTML = `
          <div class="no-results">
            <p>No other labels found for ${artistName}</p>
            <p>All releases by this artist are already in your current selection.</p>
          </div>
        `;
        return;
      }

      this.displayOtherLabelsInDrawer(drawerBody, otherLabels, artistName);
      
    } catch (error) {
      drawerBody.innerHTML = `
        <div class="error">
          <p>Failed to load labels for ${artistName}</p>
          <p class="error-details">${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Display other labels in the drawer
   */
  displayOtherLabelsInDrawer(container, labels, artistName) {
    const totalAlbums = labels.reduce((sum, label) => sum + label.albums.length, 0);

    const resultsHTML = `
      <div class="results-header">
        <p>Found ${labels.length} other label${labels.length !== 1 ? 's' : ''} with ${totalAlbums} release${totalAlbums !== 1 ? 's' : ''}</p>
      </div>
      
      <div class="other-labels-list">
        ${labels.map(label => `
          <div class="other-label-item clickable-label-card" data-label-name="${label.name}">
            <div class="label-card-overlay">
              <div class="add-overlay">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
                </svg>
              </div>
            </div>
            <div class="label-info">
              <h3 class="label-name">${label.name}</h3>
              <p class="label-total-count" data-label-name="${label.name}">
                <span class="total-text">hover for total</span>
              </p>
              <p class="label-details">
                <span class="artist-releases">${label.albums.length} release${label.albums.length !== 1 ? 's' : ''} by ${artistName}</span>
              </p>
              <div class="label-albums-preview">
                ${label.albums.slice(0, 4).map(album => `
                  <div class="album-preview">
                    <img src="${album.images[0]?.url || ''}" alt="${album.name}" loading="lazy">
                  </div>
                `).join('')}
                ${label.albums.length > 4 ? `<div class="album-preview-more">+${label.albums.length - 4}</div>` : ''}
              </div>
            </div>
            <div class="label-action-buttons">
              <!-- Save button removed for cleaner UI -->
            </div>
          </div>
        `).join('')}
      </div>
    `;
    
    container.innerHTML = resultsHTML;
    
    // Set up hover functionality for total label counts
    this.setupLabelTotalCountHover(container);
    
    // Set up clickable label card event listeners
    container.querySelectorAll('.clickable-label-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        // Don't trigger if clicking on the save button
        if (e.target.closest('.create-scatalog-btn')) {
          return;
        }
        
        e.preventDefault();
        const labelName = card.dataset.labelName;
        
        console.log('[DEBUG] Label card clicked for label:', labelName);
        
        // Show loading state on overlay
        const overlay = card.querySelector('.add-overlay');
        const originalContent = overlay.innerHTML;
        overlay.innerHTML = '<div class="loading-spinner"></div>';
        card.style.pointerEvents = 'none';
        
        try {
          await this.addLabelToCurrentResults(labelName);
          
          // Show success state
          overlay.innerHTML = '<div class="success-check">✓</div>';
          
          // Start fade-out animation
          card.classList.add('label-fade-out');
          
          // Hide the card after animation completes
          setTimeout(() => {
            card.classList.add('label-hidden');
            card.classList.remove('label-fade-out');
          }, 500);
          
        } catch (error) {
          console.error('Failed to add label:', error);
          overlay.innerHTML = originalContent;
          card.style.pointerEvents = 'auto';
        }
      });
    });

    // Create Scatalog button event listeners removed - buttons no longer displayed for cleaner UI
  }

  /**
   * Create and manage the artist selection drawer
   */
  createArtistDrawer(scatalog) {
    console.log('Creating artist drawer with scatalog:', scatalog);
    
    // Check if drawer already exists
    let existingDrawer = document.querySelector('.scatalog-artist-drawer');
    if (existingDrawer) {
      existingDrawer.remove();
      console.log('Removed existing drawer');
    }

    // For saved scatalogs, generate artist recommendations dynamically
    let artistButtons = scatalog.artistButtons;
    if (!artistButtons || artistButtons.length === 0) {
      console.log('No pre-existing artist buttons, generating recommendations from albums');
      console.log('Scatalog albums:', scatalog.albums?.length || 0);
      
      // Check if we have albums to work with
      if (!scatalog.albums || scatalog.albums.length === 0) {
        console.log('No albums found in scatalog, cannot create artist drawer');
        return null;
      }
      
      // Extract all artists from the scatalog albums
      const allArtists = [];
      scatalog.albums.forEach(album => {
        if (album.artists && album.artists.length > 0) {
          album.artists.forEach(artist => {
            // Filter out "Various Artists" and "Verschiedene Interpreten" from recommendations
            const artistNameLower = artist.name.toLowerCase();
            if (artistNameLower === 'various artists' || 
                artistNameLower === 'verschiedene interpreten' ||
                artistNameLower === 'va') {
              return; // Skip these generic artist names
            }
            
            if (!allArtists.find(a => a.id === artist.id)) {
              allArtists.push({
                id: artist.id,
                name: artist.name,
                albumCount: 1,
                reason: 'catalog-artist',
                explanation: `Artist appears in this catalog`
              });
            } else {
              const existingArtist = allArtists.find(a => a.id === artist.id);
              existingArtist.albumCount++;
              existingArtist.explanation = `Artist has ${existingArtist.albumCount} releases in this catalog`;
            }
          });
        }
      });
      
      // Sort by album count and take top artists
      artistButtons = allArtists
        .sort((a, b) => b.albumCount - a.albumCount)
        .slice(0, 20); // Limit to top 20 artists
      
      console.log('Generated artist recommendations:', artistButtons.length);
      
      // If still no artists, return null
      if (artistButtons.length === 0) {
        console.log('No artists found, cannot create artist drawer');
        return null;
      }
    } else {
      console.log('Found existing artist buttons:', artistButtons.length);
      
      // Filter out "Various Artists" and "Verschiedene Interpreten" from existing artist buttons
      artistButtons = artistButtons.filter(artist => {
        const artistNameLower = artist.name.toLowerCase();
        return !(artistNameLower === 'various artists' || 
                 artistNameLower === 'verschiedene interpreten' ||
                 artistNameLower === 'va');
      });
      
      console.log('Filtered artist buttons:', artistButtons.length);
    }

    const drawer = document.createElement('div');
    drawer.className = 'scatalog-artist-drawer';
    drawer.style.display = 'block'; // Force visible for testing
    
    // Drawer toggle button
    const toggleButton = document.createElement('button');
    toggleButton.className = 'artist-drawer-toggle';
    toggleButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M10,17L15,12L10,7V17Z"/>
      </svg>
      <span>Artists</span>
    `;
    
    // Drawer content
    const drawerContent = document.createElement('div');
    drawerContent.className = 'artist-drawer-content';
    
    drawerContent.innerHTML = `
      <div class="artist-drawer-header">
        <h3 style="color: #999; margin: 0; font-size: 14px;">Related Artists</h3>
        <button class="artist-drawer-close">×</button>
      </div>
      <div class="artist-drawer-body">
        <div class="artist-recommendations-list">
          ${artistButtons.map(artist => `
            <div class="artist-recommendation-item" 
                 data-artist-explanation="${artist.explanation || ''}"
                 title="${artist.explanation || ''}">
              <div class="artist-item-row">
                <div class="artist-thumbnail-placeholder" data-artist-id="${artist.id}">
                  <div class="artist-thumbnail-loading"></div>
                </div>
                <strong class="artist-name-link" 
                        data-artist-id="${artist.id}" 
                        title="Open ${artist.name} page">${artist.name}</strong>
                <button class="artist-other-labels-btn" 
                        data-artist-id="${artist.id}" 
                        data-artist-name="${artist.name}"
                        title="View ${artist.name}'s other labels">
                  View Labels
                </button>
              </div>
              <div class="artist-explanation" style="display: none;">
                ${artist.explanation || ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    
    drawer.appendChild(toggleButton);
    drawer.appendChild(drawerContent);
    
    // Add drawer to the document body
    document.body.appendChild(drawer);
    console.log('Artist drawer added to DOM');
    
    // Store drawer reference for toggle functionality
    this.currentArtistDrawer = drawer;
    
    // Setup drawer functionality
    this.setupArtistDrawer(drawer, toggleButton, drawerContent, scatalog);
    
    // Set initial button state (drawer is open by default)
    this.artistDrawerVisible = true;
    this.updateRelatedArtistsButton();
    
    return drawer;
  }

  /**
   * Setup artist drawer functionality
   */
  setupArtistDrawer(drawer, toggleButton, drawerContent, scatalog) {
    let isOpen = false;
    
    // Get artist buttons from scatalog or generate them
    let artistButtons = scatalog.artistButtons;
    if (!artistButtons || artistButtons.length === 0) {
      // This should have been handled in createArtistDrawer, but add fallback
      console.log('No artist buttons in setupArtistDrawer, creating fallback');
      artistButtons = [];
    }
    
    // Toggle drawer open/close
    const toggleDrawer = () => {
      isOpen = !isOpen;
      drawer.classList.toggle('open', isOpen);
      
      // Update toggle button icon
      const icon = toggleButton.querySelector('svg path');
      if (isOpen) {
        icon.setAttribute('d', 'M15,17L10,12L15,7V17Z'); // Left arrow
      } else {
        icon.setAttribute('d', 'M10,17L15,12L10,7V17Z'); // Right arrow
      }
    };
    
    // Toggle button click
    toggleButton.addEventListener('click', toggleDrawer);
    
    // Close drawer button
    const closeButton = drawerContent.querySelector('.artist-drawer-close');
    closeButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Always close the drawer, don't toggle
      isOpen = false;
      drawer.classList.remove('open');
      
      // Update toggle button icon
      const icon = toggleButton.querySelector('svg path');
      icon.setAttribute('d', 'M10,17L15,12L10,7V17Z'); // Right arrow
      
      // Update related artists button state
      this.artistDrawerVisible = false;
      this.updateRelatedArtistsButton();
    });
    
    // Setup event listeners for artist drawer content
    this.setupArtistDrawerEventListeners(drawerContent);

    // Label counts are now included in the smart recommendation data
    
    // Load artist thumbnails
    console.log('Loading artist thumbnails for', artistButtons.length, 'artists');
    this.loadArtistThumbnails(drawerContent, artistButtons);
    
    // Position the drawer next to the main modal
    console.log('Calling positionArtistDrawer');
    this.positionArtistDrawer(drawer);
    
    // Update position when window resizes
    window.addEventListener('resize', () => this.positionArtistDrawer(drawer));
    
    // Remove drawer when main modal is closed
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.spotify-label-explorer-modal')) {
        drawer.remove();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  }

  /**
   * Position the artist drawer next to the main modal
   */
  positionArtistDrawer(drawer) {
    console.log('Attempting to position artist drawer');
    const modal = document.querySelector('.spotify-label-explorer-modal');
    if (!modal) {
      console.log('Modal not found for drawer positioning - checking all modals:', document.querySelectorAll('[class*="modal"]').length);
      console.log('Available modal classes:', Array.from(document.querySelectorAll('[class*="modal"]')).map(el => el.className));
      return;
    }
    
    const modalRect = modal.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const drawerWidth = 320; // Will be set in CSS
    
    console.log('Modal rect:', modalRect);
    console.log('Viewport width:', viewportWidth);
    
    // Position drawer to the right of the modal if there's space
    if (modalRect.right + drawerWidth + 20 <= viewportWidth) {
      drawer.style.left = `${modalRect.right + 10}px`;
      drawer.style.top = `${modalRect.top}px`;
      drawer.style.maxHeight = `${modalRect.height}px`;
      console.log('Positioning drawer to the right of modal');
    } else {
      // If no space on right, position it to the left
      drawer.style.left = `${modalRect.left - drawerWidth - 10}px`;
      drawer.style.top = `${modalRect.top}px`;
      drawer.style.maxHeight = `${modalRect.height}px`;
      console.log('Positioning drawer to the left of modal');
    }
    
    // Make drawer visible by default
    drawer.classList.add('open');
  }

  /**
   * Load artist thumbnails for the artist drawer
   */
  async loadArtistThumbnails(drawerContent, artists) {
    // Load thumbnails with reduced batch size and longer delays for better performance
    const batchSize = 2; // Reduced from 3 to 2
    
    for (let i = 0; i < artists.length; i += batchSize) {
      const batch = artists.slice(i, i + batchSize);
      
      // Process batch in parallel
      const promises = batch.map(async (artist) => {
        try {
          const artistDetails = await this.api.getArtist(artist.id);
          const thumbnail = drawerContent.querySelector(`[data-artist-id="${artist.id}"]`);
          
          if (thumbnail && artistDetails.images && artistDetails.images.length > 0) {
            // Use the smallest image (usually the last one)
            const image = artistDetails.images[artistDetails.images.length - 1];
            
            thumbnail.innerHTML = `
              <img src="${image.url}" 
                   alt="${artist.name}" 
                   class="artist-thumbnail"
                   onerror="this.parentElement.innerHTML='<div class=\\'artist-thumbnail-fallback\\'>♪</div>'" />
            `;
          } else if (thumbnail) {
            // Fallback for artists without images
            thumbnail.innerHTML = '<div class="artist-thumbnail-fallback">♪</div>';
          }
        } catch (error) {
          console.warn(`Failed to load thumbnail for artist ${artist.name}:`, error);
          const thumbnail = drawerContent.querySelector(`[data-artist-id="${artist.id}"]`);
          if (thumbnail) {
            thumbnail.innerHTML = '<div class="artist-thumbnail-fallback">♪</div>';
          }
        }
      });
      
      await Promise.all(promises);
      
      // Longer delay between batches for better performance
      if (i + batchSize < artists.length) {
        await new Promise(resolve => setTimeout(resolve, 300)); // Increased from 150ms to 300ms
      }
    }
  }

  /**
   * Smart artist recommendation system
   */
  async getSmartArtistRecommendations(allArtists, currentLabelName, originalLabelInfo = null) {
    const recommendations = [];
    
    console.log(`Getting smart recommendations for ${allArtists.length} artists across labels: ${this.currentLabels.join(', ')}`);
    
    // Analyze cross-label relationships for each artist (reduced from 15 to 8 for better performance)
    for (const artist of allArtists.slice(0, 8)) { 
      try {
        // Analyze this artist's presence across current labels
        const labelAnalysis = this.analyzeArtistLabelPresence(artist.id);
        
        // For multi-label searches, prioritize cross-label artists but don't exclude single-label artists entirely
        if (labelAnalysis.totalLabels < 1) {
          continue; // Skip artists with no presence at all
        }
        
        // Skip expensive API call for total label count - use estimated value
        const totalLabelsCount = Math.max(labelAnalysis.totalLabels, 1);
        
        // Calculate smart recommendation score
        const { score, reason, explanation } = this.calculateSmartScore(
          artist, 
          labelAnalysis, 
          totalLabelsCount, 
          originalLabelInfo
        );
        
        recommendations.push({
          id: artist.id,
          name: artist.name,
          albumCount: artist.albumCount,
          totalLabelsCount: totalLabelsCount,
          labelAnalysis: labelAnalysis,
          score: score,
          reason: reason,
          explanation: explanation,
          isGray: true
        });
        
      } catch (error) {
        console.warn(`Failed to analyze artist ${artist.name}:`, error);
      }
    }
    
    // Sort by score (highest first) and return top recommendations
    const sortedRecommendations = recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    
    console.log(`Smart recommendations generated: ${sortedRecommendations.length}`);
    sortedRecommendations.forEach(rec => {
      console.log(`${rec.name}: ${rec.score} points - ${rec.reason}`);
    });
    
    // Fallback: if we have very few smart recommendations, add some top artists
    if (sortedRecommendations.length < 3) {
      console.log('Adding fallback artists due to low recommendation count');
      const fallbackArtists = allArtists.slice(0, 6).map(artist => ({
        id: artist.id,
        name: artist.name,
        albumCount: artist.albumCount,
        totalLabelsCount: 1,
        score: 5,
        reason: `featured artist`,
        explanation: `• Featured in your current selection\n• Click to explore other labels`,
        isGray: true
      }));
      
      // Filter out duplicates and combine
      const existingIds = new Set(sortedRecommendations.map(r => r.id));
      const newFallbacks = fallbackArtists.filter(f => !existingIds.has(f.id));
      
      const combined = [...sortedRecommendations, ...newFallbacks].slice(0, 8);
      console.log(`Added ${newFallbacks.length} fallback artists, total: ${combined.length}`);
      return combined;
    }
    
    return sortedRecommendations;
  }

  /**
   * Analyze an artist's presence across current labels
   */
  analyzeArtistLabelPresence(artistId) {
    const labelPresence = new Map();
    let totalAlbums = 0;
    
    // Count albums per label for this artist
    this.originalAlbums.forEach(album => {
      if (album.artists.some(artist => artist.id === artistId)) {
        const labelName = album.labelName;
        if (!labelPresence.has(labelName)) {
          labelPresence.set(labelName, []);
        }
        labelPresence.get(labelName).push(album);
        totalAlbums++;
      }
    });
    
    return {
      labelPresence: labelPresence,
      totalLabels: labelPresence.size,
      totalAlbums: totalAlbums,
      labelsWithReleases: Array.from(labelPresence.keys()),
      albumsPerLabel: Object.fromEntries(
        Array.from(labelPresence.entries()).map(([label, albums]) => [label, albums.length])
      )
    };
  }

  /**
   * Calculate smart recommendation score with detailed reasoning
   */
  calculateSmartScore(artist, labelAnalysis, totalLabelsCount, originalLabelInfo) {
    let score = 0;
    let reason = '';
    let explanation = '';
    
    const { labelPresence, totalLabels, totalAlbums, labelsWithReleases, albumsPerLabel } = labelAnalysis;
    const currentLabelsCount = this.currentLabels.length;
    
    // CROSS-LABEL BONUS (highest priority for multi-label searches)
    if (currentLabelsCount > 1 && totalLabels > 1) {
      const crossLabelCount = labelsWithReleases.filter(label => this.currentLabels.includes(label)).length;
      
      if (crossLabelCount === currentLabelsCount) {
        // Artist appears on ALL current labels
        score += 100;
        reason = `appears on all ${currentLabelsCount} selected labels`;
        explanation = `• Appears on all selected labels: ${labelsWithReleases.join(', ')}\n• Perfect cross-label connection`;
      } else if (crossLabelCount > 1) {
        // Artist appears on multiple current labels
        score += 60 + (crossLabelCount * 10);
        const sharedLabels = labelsWithReleases.filter(label => this.currentLabels.includes(label));
        reason = `spans ${crossLabelCount} of your selected labels`;
        explanation = `• Spans labels: ${sharedLabels.join(', ')}\n• Bridges your selected labels`;
      }
    }
    
    // FREQUENCY BONUS
    const avgAlbumsPerLabel = totalAlbums / totalLabels;
    if (avgAlbumsPerLabel >= 3) {
      score += 30;
      reason += reason ? ' with high activity' : 'prolific across labels';
      explanation += `\n• ${Math.round(avgAlbumsPerLabel)} releases per label (high activity)`;
    } else if (avgAlbumsPerLabel >= 2) {
      score += 20;
      reason += reason ? ' with regular activity' : 'regular across labels';
      explanation += `\n• Multiple releases on most labels`;
    } else {
      score += 10;
      reason += reason ? ' with selective releases' : 'selective collaborator';
      explanation += `\n• Selective label partnerships`;
    }
    
    // ORIGINAL ARTIST BONUS
    if (originalLabelInfo && originalLabelInfo.artist && 
        artist.name.toLowerCase() === originalLabelInfo.artist.toLowerCase()) {
      score += 50;
      reason = 'the artist you originally clicked';
      explanation = `• The artist you originally clicked\n• Explore other label connections`;
    }
    
    // LABEL DIVERSITY BONUS
    if (totalLabelsCount >= 10) {
      score += 25;
      reason += reason ? ' (extensive network)' : 'extensive label network';
      explanation += `\n• Extensive network: ${totalLabelsCount}+ labels`;
    } else if (totalLabelsCount >= 5) {
      score += 15;
      reason += reason ? ' (good network)' : 'good label network';
      explanation += `\n• Works with ${totalLabelsCount} different labels`;
    } else if (totalLabelsCount >= 3) {
      score += 8;
      reason += reason ? ' (some network)' : 'some label connections';
      explanation += `\n• Releases on ${totalLabelsCount} labels`;
    }
    
    // LABEL BALANCE BONUS (for multi-label searches)
    if (currentLabelsCount > 1 && totalLabels > 1) {
      const albumCounts = Object.values(albumsPerLabel);
      const maxAlbums = Math.max(...albumCounts);
      const minAlbums = Math.min(...albumCounts);
      const balance = minAlbums / maxAlbums;
      
      if (balance >= 0.7) {
        score += 15;
        reason += reason ? ' (well-balanced)' : 'balanced across labels';
        explanation += `\n• Consistent activity across labels`;
      }
    }
    
    // Clean up explanation - remove trailing dots for bullet points
    explanation = explanation.trim();
    
    return { score, reason, explanation };
  }

  /**
   * Recreate the artist drawer completely with fresh recommendations
   */
  async recreateArtistDrawer() {
    // Remove existing artist drawer if it exists
    const existingDrawer = document.querySelector('.scatalog-artist-drawer');
    if (existingDrawer) {
      existingDrawer.remove();
    }

    // Only create new drawer if we have a current modal and current albums
    if (!this.currentModal || !this.currentAlbums || this.currentAlbums.length === 0) {
      return;
    }

    // Get all artists from current results
    const allArtists = this.getAllArtistsFromCurrentResults();
    
    if (allArtists.length === 0) {
      return;
    }

    // Generate smart recommendations based on all current labels
    const combinedLabelName = this.currentLabels.join(' + ');
    const smartRecommendations = await this.getSmartArtistRecommendations(
      allArtists, 
      combinedLabelName, 
      null // No specific original artist for combined searches
    );

    // Create new scatalog object based on current state
    const currentScatalog = {
      artistButtons: smartRecommendations
    };

    // Create and setup new artist drawer
    this.createArtistDrawer(currentScatalog);
  }

  /**
   * Update artist drawer with new recommendations based on current labels
   */
  async updateArtistDrawer() {
    console.log('🔄 updateArtistDrawer called');
    let drawer = document.querySelector('.scatalog-artist-drawer');
    
    if (!drawer) {
      console.log('❌ No artist drawer found, attempting to create one');
      
      // Try to create a drawer if one doesn't exist
      const allArtists = this.getAllArtistsFromCurrentResults();
      if (allArtists.length > 0) {
        const combinedLabelName = this.currentLabels.join(' + ');
        const smartRecommendations = await this.getSmartArtistRecommendations(
          allArtists, 
          combinedLabelName, 
          null
        );
        
        const scatalog = { artistButtons: smartRecommendations };
        drawer = this.createArtistDrawer(scatalog);
        console.log('✅ Created new artist drawer');
      } else {
        console.log('❌ No artists available to create drawer');
        return;
      }
    }
    
    console.log('✅ Artist drawer found');
    
    try {
      // Get all artists from current results
      const allArtists = this.getAllArtistsFromCurrentResults();
      console.log(`📊 Found ${allArtists.length} artists from current results`);
      
      if (allArtists.length === 0) {
        console.log('❌ No artists found, skipping update');
        return;
      }
      
      // Generate new smart recommendations based on all current labels
      const combinedLabelName = this.currentLabels.join(' + ');
      console.log(`🏷️ Current labels: ${combinedLabelName}`);
      
      const smartRecommendations = await this.getSmartArtistRecommendations(
        allArtists, 
        combinedLabelName, 
        null // No specific original artist for combined searches
      );
      
      console.log(`🎯 Generated ${smartRecommendations.length} smart recommendations`);
      
      // Update the drawer content
      const drawerContent = drawer.querySelector('.artist-drawer-content');
      if (drawerContent) {
        const drawerBody = drawerContent.querySelector('.artist-drawer-body');
        if (drawerBody) {
          // Update the artist list HTML
          const artistList = drawerBody.querySelector('.artist-recommendations-list');
          if (artistList) {
            console.log('🔧 Updating artist list HTML');
            
            artistList.innerHTML = smartRecommendations.map(artist => `
              <div class="artist-recommendation-item" 
                   data-artist-explanation="${(artist.explanation || '').replace(/"/g, '&quot;')}"
                   title="${(artist.explanation || '').replace(/"/g, '&quot;')}">
                <div class="artist-item-row">
                  <div class="artist-thumbnail-placeholder" data-artist-id="${artist.id}">
                    <div class="artist-thumbnail-loading"></div>
                  </div>
                  <strong class="artist-name-link" 
                          data-artist-id="${artist.id}" 
                          title="Open ${artist.name} page">${artist.name}</strong>
                  <button class="artist-other-labels-btn" 
                          data-artist-id="${artist.id}" 
                          data-artist-name="${artist.name}"
                          title="View ${artist.name}'s other labels">
                    View Labels
                  </button>
                </div>
                <div class="artist-explanation" style="display: none;">
                  ${artist.explanation || ''}
                </div>
              </div>
            `).join('');
            
            console.log('✅ HTML updated, setting up event listeners');
            
            // Re-setup event listeners for the new content
            this.setupArtistDrawerEventListeners(drawerContent);
            
            console.log('🖼️ Loading thumbnails');
            
            // Load new thumbnails
            await this.loadArtistThumbnails(drawerContent, smartRecommendations);
            
            console.log('✅ Artist drawer update complete');
          } else {
            console.log('❌ Artist list element not found');
          }
        } else {
          console.log('❌ Drawer body not found');
        }
      } else {
        console.log('❌ Drawer content not found');
      }
      
      console.log(`✅ Artist drawer updated with ${smartRecommendations.length} recommendations for labels: ${combinedLabelName}`);
    } catch (error) {
      console.error('❌ Failed to update artist drawer:', error);
    }
  }

  /**
   * Setup event listeners for artist drawer content (extracted for reuse)
   */
  setupArtistDrawerEventListeners(drawerContent) {
    // Setup artist name links for opening artist pages
    const artistNameLinks = drawerContent.querySelectorAll('.artist-name-link');
    artistNameLinks.forEach(link => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const artistId = link.dataset.artistId;
        await this.openArtistPage(artistId);
      });
    });

    // Setup "View Labels" buttons
    const viewLabelsButtons = drawerContent.querySelectorAll('.artist-other-labels-btn');
    viewLabelsButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const artistId = button.dataset.artistId;
        const artistName = button.dataset.artistName;
        
        // Add active state to the clicked button
        this.setActiveArtistButton(button);
        
        this.showOtherLabelsModal(artistId, artistName);
      });
    });

    // Setup hover explanations for artist items
    const artistItems = drawerContent.querySelectorAll('.artist-recommendation-item');
    artistItems.forEach(item => {
      const explanationDiv = item.querySelector('.artist-explanation');
      
      item.addEventListener('mouseenter', () => {
        if (explanationDiv && explanationDiv.textContent.trim()) {
          explanationDiv.style.display = 'block';
          explanationDiv.style.opacity = '0';
          explanationDiv.style.transform = 'translateY(-5px)';
          
          // Animate in
          setTimeout(() => {
            explanationDiv.style.transition = 'all 0.2s ease';
            explanationDiv.style.opacity = '1';
            explanationDiv.style.transform = 'translateY(0)';
          }, 10);
        }
      });
      
      item.addEventListener('mouseleave', () => {
        if (explanationDiv) {
          explanationDiv.style.transition = 'all 0.2s ease';
          explanationDiv.style.opacity = '0';
          explanationDiv.style.transform = 'translateY(-5px)';
          
          setTimeout(() => {
            explanationDiv.style.display = 'none';
          }, 200);
        }
      });
    });
  }

  /**
   * Get all artists from current search results
   */
  getAllArtistsFromCurrentResults() {
    if (!this.originalAlbums || this.originalAlbums.length === 0) {
      return [];
    }
    
    const artistMap = new Map();
    
    this.originalAlbums.forEach(album => {
      album.artists.forEach(artist => {
        // Filter out "Various Artists" and "Verschiedene Interpreten" from recommendations
        const artistNameLower = artist.name.toLowerCase();
        if (artistNameLower === 'various artists' || 
            artistNameLower === 'verschiedene interpreten' ||
            artistNameLower === 'va') {
          return; // Skip these generic artist names
        }
        
        if (artistMap.has(artist.id)) {
          artistMap.get(artist.id).albumCount++;
        } else {
          artistMap.set(artist.id, {
            id: artist.id,
            name: artist.name,
            albumCount: 1
          });
        }
      });
    });
    
    return Array.from(artistMap.values())
      .sort((a, b) => b.albumCount - a.albumCount);
  }

  /**
   * Toggle the Related Artists drawer visibility
   */
  toggleRelatedArtistsDrawer(button) {
    if (!this.currentArtistDrawer) {
      console.log('No artist drawer found to toggle');
      return;
    }

    // Toggle the visibility state
    this.artistDrawerVisible = !this.artistDrawerVisible;
    
    // Update drawer visibility
    if (this.artistDrawerVisible) {
      this.currentArtistDrawer.classList.add('open');
      this.currentArtistDrawer.style.display = 'block';
    } else {
      this.currentArtistDrawer.classList.remove('open');
      // Don't set display: none to allow for animation
    }
    
    // Update button appearance based on state
    this.updateRelatedArtistsButton(button);
    
    console.log('Artist drawer toggled:', this.artistDrawerVisible ? 'visible' : 'hidden');
  }

  /**
   * Update the Related Artists button appearance based on drawer state
   */
  updateRelatedArtistsButton(button) {
    if (!button) {
      button = document.querySelector('#relatedArtistsBtn');
    }
    
    if (!button) return;
    
    if (this.artistDrawerVisible) {
      // Drawer is visible - button should be grayed out/disabled appearance
      button.classList.add('drawer-open');
      button.classList.remove('drawer-closed');
      button.title = 'Related Artists panel is open - click to close';
    } else {
      // Drawer is hidden - button should be available/highlighted
      button.classList.add('drawer-closed');
      button.classList.remove('drawer-open');
      button.title = 'Show Related Artists panel';
    }
  }
}

// Initialize the extension when the page loads
let labelExplorer;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    labelExplorer = new SpotifyLabelExplorer();
  });
} else {
  labelExplorer = new SpotifyLabelExplorer();
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'reinitialize') {
    if (labelExplorer) {
      labelExplorer.reinitialize();
    }
    sendResponse({ success: true });
  }
}); 