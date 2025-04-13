# FilePizza SDK

The FilePizza SDK provides browser-to-browser file transfer capabilities using WebRTC. It allows you to integrate peer-to-peer file sharing functionality into your web applications.

## Features

- Direct browser-to-browser file transfers (no server storage)
- Password protection for transfers
- Support for single and multiple file transfers
- Progress tracking and event notifications
- Works in modern browsers that support WebRTC

## Installation

```bash
npm install @filepizza/sdk
```

## Usage

### Setting up the Server

The SDK requires a minimal server implementation to coordinate connections between peers. You need to set up the following API endpoints:

1. Channel creation
2. Channel renewal
3. Channel destruction
4. ICE STUN/TURN server configuration

Here's an example using Next.js API routes:

```typescript
// app/api/create/route.ts
import { NextResponse } from 'next/server'
import { serverComponents } from '@filepizza/sdk'

// Create a channel repository
const channelRepo = process.env.REDIS_URL
  ? serverComponents.channels.createRedisRepo(process.env.REDIS_URL)
  : serverComponents.channels.createMemoryRepo()

export async function POST(request: Request): Promise<NextResponse> {
  const { uploaderPeerID } = await request.json()

  if (!uploaderPeerID) {
    return NextResponse.json(
      { error: 'Uploader peer ID is required' },
      { status: 400 },
    )
  }

  const channel = await channelRepo.createChannel(uploaderPeerID)
  return NextResponse.json(channel)
}
```

```typescript
// app/api/ice/route.ts
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { serverComponents } from '@filepizza/sdk'

const turnHost = process.env.TURN_HOST || '127.0.0.1'

export async function POST(): Promise<NextResponse> {
  if (!process.env.COTURN_ENABLED) {
    return NextResponse.json({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
  }

  // Generate ephemeral credentials
  const username = crypto.randomBytes(8).toString('hex')
  const password = crypto.randomBytes(8).toString('hex')
  const ttl = 86400 // 24 hours

  // Store credentials in Redis
  await serverComponents.coturn.setCredentials(username, password, ttl)

  return NextResponse.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [`turn:${turnHost}:3478`, `turns:${turnHost}:5349`],
        username,
        credential: password,
      },
    ],
  })
}
```

### Uploader Usage

```javascript
import { Uploader } from '@filepizza/sdk';

// Create an uploader instance
const uploader = new Uploader({
  serverUrl: 'https://your-app-domain.com',
  password: 'optional-password' // Add password if needed
});

// Initialize and set up files
await uploader.initialize();
uploader.setFiles(fileList); // From file input or drag-and-drop

// Get shareable links
const links = uploader.getShareableLinks();
console.log('Share this link:', links.short);

// Listen for events
uploader.on('connection', (connectionInfo) => {
  console.log('New downloader connected:', connectionInfo);
});

uploader.on('progress', (progressInfo) => {
  console.log('Upload progress:', progressInfo.overallProgress * 100, '%');
});

uploader.on('connectionUpdate', (connectionInfo) => {
  console.log('Connection status changed:', connectionInfo.status);
});

// When done
await uploader.stop();
```

### Downloader Usage

```javascript
import { Downloader } from '@filepizza/sdk';

// Create a downloader instance
const downloader = new Downloader();

// Connect using a link
await downloader.initialize();
await downloader.connectWithSlug('your-slug-from-url');

// Or connect directly with a peer ID
// await downloader.connectWithPeerId('uploader-peer-id');

// Handle password if required
if (downloader.getStatus().isPasswordRequired) {
  downloader.submitPassword('your-password');
}

// Listen for events
downloader.on('info', (fileInfoList) => {
  console.log('Files available for download:', fileInfoList);
});

downloader.on('progress', (progressInfo) => {
  console.log('Download progress:', progressInfo.overallProgress * 100, '%');
});

downloader.on('complete', () => {
  console.log('Download completed!');
});

// Start the download
await downloader.startDownload();

// Can pause/resume if needed
downloader.pauseDownload();
downloader.resumeDownload();

// Or cancel the download
downloader.cancelDownload();
```

## React Integration

Here's an example of how to integrate the FilePizza SDK with React:

```jsx
import { useState, useEffect } from 'react';
import { Uploader } from '@filepizza/sdk';

function FileUploaderComponent() {
  const [uploader, setUploader] = useState(null);
  const [links, setLinks] = useState(null);
  const [connections, setConnections] = useState([]);
  const [progress, setProgress] = useState({});

  useEffect(() => {
    const init = async () => {
      const uploaderInstance = new Uploader();
      await uploaderInstance.initialize();
      
      uploaderInstance.on('connection', (info) => {
        setConnections(prev => [...prev, info]);
      });
      
      uploaderInstance.on('progress', (progress) => {
        setProgress(prev => ({
          ...prev,
          [progress.fileIndex]: progress
        }));
      });
      
      setUploader(uploaderInstance);
    };
    
    init();
    
    return () => {
      if (uploader) {
        uploader.stop();
      }
    };
  }, []);

  const handleFileSelect = (e) => {
    if (uploader) {
      uploader.setFiles(e.target.files);
      setLinks(uploader.getShareableLinks());
    }
  };

  return (
    <div>
      <input type="file" multiple onChange={handleFileSelect} />
      
      {links && (
        <div>
          <h3>Share these links:</h3>
          <p>Short link: {links.short}</p>
          <p>Long link: {links.long}</p>
        </div>
      )}
      
      {connections.length > 0 && (
        <div>
          <h3>Connections ({connections.length}):</h3>
          <ul>
            {connections.map((conn, i) => (
              <li key={i}>
                Connection {i+1}: {conn.status}
                {progress[i] && ` - ${Math.round(progress[i].overallProgress * 100)}%`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

## API Reference

### Uploader

#### Constructor
```typescript
new Uploader(options?: {
  serverUrl?: string;
  password?: string;
  config?: Partial<FilePizzaConfig>;
})
```

#### Methods
- `initialize(): Promise<void>` - Initialize the uploader
- `setFiles(files: File[]): void` - Set files to share
- `addFiles(files: File[]): void` - Add more files to share
- `getFiles(): FileInfo[]` - Get list of files
- `getShareableLinks(): { long: string; short: string } | null` - Get shareable links
- `getConnections(): ConnectionInfo[]` - Get active connections
- `stop(): Promise<void>` - Stop sharing and close connections

#### Events
- `connection` - New downloader connected
- `disconnection` - Downloader disconnected
- `connectionUpdate` - Connection status changed
- `progress` - Upload progress updated
- `error` - Error occurred
- `report` - File sharing reported for violation

### Downloader

#### Constructor
```typescript
new Downloader(options?: {
  serverUrl?: string;
  config?: Partial<FilePizzaConfig>;
})
```

#### Methods
- `initialize(): Promise<void>` - Initialize the downloader
- `connectWithSlug(slug: string): Promise<boolean>` - Connect using a slug
- `connectWithPeerId(peerId: string): Promise<boolean>` - Connect directly with a peer ID
- `submitPassword(password: string): void` - Submit password for protected download
- `startDownload(): Promise<void>` - Start downloading files
- `pauseDownload(): void` - Pause the download
- `resumeDownload(): void` - Resume the download
- `cancelDownload(): void` - Cancel the download
- `getFileInfo(): FileInfo[]` - Get file information
- `getStatus(): { status: ConnectionStatus; isPasswordRequired: boolean; isPasswordInvalid: boolean; errorMessage?: string }` - Get download status
- `getProgress(): ProgressInfo` - Get progress information

#### Events
- `connected` - Connected to uploader
- `disconnected` - Disconnected from uploader
- `passwordRequired` - Password required for download
- `passwordInvalid` - Invalid password submitted
- `info` - File information received
- `progress` - Download progress updated
- `paused` - Download paused
- `resumed` - Download resumed
- `complete` - Download completed
- `cancelled` - Download cancelled
- `error` - Error occurred
- `reported` - File sharing reported for violation

## License

MIT