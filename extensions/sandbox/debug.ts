export interface SandboxDebugLine {
  timestamp: number;
  text: string;
}

/** Capture runtime diagnostics only for the owning session's lifetime. */
export function createSandboxDebugLog() {
  const lines: SandboxDebugLine[] = [];
  let restore: (() => void) | undefined;
  let inherited: string | undefined;

  function setEnabled(enabled: boolean): void {
    if (enabled) process.env.SRT_DEBUG ||= "1";
    else if (inherited === undefined) delete process.env.SRT_DEBUG;
    else process.env.SRT_DEBUG = inherited;
  }

  return {
    lines,
    describe: () => (process.env.SRT_DEBUG ? "enabled (SRT_DEBUG)" : "disabled"),
    setEnabled,
    start() {
      restore?.();
      lines.length = 0;
      inherited = process.env.SRT_DEBUG;
      const error = console.error;
      const warn = console.warn;
      const capture = (args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (!text.includes("[SandboxDebug]")) return;
        lines.push({ timestamp: Date.now(), text });
        if (lines.length > 50) lines.shift();
      };
      const wrappedError = (...args: unknown[]) => {
        capture(args);
        error(...args);
      };
      const wrappedWarn = (...args: unknown[]) => {
        capture(args);
        warn(...args);
      };
      console.error = wrappedError;
      console.warn = wrappedWarn;
      restore = () => {
        if (console.error === wrappedError) console.error = error;
        if (console.warn === wrappedWarn) console.warn = warn;
        setEnabled(false);
      };
    },
    stop() {
      restore?.();
      restore = undefined;
    },
  };
}
