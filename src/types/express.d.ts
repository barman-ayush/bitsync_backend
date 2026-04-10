import { AccessTokenPayload } from "./jwt.types";

declare module "express-serve-static-core" {
    interface Request {
        user?: AccessTokenPayload;
    }
}
