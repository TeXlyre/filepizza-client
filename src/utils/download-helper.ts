export class DownloadHelper {
  private static isNewChromiumBased() {
    return 'showSaveFilePicker' in window;
  }

  static async downloadFile(fileName: string, data: Blob | Uint8Array): Promise<void> {
    const blob = data instanceof Blob ? data : new Blob([data]);

    if (this.isNewChromiumBased()) {
      await this.downloadWithFileSystemAccessAPI(fileName, blob);
    } else {
      this.downloadWithBlobUrl(fileName, blob);
    }
  }

  private static async downloadWithFileSystemAccessAPI(fileName: string, blob: Blob): Promise<void> {
    try {
      // @ts-ignore - TypeScript may not recognize showSaveFilePicker
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'Files',
          accept: { '*/*': ['.bin'] },
        }],
      });

      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      console.error('Error downloading with File System Access API:', error);

      // Fall back to blob URL method if the user cancels or there's an error
      if (error.name !== 'AbortError') {
        this.downloadWithBlobUrl(fileName, blob);
      }
    }
  }

  private static downloadWithBlobUrl(fileName: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  static async streamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks
    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const combinedChunks = new Uint8Array(totalLength);

    let offset = 0;
    for (const chunk of chunks) {
      combinedChunks.set(chunk, offset);
      offset += chunk.length;
    }

    return combinedChunks;
  }
}