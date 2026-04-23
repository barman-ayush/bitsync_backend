import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { InvitationController } from "../controllers/invitation.controllers";

const router = Router();

router.use(authMiddleware);

// :id is the invitation_id
router.post("/:id/accept", InvitationController.accept);
router.post("/:id/reject", InvitationController.reject);
router.delete("/:id", InvitationController.remove);

export default router;
