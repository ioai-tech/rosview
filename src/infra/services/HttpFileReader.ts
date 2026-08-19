import EventEmitter from "eventemitter3";
import { BrowserHttpReader, type BrowserHttpReaderOptions } from './BrowserHttpReader';
import type { FileReader, FileStream, FileStreamEvents } from "./CachedFilelike";

class HttpFileStream extends EventEmitter<FileStreamEvents> implements FileStream {
  private _destroyed = false;
  private _abortController = new AbortController();

  constructor(reader: BrowserHttpReader, offset: number, length: number) {
    super();
    reader.read(offset, length, this._abortController.signal, (received, total) => {
      if (!this._destroyed) {
        this.emit("progress", received, total);
      }
    })
      .then((data) => {
        if (!this._destroyed) {
          this.emit("data", data);
        }
      })
      .catch((err: Error) => {
        if (this._destroyed && err.name === "AbortError") {
          return;
        }
        if (!this._destroyed) {
          this.emit("error", err);
        }
      });
  }

  destroy(): void {
    this._destroyed = true;
    this._abortController.abort();
  }
}

export class HttpFileReader implements FileReader {
  private _reader: BrowserHttpReader;

  constructor(url: string, options?: BrowserHttpReaderOptions) {
    this._reader = new BrowserHttpReader(url, options);
  }

  async open(): Promise<{ size: number }> {
    await this._reader.initialize();
    return { size: this._reader.size() };
  }

  fetch(offset: number, length: number): FileStream {
    return new HttpFileStream(this._reader, offset, length);
  }
}
