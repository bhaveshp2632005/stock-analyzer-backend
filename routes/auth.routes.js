import express from "express";
import { signup, login, getMe } from "../controllers/auth.controller.js";
import { verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/signup", signup);          // POST /api/auth/signup
router.post("/login",  login);           // POST /api/auth/login
router.get ("/me",     verifyToken, getMe); // GET  /api/auth/me  (protected)

export default router;