// Minimal typings for the untyped hoodiecrow-imap test server (dev dependency).
declare module 'hoodiecrow-imap' {
  export interface HoodiecrowMessage {
    uid: number;
    flags: string[];
    raw: string;
    internaldate: string | Date;
    modseq?: number;
  }
  export interface HoodiecrowMailbox {
    uidvalidity: number;
    uidnext: number;
    messages: HoodiecrowMessage[];
  }
  export interface HoodiecrowConnection {
    socket?: { destroy(): void };
    send(response: unknown, description: string, parsed: unknown, data: unknown): void;
  }
  export interface HoodiecrowServer {
    connections: Set<HoodiecrowConnection>;
    folderCache: Record<string, HoodiecrowMailbox>;
    getMailbox(path: string): HoodiecrowMailbox | undefined;
    appendMessage(
      mailbox: string | HoodiecrowMailbox,
      flags: string[],
      internaldate: string | Date,
      raw: string,
      ignoreConnection?: boolean,
      properties?: Record<string, unknown>,
    ): { mailbox: HoodiecrowMailbox; message: HoodiecrowMessage };
    listen(port: number, host: string, cb: () => void): void;
    address(): { port: number };
    close(cb?: () => void): void;
    getCommandHandler(command: string): CommandHandler | false;
    setCommandHandler(command: string, handler: CommandHandler): void;
  }
  export type CommandHandler = (
    connection: HoodiecrowConnection,
    parsed: { tag: string },
    data: unknown,
    callback: () => void,
  ) => void;
  export interface HoodiecrowOptions {
    plugins?: string[];
    storage?: Record<string, unknown>;
    secureConnection?: boolean;
    users?: Record<string, { password: string; xoauth2?: { accessToken: string } }>;
  }
  export default function hoodiecrow(options?: HoodiecrowOptions): HoodiecrowServer;
}
