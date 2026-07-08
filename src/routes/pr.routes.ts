import { Router } from "express"
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { PRController } from "../controllers/pr.controller";

const router = Router();
router.use(authMiddleware);

router.get("/commit-trail/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.fetchPrCommits);

// Fetches the status ->  [ "CREATE_PR", "IN_SYNC", "DIFFING", "PENDING_SYNC" ]
router.get("/status/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getPRStatus);
router.post("/create/:repoId/:workspaceId", requireRepoAccess, authorize("repo:push"), PRController.createPullRequest);

// fetches all PRs for a repository (RBAC)
router.get("/list/:repoId", requireRepoAccess, authorize("repo:view"), PRController.getAllPRs);

// fetches a single PR
router.get("/details/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrDetails);

// Returns the diff of the PR
router.get("/commit-changes/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getPrCommitChanges);

// Returns the merge check result
// router.get("/merge-check/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getMergeCheck);

router.post("/close/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.closePR);
router.post("/comment/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.addComment);
router.delete("/comment/:repoId/:prId/:commentId", requireRepoAccess, authorize("repo:view"), PRController.deleteComment);


export default router;
