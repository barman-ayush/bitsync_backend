import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { CommitController } from "../controllers/commit.controller";

const router = Router();

router.use(authMiddleware);

// list commits made in this workspace since the fork point (newest first)
router.get("/history/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), CommitController.getCommitHistory);

// bake uncommitted changes into a new commit and advance the workspace head
router.post("/:repoId/:workspaceId", requireRepoAccess, authorize("repo:push"), CommitController.createCommit);


export default router;