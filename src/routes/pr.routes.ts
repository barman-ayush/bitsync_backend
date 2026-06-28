import { Router } from "express"
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { PRController } from "../controllers/pr.controller";

const router = Router();
router.use(authMiddleware);

router.get("/commit-trail/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.fetchPrCommits);
router.get("/status/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getPRStatus);
router.post("/create/:repoId/:workspaceId", requireRepoAccess, authorize("repo:push"), PRController.createPullRequest);
router.get("/list/:repoId", requireRepoAccess, authorize("repo:view"), PRController.getAllPRs);
router.get("/details/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrDetails);
router.get("/diff/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrDiff);
router.post("/comment/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.addComment);
router.delete("/comment/:repoId/:prId/:commentId", requireRepoAccess, authorize("repo:view"), PRController.deleteComment);


export default router;
