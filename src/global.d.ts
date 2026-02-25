interface LanguageModelStatic {
  availability: (opts?: Record<string, unknown>) => Promise<string>;
  create: (opts?: Record<string, unknown>) => Promise<LanguageModelSession>;
}

interface LanguageModelSession {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<string>;
  promptStreaming: (text: string, opts?: Record<string, unknown>) => ReadableStream<string>;
  destroy: () => void;
}

declare const LanguageModel: LanguageModelStatic | undefined;
