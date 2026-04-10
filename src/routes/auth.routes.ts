import {Router} from "express"
import { AuthController } from "../controllers/auth.controller";

const router = Router();

router.post("/register" , AuthController.register);
router.get("/verify-email" , AuthController.verifyEmail);
router.post("/login" , AuthController.login);
router.get("/logout" , AuthController.logout);


export default router;