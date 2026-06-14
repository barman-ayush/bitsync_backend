import { Router, raw } from "express"
import { authMiddleware } from "../middlewares/auth.middleware";
import { requireRepoAccess } from "../middlewares/repo.middleware";
import { authorize } from "../middlewares/permission.middleware";
import { WorkspaceController } from "../controllers/workspace.controller";

const router = Router();
router.use(authMiddleware);

// Raw-body parser for blob uploads only: file content is binary, so it is sent
// as application/octet-stream and read straight into a Buffer (the global
// express.json() ignores this content type). 25 MiB matches MAX_BLOB_BYTES.
const rawBlobBody = raw({ type: "application/octet-stream", limit: "25mb" });


router.post("/create/:repoId/:name", requireRepoAccess, authorize("repo:view"), WorkspaceController.createWorkspace);
router.get("/get-all/:repoId", requireRepoAccess, authorize("repo:view"), WorkspaceController.loadAllWorkspaces);
router.get("/check/:repoId/:workspaceName", requireRepoAccess, authorize("repo:view"), WorkspaceController.checkWorkspaceName);
// fetches committed + uncommitted changes
router.get("/tree/get/:repoId/:workspaceId", requireRepoAccess, authorize("repo:view"), WorkspaceController.getWorkspaceTree);
// upload raw file content -> returns content-addressed blob hash
router.post("/blob/:repoId", requireRepoAccess, authorize("repo:push"), rawBlobBody, WorkspaceController.uploadBlob);
// fetch a blob -> returns a short-lived signed Cloudinary URL to download its content
router.get("/blob/:repoId/:blobHash", requireRepoAccess, authorize("repo:view"), WorkspaceController.getBlob);
// register uncommitted changes (server derives ADD/MODIFY/DELETE vs HEAD)
router.post("/tree/upload/:repoId/:workspaceId", requireRepoAccess, authorize("repo:push"), WorkspaceController.uploadWorkspaceChanges);

export default router;
