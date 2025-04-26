// src/core/types.ts
export interface EventEmitter {
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

/**
 * Connection status
 */
export enum ConnectionStatus {
  Pending = 'PENDING',
  Ready = 'READY',
  Paused = 'PAUSED',
  Uploading = 'UPLOADING',
  Downloading = 'DOWNLOADING',
  Done = 'DONE',
  Authenticating = 'AUTHENTICATING',
  InvalidPassword = 'INVALID_PASSWORD',
  Closed = 'CLOSED',
  Error = 'ERROR'
}

/**
 * File information
 */
export interface FileInfo {
  fileName: string;
  size: number;
  type: string;
}

/**
 * Interface for a completed file ready to download
 */
export interface CompletedFile extends FileInfo {
  data: Uint8Array;
  downloadUrl?: string;
}

/**
 * Progress information
 */
export interface ProgressInfo {
  fileIndex: number;
  fileName: string;
  totalFiles: number;
  currentFileProgress: number;
  overallProgress: number;
  bytesTransferred: number;
  totalBytes: number;
}

/**
 * Connection information
 */
export interface ConnectionInfo {
  id: string;
  status: ConnectionStatus;
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  mobileVendor?: string;
  mobileModel?: string;
}

/**
 * Message types for peer-to-peer communication
 */
export enum MessageType {
  RequestInfo = 'RequestInfo',
  Info = 'Info',
  Start = 'Start',
  Chunk = 'Chunk',
  Pause = 'Pause',
  Resume = 'Resume',
  Done = 'Done',
  Error = 'Error',
  PasswordRequired = 'PasswordRequired',
  UsePassword = 'UsePassword',
  Report = 'Report',
}