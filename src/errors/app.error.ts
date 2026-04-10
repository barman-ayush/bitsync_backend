import logger from "../services/logger.service";

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;

    constructor(message: string, statusCode: number, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        Object.setPrototypeOf(this, new.target.prototype);
        logger.error(this.constructor.name, `[${statusCode}] ${message}`);
    }
}

export class BadRequestError extends AppError {
    constructor(message = "Bad request") {
        super(message, 400);
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = "Unauthorized") {
        super(message, 401);
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "Forbidden") {
        super(message, 403);
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Not found") {
        super(message, 404);
    }
}

export class ConflictError extends AppError {
    constructor(message = "Conflict") {
        super(message, 409);
    }
}

export class ValidationError extends AppError {
    public readonly fields?: string[];

    constructor(message = "Validation failed", fields?: string[]) {
        super(message, 422);
        this.fields = fields;
    }
}

export class InternalError extends AppError {
    constructor(message = "Internal server error") {
        super(message, 500, false);
    }
}
