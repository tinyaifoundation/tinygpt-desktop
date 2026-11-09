declare module 'b4a' {
  export function from(value: string | Uint8Array, encoding?: string): Uint8Array;
  export function alloc(size: number): Uint8Array;
  export function concat(values: Uint8Array[]): Uint8Array;
  export function toString(value: Uint8Array, encoding?: string): string;
}
declare module 'noise-handshake' {
  export default class Noise {
    constructor(pattern: string, initiator: boolean, keys?: unknown, options?: { psk: Uint8Array });
    initialise(prologue: Uint8Array): void;
    send(payload?: Uint8Array): Uint8Array;
    recv(message: Uint8Array): Uint8Array;
    complete: boolean; tx: Uint8Array; rx: Uint8Array;
    s?: { secretKey: Uint8Array }; e?: { secretKey: Uint8Array }; psk?: Uint8Array | null;
  }
}
declare module 'noise-handshake/cipher.js' {
  export default class Cipher {
    constructor(key: Uint8Array);
    encrypt(value: Uint8Array, ad?: Uint8Array): Uint8Array;
    decrypt(value: Uint8Array, ad?: Uint8Array): Uint8Array;
    _clear(): void;
  }
}
