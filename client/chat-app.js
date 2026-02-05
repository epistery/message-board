// Chat view for Message Board
import { MessageBoardCommon } from './message-board-common.mjs';

const mb = new MessageBoardCommon();
let currentImageDataUrl = null;
let currentChannel = null;
let channels = [];

// Initialize
async function init() {
  console.log('[chat] Initializing...');

  await mb.init();

  // Set up callback for post updates
  mb.onPostsUpdated = renderMessages;

  // Load channels
  await loadChannels();

  // Handle hash-based channel selection
  handleHashChange();
  window.addEventListener('hashchange', handleHashChange);

  // Setup event listeners
  setupEventListeners();

  // Initial render
  renderMessages();
  scrollToBottom();

  // Hide input if no edit permission
  if (!mb.permissions || !mb.permissions.edit) {
    hideInput();
  }

  console.log('[chat] Ready');
}

// Load channels
async function loadChannels() {
  try {
    const response = await fetch('/agent/epistery/message-board/api/channels');
    if (response.ok) {
      channels = await response.json();
      console.log('[chat] Loaded channels:', channels);

      // Default to "general" channel if no channel selected
      if (!currentChannel && channels.length > 0) {
        currentChannel = 'general';
        mb.currentChannel = 'general';
      }

      renderChannels();
    }
  } catch (error) {
    console.error('[chat] Failed to load channels:', error);
  }
}

// Render channels in sidebar
function renderChannels() {
  const container = document.getElementById('channels-list');
  if (!container) return;

  if (channels.length === 0) {
    container.innerHTML = '<li style="padding: var(--spacer); color: var(--text-color-quiet); font-size: 0.875em;">No channels</li>';
    return;
  }

  container.innerHTML = channels.map(channel => `
    <li class="sidebar-link">
      <a href="#" class="${currentChannel === channel.name ? 'active' : ''}" onclick="window.selectChannel('${channel.name}'); return false;">
        # ${escapeHtml(channel.name)}
      </a>
    </li>
  `).join('');

  // Update header
  const header = document.querySelector('.chat-header h1');
  if (header) {
    header.textContent = currentChannel ? `# ${currentChannel}` : '# general';
  }

  // Update input placeholder
  const input = document.getElementById('message-input');
  if (input) {
    input.placeholder = `Message #${currentChannel || 'general'}`;
  }
}

// Handle hash change for channel selection
function handleHashChange() {
  const hash = window.location.hash.slice(1); // Remove #
  const channelName = hash || 'general';

  // Only select if it's a valid channel
  const channelExists = channels.find(ch => ch.name === channelName);
  if (channelExists || channelName === 'general') {
    selectChannel(channelName);
  }
}

// Select channel
window.selectChannel = async function(channelName) {
  currentChannel = channelName;

  // Update URL hash (no hash for general)
  if (channelName === 'general') {
    if (window.location.hash) {
      history.pushState(null, '', window.location.pathname);
    }
  } else {
    window.location.hash = channelName;
  }

  renderChannels();

  // Reload posts for this channel
  mb.currentChannel = channelName;
  await mb.loadPosts();
  renderMessages();
  scrollToBottom();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Setup event listeners
function setupEventListeners() {
  const sendButton = document.getElementById('send-button');
  const messageInput = document.getElementById('message-input');
  const imageInput = document.getElementById('image-input');
  const imagePreview = document.getElementById('image-preview');

  if (sendButton) {
    sendButton.addEventListener('click', sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  if (imageInput) {
    imageInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const previewContainer = document.getElementById('image-preview-container');
      if (previewContainer) {
        previewContainer.style.display = 'block';
      }

      imagePreview.src = 'data:image/svg+xml;base64,' + btoa(`
        <svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
          <rect width="200" height="100" fill="#f0f0f0"/>
          <text x="100" y="50" text-anchor="middle" font-family="Arial" font-size="14" fill="#666">
            Processing...
          </text>
        </svg>
      `);

      try {
        currentImageDataUrl = await mb.processImage(file);
        imagePreview.src = currentImageDataUrl;
      } catch (error) {
        console.error('[chat] Image processing error:', error);
        showError(error.message);
        imageInput.value = '';
        if (previewContainer) {
          previewContainer.style.display = 'none';
        }
        currentImageDataUrl = null;
      }
    });
  }
}

// Send message
async function sendMessage() {
  const messageInput = document.getElementById('message-input');
  const sendButton = document.getElementById('send-button');
  const imageInput = document.getElementById('image-input');
  const previewContainer = document.getElementById('image-preview-container');

  const text = messageInput.value.trim();
  if (!text) return;

  sendButton.disabled = true;
  sendButton.textContent = 'Sending...';

  try {
    await mb.createPost(text, currentImageDataUrl, currentChannel);

    messageInput.value = '';
    messageInput.style.height = 'auto';
    imageInput.value = '';
    if (previewContainer) {
      previewContainer.style.display = 'none';
    }
    currentImageDataUrl = null;

    // Wait for posts to be updated, then render and scroll
    setTimeout(() => {
      renderMessages();
      scrollToBottom();
    }, 100);
  } catch (error) {
    console.error('[chat] Send error:', error);
    showError(error.message);
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'Send';
  }
}

// Render messages
function renderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (mb.posts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <p>No messages yet. Start the conversation!</p>
      </div>
    `;
    return;
  }

  // Render in reverse order (oldest first for chat view)
  const messages = [...mb.posts].reverse();
  container.innerHTML = messages.map(post => renderMessage(post)).join('');
}

// Render single message
function renderMessage(post) {
  const date = new Date(post.timestamp);
  const timeAgo = mb.getTimeAgo(date);
  const shortAddress = post.author.substring(0, 8) + '...' + post.author.substring(post.author.length - 6);
  const avatar = mb.generateAvatar(post.author, 36);

  const authorDisplay = post.authorName || shortAddress;

  const imageHtml = post.image
    ? `<img src="${post.image}" class="message-image" alt="Attached image">`
    : '';

  const canDelete = mb.currentUser &&
    (mb.currentUser.address.toLowerCase() === post.author.toLowerCase() || mb.permissions.admin);

  return `
    <div class="message" data-message-id="${post.id}">
      <img src="${avatar}" class="message-avatar" alt="Avatar">
      <div class="message-content">
        <div class="message-header">
          <span class="message-author">${mb.escapeHtml(authorDisplay)}</span>
          <span class="clickable-address" onclick="window.copyAddress('${post.author}')" title="${post.author}">${shortAddress}</span>
          <span class="message-time">${timeAgo}</span>
        </div>
        <div class="message-text">${mb.markup ? mb.markup.render(post.text) : mb.escapeHtml(post.text)}</div>
        ${imageHtml}
        ${canDelete ? `
          <div class="message-actions">
            <button class="message-action-btn" onclick="window.deleteMessage(${post.id})">Delete</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// Delete message
window.deleteMessage = async function(postId) {
  if (!confirm('Delete this message?')) return;

  try {
    await mb.deletePost(postId);
    renderMessages();
  } catch (error) {
    console.error('[chat] Delete error:', error);
    showError(error.message);
  }
};

// Copy address
window.copyAddress = async function(address) {
  await mb.copyAddress(address);
};

// Show error
function showError(message) {
  const container = document.getElementById('error-container');
  if (!container) return;

  const errorEl = document.createElement('div');
  errorEl.className = 'error-message';
  errorEl.textContent = message;
  container.appendChild(errorEl);

  setTimeout(() => errorEl.remove(), 5000);
}

// Hide input for users without permission
function hideInput() {
  const inputContainer = document.getElementById('chat-input-container');
  if (inputContainer) {
    inputContainer.style.display = 'none';
  }
}

// Scroll to bottom
function scrollToBottom() {
  const messagesContainer = document.getElementById('chat-messages');
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
