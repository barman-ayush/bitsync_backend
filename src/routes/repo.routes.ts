import { Router } from "express";
import { RepoController } from "../controllers/repo.controllers";
import { authMiddleware } from "../middlewares/auth.middleware";
import { resolveRepoBySlug, requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";

const router = Router();

router.use(authMiddleware);

// Collection routes (literal first segment) — no repo context.
router.get("/", RepoController.searchRepository);
router.get("/check-name/:repoName", RepoController.checkRepoNameAvailability);
router.post("/create", RepoController.create);

// Invite acceptance/decline — no repo middleware: the caller isn't a member
// yet, and the repo/role context comes from the notification itself.
router.post("/invite/accept", RepoController.acceptInvite);
router.post("/invite/decline", RepoController.declineInvite);

// Tab/data routes — keyed by repoId, lightweight point-read access check.
// Must be registered before the /:username/:reponame slug route below so their
// literal second segment ("contributors", ...) takes precedence.
router.get("/:repoId/contributors", requireRepoAccess, authorize("repo:view"), RepoController.fetchContributors);
router.get("/:repoId/reviewers/search", requireRepoAccess, authorize("repo:view"), RepoController.searchReviewers);
router.post("/:repoId/invite", requireRepoAccess, authorize("member:invite"), RepoController.inviteContributors);

// Member management — requireRepoAccess proves the caller is an active member,
// authorize() enforces the role; finer rules (owner can't leave, only the
// owner removes admins, ...) live in the controllers.
router.post("/:repoId/leave", requireRepoAccess, RepoController.leaveRepository);
router.post("/:repoId/remove", requireRepoAccess, authorize("member:remove"), RepoController.removeUser);
router.post("/:repoId/promote", requireRepoAccess, authorize("member:promote"), RepoController.promoteUser);
router.post("/:repoId/demote", requireRepoAccess, authorize("member:demote"), RepoController.demoteUser);

// Repository main line fetch for files.
router.get("/get-data/:repoId", requireRepoAccess, authorize("repo:view"), RepoController.fetchRepositoryData);

// Page-mount route — slug resolution with the owner join. Keep last: its two
// param segments would otherwise shadow the more specific tab routes.
router.get("/:username/:reponame", resolveRepoBySlug, authorize("repo:view"), RepoController.showRepo);

export default router;
