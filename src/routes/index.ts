import { Router } from "express";
import authRoutes from "./auth.routes"
import userRoutes from "./user.routes"
import repoRoutes from "./repo.routes"
import invitationRoutes from "./invitation.routes"

const router = Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/repo", repoRoutes);
router.use("/invitation", invitationRoutes);


export default router;