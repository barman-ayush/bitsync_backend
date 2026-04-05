const Colors = {
    reset: "\x1b[0m",
    blue: "\x1b[34m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    gray: "\x1b[90m",
} as const;

class Logger {
    private static instance: Logger;

    private constructor() {}

    public static getInstance(): Logger {
        if (!this.instance) {
            this.instance = new Logger();
        }
        return this.instance;
    }

    public info(source: string, log: string): void {
        console.log(`${Colors.blue}[INFO] : [${source}]${Colors.reset} --`, log);
    }

    public warn(source: string, log: string): void {
        console.log(`${Colors.yellow}[WARN] : [${source}]${Colors.reset} --`, log);
    }

    public error(source: string, log: string): void {
        console.log(`${Colors.red}[ERROR] : [${source}]${Colors.reset} --`, log);
    }

    public success(source: string, log: string): void {
        console.log(`${Colors.green}[SUCCESS] : [${source}]${Colors.reset} --`, log);
    }

    public debug(source: string, log: string): void {
        console.log(`${Colors.gray}[DEBUG] : [${source}]${Colors.reset} --`, log);
    }
}

const logger : Logger = Logger.getInstance();

export default logger;