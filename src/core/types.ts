import type { DataConnection } from 'peerjs'

export type UploadedFile = File & { entryFullPath?: string }

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

export type ConnectionInfo = {
  id: string;
  status: ConnectionStatus;
  browserName?: string;
  browserVersion?: string;
  osName?: string;
  osVersion?: string;
  mobileVendor?: string;
  mobileModel?: string;
}

export type FileInfo = {
  fileName: string;
  size: number;
  type: string;
}

export type ProgressInfo = {
  fileIndex: number;
  fileName: string;
  totalFiles: number;
  currentFileProgress: number;
  overallProgress: number;
  bytesTransferred: number;
  totalBytes: number;
}

export type Channel = {
  secret?: string;
  longSlug: string;
  shortSlug: string;
  uploaderPeerID: string;
}

export interface EventEmitter {
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

export interface UploaderOptions {
  serverUrl?: string;
  password?: string;
  config?: Partial<import('./config').FilePizzaConfig>;
}

export interface DownloaderOptions {
  serverUrl?: string;
  config?: Partial<import('./config').FilePizzaConfig>;
}

// Internal type for connection management
export interface ConnectionContext {
  status: ConnectionStatus;
  dataConnection: DataConnection;
  fileIndex: number;
  filesInfo: FileInfo[];
  totalFiles: number;
  bytesTransferred: number;
  totalBytes: number;
  currentFileProgress: number;
  uploadingFileName?: string;
  uploadingOffset?: number;
}