import { Router } from "express";
import authRoutes from "./auth.routes"
import userRoutes from "./user.routes"
import repoRoutes from "./repo.routes"
import notificationRoutes from "./notification.routes"

const router = Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/repo", repoRoutes);
router.use("/notification", notificationRoutes);



export default router;