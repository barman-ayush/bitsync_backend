import { Router } from "express";
import { RepoController } from "../controllers/repo.controllers";
import { authMiddleware } from "../middlewares/auth.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { repoContext } from "../middlewares/repo.middleware";

const router = Router();

router.use(authMiddleware);


router.get("/", RepoController.list);
router.get("/check-name/:repoName", RepoController.checkRepoNameAvailability);
router.post("/create", RepoController.create);
router.get("/:repoId", repoContext, authorize("repo:view"), RepoController.getById);
router.put("/:repoId", repoContext, authorize("repo:settings"), RepoController.update);

// Member CRUD
router.post("/user/invite/:repoId", repoContext, authorize("repo:settings"), RepoController.inviteUser);
router.post("/user/remove/:repoId", repoContext, authorize("member:remove"), RepoController.removeUser);
router.post("/user/promote/:repoId", repoContext, authorize("member:promote"), RepoController.promoteUser);
router.post("/user/demote/:repoId", repoContext, authorize("member:demote"), RepoController.demoteUser);

export default router;
