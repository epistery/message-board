// Message Board Client Application
let posts = [];
let ws = null;
let currentUser = null;

// Initialize
async function init() {
  console.log('[message-board] Initializing...');

  // Load posts
  await loadPosts();

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Setup event listeners
  setupEventListeners();

  // Ensure wallet exists (auto-create if needed)
  await ensureWallet();

  // Check authentication status
  checkAuthStatus();

  console.log('[message-board] Ready');
}

// Ensure wallet exists, auto-creating if necessary
async function ensureWallet() {
  try {
    // Check if wallet already exists in localStorage
    const data = localStorage.getItem('epistery');
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.wallets && parsed.wallets.length > 0) {
        console.log('[message-board] Wallet already exists');
        return;
      }
    }

    // No wallet exists - auto-create one silently using Witness
    console.log('[message-board] No wallet found, creating one...');
    const WitnessModule = await import('/lib/witness.js');
    const Witness = WitnessModule.default;
    await Witness.connect();
    console.log('[message-board] Wallet created successfully');
  } catch (error) {
    console.log('[message-board] Could not auto-create wallet:', error.message);
    // Not critical - user can still view posts
  }
}

// Check authentication and update UI
async function checkAuthStatus() {
  // Try to get wallet address from localStorage (same-domain as home page)
  try {
    console.log('[message-board] Checking localStorage for epistery wallet...');
    console.log('[message-board] Origin:', window.location.origin);
    console.log('[message-board] localStorage length:', localStorage.length);

    const data = localStorage.getItem('epistery');
    console.log('[message-board] localStorage.epistery exists:', !!data);

    if (data) {
      const parsed = JSON.parse(data);
      console.log('[message-board] Parsed data keys:', Object.keys(parsed));
      console.log('[message-board] Wallets count:', parsed.wallets ? parsed.wallets.length : 0);
      console.log('[message-board] Default wallet ID:', parsed.defaultWalletId);

      // Get the default wallet from the wallets array
      let wallet = null;
      if (parsed.wallets && parsed.wallets.length > 0) {
        // Find the default wallet
        wallet = parsed.wallets.find(w => w.id === parsed.defaultWalletId);
        console.log('[message-board] Found default wallet:', !!wallet);

        // Fallback to first wallet if no default
        if (!wallet) {
          wallet = parsed.wallets[0];
          console.log('[message-board] Using first wallet as fallback');
        }

        // Extract actual wallet object from wrapper
        if (wallet && wallet.wallet) {
          console.log('[message-board] Wallet wrapper found, extracting...');
          wallet = wallet.wallet;
        }
      }

      if (wallet && wallet.address) {
        const address = wallet.rivetAddress || wallet.address;
        console.log('[message-board] Authenticated as:', address);

        currentUser = { address };

        // Check if user has posting permission
        await checkPostingPermission(address);
        return;
      } else {
        console.log('[message-board] No valid wallet address found in structure');
      }
    }
  } catch (e) {
    console.error('[message-board] Error checking localStorage:', e);
  }

  // No wallet in localStorage - show request access form
  showGuestAccessRequest();
}

// Load posts from API or localStorage
async function loadPosts() {
  try {
    // First, try to load from localStorage for instant display
    const cachedPosts = localStorage.getItem('message-board-posts');
    if (cachedPosts) {
      try {
        posts = JSON.parse(cachedPosts);
        renderPosts();
        console.log('[message-board] Loaded posts from localStorage cache');
      } catch (e) {
        console.error('[message-board] Failed to parse cached posts:', e);
      }
    }

    // Then fetch fresh data from server
    const response = await fetch('/agent/epistery/message-board/api/posts');
    if (!response.ok) throw new Error('Failed to load posts');

    posts = await response.json();
    savePosts();
    renderPosts();
  } catch (error) {
    console.error('[message-board] Load error:', error);
    // If we have cached posts, don't show error
    if (!posts || posts.length === 0) {
      showError('Failed to load posts: ' + error.message);
    }
  }
}

// Save posts to localStorage (limit to most recent 50 posts to avoid quota issues)
function savePosts() {
  try {
    // Only cache the most recent 50 posts (without images to save space)
    const postsToCache = posts.slice(0, 50).map(post => ({
      id: post.id,
      text: post.text,
      author: post.author,
      authorName: post.authorName,
      timestamp: post.timestamp,
      comments: post.comments,
      // Omit image data from cache to save space
      image: null
    }));
    localStorage.setItem('message-board-posts', JSON.stringify(postsToCache));
    console.log(`[message-board] Saved ${postsToCache.length} posts to localStorage`);
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      console.warn('[message-board] localStorage quota exceeded, clearing cache');
      try {
        localStorage.removeItem('message-board-posts');
      } catch (e) {
        // Ignore errors when clearing
      }
    } else {
      console.error('[message-board] Failed to save posts to localStorage:', error);
    }
  }
}

// Render posts
function renderPosts() {
  const container = document.getElementById('posts-container');

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <p>No posts yet. Be the first to post!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = posts.map(post => renderPost(post)).join('');
}

// Render single post
function renderPost(post) {
  const date = new Date(post.timestamp);
  const timeAgo = getTimeAgo(date);
  const shortAddress = post.author.substring(0, 8) + '...' + post.author.substring(post.author.length - 6);
  const avatar = generateAvatar(post.author, 40);

  const commentsHtml = post.comments && post.comments.length > 0
    ? `
      <div class="comments">
        ${post.comments.map(comment => renderComment(comment)).join('')}
      </div>
    `
    : '';

  const imageHtml = post.image
    ? `<img src="${post.image}" class="post-image" alt="Post image">`
    : '';

  const pendingStyle = post.pending ? 'opacity: 0.7;' : '';
  const pendingBadge = post.pending ? '<span style="color: #ffa500; font-size: 12px; margin-left: 8px;">⏳ Pending confirmation...</span>' : '';

  // Format: "Name (0xShort...Address)" or just "(0xShort...Address)" if no name
  const authorDisplay = post.authorName
    ? `${escapeHtml(post.authorName)} <span class="clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">(${shortAddress})</span>`
    : `<span class="clickable-address" onclick="copyAddress('${post.author}')" title="Click to copy full address">${shortAddress}</span>`;

  return `
    <div class="post" data-post-id="${post.id}" style="${pendingStyle}">
      <div class="post-header">
        <div class="post-author-section">
          <img src="${avatar}" class="avatar" alt="Avatar">
          <div>
            <div class="post-author">${authorDisplay}</div>
            <div class="post-time">${timeAgo}${pendingBadge}</div>
          </div>
        </div>
      </div>
      <div class="post-text">${escapeHtml(post.text)}</div>
      ${imageHtml}
      <div class="post-actions">
        <button class="post-action-btn" onclick="showCommentForm(${post.id})">💬 Comment</button>
        ${currentUser ? `<button class="post-action-btn delete" onclick="deletePost(${post.id})">🗑️ Delete</button>` : ''}
      </div>
      ${commentsHtml}
      <div class="comment-form" id="comment-form-${post.id}" style="display: none;">
        <input type="text" id="comment-input-${post.id}" placeholder="Write a comment...">
        <button onclick="addComment(${post.id})">Post</button>
      </div>
    </div>
  `;
}

// Render comment
function renderComment(comment) {
  const date = new Date(comment.timestamp);
  const timeAgo = getTimeAgo(date);
  const shortAddress = comment.author.substring(0, 8) + '...' + comment.author.substring(comment.author.length - 6);
  const avatar = generateAvatar(comment.author, 32);

  // Format: "Name (0xShort...Address)" or just "(0xShort...Address)" if no name
  const authorDisplay = comment.authorName
    ? `${escapeHtml(comment.authorName)} <span class="clickable-address" onclick="copyAddress('${comment.author}')" title="Click to copy full address">(${shortAddress})</span>`
    : `<span class="clickable-address" onclick="copyAddress('${comment.author}')" title="Click to copy full address">${shortAddress}</span>`;

  return `
    <div class="comment">
      <div class="comment-with-avatar">
        <img src="${avatar}" class="avatar avatar-small" alt="Avatar">
        <div class="comment-content">
          <div class="comment-header">
            <span class="comment-author">${authorDisplay}</span>
            <span class="comment-time">${timeAgo}</span>
          </div>
          <div class="comment-text">${escapeHtml(comment.text)}</div>
        </div>
      </div>
    </div>
  `;
}

// Copy address to clipboard
window.copyAddress = async function(address) {
  try {
    await navigator.clipboard.writeText(address);

    // Show brief confirmation
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

    setTimeout(() => {
      notification.remove();
    }, 2000);
  } catch (error) {
    console.error('[message-board] Failed to copy address:', error);
    alert('Failed to copy address');
  }
};

// Show comment form
window.showCommentForm = function(postId) {
  const form = document.getElementById(`comment-form-${postId}`);
  if (form) {
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
  }
};

// Add comment
window.addComment = async function(postId) {
  const input = document.getElementById(`comment-input-${postId}`);
  const text = input.value.trim();

  if (!text) return;

  try {
    // Add wallet address header for same-domain authentication
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
    }

    const response = await fetch(`/agent/epistery/message-board/api/posts/${postId}/comments`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to post comment');
      } else {
        throw new Error(`Failed to post comment (${response.status}). Please ensure you are authenticated.`);
      }
    }

    input.value = '';
    await loadPosts(); // Reload to show new comment
  } catch (error) {
    console.error('[message-board] Comment error:', error);
    showError(error.message);
  }
};

// Delete post
window.deletePost = async function(postId) {
  if (!confirm('Delete this post?')) return;

  try {
    // Add wallet address header for same-domain authentication
    const headers = {};
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
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
        throw new Error(`Failed to delete post (${response.status}). Please ensure you are authenticated.`);
      }
    }

    await loadPosts();
  } catch (error) {
    console.error('[message-board] Delete error:', error);
    showError(error.message);
  }
};

// Setup event listeners
function setupEventListeners() {
  const postButton = document.getElementById('post-button');
  const postText = document.getElementById('post-text');
  const imageInput = document.getElementById('image-input');
  const imagePreview = document.getElementById('image-preview');

  postButton.addEventListener('click', createPost);

  postText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      createPost();
    }
  });

  imageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Show loading state
    imagePreview.style.display = 'block';
    imagePreview.src = 'data:image/svg+xml;base64,' + btoa(`
      <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="100" fill="#f0f0f0"/>
        <text x="100" y="50" text-anchor="middle" font-family="Arial" font-size="14" fill="#666">
          Processing image...
        </text>
      </svg>
    `);

    try {
      // Validate and process image
      const processedImage = await processImage(file);
      imagePreview.src = processedImage;
      imagePreview.style.display = 'block';
    } catch (error) {
      console.error('[message-board] Image processing error:', error);
      showError(error.message);
      imageInput.value = ''; // Clear the input
      imagePreview.style.display = 'none';
    }
  });
}

// Process and normalize uploaded images
async function processImage(file) {
  // Fetch current image settings from server
  let settings = {
    maxUploadSize: 10,
    maxProcessedSize: 3,
    maxWidth: 1024,
    jpegQuality: 85,
    allowSvg: true
  };

  try {
    const response = await fetch('/agent/epistery/message-board/api/settings/image');
    if (response.ok) {
      settings = await response.json();
    }
  } catch (error) {
    console.warn('[message-board] Failed to fetch image settings, using defaults');
  }

  // 1. Validate file type
  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (settings.allowSvg) {
    validTypes.push('image/svg+xml');
  }

  if (!validTypes.includes(file.type)) {
    throw new Error('Invalid file type. Please upload a JPEG, PNG, GIF, WebP' + (settings.allowSvg ? ', or SVG' : '') + ' image.');
  }

  // 2. Check file size
  const maxSize = settings.maxUploadSize * 1024 * 1024;
  if (file.size > maxSize) {
    throw new Error(`File too large. Maximum size is ${settings.maxUploadSize}MB.`);
  }

  // 3. Handle SVG separately (no processing needed, just validate)
  if (file.type === 'image/svg+xml') {
    return await processSvgFile(file);
  }

  // 4. Load image
  const img = await loadImage(file);

  // 5. Resize if needed (use configured max width, maintain aspect ratio)
  const maxWidth = settings.maxWidth;
  let { width, height } = img;

  if (width > maxWidth) {
    const aspectRatio = height / width;
    width = maxWidth;
    height = Math.round(maxWidth * aspectRatio);
  }

  // 6. Draw to canvas (this strips EXIF data and normalizes format)
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Use white background for transparency (in case of PNG/GIF with transparency)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Draw image
  ctx.drawImage(img, 0, 0, width, height);

  // 7. Convert to JPEG with configured quality
  const quality = settings.jpegQuality / 100;
  const dataUrl = canvas.toDataURL('image/jpeg', quality);

  // 8. Validate output size (if still too large, reduce quality)
  const sizeInBytes = Math.round((dataUrl.length * 3) / 4);
  const maxProcessedSize = settings.maxProcessedSize * 1024 * 1024;
  if (sizeInBytes > maxProcessedSize) {
    // Reduce quality by 15%
    const reducedQuality = Math.max(0.5, quality - 0.15);
    return canvas.toDataURL('image/jpeg', reducedQuality);
  }

  return dataUrl;
}

// Process SVG file
async function processSvgFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const svgContent = e.target.result;

        // Basic client-side validation
        if (!svgContent.trim().startsWith('<svg')) {
          reject(new Error('Invalid SVG file'));
          return;
        }

        // Convert to data URL
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

// Helper: Load image from file
function loadImage(file) {
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

// Create new post
async function createPost() {
  const postText = document.getElementById('post-text');
  const imagePreview = document.getElementById('image-preview');
  const postButton = document.getElementById('post-button');

  const text = postText.value.trim();
  if (!text) return;

  postButton.disabled = true;
  postButton.textContent = 'Posting...';

  try {
    const body = {
      text,
      image: imagePreview.style.display !== 'none' ? imagePreview.src : null
    };

    // Add wallet address header for same-domain authentication
    const headers = { 'Content-Type': 'application/json' };
    if (currentUser && currentUser.address) {
      headers['X-Wallet-Address'] = currentUser.address;
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

        // Handle 403 - show request access option
        if (response.status === 403 && currentUser && currentUser.address) {
          showRequestAccessDialog(currentUser.address, error.error || 'You do not have permission to post');
          return;
        }

        throw new Error(error.error || 'Failed to post');
      } else {
        const text = await response.text();
        console.error('[message-board] Server response:', text);
        throw new Error(`Failed to post (${response.status}). ${text.substring(0, 100)}`);
      }
    }

    // Create optimistic post to show immediately
    const optimisticPost = {
      id: Date.now(), // temporary ID
      text,
      image: imagePreview.style.display !== 'none' ? imagePreview.src : null,
      author: currentUser.address,
      authorName: currentUser.name,
      timestamp: new Date().toISOString(),
      comments: [],
      pending: true // mark as pending confirmation
    };

    // Add to posts array at the beginning
    posts.unshift(optimisticPost);
    renderPosts();

    // Clear form
    postText.value = '';
    imagePreview.style.display = 'none';
    imagePreview.src = '';
    document.getElementById('image-input').value = '';

    // Reload posts to get the confirmed version
    setTimeout(() => loadPosts(), 2000);
  } catch (error) {
    console.error('[message-board] Post error:', error);
    showError(error.message);
  } finally {
    postButton.disabled = false;
    postButton.textContent = 'Post';
  }
}

// Connect WebSocket for real-time updates
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/agent/epistery/message-board/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[message-board] WebSocket connected');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onclose = () => {
    console.log('[message-board] WebSocket disconnected, reconnecting...');
    setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (error) => {
    console.error('[message-board] WebSocket error:', error);
  };
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  console.log('[message-board] WebSocket message:', message);

  switch (message.type) {
    case 'new-post':
      // Check if this post already exists (avoid duplicates)
      if (!posts.find(p => p.id === message.post.id)) {
        posts.unshift(message.post);
      }
      savePosts();
      renderPosts();
      break;

    case 'new-comment':
      const post = posts.find(p => p.id === message.postId);
      if (post) {
        // Check if comment already exists (avoid duplicates)
        if (!post.comments.find(c => c.id === message.comment.id)) {
          post.comments.push(message.comment);
        }
        savePosts();
        renderPosts();
      }
      break;

    case 'delete-post':
      posts = posts.filter(p => p.id !== message.postId);
      savePosts();
      renderPosts();
      break;
  }
}

// Show error message
function showError(message) {
  const container = document.getElementById('error-container');
  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  container.appendChild(errorEl);

  setTimeout(() => {
    errorEl.remove();
  }, 5000);
}

// Utility: Get time ago string
function getTimeAgo(date) {
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
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Generate avatar from address (deterministic)
function generateAvatar(address, size = 40) {
  // Create a deterministic color palette from the address
  const hash = address.toLowerCase();
  const seed = parseInt(hash.slice(2, 10), 16);

  // Generate colors from the hash
  const hue1 = (seed % 360);
  const hue2 = ((seed * 7) % 360);
  const saturation = 65 + ((seed % 20));
  const lightness = 45 + ((seed % 15));

  const color1 = `hsl(${hue1}, ${saturation}%, ${lightness}%)`;
  const color2 = `hsl(${hue2}, ${saturation}%, ${lightness + 10}%)`;

  // Create a simple geometric pattern
  const pattern = (seed % 4); // 4 different pattern types

  let svg = '';
  switch(pattern) {
    case 0: // Diagonal stripes
      svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${color1}"/>
        <path d="M0,0 L${size},${size} M${size/2},${-size/2} L${size*1.5},${size/2} M${-size/2},${size/2} L${size/2},${size*1.5}" stroke="${color2}" stroke-width="${size/4}"/>
      </svg>`;
      break;
    case 1: // Circles
      svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${color1}"/>
        <circle cx="${size/2}" cy="${size/2}" r="${size/3}" fill="${color2}"/>
        <circle cx="${size/2}" cy="${size/2}" r="${size/6}" fill="${color1}"/>
      </svg>`;
      break;
    case 2: // Triangles
      svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${color1}"/>
        <polygon points="${size/2},${size/6} ${size*5/6},${size*5/6} ${size/6},${size*5/6}" fill="${color2}"/>
      </svg>`;
      break;
    case 3: // Squares
      svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${color1}"/>
        <rect x="${size/4}" y="${size/4}" width="${size/2}" height="${size/2}" fill="${color2}" transform="rotate(45 ${size/2} ${size/2})"/>
      </svg>`;
      break;
  }

  return 'data:image/svg+xml;base64,' + btoa(svg);
}

// Show request access dialog
function showRequestAccessDialog(address, reason) {
  const container = document.getElementById('error-container');
  const dialog = document.createElement('div');
  dialog.className = 'error-message';
  dialog.style.cssText = 'padding: 20px; box-sizing: border-box;';
  dialog.innerHTML = `
    <div style="margin-bottom: 12px;">
      <strong>⚠️ Access Required</strong>
    </div>
    <p style="margin: 10px 0;">${escapeHtml(reason)}</p>
    <p style="margin: 10px 0; font-size: 14px; opacity: 0.9;">
      Your address: <code>${address.substring(0, 8)}...${address.substring(address.length - 6)}</code>
    </p>
    <div style="margin-top: 15px; display: flex; gap: 10px;">
      <button id="request-access-btn" style="padding: 8px 16px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
        Request Access
      </button>
      <button id="cancel-request-btn" style="padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">
        Cancel
      </button>
    </div>
  `;
  container.appendChild(dialog);

  document.getElementById('request-access-btn').addEventListener('click', async () => {
    try {
      await requestAccess(address, 'Requesting access to post on message board', '');
      dialog.innerHTML = `
        <div style="margin-bottom: 12px;">
          <strong>✓ Request Submitted</strong>
        </div>
        <p style="margin: 10px 0;">
          Your access request has been submitted to the domain administrators.
          You will be notified when your request is approved.
        </p>
      `;
      setTimeout(() => dialog.remove(), 5000);
    } catch (error) {
      showError('Failed to submit access request: ' + error.message);
      dialog.remove();
    }
  });

  document.getElementById('cancel-request-btn').addEventListener('click', () => {
    dialog.remove();
  });
}

// Request access from white-list agent
// Check if user has posting permission
async function checkPostingPermission(address) {
  try {
    // Make a test request to check permissions without actually posting
    const response = await fetch('/agent/epistery/message-board/api/check-permission', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wallet-Address': address
      },
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      if (!data.canPost) {
        // Wait for DOM to be ready
        const waitForElement = setInterval(() => {
          const container = document.getElementById('create-post');
          if (container) {
            clearInterval(waitForElement);
            showWelcomeBox(address);
          }
        }, 100);
      }
    }
  } catch (error) {
    console.log('[message-board] Permission check failed:', error);
  }
}

// Show guest access request form
function showGuestAccessRequest() {
  const container = document.getElementById('create-post');
  if (!container) {
    console.error('[message-board] create-post element not found');
    return;
  }
  container.innerHTML = `
    <div style="background: #f8f9fa; padding: 25px; border-radius: 12px; border: 2px solid #667eea; box-sizing: border-box;">
      <h3 style="margin: 0 0 10px 0; color: #333;">🔐 This site is open but requires users to request access.</h3>
      <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">
        Please provide your information to request access to post on this message board.
      </p>
      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; color: #333; font-size: 13px; font-weight: 500;">Your Name (optional)</label>
        <input
          type="text"
          id="guest-request-name"
          placeholder="e.g., John Smith"
          style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box;"
        >
      </div>
      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; color: #333; font-size: 13px; font-weight: 500;">Message (optional)</label>
        <textarea
          id="guest-request-message"
          placeholder="This is sent to the board admin"
          style="width: 100%; min-height: 80px; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical; box-sizing: border-box;"
        ></textarea>
      </div>
      <button
        onclick="submitGuestAccessRequest()"
        style="width: 100%; background: #667eea; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;"
      >
        Request Access
      </button>
    </div>
  `;
}

// Show welcome box for users without posting permission
function showWelcomeBox(address) {
  const container = document.getElementById('create-post');
  if (!container) {
    console.error('[message-board] create-post element not found');
    return;
  }
  container.innerHTML = `
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px; color: white; text-align: center; box-sizing: border-box;">
      <h2 style="margin: 0 0 15px 0; font-size: 24px;">Welcome to the Message Board! 👋</h2>
      <p style="margin: 0 0 20px 0; font-size: 16px; opacity: 0.95;">
        You're authenticated, but you'll need access to post messages.
      </p>
      <button
        onclick="showRequestAccessForm()"
        style="background: white; color: #667eea; border: none; padding: 12px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"
      >
        Request Access to Post
      </button>
    </div>
  `;
}

// Show request access form
window.showRequestAccessForm = function() {
  const container = document.getElementById('create-post');
  container.innerHTML = `
    <div style="background: #f8f9fa; padding: 25px; border-radius: 12px; border: 2px solid #667eea; box-sizing: border-box;">
      <h3 style="margin: 0 0 15px 0; color: #333;">Request Posting Access</h3>
      <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">
        Tell the administrators why you'd like to post on this message board.
      </p>
      <textarea
        id="access-request-message"
        placeholder="e.g., I'd like to contribute to discussions about..."
        style="width: 100%; min-height: 100px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical; box-sizing: border-box;"
      ></textarea>
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <button
          onclick="submitAccessRequest()"
          style="flex: 1; background: #667eea; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;"
        >
          Submit Request
        </button>
        <button
          onclick="showWelcomeBox('${currentUser.address}')"
          style="flex: 0 0 auto; background: #6c757d; color: white; border: none; padding: 12px 20px; border-radius: 8px; font-size: 16px; cursor: pointer;"
        >
          Cancel
        </button>
      </div>
    </div>
  `;
  document.getElementById('access-request-message').focus();
};

// Submit access request
window.submitAccessRequest = async function() {
  const messageInput = document.getElementById('access-request-message');
  const message = messageInput.value.trim();

  if (!message) {
    alert('Please provide a message explaining why you need access');
    return;
  }

  try {
    await requestAccess(currentUser.address, message, '');

    const container = document.getElementById('create-post');
    container.innerHTML = `
      <div style="background: #d4edda; padding: 25px; border-radius: 12px; border: 2px solid #28a745; text-align: center; box-sizing: border-box;">
        <h3 style="margin: 0 0 10px 0; color: #155724;">✓ Request Submitted!</h3>
        <p style="margin: 0; color: #155724; font-size: 14px;">
          Your access request has been sent to the administrators. You'll be able to post once they approve your request.
        </p>
      </div>
    `;
  } catch (error) {
    alert('Failed to submit request: ' + error.message);
  }
};

// Submit guest access request
window.submitGuestAccessRequest = async function() {
  const nameInput = document.getElementById('guest-request-name');
  const messageInput = document.getElementById('guest-request-message');
  const name = nameInput.value.trim();
  const message = messageInput.value.trim();

  try {
    // First, ensure wallet exists (auto-create if needed)
    console.log('[message-board] Ensuring wallet exists for guest request...');
    const WitnessModule = await import('/lib/witness.js');
    const Witness = WitnessModule.default;
    await Witness.connect();

    // Get the wallet address
    const data = localStorage.getItem('epistery');
    if (!data) {
      throw new Error('Failed to create wallet');
    }

    const parsed = JSON.parse(data);
    let wallet = parsed.wallets?.[0];
    if (wallet && wallet.wallet) {
      wallet = wallet.wallet;
    }

    if (!wallet || !wallet.address) {
      throw new Error('Failed to get wallet address');
    }

    const address = wallet.rivetAddress || wallet.address;
    console.log('[message-board] Guest address:', address);

    // Submit access request
    await requestAccess(address, message || 'Requesting access to post on message board', name);

    // Show success message
    const container = document.getElementById('create-post');
    container.innerHTML = `
      <div style="background: #d4edda; padding: 25px; border-radius: 12px; border: 2px solid #28a745; text-align: center; box-sizing: border-box;">
        <h3 style="margin: 0 0 10px 0; color: #155724;">✓ Request Submitted!</h3>
        <p style="margin: 0; color: #155724; font-size: 14px;">
          Your access request has been sent to the administrators. You'll be able to post once they approve your request.
        </p>
        ${address ? `<p style="margin-top: 10px; font-size: 12px; color: #155724; opacity: 0.8;">Your wallet address: ${address}</p>` : ''}
      </div>
    `;
  } catch (error) {
    console.error('[message-board] Guest access request error:', error);
    showError('Failed to submit request: ' + error.message);
  }
};

async function requestAccess(address, customMessage, customName) {
  const listName = 'epistery::editor';

  const response = await fetch('/agent/epistery/white-list/request-access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      address,
      listName,
      agentName: 'message-board',
      message: customMessage || 'Requesting access to post on message board',
      name: customName || ''
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Request failed');
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'Request failed');
  }

  return result;
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
