declare module 'mic' {
  import { Transform } from 'stream';

  interface MicOptions {
    rate?: string;
    bitwidth?: string;
    channels?: string;
    encoding?: string;
    endian?: string;
    device?: string;
    exitOnSilence?: number;
    fileType?: string;
    debug?: boolean;
  }

  interface MicInstance {
    start(): void;
    stop(): void;
    pause(): void;
    resume(): void;
    getAudioStream(): Transform;
  }

  function mic(options?: MicOptions): MicInstance;
  export = mic;
}
