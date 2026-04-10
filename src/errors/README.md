# Error Classes Reference

All error classes are in `app.error.ts` and extend `AppError`. Each error auto-logs via the logger service on creation.

| Class              | Status Code | When to use                                                  |
| ------------------ | ----------- | ------------------------------------------------------------ |
| `BadRequestError`  | 400         | Malformed request body, missing required fields              |
| `UnauthorizedError`| 401         | Missing or invalid authentication token                      |
| `ForbiddenError`   | 403         | Authenticated but lacking permission for the resource        |
| `NotFoundError`    | 404         | Resource (user, repo, branch, etc.) does not exist           |
| `ConflictError`    | 409         | Duplicate entry, merge conflict, resource already exists     |
| `ValidationError`  | 422         | Input passes format checks but fails business rules          |
| `InternalError`    | 500         | Unexpected server-side failure (marked as non-operational)   |

## Usage

```ts
import { NotFoundError, ValidationError } from "../errors/app.error";

// simple
throw new NotFoundError("User not found");

// with default message
throw new ForbiddenError();

// validation with field list
throw new ValidationError("Invalid input", ["email", "password"]);
```
