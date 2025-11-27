# Message Board

Simple message board demonstrating epistery white-list agent integration.

## Features

- Single-channel message board with text posts and images
- Flat comments (no nesting)
- Real-time updates via WebSocket
- Service worker for offline sync
- Optional authentication via epistery white-list agent

## Setup

```bash
cd message-board
npm install
npm start
```

Server runs on http://localhost:3000

## Authentication

Uses epistery white-list agent in **passive mode**:
- Page loads without authentication required
- Users can optionally sign in for identity attribution
- White-list agent client.js loaded from http://localhost:4080

### Environment Variables

```bash
EPISTERY_AGENT_URL=http://localhost:4080/agent/white-list  # default
PORT=3000  # default
```

## Architecture

- **Server**: Node.js + Express + WebSocket
- **Database**: Flat-file JSON (`./data/posts.json`)
- **Client**: Vanilla JS with service worker (no frameworks)
- **Auth**: Epistery white-list agent client.js handles delegation tokens

## How It Works

1. Client loads white-list agent client.js from epistery-host
2. Agent checks for existing delegation tokens
3. User can click "Sign In" to request delegation
4. Delegation flow redirects to epistery subdomain for approval
5. Posts/comments include delegation token in `X-Epistery-Delegation` header
6. Server verifies tokens with white-list agent `/check` endpoint

## Dependencies

Minimal:
- `express` - HTTP server
- `ws` - WebSocket server
