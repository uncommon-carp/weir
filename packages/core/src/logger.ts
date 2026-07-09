export type DebugEvent =
  | 'weir.taskdef.register'
  | 'weir.task.run'
  | 'weir.task.poll'
  | 'weir.task.stopped'
  | 'weir.task.stop'
  | 'weir.scheduler.create'
  | 'weir.scheduler.cancel'
  | 'weir.results.read'
  | 'weir.target.env.override'
  | 'weir.sentinel.auth.configured';

export type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: { event: DebugEvent } & Record<string, unknown>): void;
};

export function createLogger(opts: { verbose: boolean }): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const payload = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[${level}] ${msg}${payload}`);
  };

  return {
    info: (m, d) => emit('INFO', m, d),
    warn: (m, d) => emit('WARN', m, d),
    error: (m, d) => emit('ERROR', m, d),
    debug: (m, d) => {
      if (opts.verbose) emit('DEBUG', m, d);
    }
  };
}
