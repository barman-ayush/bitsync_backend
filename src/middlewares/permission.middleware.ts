import { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../errors/app.error";
import { handleError } from "./error.middleware";

export type RepoRole = "owner" | "admin" | "member";

export const PERMISSIONS: Record<string, RepoRole[]> = {
    "repo:view": ["owner", "admin", "member"],
    "repo:settings": ["owner", "admin"],
    "repo:delete": ["owner"],
    "member:invite": ["owner", "admin"],
    "member:remove": ["owner", "admin"],
    "member:promote": ["owner", "admin"],
    "member:demote": ["owner"],
};

export function authorize(permission: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        try {
            const allowedRoles = PERMISSIONS[permission];
            if (!allowedRoles) throw new Error(`Unknown permission: ${permission}`);

            const role = req.membership?.role;
            if (!role || !allowedRoles.includes(role)) {
                throw new ForbiddenError("Insufficient permissions");
            }

            next();
        } catch (err) {
            handleError(`permission_middleware/${permission}`, err, next);
        }
    };
}
