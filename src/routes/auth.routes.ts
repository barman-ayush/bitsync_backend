import {Router} from "express"
import { AuthController } from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.post("/register" , AuthController.register);
router.get("/verify-email" , AuthController.verifyEmail);
router.get("/send-email" , authMiddleware, AuthController.sendEmail);
router.post("/login" , AuthController.login);
router.get("/logout" , AuthController.logout);


export default router;