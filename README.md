<div align="center">
  <img src="public/images/api_button.png" alt="FilePizza client API" width="50%" /><h3>Client API for integrating the FilePizza Server into your apps</h3>
</div>

# FilePizza Client API

The `filepizza-client` API provides bindings to [FilePizza server](https://github.com/TeXlyre/filepizza-server). FilePizza is a React library for browser-to-browser file transfer using WebRTC. It allows you to integrate peer-to-peer file sharing functionality into your web applications.

## Features

- Direct browser-to-browser file transfers (no server storage)
- Password protection for transfers
- Support for single and multiple file transfers
- Progress tracking and event notifications

## Installation

```bash
npm install filepizza-client
```

## Usage

Set up a FilePizza client instance and use it to upload files:

```javascript
import { FilePizzaUploader } from 'filepizza-client';

const uploader = new FilePizzaUploader({
  filePizzaServerUrl: 'https://your-filepizza-server.com',

  // You can optionally specify an additional shared slug
  // where multiple uploaders can connect and share files
  sharedSlug: 'filepizza-demo',
});

await uploader.initialize();

uploader.on('progress', (progressInfo) => {
  console.log(`Upload progress: ${progressInfo.overallProgress * 100}%`);
});

uploader.setFiles(fileList); // From an input element

const links = uploader.getShareableLinks();

if (links) {
  console.log(`Long link: ${links.long}`);
  console.log(`Short link: ${links.short}`);
}
```

Set up a FilePizza client instance and use it to download files:

```javascript
import { FilePizzaDownloader } from 'filepizza-client';

const downloader = new FilePizzaDownloader({
  filePizzaServerUrl: 'https://your-filepizza-server.com',
});

await downloader.initialize();

downloader.on('progress', (progressInfo) => {
  console.log(`Download progress: ${progressInfo.overallProgress * 100}%`);
});

await downloader.connect(filePizzaUrl);
await downloader.startDownload();
```

By default, the client:

- Fetches ICE server configuration from the FilePizza server
- Attempts to discover a PeerJS signaling server from:
  ```
  /api/ice
  ```
- Falls back to PeerJS defaults if no signaling server is configured

You can also explicitly override the PeerJS signaling server configuration.

The uploader and downloader must use the same PeerJS signaling server in order to connect:

```javascript
import {
  FilePizzaUploader,
  FilePizzaDownloader,
} from 'filepizza-client';

const peerJSSignalingServer = {
  host: 'peerjs.example.com',
  port: 443,
  path: '/',
  secure: true,
};

const uploader = new FilePizzaUploader({
  filePizzaServerUrl: 'https://your-filepizza-server.com',
  peerJSSignalingServer,
});

const downloader = new FilePizzaDownloader({
  filePizzaServerUrl: 'https://your-filepizza-server.com',
  peerJSSignalingServer,
});
```

If no `peerJSSignalingServer` is provided, the client will use the FilePizza server configuration (if available) or default PeerJS behavior.

## Examples

### Regular Example

Make sure to have the [FilePizza server](https://github.com/TeXlyre/filepizza-server) running locally or specify the server URL in the example code. 

By default, the example uses `https://filepizza.texlyre.org` as the demo server URL. This server allows origins from `http://localhost:8081` so you can immediately test the API without requiring to run the server locally. 

*WARNING: The demo server (signaling and TURN as fallback) is not intended for production use and may be subject to rate limits or downtime. For production use, consider setting up your own [FilePizza server](https://github.com/TeXlyre/filepizza-server?tab=readme-ov-file#deployment-with-cloudflare-tunnel).*

To run the vite-bundled example locally, clone the repository and run:

```bash
npm install
npm run build:example
npm run example
```

Then open `http://localhost:8081` in your browser.

