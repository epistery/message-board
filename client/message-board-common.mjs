// Shared Message Board functionality for both board and chat views
import MarkUp from './MarkUp.mjs';

export class MessageBoardCommon {
  constructor() {
    this.posts = [];
    this.ws = null;
    this.currentUser = null;
    this.permissions = null;
    this.markup = null;
    this.currentChannel = null;
  }

  async init() {
    console.log('[message-board] Initializing common...');

    // Initialize markdown renderer
    this.markup = new MarkUp();
    await this.markup.init();

    // Ensure wallet exists
    await this.ensureWallet();

    // Check authentication
    await this.checkAuthStatus();

    // Load posts
    await this.loadPosts();

    // Connect WebSocket
    this.connectWebSocket();
  }

  // Ensure wallet exists, auto-creating if necessary
  async ensureWallet() {
    try {
      const data = localStorage.getItem('epistery');
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.wallets && parsed.wallets.length > 0) {
          console.log('[message-board] Wallet already exists');
          return;
        }
      }

      console.log('[message-board] No wallet found, creating one...');
      const WitnessModule = await import('/lib/witness.js');
      const Witness = WitnessModule.default;
      window.epistery = await Witness.connect();
      console.log('[message-board] Wallet created successfully:', window.epistery.wallet.address);
    } catch (error) {
      console.log('[message-board] Could not auto-create wallet:', error.message);
    }
  }

  // Check authentication and update UI
  async checkAuthStatus() {
    try {
      const response = await fetch('/api/acl/check-access?agent=' + encodeURIComponent('@epistery/message-board'));
      if (!response.ok) {
        throw new Error('Failed to check access');
      }

      const accessData = await response.json();
      console.log('[message-board] Access check:', accessData);

      if (accessData.address) {
        this.currentUser = { address: accessData.address };
        console.log('[message-board] Authenticated as:', accessData.address);

        this.permissions = {
          address: accessData.address,
          level: accessData.level || 0,
          edit: accessData.level >= 2,
          admin: accessData.level >= 3
        };

        return this.permissions;
      } else {
        this.permissions = null;
        return null;
      }
    } catch (error) {
      console.error('[message-board] Access check error:', error);
      return null;
    }
  }

  // Load posts from API
  async loadPosts() {
    try {
      const cachedPosts = localStorage.getItem('message-board-posts');
      if (cachedPosts) {
        try {
          this.posts = JSON.parse(cachedPosts);
          console.log('[message-board] Loaded posts from localStorage cache');
        } catch (e) {
          console.error('[message-board] Failed to parse cached posts:', e);
        }
      }

      // Build URL with optional channel filter
      let url = '/agent/epistery/message-board/api/posts';
      if (this.currentChannel) {
        url += `?channel=${encodeURIComponent(this.currentChannel)}`;
      }

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load posts');

      this.posts = await response.json();
      this.savePosts();
      return this.posts;
    } catch (error) {
      console.error('[message-board] Load error:', error);
      throw error;
    }
  }

  // Save posts to localStorage
  savePosts() {
    try {
      const postsToCache = this.posts.slice(0, 50).map(post => ({
        id: post.id,
        text: post.text,
        author: post.author,
        authorName: post.authorName,
        timestamp: post.timestamp,
        comments: post.comments,
        image: null
      }));
      localStorage.setItem('message-board-posts', JSON.stringify(postsToCache));
      console.log(`[message-board] Saved ${postsToCache.length} posts to localStorage`);
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        console.warn('[message-board] localStorage quota exceeded, clearing cache');
        try {
          localStorage.removeItem('message-board-posts');
        } catch (e) {}
      } else {
        console.error('[message-board] Failed to save posts to localStorage:', error);
      }
    }
  }

  // Create new post
  async createPost(text, imageDataUrl, channel) {
    try {
      const body = {
        text: text.trim(),
        image: imageDataUrl || null,
        channel: channel || null
      };

      const headers = { 'Content-Type': 'application/json' };
      if (this.currentUser && this.currentUser.address) {
        headers['X-Wallet-Address'] = this.currentUser.address;
      }

      const response = await fetch('/agent/epistery/message-board/api/posts', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to post');
        } else {
          const text = await response.text();
          throw new Error(`Failed to post (${response.status}). ${text.substring(0, 100)}`);
        }
      }

      const newPost = await response.json();

      // Don't add optimistic post - just reload to avoid duplicates
      await this.loadPosts();

      return newPost;
    } catch (error) {
      console.error('[message-board] Post error:', error);
      throw error;
    }
  }

  // Delete post
  async deletePost(postId) {
    try {
      const headers = {};
      if (this.currentUser && this.currentUser.address) {
        headers['X-Wallet-Address'] = this.currentUser.address;
      }

      const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}`, {
        method: 'DELETE',
        headers,
        credentials: 'include'
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to delete post');
        } else {
          throw new Error(`Failed to delete post (${response.status})`);
        }
      }

      await this.loadPosts();
    } catch (error) {
      console.error('[message-board] Delete error:', error);
      throw error;
    }
  }

  // Add comment
  async addComment(postId, text) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.currentUser && this.currentUser.address) {
        headers['X-Wallet-Address'] = this.currentUser.address;
      }

      const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}/comments`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ text: text.trim() })
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to post comment');
        } else {
          throw new Error(`Failed to post comment (${response.status})`);
        }
      }

      await this.loadPosts();
    } catch (error) {
      console.error('[message-board] Comment error:', error);
      throw error;
    }
  }

  // Connect WebSocket for real-time updates
  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/agent/epistery/message-board/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[message-board] WebSocket connected');
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleWebSocketMessage(message);
    };

    this.ws.onclose = () => {
      console.log('[message-board] WebSocket disconnected, reconnecting...');
      setTimeout(() => this.connectWebSocket(), 5000);
    };

    this.ws.onerror = (error) => {
      console.error('[message-board] WebSocket error:', error);
    };
  }

  // Handle WebSocket messages
  handleWebSocketMessage(message) {
    console.log('[message-board] WebSocket message:', message);

    switch (message.type) {
      case 'new-post':
        if (!this.posts.find(p => p.id === message.post.id)) {
          this.posts.unshift(message.post);

          // Fire notification if available and not from current user
          if (window.episteryNotify && message.post.author !== this.currentUser?.name) {
            const truncatedText = message.post.text.length > 80
              ? message.post.text.substring(0, 80) + '...'
              : message.post.text;
            window.episteryNotify(
              'New Post',
              `${message.post.author}: ${truncatedText}`,
              {
                icon: '/image/favicon.png',
                tag: 'post-' + message.post.id
              }
            );
          }
        }
        this.savePosts();
        this.onPostsUpdated && this.onPostsUpdated();
        break;

      case 'new-comment':
        const post = this.posts.find(p => p.id === message.postId);
        if (post) {
          if (!post.comments.find(c => c.id === message.comment.id)) {
            post.comments.push(message.comment);

            // Fire notification if available and not from current user
            if (window.episteryNotify && message.comment.author !== this.currentUser?.name) {
              const truncatedText = message.comment.text.length > 60
                ? message.comment.text.substring(0, 60) + '...'
                : message.comment.text;
              window.episteryNotify(
                'New Comment',
                `${message.comment.author} replied: ${truncatedText}`,
                {
                  icon: '/image/favicon.png',
                  tag: 'comment-' + message.comment.id
                }
              );
            }
          }
          this.savePosts();
          this.onPostsUpdated && this.onPostsUpdated();
        }
        break;

      case 'delete-post':
        this.posts = this.posts.filter(p => p.id !== message.postId);
        this.savePosts();
        this.onPostsUpdated && this.onPostsUpdated();
        break;

      case 'edit-post':
        const editedPost = this.posts.find(p => p.id === message.post.id);
        if (editedPost) {
          editedPost.text = message.post.text;
          editedPost.editedAt = message.post.editedAt;
          this.savePosts();
          this.onPostsUpdated && this.onPostsUpdated();
        }
        break;
    }
  }

  // Process and normalize uploaded images
  async processImage(file, settings) {
    const defaultSettings = {
      maxUploadSize: 10,
      maxProcessedSize: 3,
      maxWidth: 1024,
      jpegQuality: 85,
      allowSvg: true
    };

    const imgSettings = settings || defaultSettings;

    try {
      const response = await fetch('/agent/epistery/message-board/api/settings/image');
      if (response.ok) {
        Object.assign(imgSettings, await response.json());
      }
    } catch (error) {
      console.warn('[message-board] Failed to fetch image settings, using defaults');
    }

    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (imgSettings.allowSvg) {
      validTypes.push('image/svg+xml');
    }

    if (!validTypes.includes(file.type)) {
      throw new Error('Invalid file type. Please upload a JPEG, PNG, GIF, WebP' + (imgSettings.allowSvg ? ', or SVG' : '') + ' image.');
    }

    const maxSize = imgSettings.maxUploadSize * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error(`File too large. Maximum size is ${imgSettings.maxUploadSize}MB.`);
    }

    if (file.type === 'image/svg+xml') {
      return await this.processSvgFile(file);
    }

    const img = await this.loadImage(file);
    const maxWidth = imgSettings.maxWidth;
    let { width, height } = img;

    if (width > maxWidth) {
      const aspectRatio = height / width;
      width = maxWidth;
      height = Math.round(maxWidth * aspectRatio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const quality = imgSettings.jpegQuality / 100;
    const dataUrl = canvas.toDataURL('image/jpeg', quality);

    const sizeInBytes = Math.round((dataUrl.length * 3) / 4);
    const maxProcessedSize = imgSettings.maxProcessedSize * 1024 * 1024;
    if (sizeInBytes > maxProcessedSize) {
      const reducedQuality = Math.max(0.5, quality - 0.15);
      return canvas.toDataURL('image/jpeg', reducedQuality);
    }

    return dataUrl;
  }

  processSvgFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const svgContent = e.target.result;
          if (!svgContent.trim().startsWith('<svg')) {
            reject(new Error('Invalid SVG file'));
            return;
          }
          const base64 = btoa(svgContent);
          resolve(`data:image/svg+xml;base64,${base64}`);
        } catch (error) {
          reject(new Error('Failed to process SVG file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read SVG file'));
      reader.readAsText(file);
    });
  }

  loadImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // Utility: Get time ago string
  getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);

    const intervals = {
      year: 31536000,
      month: 2592000,
      week: 604800,
      day: 86400,
      hour: 3600,
      minute: 60
    };

    for (const [unit, secondsInUnit] of Object.entries(intervals)) {
      const interval = Math.floor(seconds / secondsInUnit);
      if (interval >= 1) {
        return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
      }
    }

    return 'just now';
  }

  // Utility: Escape HTML
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Generate avatar from address (deterministic)
  generateAvatar(address, size = 40) {
    const hash = address.toLowerCase();
    const seed = parseInt(hash.slice(2, 10), 16);

    const hue1 = (seed % 360);
    const hue2 = ((seed * 7) % 360);
    const saturation = 65 + ((seed % 20));
    const lightness = 45 + ((seed % 15));

    const color1 = `hsl(${hue1}, ${saturation}%, ${lightness}%)`;
    const color2 = `hsl(${hue2}, ${saturation}%, ${lightness + 10}%)`;

    const pattern = (seed % 4);

    let svg = '';
    switch(pattern) {
      case 0:
        svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${size}" height="${size}" fill="${color1}"/>
          <path d="M0,0 L${size},${size} M${size/2},${-size/2} L${size*1.5},${size/2} M${-size/2},${size/2} L${size/2},${size*1.5}" stroke="${color2}" stroke-width="${size/4}"/>
        </svg>`;
        break;
      case 1:
        svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${size}" height="${size}" fill="${color1}"/>
          <circle cx="${size/2}" cy="${size/2}" r="${size/3}" fill="${color2}"/>
          <circle cx="${size/2}" cy="${size/2}" r="${size/6}" fill="${color1}"/>
        </svg>`;
        break;
      case 2:
        svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${size}" height="${size}" fill="${color1}"/>
          <polygon points="${size/2},${size/6} ${size*5/6},${size*5/6} ${size/6},${size*5/6}" fill="${color2}"/>
        </svg>`;
        break;
      case 3:
        svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${size}" height="${size}" fill="${color1}"/>
          <rect x="${size/4}" y="${size/4}" width="${size/2}" height="${size/2}" fill="${color2}" transform="rotate(45 ${size/2} ${size/2})"/>
        </svg>`;
        break;
    }

    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  // Copy address to clipboard
  async copyAddress(address) {
    try {
      await navigator.clipboard.writeText(address);
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #155724;
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 10000;
        animation: slideIn 0.3s ease;
      `;
      notification.textContent = 'Address copied to clipboard!';
      document.body.appendChild(notification);

      setTimeout(() => notification.remove(), 2000);
    } catch (error) {
      console.error('[message-board] Failed to copy address:', error);
      alert('Failed to copy address');
    }
  }
}

export default MessageBoardCommon;
