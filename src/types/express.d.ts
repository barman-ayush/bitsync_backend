import { AccessTokenPayload } from "./jwt.types";
import { RepoRole } from "../middlewares/permission.middleware";
import { RepoContextRepo } from "./middlewares.types";

declare module "express-serve-static-core" {
    interface Request {
        user?: AccessTokenPayload;
        membership?: { role: RepoRole };
        repo?: RepoContextRepo;
        repoId?: string;
    }
}
