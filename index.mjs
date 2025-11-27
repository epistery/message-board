import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, optionalAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const POSTS_FILE = join(DATA_DIR, 'posts.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize data file
if (!existsSync(POSTS_FILE)) {
  writeFileSync(POSTS_FILE, JSON.stringify({ posts: [], nextId: 1 }));
}

const app = express();
const index = createServer(app);
const wss = new WebSocketServer({ server: index });

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Simple flat-file database operations
function readData() {
  return JSON.parse(readFileSync(POSTS_FILE, 'utf8'));
}

function writeData(data) {
  writeFileSync(POSTS_FILE, JSON.stringify(data, null, 2));
}

function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(JSON.stringify(message));
    }
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    episteryAgentUrl: process.env.EPISTERY_AGENT_URL || 'http://localhost:4080/agent/epistery/white-list'
  });
});

// Get all posts
app.get('/api/posts', (req, res) => {
  const data = readData();
  res.json(data.posts);
});

// Create new post
app.post('/api/posts', requireAuth, (req, res) => {
  const { text, image } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const data = readData();
  const post = {
    id: data.nextId++,
    text: text.trim(),
    image: image || null,
    author: req.user.id,
    timestamp: Date.now(),
    comments: []
  };

  data.posts.unshift(post);
  writeData(data);

  broadcast({ type: 'new-post', post });
  res.json(post);
});

// Add comment to post
app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = parseInt(req.params.id);
  const { text } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Text is required' });
  }

  const data = readData();
  const post = data.posts.find(p => p.id === postId);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const comment = {
    id: Date.now(),
    text: text.trim(),
    author: req.user.id,
    timestamp: Date.now()
  };

  post.comments.push(comment);
  writeData(data);

  broadcast({ type: 'new-comment', postId, comment });
  res.json(comment);
});

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
index.listen(PORT, () => {
  console.log(`Message board running on http://localhost:${PORT}`);
});
