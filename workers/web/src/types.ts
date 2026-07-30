export interface User {
  sub: string;
  email: string;
}

export interface StoredBlob {
  hash: string;
  extension: string;
  mimeType: string;
  size: number;
}
