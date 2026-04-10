import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/app.error";
import logger from "../services/logger.service";

export function handleError(source: string, err: unknown, next: NextFunction): void {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(source, message);
    next(err);
}

export function errorMiddleware(err: Error, req: Request, res: Response, next: NextFunction): void {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            status: "error",
            message: err.message,
        });
        return;
    }

    // Unexpected errors
    logger.error("UNHANDLED", err.message);
    res.status(500).json({
        status: "error",
        message: "Internal server error",
    });
}
