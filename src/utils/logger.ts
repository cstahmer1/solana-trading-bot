import pino from "pino";

const pretty = process.env.LOG_PRETTY === "1";

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: pretty
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
});

let envContext: {
  envName: string;
  deploymentId: string;
  dbLabel: string;
  walletLabel: string;
} | null = null;

export function setLoggerContext(context: {
  envName: string;
  deploymentId: string;
  dbLabel: string;
  walletLabel: string;
}): void {
  envContext = context;
}

export const logger = new Proxy(baseLogger, {
  get(target, prop) {
    const method = (target as any)[prop];
    if (typeof method === "function" && ["info", "warn", "error", "debug", "fatal", "trace"].includes(String(prop))) {
      return (...args: any[]) => {
        if (envContext) {
          if (args.length === 1 && typeof args[0] === "string") {
            return method.call(target, { env: envContext.envName }, args[0]);
          } else if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
            args[0] = { 
              env: envContext.envName,
              ...args[0] 
            };
          }
        }
        return method.apply(target, args);
      };
    }
    return method;
  }
});
