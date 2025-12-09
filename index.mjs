import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Message Board Agent
 *
 * Provides a discussion board / posting wall for epistery hosts.
 * Access control via white-list integration and notabot scores.
 * Posts are stored on IPFS as Data Wallets with user + server signatures.
 * Batching: 5 posts before paying gas to store on-chain.
 * This is the main entry point loaded by AgentManager.
 */
export default class MessageBoardAgent {
  constructor(config = {}) {
    this.config = config;
    this.epistery = null;
    this.wss = null;

    // Default configuration
    this.minNotabotPoints = config.minNotabotPoints || 10;
    this.postingList = config.postingList || 'message-board::posting';
    this.moderatorList = config.moderatorList || 'message-board::moderators';

    // IPFS & batching configuration
    this.batchThreshold = config.batchThreshold || 5; // Posts before on-chain flush
    this.ipfsUrl = null; // Will be set when epistery instance is available
    this.ipfsGateway = null;

    // Batch chain for posts (Proof of Stake - server earns right to batch)
    this.postChain = [];
    this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

    // Data storage - domain-specific paths set per-request
    this.dataDir = path.join(__dirname, 'data');

    // Per-domain state (keyed by domain)
    this.domainStates = new Map();
  }

  /**
   * Get domain-specific file paths and initialize if needed
   */
  getDomainFiles(domain) {
    const domainDir = path.join(this.dataDir, domain);
    const postsFile = path.join(domainDir, 'posts.json');
    const batchFile = path.join(domainDir, 'batch.json');

    // Ensure domain directory exists
    if (!existsSync(domainDir)) {
      mkdirSync(domainDir, { recursive: true });
    }

    // Initialize posts file
    if (!existsSync(postsFile)) {
      writeFileSync(postsFile, JSON.stringify({ posts: [], nextId: 1 }));
    }

    // Initialize batch file
    if (!existsSync(batchFile)) {
      writeFileSync(batchFile, JSON.stringify({
        chain: [],
        lastHash: this.lastHash,
        lastFlush: Date.now()
      }));
    }

    return { postsFile, batchFile, domainDir };
  }

  /**
   * Get or initialize domain state
   */
  getDomainState(domain) {
    if (!this.domainStates.has(domain)) {
      const { batchFile } = this.getDomainFiles(domain);
      const batchData = JSON.parse(readFileSync(batchFile, 'utf8'));
      this.domainStates.set(domain, {
        postChain: batchData.chain || [],
        lastHash: batchData.lastHash || this.lastHash
      });
    }
    return this.domainStates.get(domain);
  }

  /**
   * Attach the agent to an Express router
   * Called by AgentManager after instantiation
   *
   * @param {express.Router} router - Express router instance
   */
  attach(router) {
    // Store epistery instance and domain from app.locals
    router.use((req, res, next) => {
      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;

        // Initialize IPFS configuration from epistery-host
        if (!this.ipfsUrl) {
          this.ipfsUrl = process.env.IPFS_URL || 'https://rootz.digital/api/v0';
          this.ipfsGateway = process.env.IPFS_GATEWAY || 'https://rootz.digital';
          console.log('[message-board] IPFS configured:', this.ipfsUrl);
        }
      }

      // Store domain in request for domain-specific data access
      req.domain = req.hostname || 'localhost';
      next();
    });

    // Redirect root to board
    router.get('/', (req, res) => {
      res.redirect(req.baseUrl + '/board');
    });

    // Serve static files
    router.use('/static', express.static(path.join(__dirname, 'public')));

    // Serve icon
    router.get('/icon.svg', (req, res) => {
      const iconPath = path.join(__dirname, 'icon.svg');
      if (!existsSync(iconPath)) {
        return res.status(404).send('Icon not found');
      }
      res.set('Content-Type', 'image/svg+xml');
      res.sendFile(iconPath);
    });

    // Serve widget (for agent box)
    router.get('/widget', (req, res) => {
      const widgetPath = path.join(__dirname, 'client/widget.html');
      if (!existsSync(widgetPath)) {
        return res.status(404).send('Widget not found');
      }
      res.sendFile(widgetPath);
    });

    // Serve admin page
    router.get('/admin', (req, res) => {
      const adminPath = path.join(__dirname, 'client/admin.html');
      if (!existsSync(adminPath)) {
        return res.status(404).send('Admin page not found');
      }
      res.sendFile(adminPath);
    });

    // Serve board page (main UI)
    router.get('/board', (req, res) => {
      const boardPath = path.join(__dirname, 'client/board.html');
      if (!existsSync(boardPath)) {
        return res.status(404).send('Board page not found');
      }
      res.sendFile(boardPath);
    });

    // API Routes

    // Health check
    router.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        agent: 'message-board',
        version: '1.0.0',
        config: {
          minNotabotPoints: this.minNotabotPoints,
          postingList: this.postingList,
          moderatorList: this.moderatorList
        }
      });
    });

    // Get all posts (public, read-only)
    router.get('/api/posts', (req, res) => {
      try {
        const data = this.readData(req.domain);
        res.json(data.posts);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Create new post (requires auth + permission)
    router.post('/api/posts', async (req, res) => {
      try {
        console.log('[message-board] Received post request');

        const { text, image } = req.body;

        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        // Check posting permission
        console.log('[message-board] Checking posting permission...');
        const permission = await this.checkPostingPermission(req);
        console.log('[message-board] Permission result:', permission);

        if (!permission.allowed) {
          return res.status(403).json({
            error: permission.reason,
            requiresNotabotPoints: this.minNotabotPoints
          });
        }

        const data = this.readData(req.domain);
        const post = {
          id: data.nextId++,
          text: text.trim(),
          image: image || null,
          author: permission.user.address,
          authorName: permission.user.name || null,
          timestamp: Date.now(),
          comments: []
        };

        // Add to local storage
        data.posts.unshift(post);
        this.writeData(req.domain, data);

        // Add to IPFS batch chain (invisible to user)
        // This creates Data Wallet: user owns content with cryptographic proof
        try {
          const chainedPost = await this.addPostToBatch(post, null); // TODO: Get user signature from client
          if (chainedPost.ipfsHash) {
            console.log(`[message-board] Post ${post.id} stored as Data Wallet: ${chainedPost.ipfsUrl}`);
          }
        } catch (error) {
          console.error('[message-board] IPFS batching error (non-fatal):', error);
          // Continue even if IPFS fails - local storage succeeded
        }

        this.broadcast({ type: 'new-post', post });
        res.json(post);
      } catch (error) {
        console.error('[message-board] Post error:', error);
        console.error('[message-board] Stack trace:', error.stack);
        res.status(500).json({ error: error.message });
      }
    });

    // Check if user has posting permission (without actually posting)
    router.post('/api/check-permission', async (req, res) => {
      try {
        const permission = await this.checkPostingPermission(req);
        res.json({
          canPost: permission.allowed,
          reason: permission.reason,
          user: permission.user
        });
      } catch (error) {
        console.error('[message-board] Permission check error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Add comment to post (requires auth + permission)
    router.post('/api/posts/:id/comments', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);
        const { text } = req.body;

        if (!text || text.trim().length === 0) {
          return res.status(400).json({ error: 'Text is required' });
        }

        // Check posting permission
        const permission = await this.checkPostingPermission(req);
        if (!permission.allowed) {
          return res.status(403).json({
            error: permission.reason,
            requiresNotabotPoints: this.minNotabotPoints
          });
        }

        const data = this.readData(req.domain);
        const post = data.posts.find(p => p.id === postId);

        if (!post) {
          return res.status(404).json({ error: 'Post not found' });
        }

        const comment = {
          id: Date.now(),
          text: text.trim(),
          author: permission.user.address,
          authorName: permission.user.name || null,
          timestamp: Date.now()
        };

        post.comments.push(comment);
        this.writeData(req.domain, data);

        this.broadcast({ type: 'new-comment', postId, comment });
        res.json(comment);
      } catch (error) {
        console.error('[message-board] Comment error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Delete post (moderators only)
    router.delete('/api/posts/:id', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);

        // Check if user is a moderator
        const isModerator = await this.checkModeratorPermission(req);
        if (!isModerator) {
          return res.status(403).json({ error: 'Moderator access required' });
        }

        const data = this.readData(req.domain);
        const index = data.posts.findIndex(p => p.id === postId);

        if (index === -1) {
          return res.status(404).json({ error: 'Post not found' });
        }

        data.posts.splice(index, 1);
        this.writeData(req.domain, data);

        this.broadcast({ type: 'delete-post', postId });
        res.json({ success: true });
      } catch (error) {
        console.error('[message-board] Delete error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Status endpoint
    router.get('/status', (req, res) => {
      const data = this.readData(req.domain);
      res.json({
        agent: 'message-board',
        version: '1.0.0',
        postCount: data.posts.length,
        config: this.config
      });
    });

    console.log('[message-board] Agent routes attached');
  }

  /**
   * Check if user has permission to post
   * Hierarchy: Global Admin > Domain Admin > Posting Whitelist > Notabot Points
   * NOTE: Authentication not implemented - delegation removed
   */
  async checkPostingPermission(req) {
    // Try same-domain authentication
    const sameDomainAuth = await this.verifySameDomainAuth(req);
    let address, verification;

    if (sameDomainAuth.valid) {
      address = sameDomainAuth.address;
      verification = sameDomainAuth;
      console.log(`[message-board] Using same-domain auth for ${address}`);
    } else {
      console.log('[message-board] No valid authentication - delegation removed');
      return { allowed: false, reason: 'Authentication not implemented' };
    }

    // Check permission hierarchy
    if (this.epistery) {
      try {
        // 1. Check if global admin (highest privilege)
        console.log(`[message-board] Checking global admin for ${address}`);
        const isGlobalAdmin = await this.epistery.isListed(address, 'epistery::admin');
        console.log(`[message-board] Global admin check result:`, isGlobalAdmin);

        if (isGlobalAdmin) {
          const userName = await this.getUserName(req, address, 'epistery::admin');
          console.log(`[message-board] User ${address} allowed as global admin (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'global-admin'
          };
        }

        // 2. Check if domain admin
        // Format: {resource}::{role}
        const domainAdminList = `${verification.domain}::admin`;
        console.log(`[message-board] Checking domain admin for ${address} on list ${domainAdminList}`);
        const isDomainAdmin = await this.epistery.isListed(address, domainAdminList);
        console.log(`[message-board] Domain admin check result:`, isDomainAdmin);

        if (isDomainAdmin) {
          // Fetch user's display name from white-list
          const userName = await this.getUserName(req, address, domainAdminList);
          console.log(`[message-board] User ${address} allowed as domain admin (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'domain-admin'
          };
        }

        // 3. Check if on posting whitelist
        console.log(`[message-board] Checking posting whitelist for ${address} on list ${this.postingList}`);
        const isOnPostingList = await this.epistery.isListed(address, this.postingList);
        console.log(`[message-board] Posting whitelist check result:`, isOnPostingList);

        if (isOnPostingList) {
          const userName = await this.getUserName(req, address, this.postingList);
          console.log(`[message-board] User ${address} allowed via posting whitelist (name: ${userName})`);
          return {
            allowed: true,
            user: { address, name: userName || verification.name },
            method: 'posting-whitelist'
          };
        }
      } catch (error) {
        console.error('[message-board] Permission check failed:', error);
        console.error('[message-board] Error stack:', error.stack);
      }
    } else {
      console.warn('[message-board] Epistery instance not available, allowing all authenticated users');
      // If epistery not available (development mode), allow all authenticated users
      return {
        allowed: true,
        user: { address, name: verification.name },
        method: 'dev-mode'
      };
    }

    // 4. Default: Allow all authenticated users (simplified for v1.0)
    // Notabot points are collected but not enforced - agents can add their own rules later
    console.log(`[message-board] User ${address} allowed as authenticated user`);
    return {
      allowed: true,
      user: { address, name: verification.name },
      method: 'authenticated'
    };
  }

  /**
   * Get user's display name from white-list
   */
  async getUserName(req, address, listName) {
    if (!this.epistery) {
      return null;
    }

    try {
      // Query the white-list agent API for members of this list
      const url = `http://localhost:${process.env.PORT || 4080}/agent/epistery/white-list/list?list=${encodeURIComponent(listName)}`;
      console.log(`[message-board] Fetching user name from: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        console.error(`[message-board] Failed to fetch members from ${listName}: ${response.status}`);
        return null;
      }

      const data = await response.json();
      console.log(`[message-board] Received ${data.count} members from ${listName}`);

      // If there are multiple entries for the same address, prefer the one with a non-empty name
      const members = data.list.filter(m => m && m.address && m.address.toLowerCase() === address.toLowerCase());
      const member = members.find(m => m.name && m.name.trim() !== '') || members[0];

      console.log(`[message-board] Found member for ${address}:`, member);

      return member?.name || null;
    } catch (error) {
      console.error(`[message-board] Error fetching user name from white-list:`, error);
      return null;
    }
  }

  /**
   * Check if user is a moderator
   */
  async checkModeratorPermission(req) {
    const verification = await this.verifyDelegationToken(req);

    if (!verification.valid) {
      return false;
    }

    if (!this.epistery) {
      return false;
    }

    try {
      const isModerator = await this.epistery.isListed(verification.rivetAddress, this.moderatorList);
      return isModerator;
    } catch (error) {
      console.error('[message-board] Moderator check failed:', error);
      return false;
    }
  }

  /**
   * Verify delegation token from request
   */
  /**
   * Verify same-domain authentication (user's wallet address from header)
   * For same-domain scenarios, we trust the address if user is domain admin
   */
  async verifySameDomainAuth(req) {
    try {
      console.log('[message-board] verifySameDomainAuth - all headers:', req.headers);
      const address = req.headers['x-wallet-address'];

      if (!address) {
        console.log('[message-board] verifySameDomainAuth - no wallet address header found');
        return { valid: false, error: 'No wallet address provided' };
      }

      console.log('[message-board] verifySameDomainAuth - checking address:', address);

      // Verify this address is on domain admin white-list
      // Format: {resource}::{role} where resource is domain name, role is access level
      if (this.epistery) {
        const isDomainAdmin = await this.isListedCaseInsensitive(address, `${req.domain}::admin`);
        if (isDomainAdmin) {
          console.log('[message-board] Same-domain auth successful for domain admin');
          return { valid: true, address, isDomainAdmin: true };
        }

        const isGlobalAdmin = await this.isListedCaseInsensitive(address, 'epistery::admin');
        if (isGlobalAdmin) {
          console.log('[message-board] Same-domain auth successful for global admin');
          return { valid: true, address, isGlobalAdmin: true };
        }
      }

      console.log('[message-board] Same-domain auth failed - not an admin');
      return { valid: false, error: 'Not authorized' };
    } catch (error) {
      console.error('[message-board] Same-domain auth error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Case-insensitive whitelist check
   * Ethereum addresses are case-insensitive but string comparison is not
   */
  async isListedCaseInsensitive(address, listName) {
    const list = await this.epistery.getList(listName);
    const addressLower = address.toLowerCase();
    return list.some(entry => entry.addr.toLowerCase() === addressLower);
  }

  /**
   * Authentication not implemented - delegation tokens removed
   * TODO: Implement direct rivet authentication
   */
  async verifyDelegationToken(req) {
    console.log('[message-board] Authentication not implemented - delegation removed');
    return { valid: false, error: 'Authentication not implemented' };
  }

  /**
   * Read posts data from domain-specific file
   */
  readData(domain) {
    const { postsFile } = this.getDomainFiles(domain);
    return JSON.parse(readFileSync(postsFile, 'utf8'));
  }

  /**
   * Write posts data to domain-specific file
   */
  writeData(domain, data) {
    const { postsFile } = this.getDomainFiles(domain);
    writeFileSync(postsFile, JSON.stringify(data, null, 2));
  }

  /**
   * Broadcast message to all WebSocket clients
   */
  broadcast(message) {
    if (!this.wss) return;

    this.wss.clients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Initialize WebSocket server
   * @param {http.Server} server - HTTP server instance
   */
  initWebSocket(server) {
    this.wss = new WebSocketServer({ server, path: '/agent/epistery/message-board/ws' });

    this.wss.on('connection', (ws) => {
      console.log('[message-board] WebSocket client connected');

      ws.on('close', () => {
        console.log('[message-board] WebSocket client disconnected');
      });
    });

    console.log('[message-board] WebSocket server initialized');
  }

  /**
   * Create hash of post data for chain
   */
  hashPost(post) {
    const data = JSON.stringify({
      ...post,
      previousHash: this.lastHash
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Sign data with server wallet
   */
  async signPostAsServer(postData) {
    if (!this.epistery || !this.epistery.domain?.wallet) {
      console.warn('[message-board] Server wallet not available for signing');
      return null;
    }

    try {
      const dataHash = crypto.createHash('sha256').update(JSON.stringify(postData)).digest('hex');
      // TODO: Implement actual signature with server wallet private key
      // For now, return a placeholder signature
      return {
        hash: dataHash,
        signature: '0x...' // Placeholder
      };
    } catch (error) {
      console.error('[message-board] Server signing failed:', error);
      return null;
    }
  }

  /**
   * Upload data to IPFS
   */
  async uploadToIPFS(data) {
    if (!this.ipfsUrl) {
      console.warn('[message-board] IPFS URL not configured, skipping IPFS upload');
      return null;
    }

    try {
      const formData = new FormData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      formData.append('file', blob, 'post.json');

      const response = await fetch(`${this.ipfsUrl}/add`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        console.error(`[message-board] IPFS upload failed with status: ${response.status}`);
        return null;
      }

      const result = await response.json();
      const ipfsHash = result.Hash;
      console.log(`[message-board] Uploaded to IPFS: ${ipfsHash}`);

      return {
        hash: ipfsHash,
        url: `${this.ipfsGateway}/ipfs/${ipfsHash}`
      };
    } catch (error) {
      console.error('[message-board] IPFS upload error:', error);
      return null;
    }
  }

  /**
   * Add post to batch chain
   * Returns the chained post data
   */
  async addPostToBatch(post, userSignature) {
    // Create hash chain entry
    const hash = this.hashPost(post);
    const chainedPost = {
      ...post,
      hash: hash,
      previousHash: this.lastHash,
      chainIndex: this.postChain.length,
      userSignature: userSignature
    };

    // Sign with server
    const serverSig = await this.signPostAsServer(chainedPost);

    // Create Data Wallet structure
    const dataWallet = {
      data: {
        id: post.id,
        text: post.text,
        image: post.image,
        timestamp: post.timestamp
      },
      author: {
        address: post.author,
        name: post.authorName,
        signature: userSignature || 'client-side-signature-pending'
      },
      server: {
        address: this.epistery?.domain?.wallet?.address || 'server-wallet-pending',
        domain: this.epistery?.domainName || 'localhost',
        signature: serverSig
      },
      chain: {
        hash: hash,
        previousHash: this.lastHash,
        index: this.postChain.length
      },
      timestamp: new Date().toISOString()
    };

    // Upload to IPFS
    const ipfsResult = await this.uploadToIPFS(dataWallet);
    if (ipfsResult) {
      dataWallet.ipfsHash = ipfsResult.hash;
      dataWallet.ipfsUrl = ipfsResult.url;
      chainedPost.ipfsHash = ipfsResult.hash;
      chainedPost.ipfsUrl = ipfsResult.url;
    }

    // Add to chain
    this.postChain.push(chainedPost);
    this.lastHash = hash;

    // Save batch state
    this.saveBatchState();

    console.log(`[message-board] Post added to batch chain. Total: ${this.postChain.length}/${this.batchThreshold}`);

    // Check if we need to flush to blockchain
    if (this.postChain.length >= this.batchThreshold) {
      await this.flushBatch();
    }

    return chainedPost;
  }

  /**
   * Flush batched posts to blockchain
   */
  async flushBatch() {
    if (this.postChain.length === 0) {
      console.log('[message-board] No posts to flush');
      return;
    }

    console.log(`[message-board] Flushing ${this.postChain.length} posts to blockchain...`);

    try {
      // Create batch summary
      const batchSummary = {
        posts: this.postChain.map(p => ({
          id: p.id,
          hash: p.hash,
          ipfsHash: p.ipfsHash,
          author: p.author,
          timestamp: p.timestamp
        })),
        chainRoot: this.lastHash,
        count: this.postChain.length,
        timestamp: Date.now()
      };

      // Upload batch summary to IPFS
      const batchIpfs = await this.uploadToIPFS(batchSummary);

      if (batchIpfs) {
        console.log(`[message-board] Batch summary uploaded to IPFS: ${batchIpfs.hash}`);

        // TODO: Write batch IPFS hash to blockchain
        // await this.epistery.writeToContract(batchIpfs.hash);
        console.log('[message-board] TODO: Write batch to blockchain (gas payment)');
      }

      // Clear batch
      this.postChain = [];
      this.lastHash = crypto.createHash('sha256').update(this.lastHash).digest('hex');
      this.saveBatchState();

      console.log('[message-board] Batch flush complete');
    } catch (error) {
      console.error('[message-board] Batch flush error:', error);
    }
  }

  /**
   * Save batch state to file
   */
  saveBatchState() {
    const batchData = {
      chain: this.postChain,
      lastHash: this.lastHash,
      lastFlush: Date.now()
    };
    writeFileSync(this.batchFile, JSON.stringify(batchData, null, 2));
  }

  /**
   * Cleanup on shutdown (optional)
   */
  async cleanup() {
    // Flush any pending posts
    if (this.postChain.length > 0) {
      console.log('[message-board] Flushing pending posts on shutdown...');
      await this.flushBatch();
    }

    if (this.wss) {
      this.wss.close();
    }
    console.log('[message-board] Agent cleanup');
  }
}
