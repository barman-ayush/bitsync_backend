import { Router } from "express";
import authRoutes from "./auth.routes"
import userRoutes from "./user.routes"
import repoRoutes from "./repo.routes"
import notificationRoutes from "./notification.routes"
import workspaceRoutes from "./workspace.routes"
import commitRoutes from "./commit.routes"

const router = Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/repo", repoRoutes);
router.use("/notification", notificationRoutes);
router.use("/workspace", workspaceRoutes);
router.use("/commit", commitRoutes);



export default router;