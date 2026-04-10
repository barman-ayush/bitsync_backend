import {Router} from "express"
import { AuthController } from "../controllers/auth.controller";
import { UserDataController } from "../controllers/user.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const router = Router();

router.get("/data" , authMiddleware , UserDataController.getUser);


export default router;