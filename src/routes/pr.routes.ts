import { Router } from "express"
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { PRController } from "../controllers/pr.controller";

const router = Router();
router.use(authMiddleware);

// Returns the list of commits that are present in the workspace but not in the main repo.
// Used for checking the commit trail of a PR. Supports both active workspace checks and historical PR checks.
// NOTE : prId is optional to handle the draft PR commit trail case also.
router.get("/commit-trail/:repoId/:workspaceId{/:prId}", requireRepoAccess, authorize("repo:view"), PRController.fetchPrCommits);

// Fetches the status ->  [ "CREATE_PR", "VIEW_PR" ]
// Used for checking whether we can create a PR or not.
router.get("/status/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getPRStatus);

// Creates a new PR
router.post("/create/:repoId/:workspaceId", requireRepoAccess, authorize("repo:push"), PRController.createPullRequest);

// Used for checking the mergability of a PR.
router.get("/mergeability/:repoId/:workspaceId/:prId", requireRepoAccess, authorize("repo:view"), PRController.checkPrMergeability);

// fetches all PRs for a repository (RBAC)
router.get("/list/:repoId", requireRepoAccess, authorize("repo:view"), PRController.getAllPRs);

// fetches a single PR
router.get("/details/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrDetails);

// Returns the diff of the PR
router.get("/commit-changes/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getPrCommitChanges);

// Returns the merge check result
// router.get("/merge-check/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), PRController.getMergeCheck);

router.post("/close/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.closePR);
router.get("/assigned-reviews/:repoId", requireRepoAccess, authorize("repo:view"), PRController.fetchAssignedReviews);
router.get("/review-view/:repoId/:workspaceId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getReviewerViewData);
router.get("/changes-view/:repoId/:workspaceId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getChangesWithConflicts);
router.get("/reviews/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrReviews);
router.post("/resolve-conflicts/:repoId/:prId", requireRepoAccess, authorize("repo:push"), PRController.resolveConflicts);
router.post("/merge/:repoId/:prId", requireRepoAccess, authorize("repo:push"), PRController.mergePullRequest);
router.post("/add-reviewers/:repoId/:prId", requireRepoAccess, authorize("repo:push"), PRController.addReviewers);
router.post("/submit-review/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.submitReview);
router.get("/review-status/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.getPrReviewStatus);
router.post("/comment/:repoId/:prId", requireRepoAccess, authorize("repo:view"), PRController.addComment);
router.delete("/comment/:repoId/:prId/:commentId", requireRepoAccess, authorize("repo:view"), PRController.deleteComment);


export default router;
