declare module 'pngjs' {
  interface PNGOptions {
    width?: number
    height?: number
  }
  export class PNG {
    constructor(options?: PNGOptions)
    width: number
    height: number
    data: Buffer
    static sync: {
      read(buffer: Buffer): PNG
      write(png: PNG): Buffer
    }
  }
}
