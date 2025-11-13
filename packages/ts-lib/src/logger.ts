type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: unknown;
}

function log(level: LogLevel, service: string, msg: string, fields?: LogFields): void {
  const payload = {
    level,
    service,
    msg,
    ...fields,
    ts: new Date().toISOString(),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export function createLogger(service: string) {
  return {
    debug: (msg: string, fields?: LogFields) => log('debug', service, msg, fields),
    info: (msg: string, fields?: LogFields) => log('info', service, msg, fields),
    warn: (msg: string, fields?: LogFields) => log('warn', service, msg, fields),
    error: (msg: string, fields?: LogFields | Error) => {
      if (fields instanceof Error) {
        log('error', service, msg, { err: fields.message, stack: fields.stack });
      } else {
        log('error', service, msg, fields);
      }
    },
  };
}
