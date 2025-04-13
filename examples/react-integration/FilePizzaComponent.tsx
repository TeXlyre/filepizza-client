import React, { useState, useEffect, useRef } from 'react';
import { FilePizzaUploader, FilePizzaDownloader } from '../../src';

/**
 * FilePizza component that allows uploading and downloading files
 * using the existing FilePizza server
 */
export default function FilePizzaComponent() {
  const [mode, setMode] = useState(null); // 'upload' or 'download'
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState(null);
  const [links, setLinks] = useState(null);
  const [isPasswordRequired, setIsPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState('');
  const [completedFiles, setCompletedFiles] = useState([]);
  const [downloadingFile, setDownloadingFile] = useState(null);

  const uploaderRef = useRef(null);
  const downloaderRef = useRef(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (uploaderRef.current) {
        uploaderRef.current.stop();
      }
      if (downloaderRef.current) {
        downloaderRef.current.cancelDownload();
      }
    };
  }, []);

  // Initialize uploader
  const initializeUploader = async () => {
    setMode('upload');
    setError(null);

    try {
      const uploader = new FilePizzaUploader({
        // You can specify a custom FilePizza server URL if needed
        // filePizzaServerUrl: 'https://custom-filepizza-server.com',
        filePizzaServerUrl: 'http://localhost:8080',
        // You can specify a constant password here
        // password: '123'
      });

      await uploader.initialize();

      uploader.on('connection', (connectionInfo) => {
        console.log('New connection:', connectionInfo);
      });

      uploader.on('progress', (progressInfo) => {
        setProgress(progressInfo);
      });

      uploader.on('error', (err) => {
        console.error('Uploader error:', err);
        setError(typeof err === 'string' ? err : err.message || 'Upload error');
      });

      uploaderRef.current = uploader;
    } catch (err) {
      console.error('Failed to initialize uploader:', err);
      setError(err.message || 'Failed to initialize uploader');
    }
  };

  // Handle file selection
  const handleFileSelection = (e) => {
    if (!uploaderRef.current || !e.target.files.length) return;

    const filesList = Array.from(e.target.files);
    uploaderRef.current.setPassword(password);
    uploaderRef.current.setFiles(filesList);
    setFiles(filesList);

    // Generate links
    const shareableLinks = uploaderRef.current.getShareableLinks();
    if (shareableLinks) {
      setLinks(shareableLinks);
    }
  };

  // Initialize downloader
  const initializeDownloader = async () => {
    setMode('download');
    setError(null);
    setCompletedFiles([]);

    try {
      const downloader = new FilePizzaDownloader({
        // You can specify a custom FilePizza server URL if needed
        // filePizzaServerUrl: 'https://custom-filepizza-server.com'
        filePizzaServerUrl: 'http://localhost:8080'
      });

      await downloader.initialize();

      downloader.on('passwordRequired', () => {
        setIsPasswordRequired(true);
      });

      downloader.on('passwordInvalid', (message) => {
        setError(message || 'Invalid password');
      });

      downloader.on('info', (filesInfo) => {
        setFiles(filesInfo);
      });

      downloader.on('progress', (progressInfo) => {
        setProgress(progressInfo);
      });

      downloader.on('fileComplete', (file) => {
        setCompletedFiles(prev => {
          // Add file if it doesn't exist yet
          if (!prev.some(f => f.fileName === file.fileName)) {
            return [...prev, file];
          }
          return prev;
        });
      });

      downloader.on('complete', (files) => {
        console.log('Download complete!', files);
        setCompletedFiles(files);
      });

      downloader.on('error', (err) => {
        console.error('Downloader error:', err);
        setError(typeof err === 'string' ? err : err.message || 'Download error');
      });

      downloaderRef.current = downloader;
    } catch (err) {
      console.error('Failed to initialize downloader:', err);
      setError(err.message || 'Failed to initialize downloader');
    }
  };

  // Connect to FilePizza URL
  const connectToFilePizza = async () => {
    if (!downloaderRef.current || !downloadUrl) return;

    try {
      const connected = await downloaderRef.current.connect(downloadUrl);

      if (!connected) {
        setError('Failed to connect to FilePizza');
      }
    } catch (err) {
      console.error('Connect error:', err);
      setError(err.message || 'Failed to connect');
    }
  };

  // Submit password
  const submitPassword = () => {
    if (!downloaderRef.current || !password) return;

    try {
      downloaderRef.current.submitPassword(password);
    } catch (err) {
      console.error('Password error:', err);
      setError(err.message || 'Failed to submit password');
    }
  };

  // Start download
  const startDownload = async () => {
    if (!downloaderRef.current) return;

    try {
      await downloaderRef.current.startDownload();
    } catch (err) {
      console.error('Download error:', err);
      setError(err.message || 'Failed to start download');
    }
  };

  // Download specific file
  const downloadFile = async (fileName) => {
    if (!downloaderRef.current) return;

    try {
      setDownloadingFile(fileName);
      await downloaderRef.current.downloadFile(fileName);
      setDownloadingFile(null);
    } catch (err) {
      console.error('File download error:', err);
      setError(err.message || 'Failed to download file');
      setDownloadingFile(null);
    }
  };

  // Download all files
  const downloadAllFiles = async () => {
    if (!downloaderRef.current) return;

    try {
      setDownloadingFile('all');
      await downloaderRef.current.downloadAllFiles();
      setDownloadingFile(null);
    } catch (err) {
      console.error('All files download error:', err);
      setError(err.message || 'Failed to download all files');
      setDownloadingFile(null);
    }
  };

  // Reset application state
  const resetApp = () => {
    if (uploaderRef.current) {
      uploaderRef.current.stop();
      uploaderRef.current = null;
    }

    if (downloaderRef.current) {
      downloaderRef.current.cancelDownload();
      downloaderRef.current = null;
    }

    setMode(null);
    setFiles([]);
    setProgress(null);
    setLinks(null);
    setIsPasswordRequired(false);
    setPassword('');
    setError(null);
    setDownloadUrl('');
    setCompletedFiles([]);
    setDownloadingFile(null);
  };

  // Format progress percentage
  const progressPercentage = progress
    ? Math.round(progress.overallProgress * 100)
    : 0;

  return (
    <div className="filepizza-container">
      <h1>FilePizza Integration</h1>

      {error && (
        <div className="error">
          {error}
        </div>
      )}

      {/* Mode Selection */}
      {!mode && (
        <div className="mode-selection">
          <button onClick={initializeUploader}>
            Upload Files
          </button>

          <button onClick={initializeDownloader}>
            Download Files
          </button>
        </div>
      )}

      {/* Uploader UI */}
      {mode === 'upload' && (
        <div className="uploader">
          <h2>Upload Files</h2>

          {!files.length && (
            <div className="upload-form">
              <div className="password-field">
                <label>
                  Password (optional):
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Leave blank for no password"
                  />
                </label>
              </div>

              <input
                type="file"
                multiple
                onChange={handleFileSelection}
              />
            </div>
          )}

          {/* Display files */}
          {files.length > 0 && (
            <div className="file-list">
              <h3>Files:</h3>
              <ul>
                {files.map((file, index) => (
                  <li key={index}>
                    {file.name || file.fileName} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Share links */}
          {links && (
            <div className="share-links">
              <h3>Share these links:</h3>

              <div className="link-field">
                <label>Short Link:</label>
                <div className="link-input">
                  <input
                    type="text"
                    value={links.short}
                    readOnly
                  />
                  <button onClick={() => navigator.clipboard.writeText(links.short)}>
                    Copy
                  </button>
                </div>
              </div>

              <div className="link-field">
                <label>Long Link:</label>
                <div className="link-input">
                  <input
                    type="text"
                    value={links.long}
                    readOnly
                  />
                  <button onClick={() => navigator.clipboard.writeText(links.long)}>
                    Copy
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Progress bar */}
          {progress && (
            <div className="progress">
              <div className="progress-info">
                <span>Uploading...</span>
                <span>{progressPercentage}%</span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>
            </div>
          )}

          <button className="cancel-button" onClick={resetApp}>
            Cancel
          </button>
        </div>
      )}

      {/* Downloader UI */}
      {mode === 'download' && (
        <div className="downloader">
          <h2>Download Files</h2>

          {!files.length && !isPasswordRequired && (
            <div className="download-form">
              <div className="url-input">
                <input
                  type="text"
                  placeholder="Enter FilePizza URL or slug"
                  value={downloadUrl}
                  onChange={(e) => setDownloadUrl(e.target.value)}
                />
                <button onClick={connectToFilePizza}>
                  Connect
                </button>
              </div>
            </div>
          )}

          {/* Password prompt */}
          {isPasswordRequired && (
            <div className="password-form">
              <p>This download requires a password:</p>

              <div className="password-input">
                <input
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button onClick={submitPassword}>
                  Submit
                </button>
              </div>
            </div>
          )}

          {/* File list */}
          {files.length > 0 && !progress && (
            <div className="download-ready">
              <div className="file-list">
                <h3>Files to download:</h3>
                <ul>
                  {files.map((file, index) => (
                    <li key={index}>
                      {file.fileName} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                    </li>
                  ))}
                </ul>
              </div>

              <button className="download-button" onClick={startDownload}>
                Start Download
              </button>
            </div>
          )}

          {/* Progress */}
          {progress && (
            <div className="progress">
              <div className="progress-info">
                <span>Downloading...</span>
                <span>{progressPercentage}%</span>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>

              {progress.currentFileProgress < 1 && (
                <div className="file-progress">
                  File {progress.fileIndex + 1} of {progress.totalFiles}: {progress.fileName}
                </div>
              )}

              {progress.overallProgress === 1 && (
                <div className="complete-message">
                  Download Complete!
                </div>
              )}
            </div>
          )}

          {/* Completed files with download buttons */}
          {completedFiles.length > 0 && progress?.overallProgress === 1 && (
            <div className="completed-files">
              <h3>Ready to download:</h3>
              <ul className="download-files-list">
                {completedFiles.map((file, index) => (
                  <li key={index} className="download-file-item">
                    <span className="file-name">{file.fileName} ({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                    <button
                      className="download-file-button"
                      onClick={() => downloadFile(file.fileName)}
                      disabled={downloadingFile === file.fileName || downloadingFile === 'all'}
                    >
                      {downloadingFile === file.fileName ? 'Downloading...' : 'Download'}
                    </button>
                  </li>
                ))}
              </ul>

              {completedFiles.length > 1 && (
                <button
                  className="download-all-button"
                  onClick={downloadAllFiles}
                  disabled={downloadingFile !== null}
                >
                  {downloadingFile === 'all' ? 'Downloading All...' : 'Download All Files'}
                </button>
              )}
            </div>
          )}

          <button className="cancel-button" onClick={resetApp}>
            {progress?.overallProgress === 1 ? 'Back to Start' : 'Cancel'}
          </button>
        </div>
      )}
    </div>
  );
}