import { Router } from "express"
import { authMiddleware } from "../middlewares/auth.middleware";
import { NotificationController } from "../controllers/notification.controller";

const router = Router();

router.use(authMiddleware);

router.get("/", NotificationController.getByUserId);
router.patch("/read-all", NotificationController.markAllAsRead);
router.patch("/:notificationId/read", NotificationController.markAsRead);

export default router;